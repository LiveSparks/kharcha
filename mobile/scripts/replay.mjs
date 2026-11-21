// Local real-corpus replay (verification-gate §3). Runs the app's own pipeline over the
// operator's SMS export: parse → v1 ledger (with legacy flags) → real migrations, and
// parse → real scan ingest into a fresh ledger, then checks the phase targets and
// records baselines.
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
import { CLOSE_GAP_MS, flagDuplicates } from '../src/lib/duplicates.ts';
import { isUnreadTransaction, unparsedHints } from '../src/lib/unparsed.ts';
import { DEFAULT_SENDERS } from '../src/lib/model.ts';
import { bankFamily } from '../src/lib/banks.ts';
import { V1_SCHEMA, migrate, readVersion } from '../src/lib/migrations.ts';
import { ingestScanSql, listAccountRows, listPayeeRows, listTransactionRows, listUnparsedRows } from '../src/lib/ledger.ts';
import { v1TransactionRow } from '../src/lib/rows.ts';
import { debitCardSuggestions, effectivePayeeId, namingNudge, payeeStats, unnamedCount } from '../src/lib/resolve.ts';

const PHASE = 'P2';
const LATEST = 3;
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
// The scan reads only the allowed senders, matched as the native module does.
const normalize = v => v.trim().toUpperCase().replace(/^[A-Z]{2}-/, '');
const rules = DEFAULT_SENDERS.map(r => normalize(r.address));
const fromBank = sender => { const c = normalize(sender); return rules.some(r => c === r || (r.length >= 5 && c.includes(r))); };
const hashOf = sms => createHash('sha256').update(`${sms.sender}\n${sms.receivedAt}\n${sms.body}`).digest('hex');

const batch = [];
const unparsed = [];
const parsedByIndex = new Map();
for (const sms of messages) {
  const parsed = parseBankSms(sms.body);
  if (!parsed) {
    if (fromBank(sms.sender) && isUnreadTransaction(sms.body)) {
      unparsed.push({ id: `u${String(sms.index).padStart(5, '0')}`, sourceHash: hashOf(sms), sender: sms.sender, rawBody: sms.body,
        receivedAt: occurredAtFrom(sms.body, sms.receivedAt) ?? sms.receivedAt, amountPaise: unparsedHints(sms.body).amountPaise });
    }
    continue;
  }
  parsedByIndex.set(sms.index, parsed);
  batch.push({
    id: `r${String(sms.index).padStart(5, '0')}`,
    sourceHash: hashOf(sms),
    sender: sms.sender, rawBody: sms.body, occurredAt: occurredAtFrom(sms.body, sms.receivedAt) ?? sms.receivedAt,
    merchant: parsed.merchant, amountPaise: parsed.amountPaise, direction: parsed.direction, category: parsed.category,
    status: parsed.confidence >= 0.9 ? 'auto' : 'review', accountLast4: parsed.accountLast4, reference: parsed.reference,
    counterpartyMasked: parsed.counterpartyMasked, counterpartyLast4: parsed.counterpartyLast4,
    confidence: parsed.confidence, createdAt: sms.receivedAt, updatedAt: sms.receivedAt,
    accountId: null, payeeId: null, payeeOverrideId: null, categoryByUser: false, duplicateOf: null, preFlagStatus: null, duplicateCleared: false,
  });
}
// A pre-P1 install flagged with the old rule: same amount and direction within 24h,
// no identity yet (flagDuplicates with no account/payee ids reduces to exactly that).
const legacy = flagDuplicates(batch);
const transactions = batch;

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };

