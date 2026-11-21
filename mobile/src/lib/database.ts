import * as SQLite from 'expo-sqlite';
import { DEFAULT_PREFERENCES, DEFAULT_SENDERS } from './model';
import type { Account, Budget, Category, Payee, Preferences, SenderRule, Transaction, TransactionStatus, UnparsedMessage } from './model';
import { V1_SCHEMA, migrate } from './migrations';
import type { SqlDatabase } from './migrations';
import {
  dismissUnparsedSql, exportSnapshotSql, ingestScanSql, insertTransaction, keepBothSql, linkDebitCardSql, linkUnparsedSql,
  listAccountRows, listPayeeRows, listTransactionRows, listUnparsedRows, markPayeeNudgedSql, mergeDuplicateSql, movePayeeSql,
  renameAccountSql, renamePayeeSql, restoreSnapshotSql, setTransactionCategorySql, setTransactionStatusSql, unmergeSql,
} from './ledger';
import type { IngestResult, MoveTarget, ScanBatch, Snapshot, SnapshotV2 } from './ledger';

export type { IngestResult, MoveTarget, ScanBatch, Snapshot } from './ledger';

let database: Promise<SQLite.SQLiteDatabase> | undefined;

function sql(db: SQLite.SQLiteDatabase): SqlDatabase { return db as unknown as SqlDatabase; }

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!database) {
    database = (async () => {
      const db = await SQLite.openDatabaseAsync('kharcha.db');
      await db.execAsync(`PRAGMA journal_mode = WAL;\n${V1_SCHEMA}`);
      await migrate(sql(db));
      const seeded = await db.getFirstAsync<{ value: string }>('SELECT value FROM metadata WHERE key=?', 'default_senders');
      if (!seeded) {
        const existingUser = await db.getFirstAsync('SELECT 1 FROM preferences WHERE key=?', 'onboardingDone');
        if (!existingUser) for (const sender of DEFAULT_SENDERS) {
          await db.runAsync('INSERT OR IGNORE INTO senders (address,label,enabled) VALUES (?,?,?)', sender.address, sender.label, Number(sender.enabled));
        }
        await db.runAsync('INSERT INTO metadata (key,value) VALUES (?,?)', 'default_senders', '1');
      }
      return db;
    })().catch(error => { database = undefined; throw error; });
  }
  return database;
}

async function ledger(): Promise<SqlDatabase> { return sql(await getDatabase()); }

export async function listTransactions(): Promise<Transaction[]> { return listTransactionRows(await ledger()); }
export async function listAccounts(): Promise<Account[]> { return listAccountRows(await ledger()); }
export async function listPayees(): Promise<Payee[]> { return listPayeeRows(await ledger()); }

export async function listUnparsed(): Promise<UnparsedMessage[]> { return listUnparsedRows(await ledger()); }

export async function addTransaction(t: Transaction): Promise<boolean> { return insertTransaction(await ledger(), t); }
export async function ingestScan(batch: ScanBatch): Promise<IngestResult> { return ingestScanSql(await ledger(), batch); }

export async function mergeDuplicate(flaggedId: string, survivorId: string): Promise<void> { await mergeDuplicateSql(await ledger(), flaggedId, survivorId); }
export async function keepBoth(id: string): Promise<void> { await keepBothSql(await ledger(), id); }
export async function unmerge(id: string): Promise<void> { await unmergeSql(await ledger(), id); }
export async function linkUnparsed(id: string, transactionId: string): Promise<void> { await linkUnparsedSql(await ledger(), id, transactionId); }
export async function dismissUnparsed(id: string): Promise<void> { await dismissUnparsedSql(await ledger(), id); }

export async function setTransactionStatus(id: string, status: TransactionStatus): Promise<void> { await setTransactionStatusSql(await ledger(), id, status); }
export async function setTransactionCategory(id: string, category: Category): Promise<void> { await setTransactionCategorySql(await ledger(), id, category); }
export async function movePayee(id: string, target: MoveTarget): Promise<string> { return movePayeeSql(await ledger(), id, target); }
export async function renamePayee(id: string, name: string | null, category?: Category | null): Promise<void> { await renamePayeeSql(await ledger(), id, name, category); }
export async function markPayeeNudged(id: string): Promise<void> { await markPayeeNudgedSql(await ledger(), id); }
export async function renameAccount(id: string, name: string | null): Promise<void> { await renameAccountSql(await ledger(), id, name); }
export async function linkDebitCard(cardId: string, bankId: string | null): Promise<void> { await linkDebitCardSql(await ledger(), cardId, bankId); }

export async function listBudgets(): Promise<Budget[]> {
  return (await getDatabase()).getAllAsync<Budget>('SELECT category, amount_paise AS amountPaise FROM budgets ORDER BY category');
}

export async function saveBudget(category: Category, amountPaise: number): Promise<void> {
  await (await getDatabase()).runAsync('INSERT INTO budgets (category,amount_paise) VALUES (?,?) ON CONFLICT(category) DO UPDATE SET amount_paise=excluded.amount_paise', category, amountPaise);
}

export async function removeBudget(category: Category): Promise<void> {
  await (await getDatabase()).runAsync('DELETE FROM budgets WHERE category=?', category);
}

export async function listSenders(): Promise<SenderRule[]> {
  const rows = await (await getDatabase()).getAllAsync<{ address: string; label: string; enabled: number }>('SELECT address,label,enabled FROM senders ORDER BY address');
  return rows.map(row => ({ ...row, enabled: !!row.enabled }));
}

export async function saveSender(sender: SenderRule): Promise<void> {
  await (await getDatabase()).runAsync('INSERT INTO senders (address,label,enabled) VALUES (?,?,?) ON CONFLICT(address) DO UPDATE SET label=excluded.label,enabled=excluded.enabled',
    sender.address.toUpperCase().trim(), sender.label.trim(), Number(sender.enabled));
}

export async function removeSender(address: string): Promise<void> {
  await (await getDatabase()).runAsync('DELETE FROM senders WHERE address=?', address);
}

export async function loadPreferences(): Promise<Preferences> {
  const rows = await (await getDatabase()).getAllAsync<{ key: string; value: string }>('SELECT key,value FROM preferences');
  const values = Object.fromEntries(rows.map(({ key, value }) => [key, JSON.parse(value)]));
  return { ...DEFAULT_PREFERENCES, ...values };
}

export async function savePreference<K extends keyof Preferences>(key: K, value: Preferences[K]): Promise<void> {
  await (await getDatabase()).runAsync('INSERT INTO preferences (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}

export async function exportSnapshot(): Promise<SnapshotV2> { return exportSnapshotSql(await ledger()); }

export async function restoreSnapshot(snapshot: Snapshot): Promise<void> { await restoreSnapshotSql(await ledger(), snapshot); }
