import { UNKNOWN_MERCHANT } from './identity.ts';
import type { Account, Category, Payee, Transaction, TransactionStatus } from './model';

// Read-time resolvers (app-modification spec §3.3). Names, categories and links are
// decisions stored beside the parser output; nothing here writes.

const LIVE: ReadonlySet<TransactionStatus> = new Set(['auto', 'review', 'manual']);
export function isLive(t: Pick<Transaction, 'status'>): boolean { return LIVE.has(t.status); }

// Ownership (v10): a message on an account you marked not yours leaves every view —
// ledger, review, duplicates, totals. Undecided accounts still count.
export function untrackedAccountIds(accounts: readonly Pick<Account, 'id' | 'mine'>[]): Set<string> {
  return new Set(accounts.filter(a => a.mine === false).map(a => a.id));
}
export function trackedRows<T extends Pick<Transaction, 'accountId'>>(rows: readonly T[], untracked: ReadonlySet<string>): T[] {
  return untracked.size ? rows.filter(t => !t.accountId || !untracked.has(t.accountId)) : [...rows];
}

// Money moved between two of your own accounts: in the ledger, but neither spent nor received.
export function isOwnTransfer(t: Pick<Transaction, 'accountId' | 'transferAccountId'>): boolean { return !!t.accountId && !!t.transferAccountId; }

export function effectivePayeeId(t: Pick<Transaction, 'payeeId' | 'payeeOverrideId'>): string | null {
  return t.payeeOverrideId ?? t.payeeId;
}

