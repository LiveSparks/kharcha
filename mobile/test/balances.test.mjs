import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from './support/node-sqlite.mjs';
import { T0, seedV1, v1Rows } from './support/fixtures.mjs';
import { migrate, readVersion } from '../src/lib/migrations.ts';
import { parseBankSms, reportedFigures } from '../src/lib/parser.ts';
import { STALE_AFTER_MS, accountHistory, computeBalance, computeBalances, largeGap, netWorth } from '../src/lib/balances.ts';
import {
  exportSnapshotSql, insertTransaction, listAccountRows, listTransactionRows, restoreSnapshotSql,
  setCreditLimitSql, setOpeningBalanceSql,
} from '../src/lib/ledger.ts';

// P3 balances (app-modification §5.3, WF-4). Synthetic values only.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
let seq = 0;

function txn(over = {}) {
  seq++;
  return {
    id: over.id ?? `t${seq}`, sourceHash: null, sender: 'VM-BANKX-S', rawBody: 'x', occurredAt: over.occurredAt ?? T0 + seq * MIN,
    merchant: 'Shop', amountPaise: over.amountPaise ?? 10000, direction: over.direction ?? 'debit', category: 'Shopping',
    status: over.status ?? 'auto', accountLast4: null, counterpartyMasked: null, counterpartyLast4: null, reference: null,
    confidence: 0.95, createdAt: over.createdAt ?? over.occurredAt ?? T0 + seq * MIN, updatedAt: 0,
    accountId: over.accountId ?? 'acct:X:1111', payeeId: null, payeeOverrideId: null, categoryByUser: false,
    duplicateOf: null, preFlagStatus: null, duplicateCleared: false,
    reportedBalancePaise: over.bal ?? null, reportedAvlLimitPaise: over.lim ?? null,
  };
}
function acct(over = {}) {
  return {
    id: over.id ?? 'acct:X:1111', bank: 'X', last4: over.last4 ?? '1111', kind: over.kind ?? 'bank', fundedBy: over.fundedBy ?? null,
    name: null, createdAt: 0, openingBalancePaise: over.opening ?? null, openingBalanceAt: over.openingAt ?? null,
    creditLimitPaise: over.limit ?? null,
  };
}

// --- Parser -------------------------------------------------------------------------

test('balance and limit tails are read, signed, and kept out of the amount', () => {
  const pnb = parseBankSms('Ac XX1111 Debited with Rs.470.00, 05-03-2026 10:00:00. Aval Bal 312.18 CR. Helpline 1800000000');
  assert.equal(pnb.amountPaise, 47000);
  assert.equal(pnb.reportedBalancePaise, 31218);
  const dr = reportedFigures('Ac XX1111 Debited with Rs.470.00. Aval Bal 1,250.50 DR. Helpline', '1111');
  assert.equal(dr.reportedBalancePaise, -125050);
  const card = parseBankSms('Spent Rs.99.5 From HDFC Bank Card x4455 At SHOP On 2026-03-09:11:00:00 Bal Rs.900');
  assert.equal(card.reportedBalancePaise, 90000);
  const icici = parseBankSms('INR 450.00 spent using ICICI Bank Card XX6611 on 07-Mar-26 on BOOKNOOK. Avl Limit: INR 1,00,000.00. If not you, call 1800 000 0000.');
  assert.equal(icici.amountPaise, 45000);
  assert.equal(icici.reportedAvlLimitPaise, 10000000);
  assert.equal(icici.reportedBalancePaise, null);
  // a wallet/tag balance, or a message with no account, never becomes an anchor
  assert.deepEqual(reportedFigures('Paid Rs.85 toll. HDFC Bank FASTag balance: Rs.400.', null), { reportedBalancePaise: null, reportedAvlLimitPaise: null });
  assert.deepEqual(reportedFigures('Wallet Bal: Rs.120 Not you?', '1111'), { reportedBalancePaise: null, reportedAvlLimitPaise: null });
  assert.equal(parseBankSms('Sent Rs.120.00\nFrom HDFC Bank A/C *9012\nTo SHOP\nOn 02/03/26\nRef 600000000001').reportedBalancePaise, null);
});

// --- computeBalance --------------------------------------------------------------------

test('balance = last anchor + signed rows after it; rows before the first anchor are ignored', () => {
  const rows = [
    txn({ amountPaise: 5000 }),                       // before any anchor: unknown base
    txn({ amountPaise: 10000, bal: 100000 }),          // anchor: ₹1,000 after this debit
    txn({ amountPaise: 2500 }),                       // −25
    txn({ amountPaise: 20000, direction: 'credit' }), // +200
  ];
  const b = computeBalance(acct(), rows, [acct()], rows[3].occurredAt);
  assert.equal(b.kind, 'balance');
  assert.equal(b.amountPaise, 100000 - 2500 + 20000);
  assert.equal(b.asOf, rows[3].occurredAt);
  assert.equal(b.anchors, 1);
  assert.deepEqual(b.gaps, []);
  assert.equal(b.stale, false);
});

