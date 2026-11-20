import { identityFor, overrideKey } from './identity.ts';
import { LATEST_VERSION, MIGRATED_TABLES, V1_SCHEMA, migrate, migrations, readVersion, upsertAccount, upsertPayee } from './migrations.ts';
import type { SqlDatabase, SqlExecutor } from './migrations.ts';
import { accountFromRow, payeeFromRow, transactionFromRow, transactionToRow, v1TransactionRow } from './rows.ts';
import type { AccountRow, BudgetRow, PayeeRow, PreferenceRow, SenderRow, SqlValue, TransactionRow } from './rows.ts';
import { validateName } from './resolve.ts';
import type { Account, Budget, Category, Payee, Preferences, SenderRule, Transaction, TransactionStatus } from './model';

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
    const accountId = account ? await upsertAccount(tx, account, t.createdAt) : null;
    const payeeId = payee ? await upsertPayee(tx, payee, t.createdAt) : null;
    added = await insertRow(tx, 'transactions', transactionToRow({ ...t, accountId, payeeId, payeeOverrideId: null })) > 0;
  });
  return added;
}

export async function setTransactionStatusSql(db: SqlExecutor, id: string, status: TransactionStatus): Promise<void> {
  await db.runAsync('UPDATE transactions SET status=?, updated_at=? WHERE id=?', status, Date.now(), id);
}

export async function setTransactionCategorySql(db: SqlExecutor, id: string, category: Category): Promise<void> {
  await db.runAsync('UPDATE transactions SET category=?, category_by_user=1, updated_at=? WHERE id=?', category, Date.now(), id);
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

export async function markPayeeNudgedSql(db: SqlExecutor, id: string, at: number = Date.now()): Promise<void> {
  await db.runAsync('UPDATE payees SET nudged_at=? WHERE id=? AND nudged_at IS NULL', at, id);
}

export async function renameAccountSql(db: SqlExecutor, id: string, name: string | null): Promise<void> {
  await db.runAsync('UPDATE accounts SET name=? WHERE id=?', name === null ? null : validateName(name), id);
}

// User-confirmed debit-card link. Linking confirms the card is a debit card.
export async function linkDebitCardSql(db: SqlExecutor, cardId: string, bankId: string | null): Promise<void> {
  if (bankId === cardId) throw new Error('A card cannot fund itself.');
  if (bankId) await db.runAsync("UPDATE accounts SET funded_by=?, kind='debit_card' WHERE id=?", bankId, cardId);
  else await db.runAsync('UPDATE accounts SET funded_by=NULL WHERE id=?', cardId);
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
    for (const table of ['accounts', 'payees', 'transactions', 'budgets', 'senders', 'preferences'] as const) {
      const columns = new Set((await tx.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`)).map(c => c.name));
      for (const row of snapshot[table] as unknown as Record<string, unknown>[]) await insertRow(tx, table, row, columns);
    }
  });
  await migrate(db);
}
