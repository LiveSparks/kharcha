import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from './support/node-sqlite.mjs';
import { MESSAGES, MANUAL_ROW, T0, seedV1, smsTransaction, v1Rows } from './support/fixtures.mjs';
import { LATEST_VERSION, NewerLedgerError, V1_SCHEMA, migrate, readVersion } from '../src/lib/migrations.ts';
import {
  exportSnapshotSql, insertTransaction, linkDebitCardSql, listAccountRows, listPayeeRows, listTransactionRows,
  movePayeeSql, renamePayeeSql, restoreSnapshotSql, setTransactionCategorySql,
} from '../src/lib/ledger.ts';
import { byId, effectiveCategory, payeeReach, transactionLabel } from '../src/lib/resolve.ts';

async function migratedFixture() {
  const db = openDatabase();
  await seedV1(db);
  await migrate(db);
  return db;
}

test('v1 → v2: version, row count and every raw parser field are unchanged', async () => {
  const db = openDatabase();
  await seedV1(db);
  assert.equal(await readVersion(db), 1); // user_version 0 counts as v1
  const before = await db.getAllAsync('SELECT * FROM transactions ORDER BY id');
  assert.equal(await migrate(db), 2);
  assert.equal((await db.getFirstAsync('PRAGMA user_version')).user_version, 2);
  const after = await db.getAllAsync('SELECT * FROM transactions ORDER BY id');
  assert.equal(after.length, before.length);
  for (const [i, row] of before.entries()) {
    for (const [key, value] of Object.entries(row)) assert.equal(after[i][key], value, `${row.id}.${key}`);
  }
});

test('v1 → v2: accounts, payees and counterparty_masked are backfilled', async () => {
  const db = await migratedFixture();
  const rows = await listTransactionRows(db);
  for (const t of rows) {
    if (t.accountLast4 && t.sender) assert.ok(t.accountId, `${t.id} has an account`);
    if (t.merchant !== 'Unknown merchant' || t.counterpartyLast4) assert.ok(t.payeeId, `${t.id} has a payee`);
  }
  const accounts = await listAccountRows(db);
  assert.deepEqual(accounts.map(a => `${a.bank}:${a.last4}:${a.kind}`).sort(), [
    'HDFC:4455:debit_card', 'HDFC:9012:bank', 'ICICI:6611:credit_card', 'PNB:3344:bank',
  ]);
  const masked = rows.filter(t => t.counterpartyMasked).map(t => `${t.id}:${t.counterpartyMasked}`).sort();
  assert.deepEqual(masked, ['t003:**7788', 't004:**7788', 't010:XXXXXXXXXX5566']);
  const payees = await listPayeeRows(db);
  const fresh = payees.find(p => p.key === 'fresh basket');
  assert.equal(fresh.masked, 'Fresh Basket', 'first-seen display form, not the spacing variant');
  assert.equal(rows.filter(t => t.payeeId === fresh.id).length, 3, 'spacing/case variants share one payee');
  const transfer = payees.find(p => p.kind === 'masked');
  assert.deepEqual({ bank: transfer.bank, key: transfer.key, masked: transfer.masked }, { bank: 'HDFC', key: '7788', masked: '**7788' });
  const manual = rows.find(t => t.id === MANUAL_ROW.id);
  assert.equal(manual.accountId, null);
  assert.equal(payees.find(p => p.id === manual.payeeId).key, 'corner chai');
  assert.equal(manual.categoryByUser, true);
  assert.equal(rows.filter(t => t.categoryByUser).length, 1);
});

test('a failed step leaves v1 in place and is retried on the next launch', async () => {
  const db = openDatabase();
  await seedV1(db);
  // Pre-create a conflicting table so v1→v2 fails half-way.
  await db.execAsync('CREATE TABLE payees (id TEXT)');
  await assert.rejects(migrate(db));
  assert.equal(await readVersion(db), 1);
  const columns = (await db.getAllAsync('PRAGMA table_info(transactions)')).map(c => c.name);
  assert.ok(!columns.includes('payee_id'), 'ALTERs rolled back with the failed step');
  assert.equal(await db.getFirstAsync("SELECT name FROM sqlite_master WHERE name='accounts'"), null);
  await db.execAsync('DROP TABLE payees');
  assert.equal(await migrate(db), 2);
});

