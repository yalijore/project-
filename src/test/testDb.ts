import initSqlJs from 'sql.js';
import { Database } from '@/db/driver';
import { migrate } from '@/db/migrate';
import { SqlJsDriver } from '@/db/sqljsDriver';

let sqlJs: Awaited<ReturnType<typeof initSqlJs>> | null = null;

/** A fresh, fully migrated in-memory database. */
export async function createTestDb(): Promise<Database> {
  sqlJs ??= await initSqlJs();
  const db = new Database(await SqlJsDriver.create(sqlJs));
  await migrate(db);
  return db;
}
