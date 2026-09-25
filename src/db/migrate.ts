import type { Database } from './driver';
import { installUndoTriggers } from './undo';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const files = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export const MIGRATIONS: Migration[] = Object.entries(files)
  .map(([path, sql]) => {
    const match = /\/(\d{4})_([\w-]+)\.sql$/.exec(path);
    if (!match) throw new Error(`Bad migration file name: ${path}`);
    return { version: Number(match[1]), name: match[2]!, sql };
  })
  .sort((a, b) => a.version - b.version);

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export class NewerSchemaError extends Error {
  constructor(readonly found: number) {
    super(
      `This database uses schema v${found}, but this build of Keel only understands up to v${LATEST_SCHEMA_VERSION}. ` +
        'Install a newer version of Keel, or restore an older backup.',
    );
    this.name = 'NewerSchemaError';
  }
}

export interface MigrateHooks {
  /** Called once before applying migrations to a database that already has data. */
  beforeMigrate?: (pending: Migration[]) => Promise<void>;
}

export interface MigrateResult {
  fromVersion: number;
  toVersion: number;
  applied: number[];
}

export async function currentSchemaVersion(db: Database): Promise<number> {
  const table = await db.get<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (!table?.n) return 0;
  const row = await db.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
  return row?.v ?? 0;
}

/**
 * Applies pending migrations, each in its own transaction, then (re)installs undo triggers
 * so they always match the current columns.
 */
export async function migrate(
  db: Database,
  hooks: MigrateHooks = {},
  migrations: Migration[] = MIGRATIONS,
): Promise<MigrateResult> {
  await db.script(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const appliedRows = await db.all<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(appliedRows.map((r) => r.version));
  const fromVersion = Math.max(0, ...applied);
  const latest = migrations.at(-1)?.version ?? 0;
  if (fromVersion > latest) throw new NewerSchemaError(fromVersion);

  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length > 0 && applied.size > 0) await hooks.beforeMigrate?.(pending);

  for (const migration of pending) {
    await db.transaction(async (tx) => {
      await tx.script(migration.sql);
      await tx.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
    });
  }

  await installUndoTriggers(db);
  return { fromVersion, toVersion: latest, applied: pending.map((m) => m.version) };
}
