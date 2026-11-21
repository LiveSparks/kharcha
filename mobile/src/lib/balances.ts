import type { Account, Direction, Transaction } from './model';
import { balanceAccount, isLive } from './resolve.ts';

// Balances (WF-4, app-modification spec §5.3). Pure and read-time: nothing here is
// stored. An anchor is a row whose SMS states the account's figure after that
// transaction: the balance for a bank account, the available limit for a credit card.
// The running figure is the last anchor plus the signed rows after it. Between two
// anchors, whatever the rows don't explain becomes a virtual "Unexplained difference" row.

export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface GapRow {
  id: string;            // `gap:<anchor id>`
  accountId: string;
  beforeId: string;      // the anchor it explains; shown just before it
  occurredAt: number;    // the anchor's time
  amountPaise: number;   // always positive
  direction: Direction;  // credit: money arrived that no SMS reported; debit: it left
}

export interface AccountBalance {
  accountId: string;
  // balance: a bank account's signed balance. available: a card's available limit when
  // no credit limit is set. outstanding: a card's dues (limit − available). null: no figure.
  kind: 'balance' | 'available' | 'outstanding' | null;
  amountPaise: number | null;
  asOf: number | null;   // time of the last row counted
  stale: boolean;        // no anchor in the last 30 days
  anchors: number;       // SMS anchors counted
  gaps: GapRow[];        // oldest first
  needsOpening: boolean; // bank account that never stated a balance and has no opening balance
  needsLimit: boolean;   // credit card with no limit entered
}

function order(a: Transaction, b: Transaction): number {
  return a.occurredAt - b.occurredAt || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const signed = (t: Transaction) => t.direction === 'credit' ? t.amountPaise : -t.amountPaise;

// Walk an account's rows, carrying the figure forward from the first anchor.
function walk(accountId: string, rows: readonly Transaction[], anchorOf: (t: Transaction) => number | null, opening: { paise: number; at: number } | null) {
  let running: number | null = null;
  let asOf: number | null = null;
  let lastAnchorAt: number | null = null;
  let anchors = 0;
  const gaps: GapRow[] = [];
  const useOpening = opening && !rows.some(t => anchorOf(t) !== null);
  if (useOpening) { running = opening.paise; asOf = opening.at; lastAnchorAt = opening.at; }
  for (const t of rows) {
    const anchor = anchorOf(t);
    if (running === null && anchor === null) continue; // before the first anchor: unknown base
    if (useOpening && t.occurredAt < opening.at) continue;
    if (running !== null) running += signed(t);
    if (anchor !== null) {
      anchors++;
      if (running !== null && running !== anchor) {
        const diff = anchor - running;
        gaps.push({ id: `gap:${t.id}`, accountId, beforeId: t.id, occurredAt: t.occurredAt, amountPaise: Math.abs(diff), direction: diff > 0 ? 'credit' : 'debit' });
      }
      running = anchor;
      lastAnchorAt = t.occurredAt;
    }
    asOf = t.occurredAt;
  }
  return { running, asOf, lastAnchorAt, anchors, gaps };
}

// The rows that count toward an account's figure: Live rows whose account rolls up to it
// (a debit card's rows count toward its funding account once the link is set).
export function balanceRows(accountId: string, transactions: readonly Transaction[], accounts: readonly Account[]): Transaction[] {
  const byId = new Map(accounts.map(a => [a.id, a]));
  return transactions.filter(t => {
    if (!isLive(t) || !t.accountId) return false;
    const a = byId.get(t.accountId);
    return !!a && balanceAccount(a) === accountId;
  }).sort(order);
}

export function computeBalance(account: Account, transactions: readonly Transaction[], accounts: readonly Account[], now: number): AccountBalance {
  const none: AccountBalance = { accountId: account.id, kind: null, amountPaise: null, asOf: null, stale: false, anchors: 0, gaps: [], needsOpening: false, needsLimit: false };
  if (account.kind === 'bank') {
    const opening = account.openingBalancePaise !== null && account.openingBalanceAt !== null ? { paise: account.openingBalancePaise, at: account.openingBalanceAt } : null;
    const w = walk(account.id, balanceRows(account.id, transactions, accounts), t => t.reportedBalancePaise, opening);
    if (w.running === null) return { ...none, needsOpening: true };
    return {
      ...none, kind: 'balance', amountPaise: w.running, asOf: w.asOf, anchors: w.anchors, gaps: w.gaps,
      stale: w.lastAnchorAt === null || now - w.lastAnchorAt > STALE_AFTER_MS,
    };
  }
  if (account.kind === 'credit_card') {
    const w = walk(account.id, balanceRows(account.id, transactions, accounts), t => t.reportedAvlLimitPaise, null);
    const needsLimit = account.creditLimitPaise === null;
    if (w.running === null) return { ...none, needsLimit };
    const stale = w.lastAnchorAt === null || now - w.lastAnchorAt > STALE_AFTER_MS;
    return needsLimit
      ? { ...none, kind: 'available', amountPaise: w.running, asOf: w.asOf, stale, anchors: w.anchors, gaps: w.gaps, needsLimit }
      : { ...none, kind: 'outstanding', amountPaise: account.creditLimitPaise! - w.running, asOf: w.asOf, stale, anchors: w.anchors, gaps: w.gaps };
  }
  // Debit cards roll into their funding account; unknown accounts show nothing until typed.
  return none;
}

export function computeBalances(transactions: readonly Transaction[], accounts: readonly Account[], now: number): Map<string, AccountBalance> {
  return new Map(accounts.map(a => [a.id, computeBalance(a, transactions, accounts, now)]));
}

// Home's Net line: Σ bank balances − Σ card outstanding, over accounts that have a figure.
// null when no account has one.
export function netWorth(balances: Iterable<AccountBalance>): number | null {
  let net: number | null = null;
  for (const b of balances) {
    if (b.amountPaise === null) continue;
    if (b.kind === 'balance') net = (net ?? 0) + b.amountPaise;
    else if (b.kind === 'outstanding') net = (net ?? 0) - b.amountPaise;
  }
  return net;
}

// An account's history, newest first, with gap rows just before (i.e. listed after, in
// newest-first order) the anchor they explain.
export type HistoryItem = { type: 'row'; transaction: Transaction } | { type: 'gap'; gap: GapRow };
export function accountHistory(rows: readonly Transaction[], gaps: readonly GapRow[]): HistoryItem[] {
  const gapBefore = new Map(gaps.map(g => [g.beforeId, g]));
  const items: HistoryItem[] = [];
  for (const t of [...rows].sort(order).reverse()) {
    items.push({ type: 'row', transaction: t });
    const gap = gapBefore.get(t.id);
    if (gap) items.push({ type: 'gap', gap });
  }
  return items;
}

// Gaps big enough to suggest a missed or misread SMS (WF-4/WF-9 verification signal).
export function largeGap(gap: GapRow, balancePaise: number | null): boolean {
  return gap.amountPaise > 500_000 || (balancePaise !== null && gap.amountPaise > Math.abs(balancePaise) * 0.05);
}
