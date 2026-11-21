// Habits (WF-7, spec §5.5) on synthetic rows: invented payees, accounts and amounts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from './support/node-sqlite.mjs';
import { seedV1, smsTransaction } from './support/fixtures.mjs';
import { LATEST_VERSION, V1_SCHEMA, addHabitHidden, migrate, migrations, readVersion } from '../src/lib/migrations.ts';
import { exportSnapshotSql, ingestScanSql, listPayeeRows, listTransactionRows, renamePayeeSql, restoreSnapshotSql, setHabitHiddenSql } from '../src/lib/ledger.ts';
import { detectHabits, ownTransferDebits, selfTransferPayees, groupMembers, groupRows, habitDetail, habitFor, isHabitHidden, lastSpendLabel, roughRupees } from '../src/lib/habits.ts';
import { matchSchedules } from '../src/lib/schedules.ts';
import { byId } from '../src/lib/resolve.ts';

const DAY = 86_400_000;
// 10:00 IST on a calendar day.
const at = (y, m, d, h = 10) => Date.UTC(y, m - 1, d, h) - 330 * 60_000;
const NOW = at(2026, 6, 15);
const NONE = { matches: new Map() };
let seq = 0;
function txn(over = {}) {
  seq++;
  return {
    id: over.id ?? `h${String(seq).padStart(4, '0')}`, sourceHash: null, sender: 'VM-HDFCBK', rawBody: 'x', occurredAt: 0,
    merchant: 'm', amountPaise: 45000, direction: 'debit', category: 'Groceries', status: 'auto',
    accountLast4: '9012', counterpartyMasked: null, counterpartyLast4: null, reference: null, confidence: 0.95,
    createdAt: seq, updatedAt: seq, accountId: 'acct:HDFC:9012', payeeId: 'p-grocer', payeeOverrideId: null, categoryByUser: false,
    duplicateOf: null, preFlagStatus: null, duplicateCleared: false, ...over,
  };
}
const merchant = (id, name = null, over = {}) => ({ id, kind: 'merchant', bank: '', key: id, masked: id, name, category: null, nudgedAt: null, createdAt: 0, habitHidden: false, ...over });
const masked = (id, last4, over = {}) => ({ ...merchant(id), kind: 'masked', bank: 'HDFC', key: last4, masked: `**${last4}`, ...over });
const ACCOUNTS = [
  { id: 'acct:HDFC:9012', bank: 'HDFC', last4: '9012', kind: 'bank', fundedBy: null, name: 'Salary account', createdAt: 0, openingBalancePaise: null, openingBalanceAt: null, creditLimitPaise: null },
  { id: 'acct:ICICI:7788', bank: 'ICICI', last4: '7788', kind: 'credit_card', fundedBy: null, name: null, createdAt: 0, openingBalancePaise: null, openingBalanceAt: null, creditLimitPaise: null },
];
// One spend on the 3rd of each of the months given (2026), at the payee given.
const spends = (payeeId, months, over = {}) => months.map(m => txn({ payeeId, occurredAt: at(2026, m, 3), ...over }));

test('threshold: ≥4 spends across ≥3 calendar months in the trailing 365 days', () => {
  const payees = byId([merchant('p-a'), merchant('p-b'), merchant('p-c')]);
  const rows = [
    ...spends('p-a', [3, 4, 5, 6]), // 4 spends, 4 months
    ...spends('p-b', [5, 5, 6, 6, 6]), // 5 spends, 2 months
    ...spends('p-c', [4, 5, 6]), // 3 spends
  ];
  const habits = detectHabits(rows, NONE, payees, ACCOUNTS, NOW);
  assert.deepEqual(habits.map(h => h.groupKey), ['p-a']);
  // Amount isn't checked: wildly different baskets still count.
  const wide = spends('p-b', [2, 3, 4, 5]).map((t, i) => ({ ...t, amountPaise: [9900, 250000, 61000, 1500][i] }));
  assert.equal(detectHabits(wide, NONE, payees, ACCOUNTS, NOW).length, 1);
  // Older than 365 days doesn't count.
  const old = [...spends('p-a', [6]), ...[1, 2, 3].map(m => txn({ payeeId: 'p-a', occurredAt: at(2025, m, 3) }))];
  assert.equal(detectHabits(old, NONE, payees, ACCOUNTS, NOW).length, 0);
});

