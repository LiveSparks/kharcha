// Schedules through SQLite (P4): the migration step, stored decisions and backups.
// Synthetic SMS shapes only: invented card digits, merchant and amounts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from './support/node-sqlite.mjs';
import { seedV1, smsTransaction } from './support/fixtures.mjs';
import { LATEST_VERSION, V1_SCHEMA, addSchedules, migrate, migrations, readVersion } from '../src/lib/migrations.ts';
import {
  endScheduleSql, exportSnapshotSql, ingestScanSql, insertScheduleSql, listPayeeRows, listScheduleRows, listTransactionRows,
  renamePayeeSql, restoreSnapshotSql, updateScheduleTermsSql,
} from '../src/lib/ledger.ts';
import { detectSeries, draftFromCandidate, matchSchedules, suggestionsFrom } from '../src/lib/schedules.ts';
import { byId } from '../src/lib/resolve.ts';

// The version the schedules step produces, wherever it sits in the list.
const SCHEDULES_VERSION = migrations.indexOf(addSchedules) + 2;
const MONTHS = ['01', '02', '03', '04', '05'];
const card = (mm, amount = '299.00', merchant = 'CLOUDSUITE') =>
  `ALERT:Rs.${amount} spent via HDFC BANK Debit Card xx4455 at ${merchant} on 2026-${mm}-06:10:00:00 Avl bal: INR 1000.00`;
const NOW = Date.UTC(2026, 4, 20, 6);

async function ledgerWithSeries() {
  const db = openDatabase();
  await db.execAsync(V1_SCHEMA);
  await migrate(db);
  const transactions = MONTHS.map((mm, i) => smsTransaction('VM-HDFCBK-S', card(mm), Date.UTC(2026, i, 6, 5), `c${i}`));
  await ingestScanSql(db, { transactions, unparsed: [] }, NOW);
  return db;
}

async function detect(db) {
  const rows = await listTransactionRows(db);
  const payees = byId(await listPayeeRows(db));
  const schedules = await listScheduleRows(db);
  const candidates = detectSeries(rows, payees, NOW);
  return { rows, payees, schedules, candidates, suggestions: suggestionsFrom(candidates, schedules, payees) };
}

test('the schedules step only creates the table and records the next version', async () => {
  assert.ok(SCHEDULES_VERSION >= 4);
  assert.equal(LATEST_VERSION >= SCHEDULES_VERSION, true);
  const db = openDatabase();
  await seedV1(db);
  await migrate(db, SCHEDULES_VERSION - 1);
  assert.equal(await db.getFirstAsync("SELECT name FROM sqlite_master WHERE name='schedules'"), null);
  const before = await db.getAllAsync('SELECT * FROM transactions ORDER BY id');
  await migrate(db, SCHEDULES_VERSION);
  assert.equal(await readVersion(db), SCHEDULES_VERSION);
  assert.deepEqual(await db.getAllAsync('SELECT * FROM transactions ORDER BY id'), before);
  assert.deepEqual(await listScheduleRows(db), [], 'no backfill');
  await assert.rejects(db.runAsync("INSERT INTO schedules (id,payee_id,direction,interval,anchor_day,amount_min,amount_max,status,created_at,decided_at) VALUES ('x','p','debit','yearly',1,1,1,'active',0,0)"));
  assert.equal(await migrate(db), LATEST_VERSION);
});

test('first detection after upgrade suggests the series; Track it stores an active Schedule that reads Paid', async () => {
  const db = await ledgerWithSeries();
  const { suggestions } = await detect(db);
  assert.equal(suggestions.length, 1);
  const [c] = suggestions;
  assert.equal(c.interval, 'monthly');
  assert.equal(c.hits.length, 5);
  await insertScheduleSql(db, { ...draftFromCandidate(c), id: 's1', status: 'active', createdAt: NOW, decidedAt: NOW });
  const after = await detect(db);
  assert.equal(after.suggestions.length, 0, 'a tracked series is not suggested again');
  const { state, matches } = matchSchedules(after.rows, after.schedules, after.payees, NOW);
  assert.equal(state.get('s1').state, 'paid');
  assert.equal(matches.size, 5);
});