test('a ledger from a newer app version is refused', async () => {
  const db = openDatabase();
  await db.execAsync(V1_SCHEMA);
  await db.execAsync(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
  await assert.rejects(migrate(db), NewerLedgerError);
});

test('a fresh install reaches the latest version with empty identity tables', async () => {
  const db = openDatabase();
  await db.execAsync(V1_SCHEMA);
  assert.equal(await migrate(db), LATEST_VERSION);
  assert.equal((await listAccountRows(db)).length, 0);
});

test('ingest resolves a new SMS to the existing, named payee with no action', async () => {
  const db = await migratedFixture();
  const transfer = (await listPayeeRows(db)).find(p => p.kind === 'masked');
  await renamePayeeSql(db, transfer.id, '  Landlord ');
  const body = 'HDFC Bank:Rs. 1250.00 debited from a/c *9012 on 19/03/26 to a/c **7788 (UPI Ref No. 600000000125)';
  assert.equal(await insertTransaction(db, smsTransaction('VM-HDFCBK-S', body, T0 + 18 * 86_400_000, 'n001')), true);
  assert.equal(await insertTransaction(db, smsTransaction('VM-HDFCBK-S', body, T0 + 18 * 86_400_000, 'n001')), false, 'same hash is not inserted twice');
  const payees = byId(await listPayeeRows(db));
  const rows = await listTransactionRows(db);
  const added = rows.find(t => t.id === 'n001');
  assert.equal(added.payeeId, transfer.id);
  assert.equal(added.counterpartyMasked, '**7788');
  assert.equal(transactionLabel(added, payees), 'Landlord');
  assert.equal(payeeReach(transfer.id, rows), 3);
  assert.equal((await listPayeeRows(db)).length, payees.size, 'no new payee');
});

test('naming and clearing a payee never rewrites transactions', async () => {
  const db = await migratedFixture();
  const before = await db.getAllAsync('SELECT * FROM transactions ORDER BY id');
  const fresh = (await listPayeeRows(db)).find(p => p.key === 'fresh basket');
  await renamePayeeSql(db, fresh.id, 'Sabzi wala', 'Groceries');
  let payees = byId(await listPayeeRows(db));
  let rows = await listTransactionRows(db);
  const mine = rows.filter(t => t.payeeId === fresh.id);
  assert.ok(mine.every(t => transactionLabel(t, payees) === 'Sabzi wala'));
  assert.ok(mine.every(t => effectiveCategory(t, payees) === 'Groceries'));
  // A hand-set category wins over the payee default.
  await setTransactionCategorySql(db, mine[0].id, 'Health');
  payees = byId(await listPayeeRows(db));
  rows = await listTransactionRows(db);
  assert.equal(effectiveCategory(rows.find(t => t.id === mine[0].id), payees), 'Health');
  assert.equal(effectiveCategory(rows.find(t => t.id === mine[1].id), payees), 'Groceries');
  await renamePayeeSql(db, fresh.id, null, null);
  payees = byId(await listPayeeRows(db));
  assert.equal(transactionLabel(mine[1], payees), 'Fresh Basket');
  const after = await db.getAllAsync('SELECT merchant FROM transactions ORDER BY id');
  assert.deepEqual(after.map(r => r.merchant), before.map(r => r.merchant));
  await assert.rejects(renamePayeeSql(db, fresh.id, 'x'.repeat(41)));
});

test('Move this one changes only that row, and moving back clears the override', async () => {
  const db = await migratedFixture();
  const transfer = (await listPayeeRows(db)).find(p => p.kind === 'masked');
  const [first, second] = (await listTransactionRows(db)).filter(t => t.payeeId === transfer.id);
  const newId = await movePayeeSql(db, first.id, { newName: 'Cousin' });
  const created = (await listPayeeRows(db)).find(p => p.id === newId);
  assert.deepEqual({ kind: created.kind, bank: created.bank, key: created.key, name: created.name }, { kind: 'masked', bank: 'HDFC', key: '7788#1', name: 'Cousin' });
  const payees = byId(await listPayeeRows(db));
  let rows = await listTransactionRows(db);
  assert.equal(transactionLabel(rows.find(t => t.id === first.id), payees), 'Cousin');
  assert.equal(rows.find(t => t.id === second.id).payeeOverrideId, null);
  assert.equal(rows.find(t => t.id === first.id).payeeId, transfer.id, 'ingest payee untouched');
  const another = await movePayeeSql(db, second.id, { newName: 'Neighbour' });
  assert.ok(another.endsWith('7788#2'));
  await movePayeeSql(db, first.id, transfer.id);
  rows = await listTransactionRows(db);
  assert.equal(rows.find(t => t.id === first.id).payeeOverrideId, null);
});

test('linking a card to a bank account confirms it as a debit card; unlinking keeps the kind', async () => {
  const db = await migratedFixture();
  await linkDebitCardSql(db, 'acct:HDFC:4455', 'acct:HDFC:9012');
  let card = (await listAccountRows(db)).find(a => a.id === 'acct:HDFC:4455');
  assert.equal(card.fundedBy, 'acct:HDFC:9012');
  await linkDebitCardSql(db, card.id, null);
  card = (await listAccountRows(db)).find(a => a.id === 'acct:HDFC:4455');
  assert.equal(card.fundedBy, null);
  assert.equal(card.kind, 'debit_card');
  await assert.rejects(linkDebitCardSql(db, card.id, card.id));
});

test('backup schema 2 round-trips names, links and overrides', async () => {
  const db = await migratedFixture();
  const transfer = (await listPayeeRows(db)).find(p => p.kind === 'masked');
  await renamePayeeSql(db, transfer.id, 'Landlord', 'Bills');
  await linkDebitCardSql(db, 'acct:HDFC:4455', 'acct:HDFC:9012');
  const moved = (await listTransactionRows(db)).find(t => t.payeeId === transfer.id);
  await movePayeeSql(db, moved.id, { newName: 'Cousin' });
  const snapshot = JSON.parse(JSON.stringify(await exportSnapshotSql(db)));
  assert.equal(snapshot.schema, 2);
  assert.equal(snapshot.schemaVersion, 2);
  assert.ok('category_by_user' in snapshot.transactions[0], 'rows carry every column');

  const restored = openDatabase();
  await restored.execAsync(V1_SCHEMA);
  await migrate(restored);
  await insertTransaction(restored, smsTransaction(...MESSAGES[0].slice(0, 2), T0, 'stale'));
  await restoreSnapshotSql(restored, snapshot);
  assert.equal(await readVersion(restored), 2);
  const again = await exportSnapshotSql(restored);
  for (const table of ['transactions', 'accounts', 'payees', 'budgets', 'senders', 'preferences']) {
    const key = r => JSON.stringify(Object.entries(r).sort());
    assert.deepEqual(again[table].map(key).sort(), snapshot[table].map(key).sort(), table);
  }
});

test('restoring a schema-1 snapshot loads v1 tables and migrates forward', async () => {
  const camel = r => ({
    id: r.id, sourceHash: r.source_hash, sender: r.sender, rawBody: r.raw_body, occurredAt: r.occurred_at,
    merchant: r.merchant, amountPaise: r.amount_paise, direction: r.direction, category: r.category, status: r.status,
    accountLast4: r.account_last4, counterpartyMasked: null, counterpartyLast4: r.counterparty_last4,
    reference: r.reference, confidence: r.confidence, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const v1 = {
    schema: 1, transactions: v1Rows().map(camel), budgets: [{ category: 'Groceries', amountPaise: 500000 }],
    senders: [{ address: 'HDFCBK', label: 'HDFC Bank', enabled: true }], preferences: { autoAdd: false }, exportedAt: T0,
  };
  const db = await migratedFixture();
  await restoreSnapshotSql(db, v1);
  assert.equal(await readVersion(db), LATEST_VERSION);
  const rows = await listTransactionRows(db);
  assert.equal(rows.length, v1.transactions.length);
  assert.ok(rows.filter(t => t.accountLast4).every(t => t.accountId));
  assert.equal(rows.find(t => t.id === 't003').counterpartyMasked, '**7788');
  assert.equal((await listPayeeRows(db)).every(p => p.name === null), true);
  assert.equal((await db.getFirstAsync("SELECT value FROM preferences WHERE key='autoAdd'")).value, 'false');
});

test('a snapshot from a newer schema version is refused and the ledger is left alone', async () => {
  const db = await migratedFixture();
  const snapshot = await exportSnapshotSql(db);
  await assert.rejects(restoreSnapshotSql(db, { ...snapshot, schemaVersion: LATEST_VERSION + 1 }), /unsupported version/);
  await assert.rejects(restoreSnapshotSql(db, { ...snapshot, schema: 3 }), /unsupported version/);
  assert.equal((await listTransactionRows(db)).length, v1Rows().length);
});
