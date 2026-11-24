import { identityFor, overrideKey } from './identity.ts';
import { LATEST_VERSION, MIGRATED_TABLES, V1_SCHEMA, migrate, migrations, readVersion, upsertAccount, upsertPayee } from './migrations.ts';
import type { SqlDatabase, SqlExecutor } from './migrations.ts';
import { accountFromRow, categoryFromRow, payeeFromRow, scheduleFromRow, scheduleToRow, transactionFromRow, transactionToRow, unparsedFromRow, v1TransactionRow } from './rows.ts';
import type { AccountRow, BudgetRow, CategoryRow, DismissalRow, PayeeRow, PreferenceRow, ScheduleRow, SenderRow, SqlValue, TransactionRow, UnparsedRow } from './rows.ts';
import { DUPLICATE_WINDOW_MS, flagDuplicates, keepBothDecision, mergeDecision, pairKey, unmergeDecision } from './duplicates.ts';
import type { DuplicateDecision } from './duplicates.ts';
import { validateName } from './resolve.ts';
import { validateTerms } from './schedules.ts';
import { checkDelete, validateCategoryName } from './categories.ts';
import { CATEGORY_SWATCHES } from './model.ts';
import type { Account, AccountKind, Budget, Category, CategoryDef, Payee, Preferences, Schedule, SenderRule, Transaction, TransactionStatus, UnparsedMessage } from './model';

// SQL ledger operations shared by the app (expo-sqlite) and the node harness
// (node:sqlite). Raw parser fields are written once, at insert, and never again.

export async function listTransactionRows(db: SqlExecutor): Promise<Transaction[]> {
  const rows = await db.getAllAsync<TransactionRow>('SELECT * FROM transactions ORDER BY occurred_at DESC, created_at DESC');
  return rows.map(transactionFromRow);
}

export async function listAccountRows(db: SqlExecutor): Promise<Account[]> {
  return (await db.getAllAsync<AccountRow>('SELECT * FROM accounts ORDER BY bank, last4')).map(accountFromRow);
}

export async function listPayeeRows(db: SqlExecutor): Promise<Payee[]> {
  return (await db.getAllAsync<PayeeRow>('SELECT * FROM payees ORDER BY created_at, id')).map(payeeFromRow);
}

export async function listUnparsedRows(db: SqlExecutor): Promise<UnparsedMessage[]> {
  return (await db.getAllAsync<UnparsedRow>('SELECT * FROM unparsed_messages ORDER BY received_at DESC, id')).map(unparsedFromRow);
}