test('Not a schedule survives a rescan and renaming the payee', async () => {
  const db = await ledgerWithSeries();
  const [c] = (await detect(db)).suggestions;
  await insertScheduleSql(db, { ...draftFromCandidate(c), id: 'd1', status: 'dismissed', createdAt: NOW, decidedAt: NOW });
  // A rescan of the same SMS changes nothing; a new month extends the dismissed series.
  await ingestScanSql(db, { transactions: [smsTransaction('VM-HDFCBK-S', card('05'), Date.UTC(2026, 4, 6, 5), 'again')], unparsed: [] }, NOW);
  await ingestScanSql(db, { transactions: [smsTransaction('VM-HDFCBK-S', card('06'), Date.UTC(2026, 5, 6, 5), 'c5')], unparsed: [] }, NOW);
  assert.equal((await detect(db)).suggestions.length, 0);
  await renamePayeeSql(db, c.payeeId, 'Cloud Suite');
  assert.equal((await detect(db)).suggestions.length, 0);
  const stored = await listScheduleRows(db);
  assert.deepEqual(stored.map(s => s.status), ['dismissed']);
});

test('editing terms and Stop tracking are user decisions; ended keeps the row', async () => {
  const db = await ledgerWithSeries();
  const [c] = (await detect(db)).suggestions;
  await insertScheduleSql(db, { ...draftFromCandidate(c), id: 's1', status: 'active', createdAt: NOW, decidedAt: NOW });
  await updateScheduleTermsSql(db, 's1', { interval: 'monthly', anchorDay: 7, anchorMonth: null, amountMin: 25000, amountMax: 40000 }, NOW + 1);
  let [s] = await listScheduleRows(db);
  assert.deepEqual([s.anchorDay, s.amountMin, s.amountMax, s.decidedAt], [7, 25000, 40000, NOW + 1]);
  await assert.rejects(updateScheduleTermsSql(db, 's1', { interval: 'monthly', anchorDay: 40, anchorMonth: null, amountMin: 1, amountMax: 2 }));
  await assert.rejects(insertScheduleSql(db, { ...s, id: 'bad', amountMin: 0 }));
  await endScheduleSql(db, 's1', NOW + 2);
  [s] = await listScheduleRows(db);
  assert.equal(s.status, 'ended');
  await updateScheduleTermsSql(db, 's1', { interval: 'weekly', anchorDay: 1, anchorMonth: null, amountMin: 1, amountMax: 2 });
  assert.equal((await listScheduleRows(db))[0].interval, 'monthly', 'an ended Schedule is not edited');
  assert.equal((await detect(db)).suggestions.length, 0, 'an ended Schedule is never re-suggested');
});

test('backups carry schedules; an older snapshot restores with none and migrates forward', async () => {
  const db = await ledgerWithSeries();
  const [c] = (await detect(db)).suggestions;
  await insertScheduleSql(db, { ...draftFromCandidate(c), id: 's1', status: 'active', createdAt: NOW, decidedAt: NOW });
  const snapshot = JSON.parse(JSON.stringify(await exportSnapshotSql(db)));
  assert.equal(snapshot.schedules.length, 1);
  const restored = openDatabase();
  await restored.execAsync(V1_SCHEMA);
  await migrate(restored);
  await restoreSnapshotSql(restored, snapshot);
  assert.deepEqual(await listScheduleRows(restored), await listScheduleRows(db));

  const older = { ...snapshot, schemaVersion: SCHEDULES_VERSION - 1 };
  delete older.schedules;
  await restoreSnapshotSql(restored, older);
  assert.equal(await readVersion(restored), LATEST_VERSION);
  assert.deepEqual(await listScheduleRows(restored), []);
  assert.equal((await listTransactionRows(restored)).length, MONTHS.length);
});
