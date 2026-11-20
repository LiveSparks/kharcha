// Local real-corpus replay (verification-gate §3). Runs the app's own pipeline over the
// operator's SMS export: parse → v1 ledger → real migrations, and parse → real ingest
// into a fresh ledger, then checks the phase targets and records baselines.
//
//   KHARCHA_CORPUS=/path/to/export.csv KHARCHA_REPLAY_OUT=/outside/the/repo npm run replay
//
// Skips (exit 0) when KHARCHA_CORPUS is unset, so CI never needs the corpus. Nothing it
// reads or writes may live inside the repository: the export is real SMS.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../test/support/node-sqlite.mjs';
import { parseBankSms, occurredAtFrom } from '../src/lib/parser.ts';
import { flagDuplicates } from '../src/lib/duplicates.ts';
import { bankFamily } from '../src/lib/banks.ts';
import { V1_SCHEMA, migrate, readVersion } from '../src/lib/migrations.ts';
import { insertTransaction, listAccountRows, listPayeeRows, listTransactionRows } from '../src/lib/ledger.ts';
import { v1TransactionRow } from '../src/lib/rows.ts';
import { debitCardSuggestions, namingNudge, payeeStats, unnamedCount } from '../src/lib/resolve.ts';

const PHASE = 'P1';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const corpus = process.env.KHARCHA_CORPUS;
if (!corpus) {
  console.log('replay: skipped (KHARCHA_CORPUS is not set)');
  process.exit(0);
}
const out = resolve(process.env.KHARCHA_REPLAY_OUT || join(tmpdir(), 'kharcha-replay'));
if (out === repo || out.startsWith(`${repo}/`)) {
  console.error(`replay: KHARCHA_REPLAY_OUT must be outside the repository (${repo})`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });

// RFC-4180 records: quoted fields, "" escapes, embedded newlines.
function parseCsv(text) {
  const records = [];
  let record = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.length > 1 || record[0] !== '') records.push(record);
      record = [];
    } else field += c;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  return records;
}

// The export's DateTime is the phone's local time (IST).
const istEpoch = s => Date.parse(`${s.replace(' ', 'T')}+05:30`);

const records = parseCsv(readFileSync(corpus, 'utf8'));
const header = records.findIndex(r => r[0] === 'DateTime' && r[5] === 'Type');
const messages = records.slice(header + 1)
  .filter(r => r.length >= 6 && /^\d{4}-\d{2}-\d{2} /.test(r[0]))
  .map(([datetime, , contact, , body], index) => ({ index, datetime, sender: contact, body, receivedAt: istEpoch(datetime) }));

// Same transaction shape readBankSms builds (auto-add on, as the app defaults).
const batch = [];
const parsedByIndex = new Map();
for (const sms of messages) {
  const parsed = parseBankSms(sms.body);
  if (!parsed) continue;
  parsedByIndex.set(sms.index, parsed);
  batch.push({
    id: `r${String(sms.index).padStart(5, '0')}`,
    sourceHash: createHash('sha256').update(`${sms.sender}\n${sms.receivedAt}\n${sms.body}`).digest('hex'),
    sender: sms.sender, rawBody: sms.body, occurredAt: occurredAtFrom(sms.body, sms.receivedAt) ?? sms.receivedAt,
    merchant: parsed.merchant, amountPaise: parsed.amountPaise, direction: parsed.direction, category: parsed.category,
    status: parsed.confidence >= 0.9 ? 'auto' : 'review', accountLast4: parsed.accountLast4, reference: parsed.reference,
    counterpartyMasked: parsed.counterpartyMasked, counterpartyLast4: parsed.counterpartyLast4,
    confidence: parsed.confidence, createdAt: sms.receivedAt, updatedAt: sms.receivedAt,
    accountId: null, payeeId: null, payeeOverrideId: null, categoryByUser: false,
  });
}
const transactions = flagDuplicates(batch);

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };

