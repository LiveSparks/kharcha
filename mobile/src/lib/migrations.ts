import { mergeAccountKind } from './banks.ts';
import { identityFor } from './identity.ts';
import type { AccountIdentity, PayeeIdentity } from './identity.ts';
import { relinkLegacyFlags } from './duplicates.ts';
import { parseBankSms } from './parser.ts';
import { HDFC_UPI_SENDER, SENDER_RENAMES, regradePatches } from './regrade.ts';
import { transactionFromRow } from './rows.ts';
import type { SqlValue, TransactionRow } from './rows.ts';
import type { AccountKind } from './model';
import { BUILT_IN_COLORS, CATEGORIES } from './model.ts';

// Schema versioning with PRAGMA user_version (app-modification spec §4.1).
//
// The CREATE TABLE IF NOT EXISTS block below is the v1 baseline: every install runs it
// first. A fresh install and a pre-versioning install both read user_version 0, and
// both count as v1. migrations[i] takes v(i+1) to v(i+2) inside one exclusive
// transaction and sets user_version as its last statement, so a failed step leaves
// the previous version in place and is retried on the next launch.
//
// Everything here talks to a minimal async SQL surface that expo-sqlite's database
// satisfies directly and that the node:sqlite test/replay harness wraps.

export interface SqlExecutor {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: SqlValue[]): Promise<{ changes: number }>;
  getAllAsync<T>(source: string, ...params: SqlValue[]): Promise<T[]>;
  getFirstAsync<T>(source: string, ...params: SqlValue[]): Promise<T | null>;
}

export interface SqlDatabase extends SqlExecutor {
  withExclusiveTransactionAsync(task: (tx: SqlExecutor) => Promise<void>): Promise<void>;
}