async function insertRow(tx: SqlExecutor, table: string, row: object, columns?: ReadonlySet<string>): Promise<number> {
  const values = row as Record<string, unknown>;
  const keys = Object.keys(values).filter(key => !columns || columns.has(key));
  const sql = `INSERT OR IGNORE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return (await tx.runAsync(sql, ...keys.map(key => (values[key] ?? null) as SqlValue))).changes;
}

// Ingest: resolve account and payee, then insert. Returns false when the row is
// already in the ledger (same id or same source hash).
export async function insertTransaction(db: SqlDatabase, t: Transaction): Promise<boolean> {
  let added = false;
  await db.withExclusiveTransactionAsync(async tx => {
    const exists = await tx.getFirstAsync('SELECT 1 FROM transactions WHERE id=? OR (source_hash IS NOT NULL AND source_hash=?)', t.id, t.sourceHash);
    if (exists) return;
    const { account, payee } = identityFor(t);
    // A manual entry has no sender to derive an account from; it may carry one the user
    // chose (logging a balance gap on that account, WF-4).
    const accountId = account ? await upsertAccount(tx, account, t.createdAt) : t.sender ? null : t.accountId ?? null;
    const payeeId = payee ? await upsertPayee(tx, payee, t.createdAt) : null;
    added = await insertRow(tx, 'transactions', transactionToRow({ ...t, accountId, payeeId, payeeOverrideId: null })) > 0;
    if (added) await followCategoryMerges(tx);
  });
  return added;
}

// A message the scan read but the parser couldn't ("Couldn't read"). Kept once per SMS.
export interface UnparsedInput {
  id: string; sourceHash: string; sender: string; rawBody: string; receivedAt: number; amountPaise: number | null;
}

export interface ScanBatch { transactions: Transaction[]; unparsed: UnparsedInput[] }
export interface IngestResult { added: number; flagged: number; unparsed: number }
// Ingest steps for a progress bar: checking each candidate against the ledger, then adding
// the new rows and "Couldn't read" messages.
export interface IngestProgress { phase: 'checking' | 'adding'; done: number; total: number }
const INGEST_PROGRESS_EVERY = 25;

// Scan ingest (spec §5.2): drop rows already in the ledger by source hash, resolve
// identity, flag duplicates against the ledger from 24h before the batch and against
// the batch itself, then insert oldest first. One transaction for the whole batch.
export async function ingestScanSql(db: SqlDatabase, batch: ScanBatch, now: number = Date.now(), onProgress?: (progress: IngestProgress) => void): Promise<IngestResult> {
  const result: IngestResult = { added: 0, flagged: 0, unparsed: 0 };
  const tick = (phase: IngestProgress['phase'], done: number, total: number) => {
    if (onProgress && (done % INGEST_PROGRESS_EVERY === 0 || done === total)) onProgress({ phase, done, total });
  };
  await db.withExclusiveTransactionAsync(async tx => {
    const fresh: Transaction[] = [];
    // One read of what the ledger holds, instead of a query per candidate: a whole-inbox
    // scan re-reads thousands of messages that are already stored.
    const known = await tx.getAllAsync<{ id: string; source_hash: string | null }>('SELECT id, source_hash FROM transactions');
    const ids = new Set(known.map(r => r.id));
    const seen = new Set(known.flatMap(r => r.source_hash ? [r.source_hash] : []));
    for (const [index, t] of batch.transactions.entries()) {
      tick('checking', index, batch.transactions.length);
      if (ids.has(t.id) || (t.sourceHash && seen.has(t.sourceHash))) continue;
      if (t.sourceHash) seen.add(t.sourceHash);
      const { account, payee } = identityFor(t);
      const accountId = account ? await upsertAccount(tx, account, t.createdAt) : null;
      const payeeId = payee ? await upsertPayee(tx, payee, t.createdAt) : null;
      fresh.push({ ...t, accountId, payeeId, payeeOverrideId: null });
    }
    if (fresh.length) {
      const since = Math.min(...fresh.map(t => t.occurredAt)) - DUPLICATE_WINDOW_MS;
      const existing = (await tx.getAllAsync<TransactionRow>(
        "SELECT * FROM transactions WHERE occurred_at >= ? AND status IN ('auto','review','manual','duplicate_review')", since)).map(transactionFromRow);
      const dismissed = new Set((await tx.getAllAsync<DismissalRow>('SELECT a_id, b_id FROM duplicate_dismissals')).map(d => pairKey(d.a_id, d.b_id)));
      const flagged = flagDuplicates(fresh, existing, dismissed).sort((a, b) => a.occurredAt - b.occurredAt || a.createdAt - b.createdAt);
      const adding = flagged.length + batch.unparsed.length;
      for (const [index, t] of flagged.entries()) {
        tick('adding', index, adding);
        if (await insertRow(tx, 'transactions', transactionToRow(t)) > 0) {
          result.added++;
          if (t.status === 'duplicate_review') result.flagged++;
        }
      }
    }
    for (const [index, m] of batch.unparsed.entries()) {
      tick('adding', fresh.length + index, fresh.length + batch.unparsed.length);
      result.unparsed += (await tx.runAsync(
        "INSERT OR IGNORE INTO unparsed_messages (id,source_hash,sender,raw_body,received_at,amount_paise,status,created_at) VALUES (?,?,?,?,?,?,'pending',?)",
        m.id, m.sourceHash, m.sender, m.rawBody, m.receivedAt, m.amountPaise, now)).changes;
    }
    await followCategoryMerges(tx);
  });
  return result;
}

// --- Categories (schema v9) ----------------------------------------------------------

// New rows the parser filed under a deleted category move to its replacement.
export async function followCategoryMerges(tx: SqlExecutor): Promise<void> {
  if (!await tx.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='categories'")) return;
  await tx.runAsync(`UPDATE transactions SET category=(SELECT merged_into FROM categories c WHERE c.name=transactions.category)
    WHERE category IN (SELECT name FROM categories WHERE merged_into IS NOT NULL)`);
}

export async function listCategoryRows(db: SqlExecutor): Promise<CategoryDef[]> {
  return (await db.getAllAsync<CategoryRow>('SELECT * FROM categories ORDER BY position, name')).map(categoryFromRow);
}

export async function addCategorySql(db: SqlExecutor, name: string, color: string = CATEGORY_SWATCHES[0]): Promise<string> {
  const all = await listCategoryRows(db);
  const clean = validateCategoryName(name, all);
  const position = Math.max(-1, ...all.map(c => c.position)) + 1;
  // A name deleted earlier comes back as itself (its old rows stay where they moved).
  const gone = all.find(c => c.mergedInto && c.name.toLowerCase() === clean.toLowerCase());
  if (gone) await db.runAsync('UPDATE categories SET merged_into=NULL, color=?, position=? WHERE name=?', color, position, gone.name);
  else await db.runAsync('INSERT INTO categories (name,color,position,merged_into,created_at) VALUES (?,?,?,NULL,?)', clean, color, position, Date.now());
  return gone?.name ?? clean;
}

// Delete: every row, payee default and budget under `name` moves to `into`. A budget
// already set on `into` wins; the deleted one's is dropped.
export async function deleteCategorySql(db: SqlDatabase, name: Category, into: Category): Promise<void> {
  await db.withExclusiveTransactionAsync(async tx => {
    checkDelete(name, into, await listCategoryRows(tx));
    const now = Date.now();
    await tx.runAsync('UPDATE transactions SET category=?, updated_at=? WHERE category=?', into, now, name);
    await tx.runAsync('UPDATE payees SET category=? WHERE category=?', into, name);
    if (await tx.getFirstAsync('SELECT 1 FROM budgets WHERE category=?', into)) await tx.runAsync('DELETE FROM budgets WHERE category=?', name);
    else await tx.runAsync('UPDATE budgets SET category=? WHERE category=?', into, name);
    await tx.runAsync('UPDATE categories SET merged_into=? WHERE name=? OR merged_into=?', into, name, name);
  });
}

// Leaving the duplicate states through a plain status change drops the pair link.
export async function setTransactionStatusSql(db: SqlExecutor, id: string, status: TransactionStatus): Promise<void> {
  const keepLink = status === 'duplicate_review' || status === 'merged' ? 1 : 0;
  await db.runAsync(`UPDATE transactions SET status=?, updated_at=?,
    duplicate_of=CASE WHEN ? THEN duplicate_of ELSE NULL END, pre_flag_status=CASE WHEN ? THEN pre_flag_status ELSE NULL END WHERE id=?`,
  status, Date.now(), keepLink, keepLink, id);
}

// --- Duplicate review (spec §5.2) --------------------------------------------------

async function decide(db: SqlDatabase, ids: (tx: SqlExecutor) => Promise<TransactionRow[]>, choose: (rows: Map<string, Transaction>) => DuplicateDecision): Promise<void> {
  await db.withExclusiveTransactionAsync(async tx => {
    const rows = new Map((await ids(tx)).map(r => [r.id, transactionFromRow(r)]));
    const { patches, dismiss } = choose(rows);
    const now = Date.now();
    for (const p of patches) {
      await tx.runAsync('UPDATE transactions SET status=?, duplicate_of=?, pre_flag_status=?, duplicate_cleared=COALESCE(?, duplicate_cleared), updated_at=? WHERE id=?',
        p.status, p.duplicateOf, p.preFlagStatus, p.duplicateCleared === undefined ? null : Number(p.duplicateCleared), now, p.id);
    }
    if (dismiss) await tx.runAsync('INSERT OR IGNORE INTO duplicate_dismissals (a_id,b_id,created_at) VALUES (?,?,?)', dismiss[0], dismiss[1], now);
  });
}

const pairRows = (flaggedId: string) => (tx: SqlExecutor) => tx.getAllAsync<TransactionRow>(
  `SELECT * FROM transactions WHERE id=? OR id=(SELECT duplicate_of FROM transactions WHERE id=?)
     OR duplicate_of=(SELECT duplicate_of FROM transactions WHERE id=?)`, flaggedId, flaggedId, flaggedId);

export async function mergeDuplicateSql(db: SqlDatabase, flaggedId: string, survivorId: string): Promise<void> {
  await decide(db, pairRows(flaggedId), rows => mergeDecision(rows, flaggedId, survivorId));
}

export async function keepBothSql(db: SqlDatabase, id: string): Promise<void> {
  await decide(db, tx => tx.getAllAsync<TransactionRow>('SELECT * FROM transactions WHERE id=?', id), rows => keepBothDecision(rows, id));
}

export async function unmergeSql(db: SqlDatabase, id: string): Promise<void> {
  await decide(db, tx => tx.getAllAsync<TransactionRow>('SELECT * FROM transactions WHERE id=?', id), rows => unmergeDecision(rows, id));
}

// --- Couldn't read ------------------------------------------------------------------

export async function linkUnparsedSql(db: SqlExecutor, id: string, transactionId: string): Promise<void> {
  await db.runAsync("UPDATE unparsed_messages SET status='added', transaction_id=? WHERE id=? AND status='pending'", transactionId, id);
}

// Dismissing blanks the stored body (privacy posture, spec §9); the hash stays so the
// same SMS isn't captured again.
export async function dismissUnparsedSql(db: SqlExecutor, id: string): Promise<void> {
  await db.runAsync("UPDATE unparsed_messages SET status='dismissed', raw_body='' WHERE id=?", id);
}

export async function setTransactionCategorySql(db: SqlExecutor, id: string, category: Category): Promise<void> {
  await db.runAsync('UPDATE transactions SET category=?, category_by_user=1, updated_at=? WHERE id=?', category, Date.now(), id);
}

// Transfers: which of your accounts the money left and which it reached. The row's own
// side is its account_id; the other side is transfer_account_id (null: not your account).
export function transferSides(direction: 'debit' | 'credit', from: string | null, to: string | null): { accountId: string | null; transferAccountId: string | null } {
  if (from && to && from === to) throw new Error('Pick two different accounts.');
  return direction === 'debit' ? { accountId: from, transferAccountId: to } : { accountId: to, transferAccountId: from };
}

export async function setTransferSql(db: SqlExecutor, id: string, from: string | null, to: string | null): Promise<void> {
  const row = await db.getFirstAsync<{ direction: 'debit' | 'credit' }>('SELECT direction FROM transactions WHERE id=?', id);
  if (!row) throw new Error('Entry not found.');
  const sides = transferSides(row.direction, from, to);
  await db.runAsync('UPDATE transactions SET account_id=?, transfer_account_id=?, updated_at=? WHERE id=?', sides.accountId, sides.transferAccountId, Date.now(), id);
}

export type MoveTarget = string | { newName: string };

// "Move this one": per-row reassignment (WF-1 collision escape hatch). Moving back to
// the row's own ingest payee clears the override.
export async function movePayeeSql(db: SqlDatabase, transactionId: string, target: MoveTarget): Promise<string> {
  let result = '';
  await db.withExclusiveTransactionAsync(async tx => {
    const row = await tx.getFirstAsync<TransactionRow>('SELECT * FROM transactions WHERE id=?', transactionId);
    if (!row) throw new Error('Entry not found.');
    let targetId: string;
    if (typeof target === 'string') {
      if (!await tx.getFirstAsync('SELECT 1 FROM payees WHERE id=?', target)) throw new Error('Payee not found.');
      targetId = target;
    } else {
      const name = validateName(target.newName);
      if (!name) throw new Error('Enter a name for the new payee.');
      const base = await tx.getFirstAsync<PayeeRow>('SELECT * FROM payees WHERE id=?', row.payee_override_id ?? row.payee_id ?? '');
      const kind = base?.kind ?? 'merchant';
      const bank = base?.bank ?? '';
      const baseKey = (base?.key ?? name.toLowerCase()).replace(/#\d+$/, '');
      const taken = await tx.getAllAsync<{ key: string }>("SELECT key FROM payees WHERE kind=? AND bank=? AND key LIKE ? ESCAPE '\\'",
        kind, bank, `${baseKey.replace(/[\\%_]/g, c => `\\${c}`)}#%`);
      const key = overrideKey(baseKey, taken.map(r => r.key));
      targetId = `payee:${kind}:${bank}:${key}`;
      await tx.runAsync('INSERT INTO payees (id,kind,bank,key,masked,name,created_at) VALUES (?,?,?,?,?,?,?)',
        targetId, kind, bank, key, base?.masked ?? name, name, Date.now());
    }
    await tx.runAsync('UPDATE transactions SET payee_override_id=?, updated_at=? WHERE id=?',
      targetId === row.payee_id ? null : targetId, Date.now(), transactionId);
    result = targetId;
  });
  return result;
}

