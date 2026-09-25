/**
 * Integration sync engine. Provider calls happen outside database transactions; results
 * are then applied in a single transaction so the local state is never half-updated.
 *
 * Invariants
 *  - Remote events and Keel's time blocks live in separate tables; pulled events that Keel
 *    itself created (pushed blocks) are skipped.
 *  - Mappings are keyed (account, entity, external id) → idempotent re-syncs.
 *  - Keel never modifies or deletes a remote item it did not create. The only remote writes
 *    are: time-block events Keel owns (opt-in) and task completion (opt-in, per account).
 */
import type { Database, Executor } from '@/db/driver';
import { addMinutes, todayIn } from '@/domain/dates';
import { parseIcs } from '@/domain/ics';
import type { IntegrationAccount } from '@/domain/types';
import { PALETTE } from '@/domain/types';
import { rowToAccount } from '@/data/rows';
import type { Ctx, EventInput } from '@/data/repo';
import * as repo from '@/data/repo';
import type { CalendarAdapter, Http, RemoteCalendar, RemoteEvent, TaskAdapter } from './types';
import { IntegrationError } from './types';

export interface SyncDeps {
  http: Http;
  now: () => Date;
  zone: string;
  /** Downloads an iCalendar feed (Rust `ics_fetch`). */
  fetchIcs?: (url: string) => Promise<string>;
}

export interface SyncReport {
  eventsUpserted: number;
  eventsDeleted: number;
  blocksPushed: number;
  blocksRemoved: number;
  tasksCreated: number;
  tasksUpdated: number;
  tasksClosed: number;
  completionsPushed: number;
  warnings: string[];
}

export const emptyReport = (): SyncReport => ({
  eventsUpserted: 0,
  eventsDeleted: 0,
  blocksPushed: 0,
  blocksRemoved: 0,
  tasksCreated: 0,
  tasksUpdated: 0,
  tasksClosed: 0,
  completionsPushed: 0,
  warnings: [],
});

export interface CalendarChoice extends RemoteCalendar {
  selected: boolean;
}

export interface AccountConfig {
  calendars?: CalendarChoice[];
  /** External calendar id that receives Keel's time blocks (null = don't write). */
  pushCalendarId?: string | null;
  url?: string;
  localProjectId?: string | null;
  syncCompletion?: boolean;
  site?: string;
  databaseId?: string;
  intervalMin?: number;
}

function ctxFor(tx: Executor, deps: SyncDeps): Ctx {
  const now = deps.now();
  return {
    tx,
    now: now.toISOString(),
    today: todayIn(deps.zone, now),
    zone: deps.zone,
    changes: new repo.ChangeSet(),
  };
}

// ---------------------------------------------------------------------------------------
// Accounts & mappings
// ---------------------------------------------------------------------------------------

export async function getAccount(ex: Executor, id: string): Promise<IntegrationAccount | null> {
  const row = await ex.get('SELECT * FROM integration_accounts WHERE id = ?', [id]);
  return row ? rowToAccount(row) : null;
}

export async function createAccount(
  ctx: Ctx,
  provider: string,
  label: string,
  config: AccountConfig,
): Promise<string> {
  const id = repo.newId();
  await ctx.tx.run(
    `INSERT INTO integration_accounts (id, provider, label, status, config, sync_state, created_at, updated_at)
     VALUES (?, ?, ?, 'connected', ?, '{}', ?, ?)`,
    [id, provider, label, JSON.stringify(config), ctx.now, ctx.now],
  );
  ctx.changes.table('accounts');
  return id;
}