test('state: Active when the last spend is ≤60 days ago, otherwise Faded; Active first', () => {
  const payees = byId([merchant('p-new'), merchant('p-old')]);
  const rows = [...spends('p-new', [3, 4, 5, 6]), ...spends('p-old', [1, 2, 3, 4])];
  const habits = detectHabits(rows, NONE, payees, ACCOUNTS, NOW);
  assert.deepEqual(habits.map(h => [h.groupKey, h.state]), [['p-new', 'active'], ['p-old', 'faded']]);
  const [h] = habits;
  assert.equal(h.count, 4);
  assert.equal(h.since, at(2026, 3, 3));
  assert.equal(h.lastAt, at(2026, 6, 3));
  assert.equal(h.perMonthPaise, 45000, '₹1,800 over Mar–Jun');
  // Exactly 60 days is still Active.
  assert.equal(detectHabits(spends('p-new', [2, 3, 4]).concat(txn({ payeeId: 'p-new', occurredAt: NOW - 60 * DAY })), NONE, payees, ACCOUNTS, NOW)[0].state, 'active');
});

test('Active habits sort by trailing-90-day spend', () => {
  const payees = byId([merchant('p-small'), merchant('p-big')]);
  const rows = [...spends('p-small', [1, 2, 5, 6]), ...spends('p-big', [1, 2, 3, 6], { amountPaise: 30000 }), txn({ payeeId: 'p-big', occurredAt: at(2026, 5, 20), amountPaise: 90000 })];
  assert.deepEqual(detectHabits(rows, NONE, payees, ACCOUNTS, NOW).map(h => h.groupKey), ['p-big', 'p-small']);
});

test('input: debits only, Live rows only (a pending duplicate counts once)', () => {
  const payees = byId([merchant('p-a')]);
  const base = spends('p-a', [3, 4, 5]);
  const extra = [
    txn({ payeeId: 'p-a', occurredAt: at(2026, 6, 1), direction: 'credit' }),
    txn({ payeeId: 'p-a', occurredAt: at(2026, 6, 1), status: 'ignored' }),
    txn({ payeeId: 'p-a', occurredAt: at(2026, 6, 1), status: 'merged' }),
    txn({ payeeId: 'p-a', occurredAt: at(2026, 6, 1), status: 'duplicate_review' }),
  ];
  assert.equal(detectHabits([...base, ...extra], NONE, payees, ACCOUNTS, NOW).length, 0);
  assert.equal(detectHabits([...base, txn({ payeeId: 'p-a', occurredAt: at(2026, 6, 1), status: 'manual' })], NONE, payees, ACCOUNTS, NOW).length, 1);
});

test('never a Habit: no payee, own accounts by last4 or name, card bills, Not a habit', () => {
  const payees = byId([
    masked('p-self', '9012'), masked('p-card', '7788'), masked('p-friend', '5280'),
    merchant('p-named-self', 'Salary Account'), merchant('p-hidden', null, { habitHidden: true }),
  ]);
  const rows = ['p-self', 'p-card', 'p-friend', 'p-named-self', 'p-hidden', null].flatMap(id => spends(id, [3, 4, 5, 6]));
  assert.deepEqual(detectHabits(rows, NONE, payees, ACCOUNTS, NOW).map(h => h.groupKey), ['p-friend'],
    'a masked payee that is not one of your accounts can still be a Habit');
});