test('a difference between anchors becomes a gap row before the later anchor', () => {
  const a = txn({ id: 'a', amountPaise: 1000, bal: 100000 });
  const b = txn({ id: 'b', amountPaise: 3000 });
  const c = txn({ id: 'c', amountPaise: 2000, bal: 90000 }); // expected 100000−3000−2000 = 95000
  const bal = computeBalance(acct(), [a, b, c], [acct()], c.occurredAt);
  assert.equal(bal.amountPaise, 90000);
  assert.equal(bal.gaps.length, 1);
  assert.deepEqual(bal.gaps[0], { id: 'gap:c', accountId: 'acct:X:1111', beforeId: 'c', occurredAt: c.occurredAt, amountPaise: 5000, direction: 'debit' });
  // history: newest first, the gap right after (i.e. before, in time) its anchor
  assert.deepEqual(accountHistory([a, b, c], bal.gaps).map(i => i.type === 'gap' ? i.gap.id : i.transaction.id), ['c', 'gap:c', 'b', 'a']);
  // logging the missing debit on the account just before the anchor closes the gap
  const logged = txn({ id: 'm', amountPaise: 5000, status: 'manual', occurredAt: c.occurredAt - 1000 });
  assert.deepEqual(computeBalance(acct(), [a, b, logged, c], [acct()], c.occurredAt).gaps, []);
  assert.equal(largeGap(bal.gaps[0], 90000), true);   // > 5% of the balance
  assert.equal(largeGap({ ...bal.gaps[0], amountPaise: 100 }, 90000), false);
});

test('only Live rows count; merged copies and pending duplicates do not', () => {
  const a = txn({ amountPaise: 1000, bal: 50000 });
  const merged = txn({ amountPaise: 3000, status: 'merged' });
  const pending = txn({ amountPaise: 3000, status: 'duplicate_review' });
  const ignored = txn({ amountPaise: 3000, status: 'ignored' });
  assert.equal(computeBalance(acct(), [a, merged, pending, ignored], [acct()], a.occurredAt).amountPaise, 50000);
});

test('debit-card anchors count toward the bank account only once the card is linked', () => {
  const bank = acct({ id: 'acct:X:1111' });
  const card = acct({ id: 'acct:X:2222', last4: '2222', kind: 'debit_card' });
  const own = txn({ accountId: bank.id, amountPaise: 1000, bal: 100000 });
  const spend = txn({ accountId: card.id, amountPaise: 2000, bal: 97000 }); // card SMS states the bank balance
  const unlinked = computeBalance(bank, [own, spend], [bank, card], spend.occurredAt);
  assert.equal(unlinked.amountPaise, 100000);
  assert.equal(computeBalance(card, [own, spend], [bank, card], spend.occurredAt).kind, null);
  const linked = { ...card, fundedBy: bank.id };
  const b = computeBalance(bank, [own, spend], [bank, linked], spend.occurredAt);
  assert.equal(b.amountPaise, 97000);
  assert.equal(b.anchors, 2);
  assert.equal(b.gaps[0].amountPaise, 1000); // 100000 − 2000 = 98000 expected, bank said 97000
});

test('opening balance anchors an account that never states one; an SMS anchor takes over', () => {
  const opened = acct({ opening: 500000, openingAt: T0 + 10 * MIN });
  const before = txn({ occurredAt: T0 + 5 * MIN, amountPaise: 9999 });
  const after = txn({ occurredAt: T0 + 20 * MIN, amountPaise: 1000 });
  const b = computeBalance(opened, [before, after], [opened], T0 + 30 * MIN);
  assert.equal(b.amountPaise, 499000);
  assert.equal(b.needsOpening, false);
  assert.equal(computeBalance(acct(), [before, after], [acct()], T0).needsOpening, true);
  const anchored = txn({ occurredAt: T0 + 40 * MIN, amountPaise: 1000, bal: 200000 });
  assert.equal(computeBalance(opened, [before, after, anchored], [opened], T0 + 40 * MIN).amountPaise, 200000);
});

test('credit card: available without a limit, outstanding with one', () => {
  const card = acct({ id: 'acct:Y:3333', last4: '3333', kind: 'credit_card' });
  const s1 = txn({ accountId: card.id, amountPaise: 45000, lim: 9955000 });
  const s2 = txn({ accountId: card.id, amountPaise: 5000 });
  const pay = txn({ accountId: card.id, amountPaise: 20000, direction: 'credit' });
  const noLimit = computeBalance(card, [s1, s2, pay], [card], pay.occurredAt);
  assert.equal(noLimit.kind, 'available');
  assert.equal(noLimit.amountPaise, 9955000 - 5000 + 20000);
  assert.equal(noLimit.needsLimit, true);
  const limited = { ...card, creditLimitPaise: 10000000 };
  const b = computeBalance(limited, [s1, s2, pay], [limited], pay.occurredAt);
  assert.equal(b.kind, 'outstanding');
  assert.equal(b.amountPaise, 10000000 - 9955000 + 5000 - 20000);
});