// category: undefined leaves the default category as it is; null clears it.
export async function renamePayeeSql(db: SqlExecutor, id: string, name: string | null, category?: Category | null): Promise<void> {
  const clean = name === null ? null : validateName(name);
  if (category === undefined) await db.runAsync('UPDATE payees SET name=? WHERE id=?', clean, id);
  else await db.runAsync('UPDATE payees SET name=?, category=? WHERE id=?', clean, category, id);
}

// *Not a habit* (P5): set or clear on every payee of one display group at once.
export async function setHabitHiddenSql(db: SqlExecutor, ids: readonly string[], hidden: boolean): Promise<void> {
  for (const id of ids) await db.runAsync('UPDATE payees SET habit_hidden=? WHERE id=?', hidden ? 1 : 0, id);
}

export async function markPayeeNudgedSql(db: SqlExecutor, id: string, at: number = Date.now()): Promise<void> {
  await db.runAsync('UPDATE payees SET nudged_at=? WHERE id=? AND nudged_at IS NULL', at, id);
}

// Balances (P3). An opening balance anchors a bank account that never states one; a
// credit limit turns a card's available limit into an outstanding figure. null clears.
export function validPaise(paise: number | null, label: string, allowNegative = false): number | null {
  if (paise === null) return null;
  if (!Number.isSafeInteger(paise) || (!allowNegative && paise <= 0)) throw new Error(`Enter a valid ${label}.`);
  return paise;
}