test('own-account transfers: paired debits never count; a mostly-paired payee is a self-transfer', () => {
  const payees = byId([merchant('p-handle'), merchant('p-gpay'), merchant('p-shop')]);
  const credit = (d, over = {}) => txn({ direction: 'credit', payeeId: null, accountId: 'acct:PNB:7712', amountPaise: d.amountPaise, occurredAt: d.occurredAt, ...over });
  // Own UPI handle: 6 debits, 4 with the receiving credit SMS (2 missed).
  const handle = [2, 3, 4, 5, 6, 6].map((m, i) => txn({ payeeId: 'p-handle', amountPaise: 5_900_000, occurredAt: at(2026, m, 1 + i) }));
  const handleCredits = handle.slice(0, 4).map(d => credit(d));
  // A wallet: 5 real purchases plus 3 card bills paid through it (credit on the card 15 min later).
  const buys = spends('p-gpay', [2, 3, 4, 5, 6], { amountPaise: 49900 });
  const bills = [3, 4, 5].map(m => txn({ payeeId: 'p-gpay', amountPaise: 1_234_500, occurredAt: at(2026, m, 20) }));
  const billCredits = bills.map(d => credit(d, { accountId: 'acct:ICICI:7788', occurredAt: d.occurredAt + 15 * 60_000 }));
  // Not pairs: same account, too late, different amount, credit well before the debit.
  const shop = spends('p-shop', [2, 3, 4, 5]);
  const near = [
    credit(shop[0], { accountId: shop[0].accountId }),
    credit(shop[1], { occurredAt: shop[1].occurredAt + 31 * 60_000 }),
    credit(shop[2], { amountPaise: shop[2].amountPaise + 100 }),
    credit(shop[3], { occurredAt: shop[3].occurredAt - 3 * 60_000 }),
  ];
  const rows = [...handle, ...handleCredits, ...buys, ...bills, ...billCredits, ...shop, ...near];
  const paired = ownTransferDebits(rows);
  assert.deepEqual([...paired].sort(), [...handle.slice(0, 4), ...bills].map(t => t.id).sort());
  assert.deepEqual([...selfTransferPayees(rows, paired)], ['p-handle'], 'the wallet is mostly real purchases');
  const habits = detectHabits(rows, NONE, payees, ACCOUNTS, NOW);
  assert.deepEqual(habits.map(h => [h.groupKey, h.count]), [['p-gpay', 5], ['p-shop', 4]]);
  // One credit pairs with one debit only.
  const twin = [txn({ payeeId: 'p-shop', occurredAt: at(2026, 6, 1) }), txn({ payeeId: 'p-shop', occurredAt: at(2026, 6, 1) + 60_000 })];
  assert.equal(ownTransferDebits([...twin, credit(twin[0])]).size, 1);
});

test('grouping by display name: two variants named the same form one Habit at once', () => {
  const unnamed = byId([merchant('p-z1'), merchant('p-z2')]);
  const rows = [...spends('p-z1', [3, 4]), ...spends('p-z2', [5, 6])];
  assert.equal(detectHabits(rows, NONE, unnamed, ACCOUNTS, NOW).length, 0);
  const named = byId([merchant('p-z1', 'Zomato'), merchant('p-z2', ' zomato ')]);
  const [h] = detectHabits(rows, NONE, named, ACCOUNTS, NOW);
  assert.equal(h.groupKey, 'zomato');
  assert.equal(h.count, 4);
  assert.deepEqual(h.payeeIds, ['p-z1', 'p-z2']);
  // A moved row ("Move this one") counts for the payee it was moved to.
  const moved = [...spends('p-z1', [3, 4, 5]), txn({ payeeId: 'p-other', payeeOverrideId: 'p-z1', occurredAt: at(2026, 6, 3) })];
  assert.equal(detectHabits(moved, NONE, byId([merchant('p-z1'), merchant('p-other')]), ACCOUNTS, NOW)[0].count, 4);
  // Not a habit on any member hides the whole group.
  const hidden = byId([merchant('p-z1', 'Zomato'), merchant('p-z2', 'Zomato', { habitHidden: true })]);
  assert.equal(detectHabits(rows, NONE, hidden, ACCOUNTS, NOW).length, 0);
  assert.equal(isHabitHidden(hidden.get('p-z1'), hidden.values()), true);
  assert.deepEqual(groupMembers(named.get('p-z2'), named.values()), ['p-z1', 'p-z2']);
});

