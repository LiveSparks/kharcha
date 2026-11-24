import { startOfMonth } from './format.ts';
import type { Account, Transaction } from './model';

// Home's account cards (v10): accounts you track — yours first, then undecided — each with
// this month's money out and in. Most active first within each group; accounts you marked
// not yours never get a card. `rows` should already be the counted rows.

export interface AccountCardSummary { account: Account; outPaise: number; inPaise: number; count: number; lastAt: number }

export function accountCardSummaries(accounts: readonly Account[], rows: readonly Pick<Transaction, 'accountId' | 'direction' | 'amountPaise' | 'occurredAt'>[], now: number): AccountCardSummary[] {
  const from = startOfMonth(now);
  const by = new Map<string, AccountCardSummary>();
  for (const a of accounts) if (a.mine !== false) by.set(a.id, { account: a, outPaise: 0, inPaise: 0, count: 0, lastAt: 0 });
  for (const t of rows) {
    const s = t.accountId ? by.get(t.accountId) : undefined;
    if (!s) continue;
    s.lastAt = Math.max(s.lastAt, t.occurredAt);
    if (t.occurredAt < from || t.occurredAt > now) continue;
    s.count++;
    if (t.direction === 'debit') s.outPaise += t.amountPaise; else s.inPaise += t.amountPaise;
  }
  const rank = (s: AccountCardSummary) => s.account.mine === true ? 0 : 1;
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || b.lastAt - a.lastAt);
}
