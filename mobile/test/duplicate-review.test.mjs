import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from './support/node-sqlite.mjs';
import { MESSAGES, T0, seedV1, smsTransaction, v1Row, v1Rows } from './support/fixtures.mjs';
import { LATEST_VERSION, V1_SCHEMA, migrate, readVersion } from '../src/lib/migrations.ts';
import {
  CLOSE_GAP_MS, defaultSurvivor, duplicatePairs, flagDuplicates, gapLabel, keepBothDecision, mergeDecision,
  mergedCopies, relinkLegacyFlags, survivorScore, unmergeDecision, applyPatch, pairKey,
} from '../src/lib/duplicates.ts';
import { isUnreadTransaction, unparsedHints } from '../src/lib/unparsed.ts';
import {
  dismissUnparsedSql, exportSnapshotSql, ingestScanSql, keepBothSql, linkUnparsedSql, listTransactionRows,
  listUnparsedRows, mergeDuplicateSql, restoreSnapshotSql, setTransactionStatusSql, unmergeSql,
} from '../src/lib/ledger.ts';

// P2 duplicate review (app-modification §5.2). Synthetic values only.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function txn(over = {}) {
  return {
    id: over.id ?? crypto.randomUUID(), sourceHash: null, sender: 'VM-BANKX-S', rawBody: over.rawBody ?? 'x',
    occurredAt: over.occurredAt ?? T0, merchant: 'Unknown merchant', amountPaise: over.amountPaise ?? 50000,
    direction: over.direction ?? 'debit', category: 'Transfers', status: over.status ?? 'auto',
    accountLast4: null, counterpartyMasked: null, counterpartyLast4: null, reference: over.reference ?? null,
    confidence: over.confidence ?? 0.95, createdAt: over.createdAt ?? over.occurredAt ?? T0, updatedAt: 0,
    accountId: over.accountId ?? null, payeeId: over.payeeId ?? null, payeeOverrideId: over.payeeOverrideId ?? null,
    categoryByUser: false, duplicateOf: over.duplicateOf ?? null, preFlagStatus: over.preFlagStatus ?? null,
    duplicateCleared: over.duplicateCleared ?? false,
  };
}
const rowsOf = (...ts) => new Map(ts.map(t => [t.id, t]));
const apply = (rows, decision) => {
  const out = new Map(rows);
  for (const p of decision.patches) out.set(p.id, applyPatch(out.get(p.id), p, 1));
  return out;
};

// --- Detection -------------------------------------------------------------------

test('different accounts never pair; a missing account is compatible', () => {
  const a = txn({ id: 'a', accountId: 'acct:X:1111' });
  const b = txn({ id: 'b', accountId: 'acct:X:2222', occurredAt: T0 + MIN });
  assert.equal(flagDuplicates([a, b])[1].status, 'auto');
  const c = txn({ id: 'c', accountId: null, occurredAt: T0 + MIN });
  const [, flagged] = flagDuplicates([a, c]);
  assert.equal(flagged.status, 'duplicate_review');
  assert.equal(flagged.duplicateOf, 'a');
  assert.equal(flagged.preFlagStatus, 'auto');
});

test('different payees pair only within 30 minutes', () => {
  const a = txn({ id: 'a', payeeId: 'payee:one' });
  const close = txn({ id: 'b', payeeId: 'payee:two', occurredAt: T0 + CLOSE_GAP_MS });
  const far = txn({ id: 'c', payeeId: 'payee:two', occurredAt: T0 + CLOSE_GAP_MS + MIN });
  assert.equal(flagDuplicates([a, close])[1].status, 'duplicate_review');
  assert.equal(flagDuplicates([a, far])[1].status, 'auto');
  // same payee pairs across the whole window
  const same = txn({ id: 'd', payeeId: 'payee:one', occurredAt: T0 + 20 * HOUR });
  assert.equal(flagDuplicates([a, same])[1].status, 'duplicate_review');
  // a user's override decides the effective payee
  const moved = txn({ id: 'e', payeeId: 'payee:two', payeeOverrideId: 'payee:one', occurredAt: T0 + 20 * HOUR });
  assert.equal(flagDuplicates([a, moved])[1].status, 'duplicate_review');
});