test('Schedule wins per row: matched rows are removed; leftovers can still form a Habit', () => {
  const payees = byId([merchant('p-play')]);
  const subs = [1, 2, 3, 4, 5, 6].map(m => txn({ payeeId: 'p-play', occurredAt: at(2026, m, 10), amountPaise: 29900 }));
  const schedule = { id: 's1', payeeId: 'p-play', accountId: 'acct:HDFC:9012', direction: 'debit', interval: 'monthly', anchorDay: 10, anchorMonth: null,
    amountMin: 24000, amountMax: 36000, lastPaidAt: at(2025, 12, 10), status: 'active', createdAt: at(2026, 1, 10), decidedAt: at(2026, 1, 10) };
  const matches = matchSchedules(subs, [schedule], payees, NOW);
  assert.equal(matches.matches.size, 6);
  assert.equal(detectHabits(subs, NONE, payees, ACCOUNTS, NOW).length, 1, 'untracked, the subscription looks like a Habit');
  assert.equal(detectHabits(subs, matches, payees, ACCOUNTS, NOW).length, 0, 'tracked, none of its rows count');
  const extras = spends('p-play', [2, 4, 5, 6], { amountPaise: 8900 });
  const both = [...subs, ...extras];
  const [h] = detectHabits(both, matchSchedules(both, [schedule], payees, NOW), payees, ACCOUNTS, NOW);
  assert.equal(h.count, 4, 'only the extra purchases');
  // An ended Schedule's matches still win.
  const ended = { ...schedule, status: 'ended', decidedAt: NOW };
  assert.equal(detectHabits(subs, matchSchedules(subs, [ended], payees, NOW), payees, ACCOUNTS, NOW).length, 0);
});

test('display: rough per-month, relative last spend, no date or range wording', () => {
  assert.equal(roughRupees(140_000), '~₹1.4k');
  assert.equal(roughRupees(85_000), '~₹850');
  assert.equal(roughRupees(2_340_000), '~₹23k');
  assert.equal(roughRupees(15_000_000), '~₹1.5L');
  assert.equal(lastSpendLabel(NOW - 3 * DAY, NOW), 'last 3 days ago');
  assert.equal(lastSpendLabel(NOW - 1 * DAY, NOW), 'last yesterday');
  assert.equal(lastSpendLabel(NOW - 100 * DAY, NOW), 'last 3 months ago');
  const payees = byId([merchant('p-a', 'Grocer')]);
  const [h] = detectHabits(spends('p-a', [3, 4, 5, 6]), NONE, payees, ACCOUNTS, NOW);
  const text = habitDetail(h, NOW);
  assert.equal(text, '4 spends since Mar 2026 · ~₹450/month · last 12 days ago');
  assert.doesNotMatch(text, /due|upcoming|next|expected|–|\bto\b/i);
  assert.equal(habitFor(payees.get('p-a'), [h]), h);
  assert.deepEqual(groupRows('grocer', spends('p-a', [1, 2]), payees).map(t => t.occurredAt), [at(2026, 2, 3), at(2026, 1, 3)]);
});

// --- Through SQLite -------------------------------------------------------------------

const HABIT_VERSION = migrations.indexOf(addHabitHidden) + 2;
const card = (mm, dd, merchantName = 'FRESHCART') =>
  `ALERT:Rs.450.00 spent via HDFC BANK Debit Card xx4455 at ${merchantName} on 2026-${mm}-${dd}:10:00:00 Avl bal: INR 1000.00`;
const SQL_NOW = Date.UTC(2026, 5, 20, 6);