export async function setOpeningBalanceSql(db: SqlExecutor, id: string, paise: number | null, at: number): Promise<void> {
  const value = validPaise(paise, 'opening balance', true);
  const row = await db.getFirstAsync<{ kind: string }>('SELECT kind FROM accounts WHERE id=?', id);
  if (row?.kind !== 'bank') throw new Error('Only a bank account takes an opening balance.');
  await db.runAsync('UPDATE accounts SET opening_balance_paise=?, opening_balance_at=? WHERE id=?', value, value === null ? null : at, id);
}

export async function setCreditLimitSql(db: SqlExecutor, id: string, paise: number | null): Promise<void> {
  const value = validPaise(paise, 'credit limit');
  const row = await db.getFirstAsync<{ kind: string }>('SELECT kind FROM accounts WHERE id=?', id);
  if (row?.kind !== 'credit_card') throw new Error('Only a credit card takes a credit limit.');
  await db.runAsync('UPDATE accounts SET credit_limit_paise=? WHERE id=?', value, id);
}

export async function renameAccountSql(db: SqlExecutor, id: string, name: string | null): Promise<void> {
  await db.runAsync('UPDATE accounts SET name=? WHERE id=?', name === null ? null : validateName(name), id);
}

// Ownership (v10): true yours, false not tracked, null undecided.
export async function setAccountMineSql(db: SqlExecutor, id: string, mine: boolean | null): Promise<void> {
  await db.runAsync('UPDATE accounts SET mine=? WHERE id=?', mine === null ? null : Number(mine), id);
}

