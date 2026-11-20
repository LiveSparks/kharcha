// node:sqlite behind the same async surface the app gets from expo-sqlite, so the
// real migrations and ledger code run unchanged in `node --test` and the replay.
import { DatabaseSync } from 'node:sqlite';

const plain = row => row && { ...row };

export function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  const exec = {
    async execAsync(sql) { db.exec(sql); },
    async runAsync(sql, ...params) { return { changes: Number(db.prepare(sql).run(...params).changes) }; },
    async getAllAsync(sql, ...params) { return db.prepare(sql).all(...params).map(plain); },
    async getFirstAsync(sql, ...params) { return plain(db.prepare(sql).get(...params)) ?? null; },
  };
  let busy = false;
  return {
    ...exec,
    raw: db,
    close: () => db.close(),
    async withExclusiveTransactionAsync(task) {
      if (busy) throw new Error('nested transaction');
      busy = true;
      db.exec('BEGIN EXCLUSIVE');
      try { await task(exec); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      finally { busy = false; }
    },
  };
}