export const V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    source_hash TEXT UNIQUE,
    sender TEXT,
    raw_body TEXT,
    occurred_at INTEGER NOT NULL,
    merchant TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
    category TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('auto','review','duplicate_review','ignored','manual')),
    account_last4 TEXT,
    counterparty_last4 TEXT,
    reference TEXT,
    confidence REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transactions_by_date ON transactions (occurred_at DESC);
  CREATE INDEX IF NOT EXISTS transactions_by_status ON transactions (status, occurred_at DESC);
  CREATE TABLE IF NOT EXISTS budgets (
    category TEXT PRIMARY KEY,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0)
  );
  CREATE TABLE IF NOT EXISTS senders (
    address TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// Upserts used by both the v1→v2 backfill and live ingest. Accounts only ever sharpen
// their kind (mergeAccountKind); names, links and categories are never touched here.
export async function upsertAccount(tx: SqlExecutor, account: AccountIdentity, now: number): Promise<string> {
  await tx.runAsync('INSERT INTO accounts (id,bank,last4,kind,created_at) VALUES (?,?,?,?,?) ON CONFLICT(bank,last4) DO NOTHING',
    account.id, account.bank, account.last4, account.kind, now);
  const row = await tx.getFirstAsync<{ id: string; kind: AccountKind }>('SELECT id,kind FROM accounts WHERE bank=? AND last4=?', account.bank, account.last4);
  if (!row) throw new Error('Account upsert failed.');
  const kind = mergeAccountKind(row.kind, account.kind);
  if (kind !== row.kind) await tx.runAsync('UPDATE accounts SET kind=? WHERE id=?', kind, row.id);
  return row.id;
}

export async function upsertPayee(tx: SqlExecutor, payee: PayeeIdentity, now: number): Promise<string> {
  await tx.runAsync('INSERT INTO payees (id,kind,bank,key,masked,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(kind,bank,key) DO NOTHING',
    payee.id, payee.kind, payee.bank, payee.key, payee.masked, now);
  const row = await tx.getFirstAsync<{ id: string }>('SELECT id FROM payees WHERE kind=? AND bank=? AND key=?', payee.kind, payee.bank, payee.key);
  if (!row) throw new Error('Payee upsert failed.');
  return row.id;
}

interface V1Row {
  id: string; sender: string | null; raw_body: string | null; merchant: string;
  account_last4: string | null; counterparty_last4: string | null; created_at: number;
}

async function v1ToV2(tx: SqlExecutor): Promise<void> {
  await tx.execAsync(`
    CREATE TABLE accounts (
      id         TEXT PRIMARY KEY,
      bank       TEXT NOT NULL,
      last4      TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('bank','credit_card','debit_card','unknown')),
      funded_by  TEXT REFERENCES accounts(id),
      name       TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (bank, last4)
    );
    CREATE TABLE payees (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL CHECK (kind IN ('merchant','masked')),
      bank       TEXT NOT NULL DEFAULT '',
      key        TEXT NOT NULL,
      masked     TEXT,
      name       TEXT,
      category   TEXT,
      nudged_at  INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (kind, bank, key)
    );
    ALTER TABLE transactions ADD COLUMN account_id TEXT REFERENCES accounts(id);
    ALTER TABLE transactions ADD COLUMN payee_id TEXT REFERENCES payees(id);
    ALTER TABLE transactions ADD COLUMN payee_override_id TEXT REFERENCES payees(id);
    ALTER TABLE transactions ADD COLUMN counterparty_masked TEXT;
    ALTER TABLE transactions ADD COLUMN category_by_user INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX transactions_by_payee ON transactions (payee_id);
    CREATE INDEX transactions_by_account ON transactions (account_id, occurred_at);
  `);
  // Oldest first, so a merchant payee's display form is the string first seen.
  const rows = await tx.getAllAsync<V1Row>(
    'SELECT id,sender,raw_body,merchant,account_last4,counterparty_last4,created_at FROM transactions ORDER BY occurred_at, created_at, id');
  for (const row of rows) {
    // Fill the one parser field v1 dropped. Rows the parser now rejects keep NULL.
    const counterpartyMasked = row.raw_body ? parseBankSms(row.raw_body)?.counterpartyMasked ?? null : null;
    const { account, payee } = identityFor({
      sender: row.sender, rawBody: row.raw_body, merchant: row.merchant, accountLast4: row.account_last4,
      counterpartyMasked, counterpartyLast4: row.counterparty_last4,
    });
    const accountIdValue = account ? await upsertAccount(tx, account, row.created_at) : null;
    const payeeIdValue = payee ? await upsertPayee(tx, payee, row.created_at) : null;
    await tx.runAsync('UPDATE transactions SET account_id=?, payee_id=?, counterparty_masked=? WHERE id=?',
      accountIdValue, payeeIdValue, counterpartyMasked, row.id);
  }
  await tx.runAsync("UPDATE transactions SET category_by_user=1 WHERE status='manual'");
  await tx.execAsync('PRAGMA user_version = 2');
}

const V2_COLUMNS = [
  'id', 'source_hash', 'sender', 'raw_body', 'occurred_at', 'merchant', 'amount_paise', 'direction', 'category',
  'status', 'account_last4', 'counterparty_last4', 'reference', 'confidence', 'created_at', 'updated_at',
  'account_id', 'payee_id', 'payee_override_id', 'counterparty_masked', 'category_by_user',
].join(', ');

// v2 → v3 (P2, spec §4.2). SQLite can't alter a CHECK, so `transactions` is rebuilt
// with 'merged' allowed and the duplicate columns added. The app never turns on
// PRAGMA foreign_keys (and it can't change inside a transaction), so the drop and
// rename don't cascade. The self-reference names `transactions`, which resolves to
// the rebuilt table once it is renamed.
async function v2ToV3(tx: SqlExecutor): Promise<void> {
  await tx.execAsync(`
    CREATE TABLE transactions_v3 (
      id TEXT PRIMARY KEY,
      source_hash TEXT UNIQUE,
      sender TEXT,
      raw_body TEXT,
      occurred_at INTEGER NOT NULL,
      merchant TEXT NOT NULL,
      amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
      direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
      category TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('auto','review','duplicate_review','ignored','manual','merged')),
      account_last4 TEXT,
      counterparty_last4 TEXT,
      reference TEXT,
      confidence REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      account_id TEXT REFERENCES accounts(id),
      payee_id TEXT REFERENCES payees(id),
      payee_override_id TEXT REFERENCES payees(id),
      counterparty_masked TEXT,
      category_by_user INTEGER NOT NULL DEFAULT 0,
      duplicate_of TEXT REFERENCES transactions(id),
      pre_flag_status TEXT CHECK (pre_flag_status IN ('auto','review','manual')),
      duplicate_cleared INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO transactions_v3 (${V2_COLUMNS}) SELECT ${V2_COLUMNS} FROM transactions;
    DROP TABLE transactions;
    ALTER TABLE transactions_v3 RENAME TO transactions;
    CREATE INDEX transactions_by_date ON transactions (occurred_at DESC);
    CREATE INDEX transactions_by_status ON transactions (status, occurred_at DESC);
    CREATE INDEX transactions_by_payee ON transactions (payee_id);
    CREATE INDEX transactions_by_account ON transactions (account_id, occurred_at);
    CREATE INDEX transactions_by_duplicate ON transactions (duplicate_of);
    CREATE TABLE unparsed_messages (
      id             TEXT PRIMARY KEY,
      source_hash    TEXT UNIQUE NOT NULL,
      sender         TEXT NOT NULL,
      raw_body       TEXT NOT NULL,
      received_at    INTEGER NOT NULL,
      amount_paise   INTEGER,
      status         TEXT NOT NULL CHECK (status IN ('pending','added','dismissed')),
      transaction_id TEXT REFERENCES transactions(id),
      created_at     INTEGER NOT NULL
    );
    CREATE TABLE duplicate_dismissals (
      a_id       TEXT NOT NULL REFERENCES transactions(id),
      b_id       TEXT NOT NULL REFERENCES transactions(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (a_id, b_id)
    );
  `);
  // Legacy flags have no partner: link them, or unflag the ones with none.
  const autoAddPref = await tx.getFirstAsync<{ value: string }>("SELECT value FROM preferences WHERE key='autoAdd'");
  const autoAdd = autoAddPref ? JSON.parse(autoAddPref.value) !== false : true;
  const rows = (await tx.getAllAsync<TransactionRow>(
    "SELECT * FROM transactions WHERE status IN ('auto','review','manual','duplicate_review') ORDER BY occurred_at, created_at, id")).map(transactionFromRow);
  for (const patch of relinkLegacyFlags(rows, autoAdd)) {
    await tx.runAsync('UPDATE transactions SET status=?, duplicate_of=?, pre_flag_status=? WHERE id=?',
      patch.status, patch.duplicateOf, patch.preFlagStatus, patch.id);
  }
  await tx.execAsync('PRAGMA user_version = 3');
}

// v3 → v4 (P3, spec §4.2): balance anchors. New columns, then a parser-field backfill:
// the figures each stored message states are re-read from raw_body. Nothing the user
// sees on a row changes.
async function v3ToV4(tx: SqlExecutor): Promise<void> {
  await tx.execAsync(`
    ALTER TABLE transactions ADD COLUMN reported_balance_paise INTEGER;
    ALTER TABLE transactions ADD COLUMN reported_avl_limit_paise INTEGER;
    ALTER TABLE accounts ADD COLUMN opening_balance_paise INTEGER;
    ALTER TABLE accounts ADD COLUMN opening_balance_at INTEGER;
    ALTER TABLE accounts ADD COLUMN credit_limit_paise INTEGER;
  `);
  const rows = await tx.getAllAsync<{ id: string; raw_body: string }>('SELECT id, raw_body FROM transactions WHERE raw_body IS NOT NULL');
  for (const row of rows) {
    const parsed = parseBankSms(row.raw_body);
    if (!parsed || (parsed.reportedBalancePaise === null && parsed.reportedAvlLimitPaise === null)) continue;
    await tx.runAsync('UPDATE transactions SET reported_balance_paise=?, reported_avl_limit_paise=? WHERE id=?',
      parsed.reportedBalancePaise, parsed.reportedAvlLimitPaise, row.id);
  }
  await tx.execAsync('PRAGMA user_version = 4');
}


// Schedules (P4, spec §4.2). Only creates the table; the first detection run after the
// upgrade produces the suggestions. Records the step after whatever version it runs on,
// so its place in the list doesn't fix its number.
export async function addSchedules(tx: SqlExecutor): Promise<void> {
  const version = await readVersion(tx);
  // IF NOT EXISTS: an early P4 test build created this table without recording the
  // version, and the step must not fail on such a ledger (same columns).
  await tx.execAsync(`
    CREATE TABLE IF NOT EXISTS schedules (
      id           TEXT PRIMARY KEY,
      payee_id     TEXT NOT NULL REFERENCES payees(id),
      account_id   TEXT REFERENCES accounts(id),
      direction    TEXT NOT NULL CHECK (direction IN ('debit','credit')),
      interval     TEXT NOT NULL CHECK (interval IN ('weekly','fortnightly','monthly','quarterly')),
      anchor_day   INTEGER NOT NULL,
      anchor_month INTEGER,
      amount_min   INTEGER NOT NULL,
      amount_max   INTEGER NOT NULL,
      last_paid_at INTEGER,
      status       TEXT NOT NULL CHECK (status IN ('active','ended','dismissed')),
      created_at   INTEGER NOT NULL,
      decided_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedules_by_payee ON schedules (payee_id);
  `);
  await tx.execAsync(`PRAGMA user_version = ${version + 1}`);
}

// Habits (P5, spec §4.2): the only stored Habit decision is *Not a habit* on a payee.
export async function addHabitHidden(tx: SqlExecutor): Promise<void> {
  const version = await readVersion(tx);
  await tx.execAsync('ALTER TABLE payees ADD COLUMN habit_hidden INTEGER NOT NULL DEFAULT 0');
  await tx.execAsync(`PRAGMA user_version = ${version + 1}`);
}

// v6 → v7: the one-time re-check (regrade.ts) and bank-code sender rules. Senders that
// were never read before have history to catch up on, so the next scan reads the
// whole inbox again (ingest skips messages it already holds, by source hash).
export async function regradeAndSenders(tx: SqlExecutor): Promise<void> {
  const version = await readVersion(tx);
  const autoAddPref = await tx.getFirstAsync<{ value: string }>("SELECT value FROM preferences WHERE key='autoAdd'");
  const autoAdd = autoAddPref ? JSON.parse(autoAddPref.value) !== false : true;
  const rows = (await tx.getAllAsync<TransactionRow>('SELECT * FROM transactions')).map(transactionFromRow);
  const now = Date.now();
  for (const p of regradePatches(rows, autoAdd)) {
    await tx.runAsync('UPDATE transactions SET status=?, duplicate_of=?, pre_flag_status=?, confidence=?, updated_at=? WHERE id=?',
      p.status, p.duplicateOf, p.preFlagStatus, p.confidence, now, p.id);
  }
  let changed = false;
  for (const [from, to] of SENDER_RENAMES) {
    const r = await tx.runAsync('INSERT OR IGNORE INTO senders (address,label,enabled) SELECT ?, label, enabled FROM senders WHERE address=?', to, from);
    const d = await tx.runAsync('DELETE FROM senders WHERE address=?', from);
    changed ||= r.changes > 0 || d.changes > 0;
  }
  const hdfc = await tx.getFirstAsync<{ enabled: number }>("SELECT enabled FROM senders WHERE address='HDFCBK'");
  if (hdfc) {
    const r = await tx.runAsync('INSERT OR IGNORE INTO senders (address,label,enabled) VALUES (?,?,?)', HDFC_UPI_SENDER.address, HDFC_UPI_SENDER.label, hdfc.enabled);
    changed ||= r.changes > 0;
  }
  if (changed) await tx.runAsync("UPDATE preferences SET value='0' WHERE key='lastScanAt'");
  await tx.execAsync(`PRAGMA user_version = ${version + 1}`);
}

// v7 → v8: a transfer's other account (operator feedback, 2026-11-24).
export async function addTransferAccount(tx: SqlExecutor): Promise<void> {
  const version = await readVersion(tx);
  await tx.execAsync('ALTER TABLE transactions ADD COLUMN transfer_account_id TEXT REFERENCES accounts(id)');
  await tx.execAsync(`PRAGMA user_version = ${version + 1}`);
}

// v8 → v9: categories become the user's list (operator feedback, 2026-11-24), seeded with
// the built-ins in their usual order. A deleted category stays as a row with merged_into
// set, so messages the parser still files under it land in its replacement.
export async function addCategories(tx: SqlExecutor): Promise<void> {
  const version = await readVersion(tx);
  await tx.execAsync(`
    CREATE TABLE categories (
      name        TEXT PRIMARY KEY,
      color       TEXT NOT NULL,
      position    INTEGER NOT NULL,
      merged_into TEXT,
      created_at  INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  for (const [index, name] of CATEGORIES.entries()) {
    await tx.runAsync('INSERT INTO categories (name,color,position,merged_into,created_at) VALUES (?,?,?,NULL,?)', name, BUILT_IN_COLORS[name], index, now);
  }
  await tx.execAsync(`PRAGMA user_version = ${version + 1}`);
}

export const migrations: ((tx: SqlExecutor) => Promise<void>)[] = [v1ToV2, v2ToV3, v3ToV4, addSchedules, addHabitHidden, regradeAndSenders, addTransferAccount, addCategories];

export const LATEST_VERSION = migrations.length + 1;

// Tables created by migrations, dependents first (dropped in this order on restore).
export const MIGRATED_TABLES = ['categories', 'schedules', 'duplicate_dismissals', 'unparsed_messages', 'payees', 'accounts'] as const;

export async function readVersion(db: SqlExecutor): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  return Math.max(1, row?.user_version ?? 0);
}

export class NewerLedgerError extends Error {
  constructor() { super('This ledger was saved by a newer version of Kharcha. Update the app to open it.'); }
}

export async function migrate(db: SqlDatabase, target: number = LATEST_VERSION): Promise<number> {
  let version = await readVersion(db);
  if (version > LATEST_VERSION) throw new NewerLedgerError();
  while (version < target) {
    const step = migrations[version - 1];
    await db.withExclusiveTransactionAsync(tx => step(tx));
    const next = await readVersion(db);
    if (next <= version) throw new Error(`Migration to v${version + 1} did not record its version.`);
    version = next;
  }
  return version;
}