// A. Upgrade path: a v1 ledger (what a pre-P1 install holds) migrated to the latest.
const upgraded = openDatabase();
await upgraded.execAsync(V1_SCHEMA);
for (const t of legacy) {
  const row = v1TransactionRow(t);
  const keys = Object.keys(row);
  await upgraded.runAsync(`INSERT OR IGNORE INTO transactions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => row[k]));
}
const v1Count = (await upgraded.getFirstAsync('SELECT COUNT(*) AS n FROM transactions')).n;
const v1Merchants = new Map((await upgraded.getAllAsync('SELECT id, merchant FROM transactions')).map(r => [r.id, r.merchant]));
await migrate(upgraded);

// B. Fresh install: the same messages through the live scan ingest.
const fresh = openDatabase();
await fresh.execAsync(V1_SCHEMA);
await migrate(fresh);
const ingest = await ingestScanSql(fresh, { transactions, unparsed }, 0);
const unread = await listUnparsedRows(fresh);

const rowsA = await listTransactionRows(upgraded);
const rowsB = await listTransactionRows(fresh);
const accountsA = await listAccountRows(upgraded);
const accountsB = await listAccountRows(fresh);
const payeesA = await listPayeeRows(upgraded);
const payeesB = await listPayeeRows(fresh);

// R: user_version, row count, merchants unchanged.
check(await readVersion(upgraded) === LATEST, `upgraded ledger is not at user_version ${LATEST}`);
check(await readVersion(fresh) === LATEST, `fresh ledger is not at user_version ${LATEST}`);
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

// P2: duplicate flags. Every flag has a partner; both paths flag the same pairs.
const flagsOf = rows => {
  const byId = new Map(rows.map(t => [t.id, t]));
  return rows.filter(t => t.status === 'duplicate_review').map(t => ({ t, partner: byId.get(t.duplicateOf) }));
};
const flagsA = flagsOf(rowsA), flagsB = flagsOf(rowsB);
for (const [label, flags] of [['upgrade', flagsA], ['ingest', flagsB]]) {
  const orphans = flags.filter(f => !f.partner).length;
  check(orphans === 0, `${label}: ${orphans} duplicate_review rows have no partner`);
}
const pairSet = flags => flags.map(f => `${f.t.id}>${f.t.duplicateOf}`).sort().join('\n');
check(pairSet(flagsA) === pairSet(flagsB), 'upgrade relink and scan ingest flag different pairs');
check(rowsA.filter(t => t.status === 'merged').length === 0, 'migration produced merged rows');
const gap = f => Math.abs(f.t.occurredAt - f.partner.occurredAt);
const far = flagsB.filter(f => f.partner && gap(f) > CLOSE_GAP_MS);
const farDifferentPayee = far.filter(f => {
  const a = effectivePayeeId(f.t), b = effectivePayeeId(f.partner);
  return a && b && a !== b;
});
check(flagsB.length === 86, `expected 86 duplicate flags, got ${flagsB.length}`);
check(far.length === 11, `expected 11 flags more than 30 min apart, got ${far.length}`);
check(farDifferentPayee.length === 0, `${farDifferentPayee.length} flags pair different payees more than 30 min apart`);
check(ingest.flagged === flagsB.length, `ingest reported ${ingest.flagged} flags, ledger holds ${flagsB.length}`);

// P2: Couldn't read. Amount + verb, no promo exclusion, at most 100.
const badUnread = unread.filter(m => !isUnreadTransaction(m.rawBody) || unparsedHints(m.rawBody).amountPaise === null).length;
check(badUnread === 0, `${badUnread} Couldn't-read rows lack an amount or a verb, or match an exclusion`);
check(unread.length <= 100, `Couldn't read holds ${unread.length} messages (limit 100)`);
check(unread.length === unparsed.length, `Couldn't read stored ${unread.length} of ${unparsed.length}`);

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
  duplicates: {
    legacyFlags: legacy.filter(t => t.status === 'duplicate_review').length,
    flags: flagsB.length,
    moreThan30Min: far.length,
    farDifferentPayee: farDifferentPayee.length,
    statusAfterRelink: Object.fromEntries(['auto', 'review', 'duplicate_review'].map(s => [s, rowsA.filter(t => t.status === s).length])),
  },
  couldntRead: { count: unread.length, bySender: Object.fromEntries([...new Set(unread.map(m => bankFamily(m.sender)))].sort().map(f => [f, unread.filter(m => bankFamily(m.sender) === f).length])) },
  failures,
};

// Baseline: the first run records it; later runs must not move.
const baselinePath = join(out, `baseline-${PHASE}.json`);
const tracked = s => ({ corpus: s.corpus, accounts: s.accounts, payees: s.payees, rows: s.rows, duplicates: s.duplicates, couldntRead: s.couldntRead });
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
