// A small stand-in for Cloudflare D1, backed by Node's built-in SQLite, so
// the Worker's real SQL (and the real migration file) run in tests.
// It implements only the D1 calls the Worker uses: prepare/bind/first/all/run
// and batch (all-or-nothing, like D1).

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const MIGRATION = new URL('../../worker/migrations/0001_init.sql', import.meta.url);

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(MIGRATION, 'utf8'));

  const statement = (sql, params = []) => ({
    bind: (...values) => {
      if (values.some((v) => v === undefined)) throw new Error('D1_TYPE_ERROR: undefined bound');
      return statement(sql, values);
    },
    first: async (column) => {
      const row = db.prepare(sql).get(...params) ?? null;
      return column ? (row?.[column] ?? null) : (row && { ...row });
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...params).map((r) => ({ ...r })) }),
    run: async () => ({ success: true, meta: { changes: db.prepare(sql).run(...params).changes } }),
    runSync: () => db.prepare(sql).run(...params),
  });

  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => s.runSync());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    sqlite: db,
  };
}
