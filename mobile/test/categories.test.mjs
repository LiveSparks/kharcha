import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from './support/node-sqlite.mjs';
import { seedV1, smsTransaction, T0 } from './support/fixtures.mjs';
import { LATEST_VERSION, migrate } from '../src/lib/migrations.ts';
import {
  addCategorySql, deleteCategorySql, exportSnapshotSql, insertTransaction, listCategoryRows, listPayeeRows, listTransactionRows,
  renamePayeeSql, restoreSnapshotSql,
} from '../src/lib/ledger.ts';
import { CATEGORIES } from '../src/lib/model.ts';
import { liveCategories, validateCategoryName } from '../src/lib/categories.ts';

// Your categories (schema v9). Synthetic values only.

async function ledger() {
  const db = openDatabase();
  await seedV1(db);
  await migrate(db);
  return db;
}

test('v9 seeds the built-in categories in order', async () => {
  const db = await ledger();
  assert.deepEqual((await listCategoryRows(db)).map(c => c.name), [...CATEGORIES]);
});

test('names are trimmed, unique ignoring case, and at most 30 characters', () => {
  const all = CATEGORIES.map((name, position) => ({ name, color: '#000', position, mergedInto: null }));
  assert.equal(validateCategoryName('  Pet   care ', all), 'Pet care');
  assert.throws(() => validateCategoryName('groceries', all), /already a category/);
  assert.throws(() => validateCategoryName('   ', all), /Enter a name/);
  assert.throws(() => validateCategoryName('x'.repeat(31), all), /30 characters/);
});

test('a new category goes last and can be picked like any other', async () => {
  const db = await ledger();
  assert.equal(await addCategorySql(db, 'Pets', '#E0685F'), 'Pets');
  const rows = await listCategoryRows(db);
  assert.equal(rows.at(-1).name, 'Pets');
  assert.equal(rows.at(-1).color, '#E0685F');
});

test('deleting moves rows, payee defaults and the budget, and later messages follow', async () => {
  const db = await ledger();
  const target = (await listTransactionRows(db)).find(t => t.rawBody && t.category !== 'Transfers') ?? (await listTransactionRows(db)).find(t => t.rawBody);
  const old = target.category;
  const into = CATEGORIES.find(c => c !== old && c !== 'Transfers');
  const payee = (await listPayeeRows(db))[0];
  await renamePayeeSql(db, payee.id, 'Someone', old);
  await db.runAsync('INSERT OR REPLACE INTO budgets VALUES (?,?)', old, 500000);
  const before = (await listTransactionRows(db)).filter(t => t.category === old).length;
  await deleteCategorySql(db, old, into);
  const rows = await listTransactionRows(db);
  assert.equal(rows.filter(t => t.category === old).length, 0);
  assert.ok(rows.filter(t => t.category === into).length >= before);
  assert.equal((await listPayeeRows(db)).find(p => p.id === payee.id).category, into);
  assert.deepEqual(await db.getAllAsync('SELECT category FROM budgets WHERE category IN (?,?)', old, into), [{ category: into }]);
  assert.ok(!liveCategories(await listCategoryRows(db)).some(c => c.name === old));
  // A new message the parser files under the deleted name lands in its replacement.
  const fresh = smsTransaction('VM-HDFCBK-S', target.rawBody.replace(/\d{2}\/\d{2}\/\d{2}/, '01/01/27'), T0 + 400 * 86_400_000, 'late1');
  await insertTransaction(db, { ...fresh, category: old });
  assert.equal((await listTransactionRows(db)).find(t => t.id === 'late1').category, into);
  // Adding the name again brings it back.
  assert.equal(await addCategorySql(db, old), old);
  assert.ok(liveCategories(await listCategoryRows(db)).some(c => c.name === old));
});

test('Transfers stays, and a category cannot move into itself', async () => {
  const db = await ledger();
  await assert.rejects(deleteCategorySql(db, 'Transfers', 'Bills'), /can’t be deleted/);
  await assert.rejects(deleteCategorySql(db, 'Bills', 'Bills'), /different category/);
  await assert.rejects(deleteCategorySql(db, 'Nope', 'Bills'), /already gone/);
});

test('backups carry your categories, deletions included', async () => {
  const db = await ledger();
  await addCategorySql(db, 'Pets');
  await deleteCategorySql(db, 'Health', 'Bills');
  const snapshot = JSON.parse(JSON.stringify(await exportSnapshotSql(db)));
  assert.equal(snapshot.schemaVersion, LATEST_VERSION);
  const restored = openDatabase();
  await restoreSnapshotSql(restored, snapshot);
  const rows = await listCategoryRows(restored);
  assert.ok(rows.some(c => c.name === 'Pets'));
  assert.equal(rows.find(c => c.name === 'Health').mergedInto, 'Bills');
});