export async function updateAccount(
  ctx: Ctx,
  id: string,
  patch: {
    label?: string;
    status?: string;
    config?: AccountConfig;
    syncState?: Record<string, unknown>;
    lastSyncAt?: string | null;
    lastError?: string | null;
  },
): Promise<void> {
  const cols: [string, string | null][] = [];
  if (patch.label !== undefined) cols.push(['label', patch.label]);
  if (patch.status !== undefined) cols.push(['status', patch.status]);
  if (patch.config !== undefined) cols.push(['config', JSON.stringify(patch.config)]);
  if (patch.syncState !== undefined) cols.push(['sync_state', JSON.stringify(patch.syncState)]);
  if (patch.lastSyncAt !== undefined) cols.push(['last_sync_at', patch.lastSyncAt]);
  if (patch.lastError !== undefined) cols.push(['last_error', patch.lastError]);
  if (!cols.length) return;
  await ctx.tx.run(
    `UPDATE integration_accounts SET ${cols.map(([c]) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...cols.map(([, v]) => v), ctx.now, id],
  );
  ctx.changes.table('accounts');
}

interface MappingRow {
  id: string;
  local_id: string;
  external_id: string;
  external_version: string | null;
  origin: 'remote' | 'local';
  last_synced_at: string | null;
}

async function mappings(ex: Executor, accountId: string, entity: string): Promise<MappingRow[]> {
  return ex.all<MappingRow>(
    'SELECT * FROM integration_mappings WHERE account_id = ? AND entity_type = ?',
    [accountId, entity],
  );
}

async function putMapping(
  ctx: Ctx,
  accountId: string,
  entity: string,
  localId: string,
  externalId: string,
  version: string | null,
  origin: 'remote' | 'local',
  url: string | null = null,
) {
  await ctx.tx.run(
    `INSERT INTO integration_mappings (id, account_id, entity_type, local_id, external_id, external_version, external_url, origin, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, entity_type, external_id) DO UPDATE SET
       local_id = excluded.local_id, external_version = excluded.external_version,
       external_url = excluded.external_url, last_synced_at = excluded.last_synced_at`,
    [repo.newId(), accountId, entity, localId, externalId, version, url, origin, ctx.now],
  );
}

/**
 * Removes an account. Its calendars and pulled events go with it (they are copies). Imported
 * tasks are kept as ordinary local tasks unless `removeImportedTasks`.
 */
export async function removeAccount(
  ctx: Ctx,
  accountId: string,
  removeImportedTasks: boolean,
): Promise<void> {
  if (removeImportedTasks) {
    const tasks = await ctx.tx.all<{ local_id: string }>(
      "SELECT local_id FROM integration_mappings WHERE account_id = ? AND entity_type = 'task' AND origin = 'remote'",
      [accountId],
    );
    await repo.deleteTasks(
      ctx,
      tasks.map((t) => t.local_id),
    );
  }
  await ctx.tx.run('DELETE FROM integration_accounts WHERE id = ?', [accountId]);
  ctx.changes.table('accounts', 'calendars', 'events');
}

// ---------------------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------------------

function toEventInput(e: RemoteEvent, provider: string): Omit<EventInput, 'calendarId'> {
  // Provider ids make stable, unique UIDs; overrides share their series' UID so they
  // replace the right generated occurrence.
  const uid = `${provider}:${e.seriesExternalId ?? e.externalId}`;
  return {
    uid,
    recurrenceId: e.seriesExternalId ? e.recurrenceId : null,
    title: e.title,
    description: e.description,
    location: e.location,
    url: e.url,
    allDay: e.allDay,
    startUtc: e.startUtc,
    endUtc: e.endUtc ?? e.startUtc,
    startDate: e.startDate,
    endDate: e.endDate,
    tz: e.tz,
    rrule: e.rrule,
    exdates: e.exdates,
    status: e.status,
    busy: e.busy,
  };
}

async function ensureLocalCalendar(
  ctx: Ctx,
  account: IntegrationAccount,
  remote: RemoteCalendar,
  index: number,
): Promise<string> {
  const [existing] = (await mappings(ctx.tx, account.id, 'calendar')).filter(
    (m) => m.external_id === remote.externalId,
  );
  if (existing) {
    await ctx.tx.run('UPDATE calendars SET name = ?, updated_at = ? WHERE id = ?', [
      remote.name,
      ctx.now,
      existing.local_id,
    ]);
    return existing.local_id;
  }
  const id = await repo.createCalendar(ctx, {
    name: remote.name,
    color: remote.color ?? PALETTE[index % PALETTE.length]!,
    source: account.provider,
    accountId: account.id,
    isWritable: false,
    timezone: remote.timezone,
  });
  await putMapping(ctx, account.id, 'calendar', id, remote.externalId, null, 'remote');
  return id;
}

export function syncWindow(now: Date) {
  return {
    from: addMinutes(now.toISOString(), -60 * 24 * 60),
    to: addMinutes(now.toISOString(), 365 * 24 * 60),
  };
}

export async function syncCalendarAccount(
  db: Database,
  account: IntegrationAccount,
  adapter: CalendarAdapter,
  deps: SyncDeps,
): Promise<SyncReport> {
  const report = emptyReport();
  const config = account.config as AccountConfig;
  const state = {
    cursors: {} as Record<string, string | null>,
    ...(account.syncState as { cursors?: Record<string, string | null> }),
  };
  const selected = (config.calendars ?? []).filter((c) => c.selected);
  const window = syncWindow(deps.now());

  // Pull: fetch everything first, then apply.
  const pulls: {
    cal: CalendarChoice;
    index: number;
    result: Awaited<ReturnType<CalendarAdapter['syncEvents']>>;
  }[] = [];
  for (const [index, cal] of selected.entries()) {
    const result = await adapter.syncEvents(
      deps.http,
      cal.externalId,
      state.cursors[cal.externalId] ?? null,
      window,
    );
    pulls.push({ cal, index, result });
  }

  await db.transaction(async (tx) => {
    const ctx = ctxFor(tx, deps);
    const pushed = new Set(
      (await mappings(tx, account.id, 'time_block')).map((m) => m.external_id),
    );
    for (const { cal, index, result } of pulls) {
      const calendarId = await ensureLocalCalendar(ctx, account, cal, index);
      const existing = new Map(
        (await mappings(tx, account.id, 'event')).map((m) => [m.external_id, m]),
      );
      if (result.fullResync) {
        // The provider's full list replaces our copy of this calendar.
        await tx.run('DELETE FROM calendar_events WHERE calendar_id = ?', [calendarId]);
        await tx.run(
          "DELETE FROM integration_mappings WHERE account_id = ? AND entity_type = 'event' AND local_id NOT IN (SELECT id FROM calendar_events)",
          [account.id],
        );
        existing.clear();
      }
      for (const e of result.upserts) {
        if (e.keelOwned || pushed.has(e.externalId)) continue;
        const input = { ...toEventInput(e, account.provider), calendarId };
        const m = existing.get(e.externalId);
        if (m) {
          if (m.external_version && m.external_version === e.etag) continue;
          await repo.updateEvent(ctx, m.local_id, input);
          await putMapping(
            ctx,
            account.id,
            'event',
            m.local_id,
            e.externalId,
            e.etag,
            'remote',
            e.url,
          );
        } else {
          const id = await repo.createEvent(ctx, input);
          await putMapping(ctx, account.id, 'event', id, e.externalId, e.etag, 'remote', e.url);
        }
        report.eventsUpserted++;
      }
      for (const externalId of result.deletedIds) {
        const m = existing.get(externalId);
        if (!m) continue;
        await tx.run('DELETE FROM calendar_events WHERE id = ?', [m.local_id]);
        await tx.run('DELETE FROM integration_mappings WHERE id = ?', [m.id]);
        report.eventsDeleted++;
      }
      state.cursors[cal.externalId] = result.cursor;
    }
    // Calendars the user deselected: drop their local copies.
    const keep = new Set(selected.map((c) => c.externalId));
    for (const m of await mappings(tx, account.id, 'calendar')) {
      if (!keep.has(m.external_id)) {
        await tx.run('DELETE FROM calendars WHERE id = ?', [m.local_id]);
        await tx.run('DELETE FROM integration_mappings WHERE id = ?', [m.id]);
        delete state.cursors[m.external_id];
      }
    }
    await updateAccount(ctx, account.id, { syncState: state });
  });

  if (config.pushCalendarId && adapter.upsertBlock && adapter.deleteBlock) {
    await pushBlocks(db, account, adapter, config.pushCalendarId, deps, report);
  }
  return report;
}

/** Mirrors Keel's time blocks (from yesterday on) as events Keel owns in one remote calendar. */
async function pushBlocks(
  db: Database,
  account: IntegrationAccount,
  adapter: CalendarAdapter,
  calendarId: string,
  deps: SyncDeps,
  report: SyncReport,
) {
  const since = addMinutes(deps.now().toISOString(), -24 * 60);
  const blocks = await db.all<{
    id: string;
    task_id: string;
    start_utc: string;
    end_utc: string;
    tz: string;
    updated_at: string;
    title: string;
    notes: string;
    task_updated: string;
  }>(
    `SELECT b.id, b.task_id, b.start_utc, b.end_utc, b.tz, b.updated_at, t.title, t.notes, t.updated_at AS task_updated
     FROM time_blocks b JOIN tasks t ON t.id = b.task_id WHERE b.end_utc >= ?`,
    [since],
  );
  const maps = await mappings(db, account.id, 'time_block');
  const byLocal = new Map(maps.map((m) => [m.local_id, m]));
  const live = new Set(blocks.map((b) => b.id));

  for (const b of blocks) {
    const m = byLocal.get(b.id);
    if (m?.external_version === 'remote-deleted') continue; // user deleted it remotely; don't recreate
    const changed =
      !m ||
      !m.last_synced_at ||
      b.updated_at > m.last_synced_at ||
      b.task_updated > m.last_synced_at;
    if (!changed) continue;
    const saved = await adapter.upsertBlock!(deps.http, calendarId, m?.external_id ?? null, {
      title: b.title,
      notes: b.notes,
      startUtc: b.start_utc,
      endUtc: b.end_utc,
      tz: b.tz,
    });
    await db.transaction(async (tx) => {
      const ctx = ctxFor(tx, deps);
      if (saved)
        await putMapping(
          ctx,
          account.id,
          'time_block',
          b.id,
          saved.externalId,
          saved.etag,
          'local',
        );
      else if (m)
        await tx.run(
          "UPDATE integration_mappings SET external_version = 'remote-deleted', last_synced_at = ? WHERE id = ?",
          [ctx.now, m.id],
        );
    });
    if (saved) report.blocksPushed++;
    else
      report.warnings.push(
        `“${b.title}” was deleted in the provider’s calendar, so Keel stopped mirroring it.`,
      );
  }
  // Blocks deleted in Keel (or older than the window and gone): remove the events Keel created.
  for (const m of maps) {
    if (live.has(m.local_id)) continue;
    const stillExists = await db.get('SELECT 1 AS x FROM time_blocks WHERE id = ?', [m.local_id]);
    if (stillExists) continue; // just outside the window; keep
    if (m.external_version !== 'remote-deleted')
      await adapter.deleteBlock!(deps.http, calendarId, m.external_id);
    await db.run('DELETE FROM integration_mappings WHERE id = ?', [m.id]);
    report.blocksRemoved++;
  }
}

export async function syncIcsAccount(
  db: Database,
  account: IntegrationAccount,
  deps: SyncDeps,
): Promise<SyncReport> {
  const report = emptyReport();
  const url = String((account.config as AccountConfig).url ?? '');
  if (!deps.fetchIcs)
    throw new IntegrationError('Calendar subscriptions need the desktop app', 'config');
  const parsed = parseIcs(await deps.fetchIcs(url), deps.zone);
  report.warnings.push(...parsed.warnings);
  await db.transaction(async (tx) => {
    const ctx = ctxFor(tx, deps);
    let calendarId = (await mappings(tx, account.id, 'calendar'))[0]?.local_id;
    if (!calendarId) {
      calendarId = await repo.createCalendar(ctx, {
        name: account.label || parsed.name || 'Subscribed calendar',
        color: PALETTE[(await tx.all('SELECT id FROM calendars')).length % PALETTE.length]!,
        source: 'ics-subscription',
        accountId: account.id,
        isWritable: false,
      });
      await putMapping(ctx, account.id, 'calendar', calendarId, url, null, 'remote');
    }
    const r = await repo.upsertEvents(
      ctx,
      calendarId,
      parsed.events.map((e) => ({ ...e, uid: e.uid ?? `${e.title}|${e.startUtc ?? e.startDate}` })),
      { removeMissing: true },
    );
    report.eventsUpserted = r.created + r.updated;
    report.eventsDeleted = r.removed;
  });
  return report;
}

// ---------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------

async function ensureProject(
  ctx: Ctx,
  account: IntegrationAccount,
  providerName: string,
): Promise<string> {
  const config = account.config as AccountConfig;
  if (config.localProjectId) {
    const exists = await ctx.tx.get('SELECT 1 AS x FROM projects WHERE id = ?', [
      config.localProjectId,
    ]);
    if (exists) return config.localProjectId;
  }
  const id = await repo.createProject(ctx, { name: providerName, color: PALETTE[1]! });
  await updateAccount(ctx, account.id, { config: { ...config, localProjectId: id } });
  return id;
}

export async function syncTaskAccount(
  db: Database,
  account: IntegrationAccount,
  adapter: TaskAdapter,
  providerName: string,
  deps: SyncDeps,
): Promise<SyncReport> {
  const report = emptyReport();
  const config = account.config as AccountConfig;

  // 1. Push local completions first so the pull below doesn't resurrect them.
  if (config.syncCompletion && adapter.setCompleted) {
    const done = await db.all<{
      id: string;
      external_id: string;
      completed_at: string;
      last_synced_at: string | null;
    }>(
      `SELECT m.id, m.external_id, t.completed_at, m.last_synced_at FROM integration_mappings m JOIN tasks t ON t.id = m.local_id
       WHERE m.account_id = ? AND m.entity_type = 'task' AND t.completed_at IS NOT NULL
         AND (m.last_synced_at IS NULL OR t.completed_at > m.last_synced_at)`,
      [account.id],
    );
    for (const d of done) {
      await adapter.setCompleted(deps.http, config as Record<string, unknown>, d.external_id, true);
      await db.run('UPDATE integration_mappings SET last_synced_at = ? WHERE id = ?', [
        deps.now().toISOString(),
        d.id,
      ]);
      report.completionsPushed++;
    }
  }

  // 2. Pull.
  const remote = await adapter.fetchOpenTasks(deps.http, config as Record<string, unknown>);
  const remoteIds = new Set(remote.map((r) => r.externalId));

  await db.transaction(async (tx) => {
    const ctx = ctxFor(tx, deps);
    const projectId = await ensureProject(ctx, account, providerName);
    const maps = new Map((await mappings(tx, account.id, 'task')).map((m) => [m.external_id, m]));
    for (const r of remote) {
      const m = maps.get(r.externalId);
      if (!m) {
        const id = await repo.createTask(ctx, {
          title: r.title,
          notes: r.notes,
          projectId,
          priority: r.priority,
          estimateMin: r.estimateMin,
          dueDate: r.dueDate,
          source: account.provider,
          links: r.url ? [{ url: r.url, title: `Open in ${providerName}` }] : [],
        });
        await putMapping(ctx, account.id, 'task', id, r.externalId, r.version, 'remote', r.url);
        report.tasksCreated++;
        continue;
      }
      const local = await tx.get<{ updated_at: string; completed_at: string | null }>(
        'SELECT updated_at, completed_at FROM tasks WHERE id = ?',
        [m.local_id],
      );
      if (!local) continue; // deleted locally: stays deleted
      if (m.external_version === r.version) continue;
      // Remote changed. Apply it unless the task was edited in Keel since the last sync.
      const editedLocally = m.last_synced_at !== null && local.updated_at > m.last_synced_at;
      if (!editedLocally) {
        await repo.updateTasks(ctx, [m.local_id], {
          title: r.title,
          notes: r.notes,
          dueDate: r.dueDate,
          priority: r.priority,
          estimateMin: r.estimateMin ?? undefined,
        });
        report.tasksUpdated++;
      } else {
        report.warnings.push(`“${r.title}” changed in both places; Keel kept your local edits.`);
      }
      await putMapping(
        ctx,
        account.id,
        'task',
        m.local_id,
        r.externalId,
        r.version,
        'remote',
        r.url,
      );
    }
    // No longer open remotely (completed or deleted there) → complete locally if still open.
    for (const [externalId, m] of maps) {
      if (remoteIds.has(externalId)) continue;
      const local = await tx.get<{ completed_at: string | null }>(
        'SELECT completed_at FROM tasks WHERE id = ?',
        [m.local_id],
      );
      if (local && !local.completed_at) {
        await repo.completeTask(ctx, m.local_id);
        report.tasksClosed++;
      }
    }
  });
  return report;
}

export function describeReport(r: SyncReport): string {
  const parts: string[] = [];
  if (r.eventsUpserted || r.eventsDeleted)
    parts.push(
      `${r.eventsUpserted} event${r.eventsUpserted === 1 ? '' : 's'} updated, ${r.eventsDeleted} removed`,
    );
  if (r.blocksPushed || r.blocksRemoved)
    parts.push(`${r.blocksPushed} time block${r.blocksPushed === 1 ? '' : 's'} mirrored`);
  if (r.tasksCreated || r.tasksUpdated || r.tasksClosed)
    parts.push(`${r.tasksCreated} new, ${r.tasksUpdated} updated, ${r.tasksClosed} closed tasks`);
  if (r.completionsPushed)
    parts.push(`${r.completionsPushed} completion${r.completionsPushed === 1 ? '' : 's'} sent`);
  return parts.join(' · ') || 'Up to date';
}