test('a dismissed pair is not flagged again, and flags point at the earliest partner', () => {
  const a = txn({ id: 'a' });
  const b = txn({ id: 'b', occurredAt: T0 + MIN });
  assert.equal(flagDuplicates([b], [a], new Set([pairKey('b', 'a')]))[0].status, 'auto');
  const c = txn({ id: 'c', occurredAt: T0 + 2 * MIN, status: 'review' });
  const [, fb, fc] = flagDuplicates([a, b, c]);
  assert.equal(fb.duplicateOf, 'a');
  assert.equal(fc.duplicateOf, 'a');
  assert.equal(fc.preFlagStatus, 'review');
});

test('ignored and merged rows are not partners', () => {
  const ignored = txn({ id: 'a', status: 'ignored' });
  const merged = txn({ id: 'b', status: 'merged', occurredAt: T0 + MIN });
  assert.equal(flagDuplicates([txn({ id: 'c', occurredAt: T0 + 2 * MIN })], [ignored, merged])[0].status, 'auto');
});

// --- Survivor --------------------------------------------------------------------

test('the fuller parse survives; ties keep the earlier row', () => {
  const thin = txn({ id: 'a' });
  const full = txn({ id: 'b', occurredAt: T0 + MIN, accountId: 'acct:X:1', payeeId: 'payee:p', reference: '600000000001' });
  assert.equal(survivorScore(thin), 0);
  assert.equal(survivorScore(full), 3);
  assert.equal(defaultSurvivor(thin, full).id, 'b');
  assert.equal(defaultSurvivor(full, txn({ id: 'c', occurredAt: T0 + 2 * MIN, accountId: 'acct:X:1', payeeId: 'payee:p', reference: '1' })).id, 'b');
  const stamped = txn({ id: 'd', rawBody: MESSAGES[6][1], createdAt: T0 + MESSAGES[6][2] * DAY });
  assert.equal(survivorScore(stamped), 1);
});

test('pairs list newest first with the default survivor and gap label', () => {
  const a = txn({ id: 'a' });
  const b = txn({ id: 'b', occurredAt: T0 + 2 * HOUR, status: 'duplicate_review', duplicateOf: 'a', preFlagStatus: 'auto', reference: 'r' });
  const c = txn({ id: 'c', occurredAt: T0 + DAY });
  const d = txn({ id: 'd', occurredAt: T0 + DAY + 5 * MIN, status: 'duplicate_review', duplicateOf: 'c', preFlagStatus: 'auto' });
  const pairs = duplicatePairs([a, b, c, d]);
  assert.deepEqual(pairs.map(p => p.flagged.id), ['d', 'b']);
  assert.equal(pairs[1].survivorId, 'b');
  assert.equal(pairs[0].survivorId, 'c');
  assert.equal(gapLabel(pairs[0].gapMs), '5 min apart');
  assert.equal(gapLabel(pairs[1].gapMs), '2 hours apart');
  assert.equal(gapLabel(10_000), 'Same minute');
});

// --- Decisions -------------------------------------------------------------------

test('merge keeps the partner; the copy is hidden but kept', () => {
  const a = txn({ id: 'a' });
  const b = txn({ id: 'b', occurredAt: T0 + MIN, status: 'duplicate_review', duplicateOf: 'a', preFlagStatus: 'auto' });
  const after = apply(rowsOf(a, b), mergeDecision(rowsOf(a, b), 'b', 'a'));
  assert.equal(after.get('a').status, 'auto');
  assert.equal(after.get('b').status, 'merged');
  assert.equal(after.get('b').duplicateOf, 'a');
  assert.deepEqual(mergedCopies('a', [...after.values()]).map(t => t.id), ['b']);
});

