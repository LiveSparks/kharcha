import type { Account, Category, Direction, Payee, Transaction } from './model';
import { accountLabel, effectiveCategory, isLive, isOwnTransfer, transactionLabel } from './resolve.ts';

// The Ledger tab (operator feedback, 2026-11-24): every Live row as a dense list, newest
// first, grouped by day, with search and filters. Pure, so the screen only renders.

export type Period = 'all' | 'thisMonth' | 'lastMonth' | 'last3' | 'thisYear';
export const PERIODS: readonly { value: Period; label: string }[] = [
  { value: 'all', label: 'All time' }, { value: 'thisMonth', label: 'This month' }, { value: 'lastMonth', label: 'Last month' },
  { value: 'last3', label: 'Last 3 months' }, { value: 'thisYear', label: 'This year' },
];

export interface LedgerFilter {
  query: string;
  period: Period;
  accountId: string | null;
  category: Category | null;
  direction: Direction | null;
  reviewOnly: boolean;
}

export const NO_FILTER: LedgerFilter = { query: '', period: 'all', accountId: null, category: null, direction: null, reviewOnly: false };

export function activeFilters(f: LedgerFilter): number {
  return Number(f.period !== 'all') + Number(!!f.accountId) + Number(!!f.category) + Number(!!f.direction) + Number(f.reviewOnly);
}

export interface LedgerEntry {
  transaction: Transaction;
  label: string;
  category: Category;
  account: string | null;
}

export type LedgerItem =
  | { type: 'day'; key: string; at: number; outPaise: number; inPaise: number }
  | { type: 'row'; key: string; entry: LedgerEntry };

export function periodRange(period: Period, now: number): [number, number] {
  const d = new Date(now);
  const month = (offset: number) => new Date(d.getFullYear(), d.getMonth() + offset, 1).getTime();
  switch (period) {
    case 'thisMonth': return [month(0), month(1)];
    case 'lastMonth': return [month(-1), month(0)];
    case 'last3': return [month(-2), month(1)];
    case 'thisYear': return [new Date(d.getFullYear(), 0, 1).getTime(), new Date(d.getFullYear() + 1, 0, 1).getTime()];
    default: return [-Infinity, Infinity];
  }
}

// A query that is only a number (with optional ₹/Rs, commas, decimals) also matches the
// amount: "499" finds ₹499 and ₹499.50; "499.5" finds only ₹499.50.
function amountQuery(q: string): ((paise: number) => boolean) | null {
  const clean = q.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) return null;
  const wanted = Math.round(Number(clean) * 100);
  return clean.includes('.') ? paise => paise === wanted : paise => Math.floor(paise / 100) * 100 === wanted;
}

export function ledgerEntries(
  transactions: readonly Transaction[], payees: ReadonlyMap<string, Payee>, accounts: ReadonlyMap<string, Account>,
  filter: LedgerFilter, now: number,
): LedgerEntry[] {
  const [from, to] = periodRange(filter.period, now);
  const q = filter.query.trim().toLowerCase();
  const amount = q ? amountQuery(q) : null;
  const out: LedgerEntry[] = [];
  for (const t of transactions) {
    if (!isLive(t)) continue;
    if (t.occurredAt < from || t.occurredAt >= to) continue;
    if (filter.reviewOnly && t.status !== 'review') continue;
    if (filter.direction && t.direction !== filter.direction) continue;
    if (filter.accountId && t.accountId !== filter.accountId) continue;
    const category = effectiveCategory(t, payees);
    if (filter.category && category !== filter.category) continue;
    const label = transactionLabel(t, payees);
    const a = t.accountId ? accounts.get(t.accountId) : undefined;
    const own = a ? accountLabel(a) : t.accountLast4 ? `··${t.accountLast4}` : null;
    const b = t.transferAccountId ? accounts.get(t.transferAccountId) : undefined;
    // A transfer between your accounts reads "From → To".
    const account = own && b ? (t.direction === 'debit' ? `${own} → ${accountLabel(b)}` : `${accountLabel(b)} → ${own}`) : own;
    if (q) {
      const text = `${label}\n${t.merchant}\n${category}\n${account ?? ''}`.toLowerCase();
      const hit = text.includes(q) || (amount !== null && amount(t.amountPaise));
      if (!hit) continue;
    }
    out.push({ transaction: t, label, category, account });
  }
  return out.sort((x, y) => y.transaction.occurredAt - x.transaction.occurredAt || (x.transaction.id < y.transaction.id ? -1 : 1));
}

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// Day headers carry that day's totals; entries must be newest first.
export function groupByDay(entries: readonly LedgerEntry[]): LedgerItem[] {
  const items: LedgerItem[] = [];
  let header: Extract<LedgerItem, { type: 'day' }> | null = null;
  for (const entry of entries) {
    const t = entry.transaction;
    const key = dayKey(t.occurredAt);
    if (!header || header.key !== `day:${key}`) {
      header = { type: 'day', key: `day:${key}`, at: t.occurredAt, outPaise: 0, inPaise: 0 };
      items.push(header);
    }
    // Money moved between your own accounts is neither spent nor received.
    if (!isOwnTransfer(t)) { if (t.direction === 'debit') header.outPaise += t.amountPaise; else header.inPaise += t.amountPaise; }
    items.push({ type: 'row', key: t.id, entry });
  }
  return items;
}

export function totals(entries: readonly LedgerEntry[]): { outPaise: number; inPaise: number } {
  let outPaise = 0, inPaise = 0;
  for (const { transaction: t } of entries) {
    if (isOwnTransfer(t)) continue;
    if (t.direction === 'debit') outPaise += t.amountPaise; else inPaise += t.amountPaise;
  }
  return { outPaise, inPaise };
}
