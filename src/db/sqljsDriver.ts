import type { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import type { ExecResult, RawDriver, RawResult, SqlValue } from './driver';

/**
 * In-memory SQLite via WebAssembly. Used by the unit tests and by the dev-only browser
 * preview (`npm run dev:web`). The desktop app always uses the Rust/rusqlite driver.
 */
export class SqlJsDriver implements RawDriver {
  private constructor(private readonly db: SqlJsDatabase) {}

  static async create(sqlJs: SqlJsStatic): Promise<SqlJsDriver> {
    const db = new sqlJs.Database();
    db.run('PRAGMA foreign_keys = ON');
    return new SqlJsDriver(db);
  }

  async execute(sql: string, params: SqlValue[]): Promise<ExecResult> {
    this.db.run(sql, params);
    const changes = this.db.getRowsModified();
    const rowid = this.db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0];
    return { changes, lastInsertRowid: Number(rowid ?? 0) };
  }

  async query(sql: string, params: SqlValue[]): Promise<RawResult> {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: SqlValue[][] = [];
      while (stmt.step()) rows.push(stmt.get() as SqlValue[]);
      return { columns: stmt.getColumnNames(), rows };
    } finally {
      stmt.free();
    }
  }

  async executeScript(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async reset(): Promise<void> {
    // sql.js databases do not survive a reload, so there is never a dangling transaction.
  }
}