test('keep the other flips the survivor and re-points earlier copies', () => {
  const a = txn({ id: 'a', status: 'review' });
  const old = txn({ id: 'x', occurredAt: T0 + 30 * 1000, status: 'merged', duplicateOf: 'a', preFlagStatus: 'auto' });
  const b = txn({ id: 'b', occurredAt: T0 + MIN, status: 'duplicate_review', duplicateOf: 'a', preFlagStatus: 'auto' });
  const rows = rowsOf(a, old, b);
  const after = apply(rows, mergeDecision(rows, 'b', 'b'));
  assert.equal(after.get('b').status, 'auto');
  assert.equal(after.get('b').duplicateOf, null);
  assert.equal(after.get('a').status, 'merged');
  assert.equal(after.get('a').duplicateOf, 'b');
  assert.equal(after.get('a').preFlagStatus, 'review');
  assert.equal(after.get('x').duplicateOf, 'b', 'no merge chain');
  // unmerging the old survivor brings it back as it was
  const restored = apply(after, unmergeDecision(after, 'a'));
  assert.equal(restored.get('a').status, 'review');
  assert.equal(restored.get('a').duplicateCleared, true);
  assert.throws(() => mergeDecision(rows, 'b', 'nope'));
  assert.throws(() => mergeDecision(rows, 'a', 'a'));
});

test('keep both restores the flagged row and remembers the pair', () => {
  const a = txn({ id: 'a' });
  const b = txn({ id: 'b', occurredAt: T0 + MIN, status: 'duplicate_review', duplicateOf: 'a', preFlagStatus: 'review' });
  const decision = keepBothDecision(rowsOf(a, b), 'b');
  assert.deepEqual(decision.dismiss, ['a', 'b']);
  const after = apply(rowsOf(a, b), decision);
  assert.equal(after.get('b').status, 'review');
  assert.equal(after.get('b').duplicateOf, null);
  assert.equal(after.get('b').duplicateCleared, true);
  assert.throws(() => keepBothDecision(after, 'b'));
});

test('legacy flags relink to a partner or return to their unflagged status', () => {
  const a = txn({ id: 'a' });
  const linked = txn({ id: 'b', occurredAt: T0 + MIN, status: 'duplicate_review' });
  const orphan = txn({ id: 'c', occurredAt: T0 + 3 * DAY, amountPaise: 777, status: 'duplicate_review', confidence: 0.6 });
  const patches = relinkLegacyFlags([a, linked, orphan], true);
  assert.deepEqual(patches.find(p => p.id === 'b'), { id: 'b', status: 'duplicate_review', duplicateOf: 'a', preFlagStatus: 'auto' });
  assert.deepEqual(patches.find(p => p.id === 'c'), { id: 'c', status: 'review', duplicateOf: null, preFlagStatus: null });
  assert.equal(relinkLegacyFlags([a, linked], false).find(p => p.id === 'b').preFlagStatus, 'review');
});

// --- Couldn't read ---------------------------------------------------------------

test("Couldn't read keeps amount-and-verb messages and skips promotions and reminders", () => {
  assert.equal(isUnreadTransaction('Rs.450 debited from your account towards SHOP. Ref 1'), true);
  assert.equal(isUnreadTransaction('INR 2,000.00 credited to a/c XX1 by NEFT'), true);
  assert.equal(isUnreadTransaction('Get Rs.500 cashback when you spent on cards'), false);
  assert.equal(isUnreadTransaction('Your bill of Rs.900 is due on 5th. Paid already? Ignore'), false);
  assert.equal(isUnreadTransaction('Rs.100 credited. Claim at https://example.test/x'), false);
  assert.equal(isUnreadTransaction('Your OTP is 123456'), false);
  // nothing has moved yet: mandate notices, collect requests, bill notices
  assert.equal(isUnreadTransaction('BANKX: Upcoming mandate set for 1/2/26 12:00 AM, your account will be debited with Rs 499.00 towards SHOP'), false);
  assert.equal(isUnreadTransaction('SHOP has requested money through UPI app. On approval, Rs 120.00 will be debited from your A/c'), false);
  assert.equal(isUnreadTransaction('Total Due INR 884 & Min Due INR 100 to be paid by 30-Jan-26 on Card XX1111'), false);
  assert.equal(isUnreadTransaction('Card XX1111 payment Rs 2,000.00 overdue. Pay now'), false);
  // a foreign-currency spend with an INR limit is a real missed transaction
  assert.equal(isUnreadTransaction('USD 12.00 spent using Bank Card XX1111 on 01-Mar-26 on SHOP. Avl Limit: INR 50,000.00'), true);
  assert.deepEqual(unparsedHints('INR 2,000.50 credited to a/c'), { amountPaise: 200050, direction: 'credit' });
  assert.deepEqual(unparsedHints('Rs 75 paid then received'), { amountPaise: 7500, direction: 'debit' });
  assert.deepEqual(unparsedHints('no amount here'), { amountPaise: null, direction: null });
});