export function payeeDefaultLabel(p: Payee): string {
  if (p.kind === 'merchant') return p.masked ?? p.key.replace(/#\d+$/, '');
  return `a/c ${p.masked ?? `**${p.key.replace(/#\d+$/, '')}`} · ${p.bank || 'bank'}`;
}

export function payeeLabel(p: Payee): string { return p.name ?? payeeDefaultLabel(p); }

export function accountDefaultLabel(a: Account): string {
  return a.kind === 'credit_card' ? `${a.bank} card ••${a.last4}` : `${a.bank} ••${a.last4}`;
}

export function accountLabel(a: Account): string { return a.name ?? accountDefaultLabel(a); }

export function effectiveCategory(t: Pick<Transaction, 'category' | 'categoryByUser' | 'payeeId' | 'payeeOverrideId'>, payees: ReadonlyMap<string, Payee>): Category {
  if (t.categoryByUser) return t.category;
  const id = effectivePayeeId(t);
  return (id ? payees.get(id)?.category : null) ?? t.category;
}

export function payeeGroupKey(p: Payee): string {
  return p.name ? p.name.trim().normalize('NFKC').toLocaleLowerCase() : p.id;
}

export function balanceAccount(a: Account): string {
  return a.kind === 'debit_card' && a.fundedBy ? a.fundedBy : a.id;
}

export function transactionLabel(t: Pick<Transaction, 'merchant' | 'payeeId' | 'payeeOverrideId'>, payees: ReadonlyMap<string, Payee>): string {
  const id = effectivePayeeId(t);
  const payee = id ? payees.get(id) : undefined;
  return payee ? payeeLabel(payee) : t.merchant || UNKNOWN_MERCHANT;
}

export function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map(item => [item.id, item]));
}

export interface PayeeStats { count: number; spentPaise: number; receivedPaise: number }

// Live rows per effective payee.
export function payeeStats(transactions: readonly Transaction[]): Map<string, PayeeStats> {
  const stats = new Map<string, PayeeStats>();
  for (const t of transactions) {
    if (!isLive(t)) continue;
    const id = effectivePayeeId(t);
    if (!id) continue;
    const s = stats.get(id) ?? { count: 0, spentPaise: 0, receivedPaise: 0 };
    s.count++;
    if (t.direction === 'debit') s.spentPaise += t.amountPaise; else s.receivedPaise += t.amountPaise;
    stats.set(id, s);
  }
  return stats;
}

export interface PayeeListEntry { payee: Payee; label: string; stats: PayeeStats }

// Payees list order (WF-3): unnamed by total spend, then named A–Z. Payees with no
// Live rows are left out: there is nothing of theirs to show or name.
export function payeeList(payees: readonly Payee[], stats: ReadonlyMap<string, PayeeStats>): PayeeListEntry[] {
  const entries = payees.flatMap(payee => {
    const s = stats.get(payee.id);
    return s ? [{ payee, label: payeeLabel(payee), stats: s }] : [];
  });
  const unnamed = entries.filter(e => !e.payee.name)
    .sort((a, b) => b.stats.spentPaise - a.stats.spentPaise || b.stats.receivedPaise - a.stats.receivedPaise || a.label.localeCompare(b.label));
  const named = entries.filter(e => e.payee.name).sort((a, b) => a.label.localeCompare(b.label));
  return [...unnamed, ...named];
}

export function unnamedCount(payees: readonly Payee[], stats: ReadonlyMap<string, PayeeStats>): number {
  return payees.filter(p => !p.name && stats.has(p.id)).length;
}

export const NUDGE_AFTER = 3;

// Home naming nudge (WF-3): an unnamed payee with ≥3 Live rows that hasn't been asked
// about yet, highest spend first.
export function namingNudge(payees: readonly Payee[], stats: ReadonlyMap<string, PayeeStats>): { payee: Payee; label: string; count: number } | null {
  let best: { payee: Payee; label: string; count: number; spent: number } | null = null;
  for (const payee of payees) {
    if (payee.name || payee.nudgedAt != null) continue;
    const s = stats.get(payee.id);
    if (!s || s.count < NUDGE_AFTER) continue;
    if (!best || s.spentPaise > best.spent || s.spentPaise === best.spent && s.count > best.count) {
      best = { payee, label: payeeLabel(payee), count: s.count, spent: s.spentPaise };
    }
  }
  return best && { payee: best.payee, label: best.label, count: best.count };
}

// Reach line on the name sheet: Live rows whose effective payee is this one.
export function payeeReach(payeeIdValue: string, transactions: readonly Transaction[]): number {
  let n = 0;
  for (const t of transactions) if (isLive(t) && effectivePayeeId(t) === payeeIdValue) n++;
  return n;
}

export interface DebitCardSuggestion { card: Account; bank: Account; cardSpends: number; unmatched: number }

const MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

// "••8812 looks like a debit card on HDFC ••3391" (WF-1/WF-3). A card (debit or of
// unknown type) at a bank where the user also has a bank account, whose spends mostly
// have no same-amount bank-account SMS within a day: the bank account isn't being
// notified separately, so the card is probably drawing on it. Never applied silently.
export function debitCardSuggestions(accounts: readonly Account[], transactions: readonly Transaction[]): DebitCardSuggestion[] {
  const rowsByAccount = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (!isLive(t) || !t.accountId) continue;
    const rows = rowsByAccount.get(t.accountId) ?? [];
    rows.push(t);
    rowsByAccount.set(t.accountId, rows);
  }
  const suggestions: DebitCardSuggestion[] = [];
  for (const card of accounts) {
    if (card.fundedBy || card.kind !== 'debit_card' && card.kind !== 'unknown') continue;
    const banks = accounts.filter(a => a.kind === 'bank' && a.bank === card.bank && a.id !== card.id);
    if (!banks.length) continue;
    const spends = (rowsByAccount.get(card.id) ?? []).filter(t => t.direction === 'debit');
    if (!spends.length) continue;
    const bankRows = banks.flatMap(b => rowsByAccount.get(b.id) ?? []);
    const unmatched = spends.filter(s => !bankRows.some(b => b.direction === 'debit' && b.amountPaise === s.amountPaise
      && Math.abs(b.occurredAt - s.occurredAt) <= MATCH_WINDOW_MS)).length;
    if (unmatched * 2 < spends.length) continue;
    const bank = banks.map(b => ({ b, n: rowsByAccount.get(b.id)?.length ?? 0 }))
      .sort((x, y) => y.n - x.n || x.b.last4.localeCompare(y.b.last4))[0].b;
    suggestions.push({ card, bank, cardSpends: spends.length, unmatched });
  }
  return suggestions;
}

export function validateName(input: string): string | null {
  const name = input.trim();
  if (!name) return null;
  if (name.length > 40) throw new Error('Keep the name to 40 characters or fewer.');
  return name;
}