// A type you choose sticks (kind_by_user). Only a debit card draws from another account.
export async function setAccountKindSql(db: SqlExecutor, id: string, kind: AccountKind): Promise<void> {
  if (kind === 'debit_card') await db.runAsync('UPDATE accounts SET kind=?, kind_by_user=1 WHERE id=?', kind, id);
  else await db.runAsync('UPDATE accounts SET kind=?, kind_by_user=1, funded_by=NULL WHERE id=?', kind, id);
}

// User-confirmed debit-card link. Linking confirms the card is a debit card.
export async function linkDebitCardSql(db: SqlExecutor, cardId: string, bankId: string | null): Promise<void> {
  if (bankId === cardId) throw new Error('A card cannot fund itself.');
  if (bankId) await db.runAsync("UPDATE accounts SET funded_by=?, kind='debit_card' WHERE id=?", bankId, cardId);
  else await db.runAsync('UPDATE accounts SET funded_by=NULL WHERE id=?', cardId);
}

// --- Schedules (spec §5.4) -----------------------------------------------------------

export async function listScheduleRows(db: SqlExecutor): Promise<Schedule[]> {
  return (await db.getAllAsync<ScheduleRow>('SELECT * FROM schedules ORDER BY created_at, id')).map(scheduleFromRow);
}

