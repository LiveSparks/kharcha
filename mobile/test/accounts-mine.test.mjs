import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from './support/node-sqlite.mjs';
import { seedV1, smsTransaction, T0 } from './support/fixtures.mjs';
import { migrate } from '../src/lib/migrations.ts';
import { insertTransaction, listAccountRows, listTransactionRows, setAccountKindSql, setAccountMineSql } from '../src/lib/ledger.ts';
import { trackedRows, untrackedAccountIds } from '../src/lib/resolve.ts';
import { accountCardSummaries } from '../src/lib/accountCards.ts';

// Which accounts are yours (schema v10). Synthetic values only.

async function ledger() {
  const db = openDatabase();
  await seedV1(db);
  await migrate(db);
  return db;
}

test('every account starts undecided and still counts', async () => {
  const db = await ledger();
  const accounts = await listAccountRows(db);
  assert.ok(accounts.length >= 2);
  assert.ok(accounts.every(a => a.mine === null && a.kindByUser === false));
  const rows = await listTransactionRows(db);
  assert.equal(trackedRows(rows, untrackedAccountIds(accounts)).length, rows.length);
});

test('an account marked not yours takes its messages out; yours and unlinked rows stay', async () => {
  const db = await ledger();
  const rows = await listTransactionRows(db);
  const [a, b] = await listAccountRows(db);
  await setAccountMineSql(db, a.id, false);
  await setAccountMineSql(db, b.id, true);
  const accounts = await listAccountRows(db);
  assert.equal(accounts.find(x => x.id === a.id).mine, false);
  assert.equal(accounts.find(x => x.id === b.id).mine, true);
  const kept = trackedRows(rows, untrackedAccountIds(accounts));
  assert.ok(kept.every(t => t.accountId !== a.id));
  assert.equal(kept.length, rows.filter(t => t.accountId !== a.id).length);
  await setAccountMineSql(db, a.id, null);
  assert.equal((await listAccountRows(db)).find(x => x.id === a.id).mine, null);
});

test('a type you set is not changed by later messages', async () => {
  const db = await ledger();
  const rows = await listTransactionRows(db);
  const row = rows.find(t => t.accountId && t.rawBody);
  await setAccountKindSql(db, row.accountId, 'credit_card');
  await insertTransaction(db, smsTransaction(row.sender, row.rawBody, T0 + 500 * 86_400_000, 'again1'));
  const acct = (await listAccountRows(db)).find(a => a.id === row.accountId);
  assert.equal(acct.kind, 'credit_card');
  assert.equal(acct.kindByUser, true);
});

test('Home cards: yours first, then undecided; not yours gets no card; this month only', () => {
  const now = new Date(2026, 10, 24).getTime();
  const acct = (id, mine) => ({ id, bank: 'HDFC', last4: id, kind: 'bank', fundedBy: null, name: null, createdAt: 0, openingBalancePaise: null, openingBalanceAt: null, creditLimitPaise: null, mine, kindByUser: false });
  const rows = [
    { accountId: 'u', direction: 'debit', amountPaise: 100, occurredAt: new Date(2026, 10, 20).getTime() },
    { accountId: 'm', direction: 'credit', amountPaise: 500, occurredAt: new Date(2026, 10, 2).getTime() },
    { accountId: 'm', direction: 'debit', amountPaise: 900, occurredAt: new Date(2026, 9, 30).getTime() },
    { accountId: 'x', direction: 'debit', amountPaise: 700, occurredAt: new Date(2026, 10, 3).getTime() },
  ];
  const cards = accountCardSummaries([acct('u', null), acct('x', false), acct('m', true)], rows, now);
  assert.deepEqual(cards.map(c => c.account.id), ['m', 'u']);
  assert.deepEqual([cards[0].inPaise, cards[0].outPaise, cards[0].count], [500, 0, 1]);
  assert.deepEqual([cards[1].outPaise, cards[1].count], [100, 1]);
});
