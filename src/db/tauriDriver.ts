import { invoke } from '@tauri-apps/api/core';
import type { ExecResult, RawDriver, RawResult, SqlValue } from './driver';

/** Executes SQL in the Rust backend (rusqlite, single connection). */
export class TauriDriver implements RawDriver {
  execute(sql: string, params: SqlValue[]): Promise<ExecResult> {
    return invoke<ExecResult>('db_execute', { sql, params });
  }

  query(sql: string, params: SqlValue[]): Promise<RawResult> {
    return invoke<RawResult>('db_query', { sql, params });
  }

  executeScript(sql: string): Promise<void> {
    return invoke<void>('db_execute_script', { sql });
  }

  async reset(): Promise<void> {
    await invoke<boolean>('db_reset');
  }
}
