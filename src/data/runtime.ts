/**
 * Holds the open database for the running app and knows whether we are inside the desktop
 * shell (Tauri) or the dev-only browser preview.
 */
import type { Database } from '@/db/driver';

let database: Database | null = null;

export function setDatabase(db: Database | null) {
  database = db;
}

export function getDb(): Database {
  if (!database) throw new Error('Database not initialised');
  return database;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