// --- SQLite ledger ---------------------------------------------------------------

async function v3Fixture(rows = v1Rows()) {
  const db = openDatabase();
  await seedV1(db, rows);
  await migrate(db);
  return db;
}

test('v2 → v3 keeps every row, allows merged and relinks legacy flags', async () => {
  const rows = v1Rows();
  const copy = { ...v1Row(MESSAGES[3], 3), id: 't900', source_hash: 'hash-900', sender: 'AD-HDFCBK-T', status: 'duplicate_review', created_at: rows[3].created_at + MIN };
  const orphan = { ...rows[5], status: 'duplicate_review' };
  const seeded = [...rows.slice(0, 5), orphan, ...rows.slice(6), copy];
  const db = openDatabase();
  await seedV1(db, seeded);
  assert.equal(await migrate(db, 2), 2);
  assert.equal(await migrate(db, 3), 3);
  assert.equal(await readVersion(db), 3);
  assert.ok(LATEST_VERSION >= 3);
  const after = await listTransactionRows(db);
  assert.equal(after.length, seeded.length);
  for (const r of seeded) {
    const t = after.find(x => x.id === r.id);
    assert.equal(t.rawBody, r.raw_body);
    assert.equal(t.amountPaise, r.amount_paise);
  }
  const relinked = after.find(t => t.id === 't900');
  assert.equal(relinked.status, 'duplicate_review');
  assert.equal(relinked.duplicateOf, 't003');
  const back = after.find(t => t.id === orphan.id);
  assert.equal(back.status, orphan.confidence >= 0.9 ? 'auto' : 'review');
  assert.equal(back.duplicateOf, null);
  await db.runAsync("UPDATE transactions SET status='merged' WHERE id='t900'");
  await assert.rejects(db.runAsync("UPDATE transactions SET status='bogus' WHERE id='t900'"));
  assert.deepEqual(await listUnparsedRows(db), []);
});

test('ingest flags a copy that arrives in a later scan and skips a re-scan', async () => {
  const db = await v3Fixture();
  const [sender, body] = MESSAGES[4];
  const first = smsTransaction(sender, body, T0 + 11 * DAY, 'scan1');
  assert.deepEqual(await ingestScanSql(db, { transactions: [first], unparsed: [] }), { added: 1, flagged: 0, unparsed: 0 });
  const twin = smsTransaction('VM-HDFCBK-S', body, T0 + 11 * DAY + 20_000, 'scan2');
  assert.deepEqual(await ingestScanSql(db, { transactions: [first, twin], unparsed: [] }), { added: 1, flagged: 1, unparsed: 0 });
  const rows = await listTransactionRows(db);
  const flagged = rows.find(t => t.id === 'scan2');
  assert.equal(flagged.status, 'duplicate_review');
  assert.ok([first.id, 't004'].includes(flagged.duplicateOf));
  assert.ok(flagged.accountId && flagged.payeeId, 'identity is filled before flagging');
});

