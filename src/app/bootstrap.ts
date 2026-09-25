/** Opens the database, migrates it, loads everything into memory and starts the clock. */
import { perform, refreshAll } from '@/data/actions';
import * as repo from '@/data/repo';
import { getDb, isTauri, setDatabase } from '@/data/runtime';
import { getData } from '@/data/store';
import type { RawDriver } from '@/db/driver';
import { Database } from '@/db/driver';
import { migrate } from '@/db/migrate';
import { TauriDriver } from '@/db/tauriDriver';
import { startClock } from './clock';
import { runDayStart } from './maintenance';
import { native } from './native';

async function createDriver(): Promise<RawDriver> {
  if (isTauri()) return new TauriDriver();
  if (import.meta.env.DEV) {
    // Dev-only browser preview: an in-memory database that is discarded on reload.
    const [{ default: initSqlJs }, { default: wasmUrl }, { SqlJsDriver }] = await Promise.all([
      import('sql.js'),
      import('sql.js/dist/sql-wasm.wasm?url'),
      import('@/db/sqljsDriver'),
    ]);
    return SqlJsDriver.create(await initSqlJs({ locateFile: () => wasmUrl }));
  }
  throw new Error(
    'Keel is a desktop app. Launch it with "npm run dev" or the installed application.',
  );
}

/** First-run defaults: a local calendar for events you add in Keel. */
async function ensureDefaults() {
  const calendars = await repo.loadCalendars(getDb());
  if (calendars.length === 0) {
    await perform({ label: null, quiet: true }, async (ctx) => {
      const id = await repo.createCalendar(ctx, { name: 'Personal', color: '#3E7CB1' });
      await repo.saveSettings(ctx, { defaultCalendarId: id });
    });
  }
}

export async function bootstrap(): Promise<void> {
  const driver = await createDriver();
  await driver.reset();
  const db = new Database(driver);
  await migrate(db, {
    beforeMigrate: async () => {
      if (isTauri()) await native.createBackup('pre-migration');
    },
  });
  setDatabase(db);
  await ensureDefaults();
  await refreshAll();
  if (import.meta.env.DEV && !isTauri() && new URLSearchParams(location.search).has('demo')) {
    const { seedDemo } = await import('./devSeed');
    await seedDemo();
    await refreshAll();
  }
  await runDayStart();
  startClock();
  if (import.meta.env.DEV || (await native.environment()).e2e) {
    // Test/debug handle; not present in normal production runs.
    (window as unknown as { __keel: unknown }).__keel = { db, getData, refresh: refreshAll };
  }
}