async function ledgerWithHabit() {
  const db = openDatabase();
  await db.execAsync(V1_SCHEMA);
  await migrate(db);
  const transactions = [['02', '04'], ['03', '09'], ['04', '13'], ['05', '22'], ['06', '01']]
    .map(([mm, dd], i) => smsTransaction('VM-HDFCBK-S', card(mm, dd, i % 2 ? 'FRESHCART PVT LTD' : 'FRESHCART'), Date.UTC(2026, Number(mm) - 1, Number(dd), 5), `g${i}`));
  await ingestScanSql(db, { transactions, unparsed: [] }, SQL_NOW);
  return db;
}
async function habitsOf(db) {
  const rows = await listTransactionRows(db);
  return detectHabits(rows, NONE, byId(await listPayeeRows(db)), [], SQL_NOW);
}

test('v5 → v6: only adds payees.habit_hidden, defaulting off', async () => {
  assert.equal(HABIT_VERSION, 6);
  assert.equal(LATEST_VERSION, HABIT_VERSION);
  const db = openDatabase();
  await seedV1(db);
  await migrate(db, HABIT_VERSION - 1);
  const before = await db.getAllAsync('SELECT * FROM payees ORDER BY id');
  assert.ok(before.length > 0);
  await migrate(db);
  assert.equal(await readVersion(db), 6);
  const after = await db.getAllAsync('SELECT * FROM payees ORDER BY id');
  assert.deepEqual(after.map(({ habit_hidden, ...rest }) => rest), before);
  assert.ok(after.every(p => p.habit_hidden === 0));
  assert.ok((await listPayeeRows(db)).every(p => p.habitHidden === false));
});

test('renaming two variant payees merges their Habit; Not a habit survives a rescan and a backup', async () => {
  const db = await ledgerWithHabit();
  assert.equal((await habitsOf(db)).length, 0, 'split across two merchant strings: 3 + 2 spends');
  const variants = (await listPayeeRows(db)).filter(p => /freshcart/i.test(p.masked ?? ''));
  assert.equal(variants.length, 2);
  for (const p of variants) await renamePayeeSql(db, p.id, 'FreshCart');
  const [h] = await habitsOf(db);
  assert.equal(h.label, 'FreshCart');
  assert.equal(h.count, 5);

  await setHabitHiddenSql(db, groupMembers(variants[0], variants), true);
  assert.equal((await habitsOf(db)).length, 0);
  // A rescan of the same messages adds nothing and keeps the decision.
  const rescan = [['06', '01']].map(([mm, dd]) => smsTransaction('VM-HDFCBK-S', card(mm, dd), Date.UTC(2026, 5, 1, 5), 'g4'));
  await ingestScanSql(db, { transactions: rescan, unparsed: [] }, SQL_NOW);
  assert.equal((await habitsOf(db)).length, 0);

  const snapshot = JSON.parse(JSON.stringify(await exportSnapshotSql(db)));
  assert.ok(snapshot.payees.every(p => 'habit_hidden' in p));
  const restored = openDatabase();
  await restored.execAsync(V1_SCHEMA);
  await migrate(restored);
  await restoreSnapshotSql(restored, snapshot);
  assert.equal((await habitsOf(restored)).length, 0);
  // Turning it back off brings the Habit back: nothing else was stored.
  await setHabitHiddenSql(restored, variants.map(p => p.id), false);
  assert.equal((await habitsOf(restored)).length, 1);
});

test('a v5 backup (no habit_hidden column) restores and migrates with Habits on', async () => {
  const db = await ledgerWithHabit();
  const snapshot = JSON.parse(JSON.stringify(await exportSnapshotSql(db)));
  const v5 = { ...snapshot, schemaVersion: 5, payees: snapshot.payees.map(({ habit_hidden, ...rest }) => rest) };
  const restored = openDatabase();
  await restored.execAsync(V1_SCHEMA);
  await migrate(restored);
  await restoreSnapshotSql(restored, v5);
  assert.equal(await readVersion(restored), 6);
  assert.ok((await listPayeeRows(restored)).every(p => p.habitHidden === false));
});