// Track it, Track as schedule, and Not a schedule (a 'dismissed' row) all store one row.
export async function insertScheduleSql(db: SqlExecutor, s: Schedule): Promise<void> {
  if (s.status !== 'dismissed') validateTerms(s);
  await insertRow(db, 'schedules', scheduleToRow(s));
}

export type ScheduleTerms = Pick<Schedule, 'interval' | 'anchorDay' | 'anchorMonth' | 'amountMin' | 'amountMax'>;

// The user edits terms; detection never does (WF-6).
export async function updateScheduleTermsSql(db: SqlExecutor, id: string, terms: ScheduleTerms, at: number = Date.now()): Promise<void> {
  validateTerms(terms);
  await db.runAsync("UPDATE schedules SET interval=?, anchor_day=?, anchor_month=?, amount_min=?, amount_max=?, decided_at=? WHERE id=? AND status='active'",
    terms.interval, terms.anchorDay, terms.anchorMonth, terms.amountMin, terms.amountMax, at, id);
}

// Stop tracking: the row (and its history) stays, and it is never suggested again.
export async function endScheduleSql(db: SqlExecutor, id: string, at: number = Date.now()): Promise<void> {
  await db.runAsync("UPDATE schedules SET status='ended', decided_at=? WHERE id=? AND status='active'", at, id);
}

// --- Backup snapshots (spec §4.3) --------------------------------------------------

export interface SnapshotV1 {
  schema: 1;
  transactions: Pick<Transaction, 'id' | 'sourceHash' | 'sender' | 'rawBody' | 'occurredAt' | 'merchant' | 'amountPaise' | 'direction' | 'category' | 'status' | 'accountLast4' | 'counterpartyLast4' | 'reference' | 'confidence' | 'createdAt' | 'updatedAt'>[];
  budgets: Budget[];
  senders: SenderRule[];
  preferences: Partial<Preferences>;
  exportedAt: number;
}

export interface SnapshotV2 {
  schema: 2;
  schemaVersion: number;
  transactions: TransactionRow[];
  budgets: BudgetRow[];
  senders: SenderRow[];
  preferences: PreferenceRow[];
  accounts: AccountRow[];
  payees: PayeeRow[];
  // v3; omitted when the writer's ledger predates the table.
  unparsed_messages?: UnparsedRow[];
  duplicate_dismissals?: DismissalRow[];
  // P4
  schedules?: ScheduleRow[];
  // v9
  categories?: CategoryRow[];
  exportedAt: number;
}

export type Snapshot = SnapshotV1 | SnapshotV2;

export class UnsupportedSnapshotError extends Error {
  constructor() { super('This backup was made by an unsupported version of Kharcha.'); }
}

export function validateSnapshot(value: unknown): Snapshot {
  const s = value as { schema?: unknown; schemaVersion?: unknown; transactions?: unknown; budgets?: unknown; senders?: unknown; preferences?: unknown; accounts?: unknown; payees?: unknown };
  if (!s || typeof s !== 'object' || !Array.isArray(s.transactions) || !Array.isArray(s.budgets) || !Array.isArray(s.senders)) {
    throw new Error('This backup format is not supported.');
  }
  if (s.schema === 1) return s as unknown as SnapshotV1;
  if (s.schema === 2 && Number.isInteger(s.schemaVersion) && Array.isArray(s.accounts) && Array.isArray(s.payees) && Array.isArray(s.preferences)) {
    if ((s.schemaVersion as number) > LATEST_VERSION || (s.schemaVersion as number) < 2) throw new UnsupportedSnapshotError();
    return s as unknown as SnapshotV2;
  }
  throw new UnsupportedSnapshotError();
}