// A. Upgrade path: a v1 ledger (what a pre-P1 install holds) migrated to v2.
const upgraded = openDatabase();
await upgraded.execAsync(V1_SCHEMA);
for (const t of transactions) {
  const row = v1TransactionRow(t);
  const keys = Object.keys(row);
  await upgraded.runAsync(`INSERT OR IGNORE INTO transactions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => row[k]));
}
const v1Count = (await upgraded.getFirstAsync('SELECT COUNT(*) AS n FROM transactions')).n;
const v1Merchants = new Map((await upgraded.getAllAsync('SELECT id, merchant FROM transactions')).map(r => [r.id, r.merchant]));
await migrate(upgraded);

// B. Fresh install: the same messages through the live ingest path.
const fresh = openDatabase();
await fresh.execAsync(V1_SCHEMA);
await migrate(fresh);
for (const t of transactions) await insertTransaction(fresh, t);

const rowsA = await listTransactionRows(upgraded);
const rowsB = await listTransactionRows(fresh);
const accountsA = await listAccountRows(upgraded);
const accountsB = await listAccountRows(fresh);
const payeesA = await listPayeeRows(upgraded);
const payeesB = await listPayeeRows(fresh);

// R: user_version, row count, merchants unchanged.
check(await readVersion(upgraded) === 2, 'upgraded ledger is not at user_version 2');
check(rowsA.length === v1Count, `migration changed the row count: ${v1Count} → ${rowsA.length}`);
check(rowsA.every(t => v1Merchants.get(t.id) === t.merchant), 'migration rewrote a merchant');

// R: every row with a last4 has an account; every row with a merchant or counterparty has a payee.
for (const [label, rows] of [['upgrade', rowsA], ['ingest', rowsB]]) {
  const noAccount = rows.filter(t => t.accountLast4 && !t.accountId).length;
  const noPayee = rows.filter(t => (t.merchant !== 'Unknown merchant' || t.counterpartyLast4) && !t.payeeId).length;
  check(noAccount === 0, `${label}: ${noAccount} rows with a last4 have no account_id`);
  check(noPayee === 0, `${label}: ${noPayee} rows with a merchant or counterparty have no payee_id`);
}

// R: the account set equals the distinct (bank family, last4) pairs.
const expectedAccounts = [...new Set(transactions.filter(t => t.accountLast4).map(t => `${bankFamily(t.sender)}:${t.accountLast4}`))].sort();
const accountKeys = accounts => accounts.map(a => `${a.bank}:${a.last4}`).sort();
check(JSON.stringify(accountKeys(accountsA)) === JSON.stringify(expectedAccounts), 'upgrade: accounts differ from the distinct (bank, last4) pairs');
check(JSON.stringify(accountKeys(accountsB)) === JSON.stringify(expectedAccounts), 'ingest: accounts differ from the distinct (bank, last4) pairs');

// R: counterparty_masked is non-null on exactly the rows where the parser emits it.
for (const [label, rows] of [['upgrade', rowsA], ['ingest', rowsB]]) {
  const wrong = rows.filter(t => {
    const emitted = parsedByIndex.get(Number(t.id.slice(1)))?.counterpartyMasked ?? null;
    return (t.counterpartyMasked ?? null) !== emitted;
  }).length;
  check(wrong === 0, `${label}: counterparty_masked differs from the parser on ${wrong} rows`);
}

// Both paths agree on every identity decision.
const identity = rows => rows.map(t => `${t.id}|${t.accountId}|${t.payeeId}`).sort().join('\n');
check(identity(rowsA) === identity(rowsB), 'upgrade and ingest resolve different accounts/payees');
const shape = list => JSON.stringify(list.map(x => ({ ...x, createdAt: 0 })).sort((a, b) => a.id.localeCompare(b.id)));
check(shape(accountsA) === shape(accountsB), 'upgrade and ingest produce different account rows');
check(shape(payeesA) === shape(payeesB), 'upgrade and ingest produce different payee rows');

const stats = payeeStats(rowsA);
const nudge = namingNudge(payeesA, stats);
const summary = {
  phase: PHASE,
  corpus: { messages: messages.length, parsed: batch.length, ledgerRows: rowsA.length },
  userVersion: await readVersion(upgraded),
  accounts: accountsA.map(a => `${a.bank}:${a.last4}:${a.kind}`),
  payees: { total: payeesA.length, masked: payeesA.filter(p => p.kind === 'masked').length, unnamedWithLiveRows: unnamedCount(payeesA, stats) },
  rows: {
    withAccount: rowsA.filter(t => t.accountId).length,
    withPayee: rowsA.filter(t => t.payeeId).length,
    counterpartyMasked: rowsA.filter(t => t.counterpartyMasked).length,
    noIdentity: rowsA.filter(t => !t.accountId && !t.payeeId).length,
  },
  debitCardSuggestions: debitCardSuggestions(accountsA, rowsA).map(s => `${s.card.bank}:${s.card.last4} → ${s.bank.last4} (${s.unmatched}/${s.cardSpends} unmatched)`),
  homeNudge: nudge ? { count: nudge.count, kind: nudge.payee.kind } : null,
  failures,
};

// Baseline: the first run records it; later runs must not move.
const baselinePath = join(out, `baseline-${PHASE}.json`);
const tracked = s => ({ corpus: s.corpus, accounts: s.accounts, payees: s.payees, rows: s.rows });
if (!existsSync(baselinePath)) {
  if (!failures.length) writeFileSync(baselinePath, `${JSON.stringify(tracked(summary), null, 2)}\n`);
  summary.baseline = failures.length ? 'not written (targets failed)' : `written ${baselinePath}`;
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const same = JSON.stringify(tracked(summary)) === JSON.stringify(baseline);
  check(same, `regressed against ${baselinePath}`);
  summary.baseline = same ? 'matches' : 'DIFFERS';
}

// Reconciliation input in the reconcile3.py column layout.
const esc = s => `"${String(s ?? '').replaceAll('"', '""').replaceAll('\n', ' ⏎ ')}"`;
const csv = ['row_id,datetime,sender,direction,amount_paise,amount_rs,merchant,category,account_last4,counterparty_masked,counterparty_last4,reference,confidence,parse_status,raw_body'];
for (const sms of messages) {
  const p = parsedByIndex.get(sms.index);
  const fields = p ? [p.direction, p.amountPaise, (p.amountPaise / 100).toFixed(2), p.merchant, p.category, p.accountLast4,
    p.counterpartyMasked, p.counterpartyLast4, p.reference, p.confidence, 'parsed'] : ['', '', '', '', '', '', '', '', '', '', 'unparsed'];
  csv.push([sms.index, sms.datetime, sms.sender, ...fields.map(esc), esc(sms.body)].join(','));
}
writeFileSync(join(out, 'kharcha-transactions.csv'), `${csv.join('\n')}\n`);
writeFileSync(join(out, 'replay.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(failures.length ? `replay ${PHASE}: FAIL (${failures.length})` : `replay ${PHASE}: PASS · ${out}`);
process.exit(failures.length ? 1 : 0);