test('whole-inbox re-read: stored rows are skipped and progress only moves forward', async () => {
  const db = await v3Fixture();
  const batch = MESSAGES.slice(0, 6).map(([sender, body], i) => smsTransaction(sender, body, T0 + (20 + i) * DAY, `re${i}`));
  const first = await ingestScanSql(db, { transactions: batch, unparsed: [] });
  assert.equal(first.added, batch.length);
  const before = (await listTransactionRows(db)).length;
  // The same messages again, with new ids (each scan makes fresh ones): same hashes, nothing added.
  const again = batch.map((t, i) => ({ ...t, id: `again${i}` }));
  const ticks = [];
  const second = await ingestScanSql(db, { transactions: again, unparsed: [] }, Date.now(), p => ticks.push(p));
  assert.deepEqual(second, { added: 0, flagged: 0, unparsed: 0 });
  assert.equal((await listTransactionRows(db)).length, before);
  assert.deepEqual(ticks[0], { phase: 'checking', done: 0, total: again.length });
  assert.ok(ticks.every(t => t.done <= t.total));
  // A new message among stored ones is still added, and adding reports after checking.
  const fresh = smsTransaction(MESSAGES[7][0], MESSAGES[7][1], T0 + 40 * DAY, 'brand-new');
  const order = [];
  const third = await ingestScanSql(db, { transactions: [...again, fresh], unparsed: [] }, Date.now(), p => order.push(p.phase));
  assert.equal(third.added, 1);
  assert.equal(order[0], 'checking');
  assert.equal(order.at(-1), 'adding');
});

test('merge, unmerge and keep both through SQLite', async () => {
  const db = await v3Fixture();
  const [sender, body] = MESSAGES[9];
  const a = smsTransaction(sender, body, T0 + 7 * DAY, 'n1');
  const b = smsTransaction('JD-PNBSMS-T', body, T0 + 7 * DAY + MIN, 'n2');
  await ingestScanSql(db, { transactions: [a, b], unparsed: [] });
  const get = async id => (await listTransactionRows(db)).find(t => t.id === id);
  const flaggedId = (await get('n2')).status === 'duplicate_review' ? 'n2' : 'n1';
  const flagged = await get(flaggedId);
  await mergeDuplicateSql(db, flaggedId, flagged.duplicateOf);
  assert.equal((await get(flaggedId)).status, 'merged');
  await unmergeSql(db, flaggedId);
  const back = await get(flaggedId);
  assert.equal(back.status, flagged.preFlagStatus);
  assert.equal(back.duplicateCleared, true);
  const dismissals = await db.getAllAsync('SELECT * FROM duplicate_dismissals');
  assert.equal(dismissals.length, 1);
  await assert.rejects(keepBothSql(db, flaggedId));
  // a plain status change drops a pending link
  await db.runAsync("UPDATE transactions SET status='duplicate_review', duplicate_of=?, pre_flag_status='auto' WHERE id=?", flagged.duplicateOf, flaggedId);
  await setTransactionStatusSql(db, flaggedId, 'ignored');
  const ignored = await get(flaggedId);
  assert.equal(ignored.duplicateOf, null);
  assert.equal(ignored.preFlagStatus, null);
});

test("Couldn't read: stored once, linked or dismissed with the body wiped, and backed up", async () => {
  const db = await v3Fixture();
  const message = { id: 'u1', sourceHash: 'uh-1', sender: 'VM-BANKX-S', rawBody: 'Rs.450 debited from your account towards SHOP', receivedAt: T0, amountPaise: 45000 };
  const other = { ...message, id: 'u2', sourceHash: 'uh-2', rawBody: 'INR 90 credited to a/c' };
  assert.equal((await ingestScanSql(db, { transactions: [], unparsed: [message, other] })).unparsed, 2);
  assert.equal((await ingestScanSql(db, { transactions: [], unparsed: [message] })).unparsed, 0);
  await linkUnparsedSql(db, 'u1', 't000');
  await dismissUnparsedSql(db, 'u2');
  const [linked, dismissed] = (await listUnparsedRows(db)).sort((x, y) => x.id.localeCompare(y.id));
  assert.equal(linked.status, 'added');
  assert.equal(linked.transactionId, 't000');
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(dismissed.rawBody, '');

  await db.runAsync("INSERT INTO duplicate_dismissals VALUES ('t000','t001',1)");
  const snapshot = JSON.parse(JSON.stringify(await exportSnapshotSql(db)));
  assert.equal(snapshot.unparsed_messages.length, 2);
  assert.equal(snapshot.duplicate_dismissals.length, 1);
  const restored = openDatabase();
  await restored.execAsync(V1_SCHEMA);
  await migrate(restored);
  await restoreSnapshotSql(restored, snapshot);
  assert.equal((await listUnparsedRows(restored)).length, 2);
  assert.equal((await restored.getAllAsync('SELECT * FROM duplicate_dismissals')).length, 1);
});
