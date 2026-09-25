/**
 * SQL access for Keel.
 *
 * All statements go through a single FIFO queue, so a transaction (which holds the queue
 * for its whole duration) can freely mix reads and writes on the one underlying connection
 * without another caller's statement slipping into it.
 */

export type SqlValue = string | number | null;
export type SqlParam = SqlValue | boolean | undefined;
export type Row = Record<string, SqlValue>;

export interface ExecResult {
  changes: number;
  lastInsertRowid: number;
}

export interface RawResult {
  columns: string[];
  rows: SqlValue[][];
}

/** A backend that can execute SQL against one connection (Tauri/rusqlite or sql.js). */
export interface RawDriver {
  execute(sql: string, params: SqlValue[]): Promise<ExecResult>;
  query(sql: string, params: SqlValue[]): Promise<RawResult>;
  executeScript(sql: string): Promise<void>;
  /** Roll back a transaction left open by a previous page load, if any. */
  reset(): Promise<void>;
}

/** Anything that can run statements: the database itself or an open transaction. */
export interface Executor {
  all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  run(sql: string, params?: SqlParam[]): Promise<ExecResult>;
  script(sql: string): Promise<void>;
  /** True if this executor is already inside a transaction. */
  readonly inTransaction: boolean;
}

function normalize(params: SqlParam[] = []): SqlValue[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'number' && !Number.isFinite(p)) {
      throw new Error(`Refusing to bind non-finite number ${p}`);
    }
    return p;
  });
}

function toObjects<T>(result: RawResult): T[] {
  const { columns, rows } = result;
  return rows.map((values) => {
    const obj: Record<string, SqlValue> = {};
    for (let i = 0; i < columns.length; i++) obj[columns[i]!] = values[i] ?? null;
    return obj as T;
  });
}

class DirectExecutor implements Executor {
  closed = false;
  constructor(
    private readonly raw: RawDriver,
    readonly inTransaction: boolean,
  ) {}

  private check() {
    if (this.closed) throw new Error('Transaction already finished; do not keep references to it');
  }

  async all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]> {
    this.check();
    return toObjects<T>(await this.raw.query(sql, normalize(params)));
  }

  async get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params?: SqlParam[]): Promise<ExecResult> {
    this.check();
    return this.raw.execute(sql, normalize(params));
  }

  async script(sql: string): Promise<void> {
    this.check();
    return this.raw.executeScript(sql);
  }
}

export class Database implements Executor {
  readonly inTransaction = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly direct: DirectExecutor;

  constructor(readonly raw: RawDriver) {
    this.direct = new DirectExecutor(raw, false);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }

  all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]> {
    return this.exclusive(() => this.direct.all<T>(sql, params));
  }

  get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
    return this.exclusive(() => this.direct.get<T>(sql, params));
  }

  run(sql: string, params?: SqlParam[]): Promise<ExecResult> {
    return this.exclusive(() => this.direct.run(sql, params));
  }

  script(sql: string): Promise<void> {
    return this.exclusive(() => this.direct.script(sql));
  }

  /**
   * Runs `fn` inside BEGIN IMMEDIATE … COMMIT. Any thrown error rolls back.
   * Inside `fn`, use only the provided executor — calling `db.*` would wait for the
   * transaction to finish and deadlock.
   */
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      await this.raw.execute('BEGIN IMMEDIATE', []);
      const tx = new DirectExecutor(this.raw, true);
      try {
        const result = await fn(tx);
        await this.raw.execute('COMMIT', []);
        return result;
      } catch (error) {
        try {
          await this.raw.execute('ROLLBACK', []);
        } catch {
          // The transaction may already have been rolled back by SQLite itself.
        }
        throw error;
      } finally {
        tx.closed = true;
      }
    });
  }
}

/** Run `fn` in the caller's transaction if there is one, otherwise open a new one. */
export function inTransaction<T>(ex: Executor, fn: (tx: Executor) => Promise<T>): Promise<T> {
  if (ex.inTransaction) return fn(ex);
  if (ex instanceof Database) return ex.transaction(fn);
  throw new Error('Executor cannot open a transaction');
}
