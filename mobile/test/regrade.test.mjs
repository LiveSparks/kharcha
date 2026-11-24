import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from './support/node-sqlite.mjs';
import { seedV1 } from './support/fixtures.mjs';
import { LATEST_VERSION, migrate, readVersion } from '../src/lib/migrations.ts';
import { listTransactionRows } from '../src/lib/ledger.ts';
import { isMandateEcho, parseBankSms } from '../src/lib/parser.ts';
import { isUnreadTransaction } from '../src/lib/unparsed.ts';
import { regradePatches } from '../src/lib/regrade.ts';

// v6 → v7 re-check: mandate echoes, reference-optional auto-add, bank-code senders.
// Synthetic values only.

const ECHO = 'AutoPay (E-mandate) Success! For Cloud Suite Txn Amt:INR499.00 Dt:05/11/2026 Via:HDFC Bank DC 4321 Mandate ID: AbCdEf1234 Not You? To Block+Reissue Call 18002586161';
const SPEND = 'Spent Rs.499.00 From HDFC Bank Card x4321 At CLOUD SUITE SI On 2026-11-05:09:12:33 Bal Rs.12000.00 Not You? Call 18002586161/SMS BLOCK DC 4321 to 7308080808';
const NO_REF = 'Rs 1,250.00 spent on ICICI Bank Card XX4321 on 05-Nov-26 at BLUE TOKAI COFFEE. Avl Lmt: Rs 40,000.00. To dispute, call 18001080.';
const UPI_MANDATE = 'UPI Mandate:\nSent Rs.149.00\nfrom HDFC Bank A/c 9012\nTo Music App\n05/11/26\nRef 600000000777\nNot You?\nCall 18002586161/SMS BLOCK UPI to 7308080808';
const REMINDER = 'E-Mandate! Rs.149.00 will be deducted on 06/11/26, 00:00:00 For Music App mandate UMN 1a2b3c@okhdfcbank Maintain Balance - HDFC Bank';

function row(over) {
  return { id: over.id, rawBody: over.rawBody ?? null, status: over.status ?? 'review', duplicateOf: over.duplicateOf ?? null,
    preFlagStatus: over.preFlagStatus ?? null, confidence: over.confidence ?? 0.84 };
}

test('a mandate echo is not a spend and never lands in Couldn\'t read', () => {
  assert.equal(isMandateEcho(ECHO), true);
  assert.equal(parseBankSms(ECHO), null);
  assert.equal(isUnreadTransaction(ECHO), false);
  assert.ok(parseBankSms(SPEND), 'its normal-template twin still parses');
});

test('a UPI mandate debit is the only record of that debit, so it stays a spend', () => {
  assert.equal(isMandateEcho(UPI_MANDATE), false);
  const parsed = parseBankSms(UPI_MANDATE);
  assert.equal(parsed?.amountPaise, 14900);
  assert.ok(parsed.confidence >= 0.9);
  assert.equal(parseBankSms(REMINDER), null, 'a reminder is not a spend');
});

test('an echo becomes Ignored and its twin comes back from a flag or a merge', () => {
  const patches = new Map(regradePatches([
    row({ id: 'echo1', rawBody: ECHO, status: 'auto', confidence: 0.95 }),
    row({ id: 'twin1', rawBody: SPEND, status: 'duplicate_review', duplicateOf: 'echo1', preFlagStatus: 'auto', confidence: 0.9 }),
    row({ id: 'echo2', rawBody: ECHO, status: 'auto', confidence: 0.95 }),
    row({ id: 'twin2', rawBody: SPEND, status: 'merged', duplicateOf: 'echo2', preFlagStatus: 'auto', confidence: 0.9 }),
    row({ id: 'echo3', rawBody: ECHO, status: 'merged', duplicateOf: 'twin3', preFlagStatus: 'auto', confidence: 0.95 }),
    row({ id: 'twin3', rawBody: SPEND, status: 'auto', confidence: 0.9 }),
  ], true).map(p => [p.id, p]));
  for (const id of ['echo1', 'echo2', 'echo3']) assert.deepEqual([patches.get(id).status, patches.get(id).duplicateOf, patches.get(id).preFlagStatus], ['ignored', null, null]);
  for (const id of ['twin1', 'twin2']) assert.deepEqual([patches.get(id).status, patches.get(id).duplicateOf], ['auto', null]);
  assert.equal(patches.has('twin3'), false, 'a survivor that is not an echo is untouched');
});

test('untouched review rows that now clear the bar move to the ledger; nothing is demoted', () => {
  const patches = new Map(regradePatches([
    row({ id: 'r1', rawBody: NO_REF }),
    row({ id: 'r2', rawBody: NO_REF, status: 'duplicate_review', duplicateOf: 'x', preFlagStatus: 'review' }),
    row({ id: 'r3', rawBody: 'Ac XX9012 Debited with Rs.500.00, 05-11-2026 10:00:00. Aval Bal 100.00 CR. Helpline-PNB', confidence: 0.45 }),
    row({ id: 'r4', rawBody: NO_REF, status: 'ignored' }),
    row({ id: 'r5', rawBody: null }),
  ], true).map(p => [p.id, p]));
  assert.equal(patches.get('r1').status, 'auto');
  assert.equal(patches.get('r1').confidence, 0.9);
  assert.deepEqual([patches.get('r2').status, patches.get('r2').preFlagStatus], ['duplicate_review', 'auto']);
  for (const id of ['r3', 'r4', 'r5']) assert.equal(patches.has(id), false, `${id} stays as it is`);
});

test('with auto-add off, review rows stay in review', () => {
  const [patch] = regradePatches([row({ id: 'r1', rawBody: NO_REF })], false);
  assert.equal(patch.status, 'review');
  assert.equal(patch.confidence, 0.9);
});

test('v6 → v7 renames route-bound sender rules, adds HDFC UPI and asks for a whole-inbox read', async () => {
  const db = openDatabase();
  await seedV1(db);
  await migrate(db, LATEST_VERSION - 1);
  await db.execAsync(`
    DELETE FROM senders;
    INSERT INTO senders VALUES ('HDFCBK','HDFC Bank',1),('VM-SBIUPI','SBI · UPI',1),('AX-ICICIT','ICICI Bank',0),('PNBSMS','PNB',1);
    INSERT OR REPLACE INTO preferences VALUES ('lastScanAt','1767225600000');
  `);
  await db.runAsync("UPDATE transactions SET status='review', confidence=0.84, raw_body=? WHERE id=(SELECT id FROM transactions WHERE raw_body IS NOT NULL LIMIT 1)", NO_REF);
  assert.equal(await migrate(db), LATEST_VERSION);
  assert.equal(await readVersion(db), LATEST_VERSION);
  const senders = await db.getAllAsync('SELECT address, label, enabled FROM senders ORDER BY address');
  assert.deepEqual(senders.map(s => [s.address, s.enabled]), [['HDFCBK', 1], ['HDFCBN', 1], ['ICICIT', 0], ['PNBSMS', 1], ['SBIUPI', 1]]);
  assert.equal((await db.getFirstAsync("SELECT value FROM preferences WHERE key='lastScanAt'")).value, '0');
  const moved = (await listTransactionRows(db)).find(t => t.rawBody === NO_REF);
  assert.equal(moved.status, 'auto');
});