async function tableNames(db: SqlExecutor): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
  return new Set(rows.map(r => r.name));
}

export async function exportSnapshotSql(db: SqlExecutor): Promise<SnapshotV2> {
  const schemaVersion = await readVersion(db);
  const tables = await tableNames(db);
  const read = async <T>(table: string): Promise<T[]> => tables.has(table) ? db.getAllAsync<T>(`SELECT * FROM ${table}`) : [];
  return {
    schema: 2, schemaVersion,
    transactions: await read<TransactionRow>('transactions'),
    budgets: await read<BudgetRow>('budgets'),
    senders: await read<SenderRow>('senders'),
    preferences: await read<PreferenceRow>('preferences'),
    accounts: await read<AccountRow>('accounts'),
    payees: await read<PayeeRow>('payees'),
    ...tables.has('unparsed_messages') ? { unparsed_messages: await read<UnparsedRow>('unparsed_messages') } : {},
    ...tables.has('duplicate_dismissals') ? { duplicate_dismissals: await read<DismissalRow>('duplicate_dismissals') } : {},
    ...tables.has('schedules') ? { schedules: await read<ScheduleRow>('schedules') } : {},
    ...tables.has('categories') ? { categories: await read<CategoryRow>('categories') } : {},
    exportedAt: Date.now(),
  };
}

// Restore resets the ledger to the snapshot's own schema version (v1 baseline plus the
// migrations up to it, run on empty tables), loads the rows with every column, then
// runs the normal migrations forward. A schema-1 snapshot is a v1 ledger, so restoring
// one exercises exactly the upgrade path an old install takes.
export async function restoreSnapshotSql(db: SqlDatabase, input: unknown): Promise<void> {
  const snapshot = validateSnapshot(input);
  const version = snapshot.schema === 1 ? 1 : snapshot.schemaVersion;
  await db.withExclusiveTransactionAsync(async tx => {
    await tx.execAsync(['transactions', ...MIGRATED_TABLES, 'budgets', 'senders', 'preferences']
      .map(table => `DROP TABLE IF EXISTS ${table};`).join('\n'));
    await tx.execAsync(V1_SCHEMA);
    await tx.execAsync('PRAGMA user_version = 1');
    for (let v = 1; v < version; v++) await migrations[v - 1](tx);
    if (snapshot.schema === 1) {
      for (const t of snapshot.transactions) await insertRow(tx, 'transactions', v1TransactionRow(t));
      for (const b of snapshot.budgets) await tx.runAsync('INSERT OR IGNORE INTO budgets VALUES (?,?)', b.category, b.amountPaise);
      for (const s of snapshot.senders) await tx.runAsync('INSERT OR IGNORE INTO senders VALUES (?,?,?)', s.address, s.label, Number(s.enabled));
      for (const [key, value] of Object.entries(snapshot.preferences ?? {})) {
        await tx.runAsync('INSERT OR IGNORE INTO preferences VALUES (?,?)', key, JSON.stringify(value));
      }
      return;
    }
    // Parents before children so the references hold.
    for (const table of ['categories', 'accounts', 'payees', 'transactions', 'unparsed_messages', 'duplicate_dismissals', 'schedules', 'budgets', 'senders', 'preferences'] as const) {
      const rows = (snapshot[table] ?? []) as unknown as Record<string, unknown>[];
      if (!rows.length) continue;
      const columns = new Set((await tx.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`)).map(c => c.name));
      // A table newer than the snapshot's own version is filled by the migrations after.
      if (!columns.size) continue;
      // The v9 step seeded the built-ins; the snapshot's own list replaces them.
      if (table === 'categories') await tx.runAsync('DELETE FROM categories');
      for (const row of rows) await insertRow(tx, table, row, columns);
    }
  });
  await migrate(db);
}
