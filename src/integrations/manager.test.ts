/**
 * The integration manager against a fake Rust bridge: what reaches the credential store,
 * rollback when a connection fails, error states, disconnect clean-up, and "Delete all data".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '@/data/repo';
import { setDatabase } from '@/data/runtime';
import { applySnapshot, getData } from '@/data/store';
import type { Database } from '@/db/driver';
import { createTestDb } from '@/test/testDb';
import googleCalendarList from './__fixtures__/google-calendarList.json';
import googleFull from './__fixtures__/google-events-full.json';

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  handlers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    bridge.calls.push({ cmd, args });
    const h = bridge.handlers[cmd];
    if (!h) throw new Error(`unexpected command ${cmd}`);
    return h(args);
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(() => undefined, {
    success: () => undefined,
    error: () => undefined,
    warning: () => undefined,
  }),
}));

// The manager only runs inside the desktop shell.
(globalThis as Record<string, unknown>).window = globalThis;
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

const manager = await import('./manager');

let db: Database;

type Req = { method: string; url: string };
function provider(routes: [RegExp, (req: Req) => unknown][]) {
  bridge.handlers.integration_fetch = (args) => {
    const req = args.request as Req;
    const route = routes.find(([re]) => re.test(`${req.method} ${req.url}`));
    if (!route) return { status: 404, headers: {}, body: 'not found' };
    const out = route[1](req);
    if (out instanceof Error) throw out;
    return { status: 200, headers: {}, body: JSON.stringify(out) };
  };
}

const todoistTasks = (ids: string[]) => ({
  results: ids.map((id) => ({ id, content: `Task ${id}`, updated_at: '2026-09-20T00:00:00Z' })),
  next_cursor: null,
});

beforeEach(async () => {
  manager.retryOptions.sleep = async () => undefined;
  db = await createTestDb();
  setDatabase(db);
  applySnapshot(await repo.loadSnapshot(db));
  bridge.calls.length = 0;
  bridge.handlers = {
    integration_store_secret: () => undefined,
    integration_delete_secret: () => undefined,
    integration_delete_secrets: () => undefined,
    oauth_revoke: () => true,
  };
});

const cmds = (name: string) => bridge.calls.filter((c) => c.cmd === name);

describe('connecting', () => {
  it('stores a token only in the credential store, runs the first sync, and imports tasks', async () => {
    provider([
      [/GET .*\/projects/, () => ({ results: [], next_cursor: null })],
      [/GET .*\/tasks\?/, () => todoistTasks(['a', 'b'])],
    ]);
    const { id, report } = await manager.connectWithCredentials('todoist', { apiToken: ' tok ' });
    expect(report.tasksCreated).toBe(2);
    expect(cmds('integration_store_secret')[0]!.args).toMatchObject({
      accountId: id,
      secret: { provider: 'todoist', api_token: 'tok' },
    });
    const row = await db.get<{ config: string; status: string }>(
      'SELECT config, status FROM integration_accounts WHERE id = ?',
      [id],
    );
    expect(row!.status).toBe('connected');
    expect(row!.config).not.toContain('tok'); // the token never reaches SQLite
    expect(
      Object.values(getData().tasks)
        .map((t) => t.title)
        .sort(),
    ).toEqual(['Task a', 'Task b']);
    expect(getData().accounts[id]!.lastSyncAt).not.toBeNull();
  });

  it('rolls back the account and deletes the secret when the first sync fails', async () => {
    provider([[/./, () => new Error('REAUTH: the provider rejected the credentials')]]);
    await expect(manager.connectWithCredentials('todoist', { apiToken: 'bad' })).rejects.toThrow(
      /rejected the credentials/,
    );
    expect(await db.all('SELECT * FROM integration_accounts')).toEqual([]);
    expect(cmds('integration_delete_secret')).toHaveLength(1);
    expect(Object.keys(getData().accounts)).toEqual([]);
  });

  it('keeps calendar-feed addresses out of the database', async () => {
    bridge.handlers.ics_fetch_account = () =>
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261225\r\nDTEND;VALUE=DATE:20261226\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const url = 'webcal://cal.example.com/private-3f9a/basic.ics';
    const { id } = await manager.connectWithCredentials('ics-subscription', { url });
    expect(cmds('integration_store_secret')[0]!.args).toMatchObject({
      secret: { provider: 'ics', url },
    });
    expect(cmds('ics_fetch_account')[0]!.args).toEqual({ accountId: id });
    const dump =
      JSON.stringify(await db.all('SELECT * FROM integration_accounts')) +
      JSON.stringify(await db.all('SELECT * FROM integration_mappings')) +
      JSON.stringify(await db.all('SELECT * FROM calendars'));
    expect(dump).not.toContain('private-3f9a');
    expect(getData().accounts[id]!.label).toBe('cal.example.com');
    expect(Object.values(getData().events).map((e) => e.title)).toEqual(['Holiday']);
  });

  it('OAuth: requests read-only scopes unless writing is allowed, selects the primary calendar', async () => {
    bridge.handlers.oauth_connect = () => ({
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
    });
    provider([
      [/GET .*calendarList/, () => googleCalendarList],
      [/GET .*\/events\?/, () => googleFull],
    ]);
    const { id } = await manager.connectOAuth(
      'google',
      { clientId: 'cid', clientSecret: 's' },
      false,
    );
    expect(cmds('oauth_connect')[0]!.args).toMatchObject({
      provider: 'google',
      clientId: 'cid',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    const account = getData().accounts[id]!;
    expect(account.label).toBe('me@example.com');
    const config = account.config as { calendars: { selected: boolean; primary: boolean }[] };
    expect(config.calendars.filter((c) => c.selected).every((c) => c.primary)).toBe(true);
    expect(Object.keys(getData().events).length).toBeGreaterThan(0);

    await manager.connectOAuth('google', { clientId: 'cid' }, true).catch(() => undefined);
    expect(cmds('oauth_connect')[1]!.args.scopes).toEqual([
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ]);
  });
});

describe('sync errors and scheduling', () => {
  async function connected() {
    provider([
      [/GET .*\/tasks\?/, () => todoistTasks(['a'])],
      [/projects/, () => ({ results: [] })],
    ]);
    return (await manager.connectWithCredentials('todoist', { apiToken: 'tok' })).id;
  }

  it('offline keeps the account connected; rejected credentials pause it until reconnect', async () => {
    const id = await connected();
    provider([[/./, () => new Error('NETWORK: dns error')]]);
    const waits: number[] = [];
    manager.retryOptions.sleep = async (ms) => void waits.push(ms);
    expect(await manager.syncAccount(id, { quiet: true })).toBeNull();
    expect(waits).toEqual([1000, 2000, 4000]); // backed off before giving up
    let account = getData().accounts[id]!;
    expect(account.status).toBe('connected');
    expect(account.lastError).toMatch(/Offline or unreachable/);

    provider([[/./, () => new Error('REAUTH: token refresh failed (400); reconnect the account')]]);
    expect(await manager.syncAccount(id, { quiet: true })).toBeNull();
    account = getData().accounts[id]!;
    expect(account.status).toBe('needs_reauth');
    expect(manager.isDue(account, Date.now() + 86_400_000)).toBe(false);
  });

  it('schedules by interval, backs off after errors, and respects manual-only accounts', async () => {
    const id = await connected();
    const a = getData().accounts[id]!;
    const last = Date.parse(a.lastSyncAt!);
    expect(manager.isDue(a, last + 14 * 60_000)).toBe(false);
    expect(manager.isDue(a, last + 15 * 60_000)).toBe(true);
    expect(manager.isDue({ ...a, config: { ...a.config, intervalMin: 0 } }, last + 1e9)).toBe(
      false,
    );
    expect(
      manager.isDue({ ...a, status: 'error', config: { intervalMin: 1 } }, last + 2 * 60_000),
    ).toBe(false);
    expect(
      manager.isDue({ ...a, status: 'error', config: { intervalMin: 1 } }, last + 5 * 60_000),
    ).toBe(true);
  });

  it('runs one sync per account at a time', async () => {
    const id = await connected();
    let fetches = 0;
    provider([
      [/GET .*\/tasks\?/, () => (fetches++, todoistTasks(['a']))],
      [/projects/, () => ({ results: [] })],
    ]);
    await Promise.all([manager.syncAccount(id), manager.syncAccount(id), manager.syncAccount(id)]);
    expect(fetches).toBe(1);
  });
});

describe('disconnecting', () => {
  it('removes credentials and local copies; imported tasks stay unless asked', async () => {
    provider([
      [/GET .*\/tasks\?/, () => todoistTasks(['a', 'b'])],
      [/projects/, () => ({ results: [] })],
    ]);
    const keep = await manager.connectWithCredentials('todoist', { apiToken: 'tok' });
    await manager.disconnectAccount(getData().accounts[keep.id]!, {
      removeImportedTasks: false,
      removeMirroredBlocks: false,
    });
    expect(cmds('integration_delete_secret').at(-1)!.args).toEqual({ accountId: keep.id });
    expect(Object.keys(getData().accounts)).toEqual([]);
    expect(Object.values(getData().tasks)).toHaveLength(2);

    const drop = await manager.connectWithCredentials('todoist', { apiToken: 'tok' });
    expect(Object.values(getData().tasks)).toHaveLength(4);
    await manager.disconnectAccount(getData().accounts[drop.id]!, {
      removeImportedTasks: true,
      removeMirroredBlocks: false,
    });
    expect(Object.values(getData().tasks)).toHaveLength(2); // only the second import removed
  });

  it('deletes the time-block events Keel created (and only those) when asked, and revokes Google', async () => {
    bridge.handlers.oauth_connect = () => ({
      scope:
        'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events',
    });
    const deleted: string[] = [];
    provider([
      [/GET .*calendarList/, () => googleCalendarList],
      [/GET .*\/events\?/, () => ({ items: [], nextSyncToken: 's1' })],
      [/POST .*\/events$/, () => ({ id: 'evt-1', etag: '"1"' })],
      [/DELETE .*\/events\//, (req) => (deleted.push(req.url), {})],
    ]);
    const { id } = await manager.connectOAuth('google', { clientId: 'cid' }, true);
    const today = getData().today;
    const taskId = await repo.createTask(
      {
        tx: db,
        now: new Date().toISOString(),
        today,
        zone: getData().zone,
        changes: new repo.ChangeSet(),
      },
      { title: 'Deep work', planDate: today },
    );
    const start = new Date(Date.now() + 3_600_000).toISOString();
    const end = new Date(Date.now() + 7_200_000).toISOString();
    await db.transaction((tx) =>
      repo.createBlock(
        {
          tx,
          now: new Date().toISOString(),
          today,
          zone: getData().zone,
          changes: new repo.ChangeSet(),
        },
        taskId,
        start,
        end,
      ),
    );
    await manager.saveAccountConfig(getData().accounts[id]!, { pushCalendarId: 'me@example.com' });
    const report = await manager.syncAccount(id);
    expect(report!.blocksPushed).toBe(1);

    await manager.disconnectAccount(getData().accounts[id]!, {
      removeImportedTasks: false,
      removeMirroredBlocks: true,
    });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/\/events\/evt-1$/);
    expect(cmds('oauth_revoke')).toHaveLength(1);
  });

  it('"Delete all data" removes every account’s credentials', async () => {
    provider([
      [/GET .*\/tasks\?/, () => todoistTasks([])],
      [/projects/, () => ({ results: [] })],
    ]);
    const a = await manager.connectWithCredentials('todoist', { apiToken: 'x' });
    const b = await manager.connectWithCredentials('todoist', { apiToken: 'y' });
    await manager.deleteAllIntegrationSecrets();
    expect((cmds('integration_delete_secrets')[0]!.args.accountIds as string[]).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });
});