test('stale after 30 days without an anchor; unknown accounts show nothing; Net', () => {
  const a = txn({ amountPaise: 1000, bal: 100000 });
  assert.equal(computeBalance(acct(), [a], [acct()], a.occurredAt + STALE_AFTER_MS + 1).stale, true);
  assert.equal(computeBalance(acct({ kind: 'unknown' }), [a], [acct({ kind: 'unknown' })], a.occurredAt).kind, null);
  const card = acct({ id: 'acct:Y:3333', last4: '3333', kind: 'credit_card', limit: 1000000 });
  const s = txn({ accountId: card.id, amountPaise: 1000, lim: 900000 });
  const all = computeBalances([a, s], [acct(), card], s.occurredAt);
  assert.equal(netWorth(all.values()), 100000 - 100000);
  assert.equal(netWorth([]), null);
});

// --- SQLite ------------------------------------------------------------------------------

test('v3 → v4 adds the columns and backfills stated figures from stored messages', async () => {
  const db = openDatabase();
  await seedV1(db);
  await migrate(db, 3);
  await migrate(db, 4);
  assert.equal(await readVersion(db), 4);
  const rows = await listTransactionRows(db);
  const before = v1Rows();
  assert.equal(rows.length, before.length);
  for (const r of before) {
    const t = rows.find(x => x.id === r.id);
    assert.equal(t.rawBody, r.raw_body);
    assert.equal(t.amountPaise, r.amount_paise);
    const expected = r.raw_body ? parseBankSms(r.raw_body)?.reportedBalancePaise ?? null : null;
    assert.equal(t.reportedBalancePaise, expected, r.id);
  }
  assert.ok(rows.some(t => t.reportedBalancePaise !== null), 'fixtures include anchors');
  assert.ok(rows.some(t => t.reportedAvlLimitPaise !== null), 'fixtures include card limits');
  const accounts = await listAccountRows(db);
  assert.ok(accounts.every(a => a.openingBalancePaise === null && a.creditLimitPaise === null));
});

test('opening balance and credit limit are stored, validated, cleared and backed up', async () => {
  const db = openDatabase();
  await seedV1(db);
  await migrate(db);
  const accounts = await listAccountRows(db);
  const bank = accounts.find(a => a.kind === 'bank');
  const card = accounts.find(a => a.kind === 'credit_card');
  await setOpeningBalanceSql(db, bank.id, 1234500, T0);
  await setCreditLimitSql(db, card.id, 10000000);
  await assert.rejects(setCreditLimitSql(db, bank.id, 100));
  await assert.rejects(setOpeningBalanceSql(db, card.id, 100, T0));
  await assert.rejects(setCreditLimitSql(db, card.id, -5));
  let after = await listAccountRows(db);
  assert.equal(after.find(a => a.id === bank.id).openingBalancePaise, 1234500);
  assert.equal(after.find(a => a.id === bank.id).openingBalanceAt, T0);
  assert.equal(after.find(a => a.id === card.id).creditLimitPaise, 10000000);

  const snapshot = JSON.parse(JSON.stringify(await exportSnapshotSql(db)));
  const restored = openDatabase();
  await seedV1(restored, []);
  await migrate(restored);
  await restoreSnapshotSql(restored, snapshot);
  const back = await listAccountRows(restored);
  assert.equal(back.find(a => a.id === card.id).creditLimitPaise, 10000000);
  assert.ok((await listTransactionRows(restored)).some(t => t.reportedBalancePaise !== null));

  await setOpeningBalanceSql(db, bank.id, null, T0);
  after = await listAccountRows(db);
  assert.equal(after.find(a => a.id === bank.id).openingBalanceAt, null);
});

test('a manual entry logged on an account keeps it and counts toward the balance', async () => {
  const db = openDatabase();
  await seedV1(db);
  await migrate(db);
  const accounts = await listAccountRows(db);
  const bank = accounts.find(a => a.kind === 'bank');
  await insertTransaction(db, { ...txn({ id: 'manual-1', status: 'manual', amountPaise: 700, accountId: bank.id }), sender: null, rawBody: null });
  const row = (await listTransactionRows(db)).find(t => t.id === 'manual-1');
  assert.equal(row.accountId, bank.id);
  // an SMS row never takes an account it didn't name
  await insertTransaction(db, { ...txn({ id: 'sms-1', accountId: bank.id }), sourceHash: 'h-sms-1' });
  assert.equal((await listTransactionRows(db)).find(t => t.id === 'sms-1').accountId, null);
});
