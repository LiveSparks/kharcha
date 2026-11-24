import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from './support/node-sqlite.mjs';
import { seedV1 } from './support/fixtures.mjs';
import { migrate } from '../src/lib/migrations.ts';
import { listAccountRows, listTransactionRows, setTransferSql, transferSides } from '../src/lib/ledger.ts';
import { reviewReasons } from '../src/lib/reviewReason.ts';
import { NO_FILTER, groupByDay, ledgerEntries, totals } from '../src/lib/ledgerView.ts';
import { isOwnTransfer } from '../src/lib/resolve.ts';

// Review reasons and transfers (operator feedback, 2026-11-24). Synthetic values only.

const review = over => ({ status: 'review', merchant: 'Blue Tokai', accountLast4: '4321', counterpartyLast4: null, confidence: 0.9, ...over });

test('each review card says what was missing', () => {
  assert.deepEqual(reviewReasons(review({ status: 'auto' }), true), []);
  assert.deepEqual(reviewReasons(review({ merchant: 'Unknown merchant', counterpartyLast4: '7788', confidence: 0.45 }), true), ['Sent to an account number (··7788), not a named payee.']);
  assert.deepEqual(reviewReasons(review({ merchant: 'Unknown merchant', confidence: 0.45 }), true), ["The message doesn't say who this was with."]);
  assert.deepEqual(reviewReasons(review({ accountLast4: null, confidence: 0.68 }), true), ["The message doesn't name your account or card."]);
  assert.deepEqual(reviewReasons(review({ confidence: 0.68 }), true), ["The amount isn't next to a word like debited or credited."]);
  assert.deepEqual(reviewReasons(review({}), false), ['Auto-add is off, so every message waits here.']);
  assert.deepEqual(reviewReasons(review({}), true), ["Kharcha wasn't sure about this read."]);
});

test('a transfer stores its own side on account_id and the other on transfer_account_id', () => {
  assert.deepEqual(transferSides('debit', 'a', 'b'), { accountId: 'a', transferAccountId: 'b' });
  assert.deepEqual(transferSides('credit', 'a', 'b'), { accountId: 'b', transferAccountId: 'a' });
  assert.throws(() => transferSides('debit', 'a', 'a'), /two different accounts/);
});

test('setting both sides on SQLite makes it an own-account transfer, left out of totals', async () => {
  const db = openDatabase();
  await seedV1(db);
  await migrate(db);
  const accounts = await listAccountRows(db);
  assert.ok(accounts.length >= 2, 'fixture has two accounts');
  const debit = (await listTransactionRows(db)).find(t => t.direction === 'debit' && t.accountId);
  const other = accounts.find(a => a.id !== debit.accountId);
  await setTransferSql(db, debit.id, debit.accountId, other.id);
  const rows = await listTransactionRows(db);
  const moved = rows.find(t => t.id === debit.id);
  assert.equal(moved.transferAccountId, other.id);
  assert.equal(isOwnTransfer(moved), true);
  const entries = ledgerEntries(rows, new Map(), new Map(accounts.map(a => [a.id, a])), NO_FILTER, Date.now());
  const entry = entries.find(e => e.transaction.id === debit.id);
  assert.match(entry.account, / → /);
  const withIt = totals(entries).outPaise;
  const without = totals(entries.filter(e => e.transaction.id !== debit.id)).outPaise;
  assert.equal(withIt, without);
  const day = groupByDay(entries).find(i => i.type === 'day' && new Date(i.at).toDateString() === new Date(moved.occurredAt).toDateString());
  assert.ok(day);
  await setTransferSql(db, debit.id, debit.accountId, null);
  assert.equal((await listTransactionRows(db)).find(t => t.id === debit.id).transferAccountId, null);
});
