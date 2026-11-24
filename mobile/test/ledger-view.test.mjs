import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_FILTER, activeFilters, groupByDay, ledgerEntries, periodRange, totals } from '../src/lib/ledgerView.ts';

// The Ledger tab's search, filters and day grouping. Synthetic values only.

const NOW = new Date(2026, 10, 24, 12).getTime(); // 24 Nov 2026
const at = (m, d, h = 10) => new Date(2026, m - 1, d, h).getTime();

function txn(over) {
  return {
    id: over.id, sourceHash: null, sender: 'VM-BANKX-S', rawBody: 'x', occurredAt: over.occurredAt, merchant: over.merchant ?? 'Unknown merchant',
    amountPaise: over.amountPaise ?? 10000, direction: over.direction ?? 'debit', category: over.category ?? 'Other', status: over.status ?? 'auto',
    accountLast4: over.accountLast4 ?? null, counterpartyMasked: null, counterpartyLast4: null, reference: null, confidence: 0.95, createdAt: 0, updatedAt: 0,
    accountId: over.accountId ?? null, payeeId: over.payeeId ?? null, payeeOverrideId: null, categoryByUser: over.categoryByUser ?? false,
    duplicateOf: null, preFlagStatus: null, duplicateCleared: false, reportedBalancePaise: null, reportedAvlLimitPaise: null,
  };
}

const payees = new Map([['p1', { id: 'p1', kind: 'merchant', bank: 'HDFC', key: 'bluetokai', masked: null, name: 'Coffee place', category: 'Food', nudgedAt: null, createdAt: 0, habitHidden: false }]]);
const accounts = new Map([['a1', { id: 'a1', bank: 'HDFC', last4: '4321', kind: 'bank', fundedBy: null, name: 'Salary', createdAt: 0, openingBalancePaise: null, openingBalanceAt: null, creditLimitPaise: null }]]);
const rows = [
  txn({ id: 't1', occurredAt: at(11, 24, 9), merchant: 'Blue Tokai', payeeId: 'p1', amountPaise: 45000, accountId: 'a1' }),
  txn({ id: 't2', occurredAt: at(11, 24, 18), merchant: 'Employer', direction: 'credit', amountPaise: 12500050, category: 'Income', accountId: 'a1' }),
  txn({ id: 't3', occurredAt: at(11, 2), merchant: 'Grocer', amountPaise: 125000, status: 'review', accountLast4: '9999' }),
  txn({ id: 't4', occurredAt: at(10, 15), merchant: 'Cinema', amountPaise: 49950, category: 'Entertainment' }),
  txn({ id: 't5', occurredAt: at(10, 16), merchant: 'Ignored one', status: 'ignored' }),
  txn({ id: 't6', occurredAt: at(10, 17), merchant: 'Merged copy', status: 'merged' }),
];
const run = (patch = {}) => ledgerEntries(rows, payees, accounts, { ...NO_FILTER, ...patch }, NOW).map(e => e.transaction.id);

test('only rows in the books show, newest first', () => {
  assert.deepEqual(run(), ['t2', 't1', 't3', 't4']);
});

test('search matches the payee name, category, account and amount', () => {
  assert.deepEqual(run({ query: 'coffee' }), ['t1'], 'named payee');
  assert.deepEqual(run({ query: 'food' }), ['t1'], 'category from the payee default');
  assert.deepEqual(run({ query: 'salary' }), ['t2', 't1'], 'account name');
  assert.deepEqual(run({ query: '9999' }), ['t3'], 'account digits');
  assert.deepEqual(run({ query: '1,250' }), ['t3'], 'amount with a comma');
  assert.deepEqual(run({ query: '₹499' }), ['t4'], 'amount prefix with decimals');
  assert.deepEqual(run({ query: 'nothing like this' }), []);
});

test('filters combine', () => {
  assert.deepEqual(run({ period: 'thisMonth' }), ['t2', 't1', 't3']);
  assert.deepEqual(run({ period: 'lastMonth' }), ['t4']);
  assert.deepEqual(run({ accountId: 'a1', direction: 'debit' }), ['t1']);
  assert.deepEqual(run({ category: 'Entertainment' }), ['t4']);
  assert.deepEqual(run({ reviewOnly: true }), ['t3']);
  assert.equal(activeFilters({ ...NO_FILTER, period: 'last3', reviewOnly: true }), 2);
});

test('rows group under day headers that carry the day totals', () => {
  const entries = ledgerEntries(rows, payees, accounts, NO_FILTER, NOW);
  const items = groupByDay(entries);
  assert.deepEqual(items.map(i => i.type === 'day' ? 'day' : i.key), ['day', 't2', 't1', 'day', 't3', 'day', 't4']);
  assert.deepEqual([items[0].outPaise, items[0].inPaise], [45000, 12500050]);
  assert.deepEqual(totals(entries), { outPaise: 45000 + 125000 + 49950, inPaise: 12500050 });
});

test('period ranges are calendar months', () => {
  const [from, to] = periodRange('last3', NOW);
  assert.equal(new Date(from).getMonth(), 8);
  assert.equal(new Date(to).getMonth(), 11);
});
