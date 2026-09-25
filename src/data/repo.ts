/**
 * Repository: every state change Keel makes to its database.
 *
 * Functions take a `Ctx` carrying the executor (usually a transaction), the current instant,
 * today's date and the effective time zone — never reading the clock themselves — so they
 * are deterministic under test. Each records which entities it touched in `ctx.changes`
 * so the in-memory store can refresh exactly those.
 */
import type { Executor, SqlParam, SqlValue } from '@/db/driver';
import type { ISODate, ISOInstant } from '@/domain/dates';
import { dateOfInstant, minutesIntoDay, wallTimeToInstant } from '@/domain/dates';
import type {
  Area,
  Calendar,
  CalendarEvent,
  IntegrationAccount,
  Priority,
  Project,
  RecurrenceSeries,
  Ritual,
  RitualKind,
  Settings,
  Tag,
  Task,
  TimeBlock,
  TimeSession,
} from '@/domain/types';
import { DEFAULT_SETTINGS } from '@/domain/types';
import {
  parseJson,
  rowToAccount,
  rowToArea,
  rowToBlock,
  rowToCalendar,
  rowToEvent,
  rowToLink,
  rowToProject,
  rowToRitual,
  rowToSeries,
  rowToSession,
  rowToSubtask,
  rowToTag,
  rowToTask,
} from './rows';

export type TableKey =
  | 'areas'
  | 'projects'
  | 'tags'
  | 'series'
  | 'calendars'
  | 'events'
  | 'rituals'
  | 'settings'
  | 'accounts';

export class ChangeSet {
  readonly tasks = new Set<string>();
  readonly tables = new Set<TableKey>();
  all = false;
  task(...ids: string[]) {
    for (const id of ids) this.tasks.add(id);
  }
  table(...keys: TableKey[]) {
    for (const k of keys) this.tables.add(k);
  }
  get empty() {
    return !this.all && this.tasks.size === 0 && this.tables.size === 0;
  }
}

export interface Ctx {
  tx: Executor;
  now: ISOInstant;
  today: ISODate;
  zone: string;
  changes: ChangeSet;
}

export function newId(): string {
  return crypto.randomUUID();
}

function chunks<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

// ---------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------

const TASK_SELECT = `
  SELECT t.*, e.id AS plan_entry_id, e.plan_date, e.sort_order AS plan_order,
    (SELECT count(*) FROM day_plan_entries r WHERE r.task_id = t.id AND r.status = 'rolled_over') AS rollover_count
  FROM tasks t
  LEFT JOIN day_plan_entries e ON e.task_id = t.id AND e.status IN ('active', 'done')`;

/** Loads tasks (all, or the given ids) with plan state, tags, subtasks and links. */
export async function loadTasks(ex: Executor, ids?: string[]): Promise<Task[]> {
  const rows: Record<string, SqlValue>[] = [];
  const idBatches = ids ? chunks(ids) : [null];
  for (const batch of idBatches) {
    if (batch && batch.length === 0) continue;
    const where = batch ? ` WHERE t.id IN (${placeholders(batch.length)})` : '';
    rows.push(...(await ex.all(TASK_SELECT + where, batch ?? [])));
  }
  const tasks = rows.map(rowToTask);
  if (tasks.length === 0) return tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const batch of ids ? chunks(ids) : [null]) {
    const filter = batch ? ` WHERE task_id IN (${placeholders(batch.length)})` : '';
    const params = batch ?? [];
    for (const r of await ex.all<{ task_id: string; tag_id: string }>(
      `SELECT task_id, tag_id FROM task_tags${filter}`,
      params,
    )) {
      byId.get(r.task_id)?.tagIds.push(r.tag_id);
    }
    for (const r of await ex.all(
      `SELECT * FROM subtasks${filter} ORDER BY sort_order, created_at`,
      params,
    )) {
      const st = rowToSubtask(r);
      byId.get(st.taskId)?.subtasks.push(st);
    }
    for (const r of await ex.all(
      `SELECT * FROM task_links${filter} ORDER BY sort_order, created_at`,
      params,
    )) {
      const link = rowToLink(r);
      byId.get(link.taskId)?.links.push(link);
    }
  }
  return tasks;
}

export async function loadBlocks(ex: Executor, taskIds?: string[]): Promise<TimeBlock[]> {
  if (!taskIds)
    return (await ex.all('SELECT * FROM time_blocks ORDER BY start_utc')).map(rowToBlock);
  const out: TimeBlock[] = [];
  for (const batch of chunks(taskIds)) {
    out.push(
      ...(
        await ex.all(
          `SELECT * FROM time_blocks WHERE task_id IN (${placeholders(batch.length)})`,
          batch,
        )
      ).map(rowToBlock),
    );
  }
  return out;
}

export async function loadSessions(ex: Executor, taskIds?: string[]): Promise<TimeSession[]> {
  if (!taskIds)
    return (await ex.all('SELECT * FROM time_sessions ORDER BY start_utc')).map(rowToSession);
  const out: TimeSession[] = [];
  for (const batch of chunks(taskIds)) {
    out.push(
      ...(
        await ex.all(
          `SELECT * FROM time_sessions WHERE task_id IN (${placeholders(batch.length)})`,
          batch,
        )
      ).map(rowToSession),
    );
  }
  return out;
}

export const loadAreas = async (ex: Executor): Promise<Area[]> =>
  (await ex.all('SELECT * FROM areas ORDER BY sort_order, name')).map(rowToArea);
export const loadProjects = async (ex: Executor): Promise<Project[]> =>
  (await ex.all('SELECT * FROM projects ORDER BY sort_order, name')).map(rowToProject);
export const loadTags = async (ex: Executor): Promise<Tag[]> =>
  (await ex.all('SELECT * FROM tags ORDER BY name')).map(rowToTag);
export async function loadSeries(ex: Executor): Promise<RecurrenceSeries[]> {
  const series = (await ex.all('SELECT * FROM recurrence_series')).map(rowToSeries);
  const byId = new Map(series.map((s) => [s.id, s]));
  const skips = await ex.all<{ series_id: string; occurrence_date: string }>(
    'SELECT series_id, occurrence_date FROM recurrence_exceptions ORDER BY occurrence_date',
  );
  for (const r of skips) byId.get(r.series_id)?.skipDates.push(r.occurrence_date);
  return series;
}
export const loadCalendars = async (ex: Executor): Promise<Calendar[]> =>
  (await ex.all('SELECT * FROM calendars ORDER BY sort_order, name')).map(rowToCalendar);
export const loadEvents = async (ex: Executor): Promise<CalendarEvent[]> =>
  (await ex.all('SELECT * FROM calendar_events')).map(rowToEvent);
export const loadAccounts = async (ex: Executor): Promise<IntegrationAccount[]> =>
  (await ex.all('SELECT * FROM integration_accounts ORDER BY created_at')).map(rowToAccount);
export const loadRituals = async (ex: Executor): Promise<Ritual[]> =>
  (await ex.all('SELECT * FROM rituals ORDER BY period')).map(rowToRitual);

export async function loadSettings(ex: Executor): Promise<Settings> {
  const rows = await ex.all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const out: Settings = { ...DEFAULT_SETTINGS };
  const record = out as unknown as Record<string, unknown>;
  for (const { key, value } of rows) {
    if (key in DEFAULT_SETTINGS) record[key] = parseJson(value, record[key]);
  }
  return out;
}

export interface Snapshot {
  tasks: Task[];
  areas: Area[];
  projects: Project[];
  tags: Tag[];
  series: RecurrenceSeries[];
  blocks: TimeBlock[];
  sessions: TimeSession[];
  calendars: Calendar[];
  events: CalendarEvent[];
  rituals: Ritual[];
  accounts: IntegrationAccount[];
  settings: Settings;
}

export async function loadSnapshot(ex: Executor): Promise<Snapshot> {
  return {
    tasks: await loadTasks(ex),
    areas: await loadAreas(ex),
    projects: await loadProjects(ex),
    tags: await loadTags(ex),
    series: await loadSeries(ex),
    blocks: await loadBlocks(ex),
    sessions: await loadSessions(ex),
    calendars: await loadCalendars(ex),
    events: await loadEvents(ex),
    rituals: await loadRituals(ex),
    accounts: await loadAccounts(ex),
    settings: await loadSettings(ex),
  };
}

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

export async function saveSettings(ctx: Ctx, patch: Partial<Settings>): Promise<void> {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${key}`);
    await ctx.tx.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), ctx.now],
    );
  }
  ctx.changes.table('settings');
}

// ---------------------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------------------

/** A sort key strictly between `before` and `after` (either may be missing). */
export function orderBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

export type Position = 'top' | 'bottom' | { index: number };

async function dayOrders(tx: Executor, date: ISODate, excludeTaskId?: string): Promise<number[]> {
  const rows = await tx.all<{ sort_order: number }>(
    `SELECT sort_order FROM day_plan_entries
     WHERE plan_date = ? AND status IN ('active', 'done') AND task_id IS NOT ?
     ORDER BY sort_order`,
    [date, excludeTaskId ?? null],
  );
  return rows.map((r) => r.sort_order);
}

function orderAt(orders: number[], position: Position): number {
  if (position === 'top') return orderBetween(undefined, orders[0]);
  if (position === 'bottom') return orderBetween(orders.at(-1), undefined);
  const i = Math.max(0, Math.min(position.index, orders.length));
  return orderBetween(orders[i - 1], orders[i]);
}

/** Renumbers a day's entries 1..n when keys get too close (after many midpoint inserts). */
async function normalizeDayOrder(tx: Executor, date: ISODate): Promise<void> {
  const rows = await tx.all<{ id: string; sort_order: number }>(
    `SELECT id, sort_order FROM day_plan_entries WHERE plan_date = ? AND status IN ('active','done') ORDER BY sort_order`,
    [date],
  );
  let crowded = false;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.sort_order - rows[i - 1]!.sort_order < 1e-6) crowded = true;
  }
  if (!crowded) return;
  for (let i = 0; i < rows.length; i++) {
    await tx.run('UPDATE day_plan_entries SET sort_order = ? WHERE id = ?', [i + 1, rows[i]!.id]);
  }
}

async function backlogEdge(tx: Executor, edge: 'top' | 'bottom'): Promise<number> {
  const row = await tx.get<{ v: number | null }>(
    `SELECT ${edge === 'top' ? 'min' : 'max'}(backlog_order) AS v FROM tasks`,
  );
  const v = row?.v ?? 0;
  return edge === 'top' ? v - 1 : v + 1;
}

// ---------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------

export interface NewTask {
  id?: string;
  title: string;
  notes?: string;
  projectId?: string | null;
  areaId?: string | null;
  priority?: Priority;
  estimateMin?: number | null;
  dueDate?: ISODate | null;
  /** undefined/null = backlog (unplanned). */
  planDate?: ISODate | null;
  planPosition?: Position;
  backlogPosition?: 'top' | 'bottom';
  tagIds?: string[];
  subtasks?: string[];
  links?: { url: string; title?: string }[];
  recurrenceId?: string | null;
  recurrenceDate?: ISODate | null;
  source?: string;
}

export async function projectArea(
  tx: Executor,
  projectId: string | null | undefined,
): Promise<string | null> {
  if (!projectId) return null;
  const row = await tx.get<{ area_id: string | null }>(
    'SELECT area_id FROM projects WHERE id = ?',
    [projectId],
  );
  return row?.area_id ?? null;
}

export async function createTask(ctx: Ctx, input: NewTask): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new Error('A task needs a title');
  const id = input.id ?? newId();
  const areaId = input.projectId
    ? await projectArea(ctx.tx, input.projectId)
    : (input.areaId ?? null);
  await ctx.tx.run(
    `INSERT INTO tasks (id, title, notes, project_id, area_id, priority, estimate_min, due_date,
       backlog_order, recurrence_id, recurrence_date, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      title,
      input.notes ?? '',
      input.projectId ?? null,
      areaId,
      input.priority ?? 0,
      input.estimateMin ?? null,
      input.dueDate ?? null,
      await backlogEdge(ctx.tx, input.backlogPosition ?? 'bottom'),
      input.recurrenceId ?? null,
      input.recurrenceDate ?? null,
      input.source ?? 'local',
      ctx.now,
      ctx.now,
    ],
  );
  for (const tagId of input.tagIds ?? []) {
    await ctx.tx.run('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)', [
      id,
      tagId,
    ]);
  }
  let order = 1;
  for (const st of input.subtasks ?? []) {
    if (!st.trim()) continue;
    await ctx.tx.run(
      'INSERT INTO subtasks (id, task_id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [newId(), id, st.trim(), order++, ctx.now, ctx.now],
    );
  }
  order = 1;
  for (const link of input.links ?? []) {
    await ctx.tx.run(
      'INSERT INTO task_links (id, task_id, url, title, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [newId(), id, link.url, link.title ?? '', order++, ctx.now],
    );
  }
  if (input.planDate) await planTask(ctx, id, input.planDate, input.planPosition ?? 'bottom');
  ctx.changes.task(id);
  return id;
}

export interface TaskPatch {
  title?: string;
  notes?: string;
  projectId?: string | null;
  areaId?: string | null;
  priority?: Priority;
  estimateMin?: number | null;
  dueDate?: ISODate | null;
  archivedAt?: ISOInstant | null;
}

const TASK_COLUMNS: Record<keyof TaskPatch, string> = {
  title: 'title',
  notes: 'notes',
  projectId: 'project_id',
  areaId: 'area_id',
  priority: 'priority',
  estimateMin: 'estimate_min',
  dueDate: 'due_date',
  archivedAt: 'archived_at',
};

export async function updateTasks(ctx: Ctx, ids: string[], patch: TaskPatch): Promise<void> {
  const p = { ...patch };
  if (p.title !== undefined) {
    p.title = p.title.trim();
    if (!p.title) throw new Error('A task needs a title');
  }
  // A project implies its area; choosing an area directly clears the project if it disagrees.
  if (p.projectId !== undefined && p.projectId !== null)
    p.areaId = await projectArea(ctx.tx, p.projectId);
  const sets: string[] = [];
  const params: SqlParam[] = [];
  for (const [key, col] of Object.entries(TASK_COLUMNS) as [keyof TaskPatch, string][]) {
    if (p[key] !== undefined) {
      sets.push(`${col} = ?`);
      params.push(p[key] as SqlParam);
    }
  }
  if (sets.length === 0 || ids.length === 0) return;
  sets.push('updated_at = ?');
  params.push(ctx.now);
  for (const batch of chunks(ids)) {
    await ctx.tx.run(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id IN (${placeholders(batch.length)})`,
      [...params, ...batch],
    );
  }
  if (patch.areaId !== undefined && patch.projectId === undefined) {
    // Moving to a different area detaches tasks from projects in other areas.
    await ctx.tx.run(
      `UPDATE tasks SET project_id = NULL WHERE id IN (${placeholders(ids.length)})
       AND project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects WHERE area_id IS ?)`,
      [...ids, patch.areaId],
    );
  }
  ctx.changes.task(...ids);
}

export async function deleteTasks(ctx: Ctx, ids: string[]): Promise<void> {
  for (const batch of chunks(ids)) {
    // Remember deleted recurring instances so they are never re-created.
    await ctx.tx.run(
      `INSERT OR IGNORE INTO recurrence_exceptions (series_id, occurrence_date, kind, created_at)
       SELECT recurrence_id, recurrence_date, 'skip', ? FROM tasks
       WHERE id IN (${placeholders(batch.length)}) AND recurrence_id IS NOT NULL`,
      [ctx.now, ...batch],
    );
    await ctx.tx.run(`DELETE FROM tasks WHERE id IN (${placeholders(batch.length)})`, batch);
  }
  ctx.changes.task(...ids);
}

export async function setTaskTags(ctx: Ctx, taskId: string, tagIds: string[]): Promise<void> {
  await ctx.tx.run(
    'DELETE FROM task_tags WHERE task_id = ? AND tag_id NOT IN (' +
      placeholders(tagIds.length) +
      ')',
    [taskId, ...tagIds],
  );
  for (const tagId of tagIds) {
    await ctx.tx.run('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)', [
      taskId,
      tagId,
    ]);
  }
  ctx.changes.task(taskId);
}

export async function addTagToTasks(
  ctx: Ctx,
  taskIds: string[],
  tagId: string,
  add: boolean,
): Promise<void> {
  for (const id of taskIds) {
    if (add)
      await ctx.tx.run('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)', [
        id,
        tagId,
      ]);
    else await ctx.tx.run('DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?', [id, tagId]);
  }
  ctx.changes.task(...taskIds);
}

export async function reorderBacklog(
  ctx: Ctx,
  taskId: string,
  before?: string,
  after?: string,
): Promise<void> {
  const order = async (id?: string) =>
    id
      ? (await ctx.tx.get<{ o: number }>('SELECT backlog_order AS o FROM tasks WHERE id = ?', [id]))
          ?.o
      : undefined;
  const value = orderBetween(await order(before), await order(after));
  await ctx.tx.run('UPDATE tasks SET backlog_order = ?, updated_at = ? WHERE id = ?', [
    value,
    ctx.now,
    taskId,
  ]);
  ctx.changes.task(taskId);
}

// ---------------------------------------------------------------------------------------
// Subtasks & links
// ---------------------------------------------------------------------------------------

export async function addSubtask(ctx: Ctx, taskId: string, title: string): Promise<string> {
  const id = newId();
  const max = await ctx.tx.get<{ v: number | null }>(
    'SELECT max(sort_order) AS v FROM subtasks WHERE task_id = ?',
    [taskId],
  );
  await ctx.tx.run(
    'INSERT INTO subtasks (id, task_id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, taskId, title.trim(), (max?.v ?? 0) + 1, ctx.now, ctx.now],
  );
  ctx.changes.task(taskId);
  return id;
}

export async function updateSubtask(
  ctx: Ctx,
  id: string,
  patch: { title?: string; done?: boolean; sortOrder?: number },
): Promise<void> {
  const row = await ctx.tx.get<{ task_id: string }>('SELECT task_id FROM subtasks WHERE id = ?', [
    id,
  ]);
  if (!row) return;
  if (patch.title !== undefined)
    await ctx.tx.run('UPDATE subtasks SET title = ?, updated_at = ? WHERE id = ?', [
      patch.title.trim(),
      ctx.now,
      id,
    ]);
  if (patch.done !== undefined)
    await ctx.tx.run('UPDATE subtasks SET completed_at = ?, updated_at = ? WHERE id = ?', [
      patch.done ? ctx.now : null,
      ctx.now,
      id,
    ]);
  if (patch.sortOrder !== undefined)
    await ctx.tx.run('UPDATE subtasks SET sort_order = ?, updated_at = ? WHERE id = ?', [
      patch.sortOrder,
      ctx.now,
      id,
    ]);
  ctx.changes.task(row.task_id);
}

export async function deleteSubtask(ctx: Ctx, id: string): Promise<void> {
  const row = await ctx.tx.get<{ task_id: string }>('SELECT task_id FROM subtasks WHERE id = ?', [
    id,
  ]);
  if (!row) return;
  await ctx.tx.run('DELETE FROM subtasks WHERE id = ?', [id]);
  ctx.changes.task(row.task_id);
}

export async function addLink(ctx: Ctx, taskId: string, url: string, title = ''): Promise<string> {
  const id = newId();
  const max = await ctx.tx.get<{ v: number | null }>(
    'SELECT max(sort_order) AS v FROM task_links WHERE task_id = ?',
    [taskId],
  );
  await ctx.tx.run(
    'INSERT INTO task_links (id, task_id, url, title, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, taskId, url.trim(), title.trim(), (max?.v ?? 0) + 1, ctx.now],
  );
  ctx.changes.task(taskId);
  return id;
}

export async function deleteLink(ctx: Ctx, id: string): Promise<void> {
  const row = await ctx.tx.get<{ task_id: string }>('SELECT task_id FROM task_links WHERE id = ?', [
    id,
  ]);
  if (!row) return;
  await ctx.tx.run('DELETE FROM task_links WHERE id = ?', [id]);
  ctx.changes.task(row.task_id);
}

// ---------------------------------------------------------------------------------------
// Planning (which day a task is planned for)
// ---------------------------------------------------------------------------------------

interface CurrentEntry {
  id: string;
  plan_date: string;
  status: 'active' | 'done';
}

async function currentEntry(tx: Executor, taskId: string): Promise<CurrentEntry | undefined> {
  return tx.get<CurrentEntry>(
    "SELECT id, plan_date, status FROM day_plan_entries WHERE task_id = ? AND status IN ('active', 'done')",
    [taskId],
  );
}

async function isCompleted(tx: Executor, taskId: string): Promise<boolean> {
  const row = await tx.get<{ completed_at: string | null }>(
    'SELECT completed_at FROM tasks WHERE id = ?',
    [taskId],
  );
  if (!row) throw new Error('Task not found');
  return row.completed_at !== null;
}

export interface PlanOptions {
  /**
   * Shift not-yet-started time blocks on the old day to the same wall-clock time on the
   * new day (default true). Past blocks stay where they were — they are history.
   */
  shiftBlocks?: boolean;
}

/** Plans a task for `date` at `position`, closing its previous day entry as 'moved'. */
export async function planTask(
  ctx: Ctx,
  taskId: string,
  date: ISODate,
  position: Position = 'bottom',
  options: PlanOptions = {},
): Promise<void> {
  const current = await currentEntry(ctx.tx, taskId);
  const orders = await dayOrders(ctx.tx, date, taskId);
  const sortOrder = orderAt(orders, position);
  if (current && current.plan_date === date) {
    await ctx.tx.run('UPDATE day_plan_entries SET sort_order = ? WHERE id = ?', [
      sortOrder,
      current.id,
    ]);
  } else {
    const done = await isCompleted(ctx.tx, taskId);
    if (current) {
      await ctx.tx.run("UPDATE day_plan_entries SET status = 'moved', closed_at = ? WHERE id = ?", [
        ctx.now,
        current.id,
      ]);
      if (options.shiftBlocks !== false)
        await shiftFutureBlocks(ctx, taskId, current.plan_date, date);
    }
    await ctx.tx.run(
      'INSERT INTO day_plan_entries (id, task_id, plan_date, sort_order, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [newId(), taskId, date, sortOrder, done ? 'done' : 'active', ctx.now],
    );
  }
  await normalizeDayOrder(ctx.tx, date);
  ctx.changes.task(taskId);
}

/** Moves a task back to the backlog. Its upcoming time blocks are removed (they belonged to that day). */
export async function unplanTask(ctx: Ctx, taskId: string): Promise<void> {
  const current = await currentEntry(ctx.tx, taskId);
  if (!current) return;
  await ctx.tx.run("UPDATE day_plan_entries SET status = 'removed', closed_at = ? WHERE id = ?", [
    ctx.now,
    current.id,
  ]);
  await ctx.tx.run('DELETE FROM time_blocks WHERE task_id = ? AND start_utc > ?', [
    taskId,
    ctx.now,
  ]);
  ctx.changes.task(taskId);
}

async function shiftFutureBlocks(
  ctx: Ctx,
  taskId: string,
  fromDate: ISODate,
  toDate: ISODate,
): Promise<void> {
  const blocks = await ctx.tx.all<{ id: string; start_utc: string; end_utc: string }>(
    'SELECT id, start_utc, end_utc FROM time_blocks WHERE task_id = ? AND start_utc > ?',
    [taskId, ctx.now],
  );
  for (const b of blocks) {
    if (dateOfInstant(b.start_utc, ctx.zone) !== fromDate) continue;
    const startMin = Math.round(minutesIntoDay(b.start_utc, fromDate, ctx.zone));
    const duration = (Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000;
    const start = wallTimeToInstant(toDate, startMin, ctx.zone);
    const end = new Date(Date.parse(start) + duration * 60000).toISOString();
    if (Date.parse(start) <= Date.parse(ctx.now)) {
      // Moving to a past day: the block would be in the past, so drop it instead.
      await ctx.tx.run('DELETE FROM time_blocks WHERE id = ?', [b.id]);
    } else {
      await ctx.tx.run(
        'UPDATE time_blocks SET start_utc = ?, end_utc = ?, updated_at = ? WHERE id = ?',
        [start, end, ctx.now, b.id],
      );
    }
  }
}

/** Sets a day's order to exactly `taskIds` (tasks not planned on that day are ignored). */
export async function reorderDay(ctx: Ctx, date: ISODate, taskIds: string[]): Promise<void> {
  let order = 1;
  for (const id of taskIds) {
    const r = await ctx.tx.run(
      "UPDATE day_plan_entries SET sort_order = ? WHERE task_id = ? AND plan_date = ? AND status IN ('active','done')",
      [order, id, date],
    );
    if (r.changes) order++;
  }
  ctx.changes.task(...taskIds);
}

export async function completeTask(ctx: Ctx, taskId: string): Promise<void> {
  if (await isCompleted(ctx.tx, taskId)) return;
  await ctx.tx.run('UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?', [
    ctx.now,
    ctx.now,
    taskId,
  ]);
  await ctx.tx.run(
    'UPDATE time_sessions SET end_utc = ?, updated_at = ? WHERE task_id = ? AND end_utc IS NULL',
    [ctx.now, ctx.now, taskId],
  );
  const current = await currentEntry(ctx.tx, taskId);
  if (current && current.plan_date <= ctx.today) {
    await ctx.tx.run("UPDATE day_plan_entries SET status = 'done' WHERE id = ?", [current.id]);
  } else {
    // Unplanned, or planned for a future day: it was done today.
    await planTask(ctx, taskId, ctx.today, 'bottom', { shiftBlocks: false });
    const entry = await currentEntry(ctx.tx, taskId);
    if (entry)
      await ctx.tx.run("UPDATE day_plan_entries SET status = 'done' WHERE id = ?", [entry.id]);
  }
  ctx.changes.task(taskId);
}

export async function reopenTask(ctx: Ctx, taskId: string): Promise<void> {
  if (!(await isCompleted(ctx.tx, taskId))) return;
  await ctx.tx.run('UPDATE tasks SET completed_at = NULL, updated_at = ? WHERE id = ?', [
    ctx.now,
    taskId,
  ]);
  await ctx.tx.run(
    "UPDATE day_plan_entries SET status = 'active' WHERE task_id = ? AND status = 'done'",
    [taskId],
  );
  ctx.changes.task(taskId);
}

/**
 * Carries unfinished tasks planned before `target` forward to `target` (placed at the top, in
 * their original order). Each old entry is kept as 'rolled_over' history.
 * A recurring instance is not carried forward when a newer instance of the same series is
 * already planned on or before `target`; it is marked skipped instead of duplicating.
 */
export async function rolloverTasks(
  ctx: Ctx,
  target: ISODate,
  onlyTaskIds?: string[],
): Promise<string[]> {
  const rows = await ctx.tx.all<{
    id: string;
    task_id: string;
    recurrence_id: string | null;
    recurrence_date: string | null;
  }>(
    `SELECT e.id, e.task_id, t.recurrence_id, t.recurrence_date
     FROM day_plan_entries e JOIN tasks t ON t.id = e.task_id
     WHERE e.status = 'active' AND e.plan_date < ? AND t.completed_at IS NULL AND t.archived_at IS NULL
     ORDER BY e.plan_date, e.sort_order`,
    [target],
  );
  const selected = onlyTaskIds ? rows.filter((r) => onlyTaskIds.includes(r.task_id)) : rows;
  const moved: string[] = [];
  const orders = await dayOrders(ctx.tx, target);
  const top = orders[0] ?? 1;
  let i = 0;
  for (const r of selected) {
    if (r.recurrence_id) {
      const newer = await ctx.tx.get<{ n: number }>(
        `SELECT count(*) AS n FROM tasks t JOIN day_plan_entries e ON e.task_id = t.id AND e.status IN ('active','done')
         WHERE t.recurrence_id = ? AND t.recurrence_date > ? AND e.plan_date <= ?`,
        [r.recurrence_id, r.recurrence_date, target],
      );
      if (newer?.n) {
        await ctx.tx.run(
          "UPDATE day_plan_entries SET status = 'removed', closed_at = ? WHERE id = ?",
          [ctx.now, r.id],
        );
        await ctx.tx.run('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?', [
          ctx.now,
          ctx.now,
          r.task_id,
        ]);
        ctx.changes.task(r.task_id);
        continue;
      }
    }
    await ctx.tx.run(
      "UPDATE day_plan_entries SET status = 'rolled_over', closed_at = ? WHERE id = ?",
      [ctx.now, r.id],
    );
    await ctx.tx.run(
      "INSERT INTO day_plan_entries (id, task_id, plan_date, sort_order, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
      [newId(), r.task_id, target, top - selected.length + i, ctx.now],
    );
    i++;
    moved.push(r.task_id);
    ctx.changes.task(r.task_id);
  }
  return moved;
}

// ---------------------------------------------------------------------------------------
// Time blocks (timeboxing)
// ---------------------------------------------------------------------------------------

function assertRange(start: ISOInstant, end: ISOInstant) {
  if (!(Date.parse(end) > Date.parse(start)))
    throw new Error('A time block must end after it starts');
}

export async function createBlock(
  ctx: Ctx,
  taskId: string,
  start: ISOInstant,
  end: ISOInstant,
): Promise<string> {
  assertRange(start, end);
  const id = newId();
  await ctx.tx.run(
    'INSERT INTO time_blocks (id, task_id, start_utc, end_utc, tz, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, taskId, start, end, ctx.zone, ctx.now, ctx.now],
  );
  // A timebox on a day means the task is planned for that day.
  const date = dateOfInstant(start, ctx.zone);
  const current = await currentEntry(ctx.tx, taskId);
  if (current?.plan_date !== date)
    await planTask(ctx, taskId, date, 'bottom', { shiftBlocks: false });
  ctx.changes.task(taskId);
  return id;
}

export async function updateBlock(
  ctx: Ctx,
  blockId: string,
  start: ISOInstant,
  end: ISOInstant,
): Promise<void> {
  assertRange(start, end);
  const block = await ctx.tx.get<{ task_id: string; start_utc: string }>(
    'SELECT task_id, start_utc FROM time_blocks WHERE id = ?',
    [blockId],
  );
  if (!block) throw new Error('Time block not found');
  await ctx.tx.run(
    'UPDATE time_blocks SET start_utc = ?, end_utc = ?, tz = ?, updated_at = ? WHERE id = ?',
    [start, end, ctx.zone, ctx.now, blockId],
  );
  const oldDate = dateOfInstant(block.start_utc, ctx.zone);
  const newDate = dateOfInstant(start, ctx.zone);
  if (oldDate !== newDate) {
    const current = await currentEntry(ctx.tx, block.task_id);
    if (!current || current.plan_date === oldDate) {
      await planTask(ctx, block.task_id, newDate, 'bottom', { shiftBlocks: false });
    }
  }
  ctx.changes.task(block.task_id);
}

export async function deleteBlock(ctx: Ctx, blockId: string): Promise<void> {
  const block = await ctx.tx.get<{ task_id: string }>(
    'SELECT task_id FROM time_blocks WHERE id = ?',
    [blockId],
  );
  if (!block) return;
  await ctx.tx.run('DELETE FROM time_blocks WHERE id = ?', [blockId]);
  ctx.changes.task(block.task_id);
}

/** Keel's own blocks shifted by the same wall-clock time into a new zone (time zone change). */
export async function rebaseBlocksToZone(
  ctx: Ctx,
  fromZone: string,
  blockIds: string[],
): Promise<number> {
  let n = 0;
  for (const id of blockIds) {
    const b = await ctx.tx.get<{ task_id: string; start_utc: string; end_utc: string }>(
      'SELECT task_id, start_utc, end_utc FROM time_blocks WHERE id = ?',
      [id],
    );
    if (!b) continue;
    const date = dateOfInstant(b.start_utc, fromZone);
    const startMin = Math.round(minutesIntoDay(b.start_utc, date, fromZone));
    const duration = Date.parse(b.end_utc) - Date.parse(b.start_utc);
    const start = wallTimeToInstant(date, startMin, ctx.zone);
    const end = new Date(Date.parse(start) + duration).toISOString();
    await ctx.tx.run(
      'UPDATE time_blocks SET start_utc = ?, end_utc = ?, tz = ?, updated_at = ? WHERE id = ?',
      [start, end, ctx.zone, ctx.now, id],
    );
    ctx.changes.task(b.task_id);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------------------
// Timer & time sessions
// ---------------------------------------------------------------------------------------

export async function runningSession(ex: Executor): Promise<TimeSession | null> {
  const row = await ex.get('SELECT * FROM time_sessions WHERE end_utc IS NULL');
  return row ? rowToSession(row) : null;
}

export async function startTimer(ctx: Ctx, taskId: string): Promise<string> {
  const running = await runningSession(ctx.tx);
  if (running?.taskId === taskId) return running.id;
  if (running) await stopTimer(ctx);
  if (await isCompleted(ctx.tx, taskId)) await reopenTask(ctx, taskId);
  const id = newId();
  await ctx.tx.run(
    `INSERT INTO time_sessions (id, task_id, start_utc, heartbeat_utc, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'timer', ?, ?)`,
    [id, taskId, ctx.now, ctx.now, ctx.now, ctx.now],
  );
  // Working on something means it is on today's plan.
  const current = await currentEntry(ctx.tx, taskId);
  if (current?.plan_date !== ctx.today)
    await planTask(ctx, taskId, ctx.today, 'bottom', { shiftBlocks: false });
  ctx.changes.task(taskId);
  return id;
}

export async function stopTimer(ctx: Ctx, at?: ISOInstant): Promise<TimeSession | null> {
  const running = await runningSession(ctx.tx);
  if (!running) return null;
  const end = at && Date.parse(at) >= Date.parse(running.startUtc) ? at : ctx.now;
  await ctx.tx.run('UPDATE time_sessions SET end_utc = ?, updated_at = ? WHERE id = ?', [
    end,
    ctx.now,
    running.id,
  ]);
  ctx.changes.task(running.taskId);
  return { ...running, endUtc: end };
}

/** Records that the app is awake while the timer runs (not undoable, touches one column). */
export async function heartbeat(ctx: Ctx): Promise<void> {
  await ctx.tx.run('UPDATE time_sessions SET heartbeat_utc = ? WHERE end_utc IS NULL', [ctx.now]);
}

export type GapDecision = 'keep' | 'discard' | 'discard-stop';

/** Resolves an unattended gap (sleep) detected on the running session. */
export async function resolveGap(
  ctx: Ctx,
  decision: GapDecision,
  gapStart: ISOInstant,
  sessionId?: string,
): Promise<void> {
  const running = await runningSession(ctx.tx);
  // The prompt was about one session; if that timer has since stopped or another task's
  // timer started, the decision no longer applies to anything.
  if (!running || (sessionId && running.id !== sessionId)) return;
  if (decision === 'keep') {
    await heartbeat(ctx);
    return;
  }
  await stopTimer(ctx, gapStart);
  if (decision === 'discard') {
    await ctx.tx.run(
      `INSERT INTO time_sessions (id, task_id, start_utc, heartbeat_utc, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'timer', ?, ?)`,
      [newId(), running.taskId, ctx.now, ctx.now, ctx.now, ctx.now],
    );
  }
  ctx.changes.task(running.taskId);
}

/** Adds manually tracked time ending at `end` (default now). Negative minutes are rejected. */
export async function addManualTime(
  ctx: Ctx,
  taskId: string,
  minutes: number,
  end: ISOInstant = ctx.now,
): Promise<void> {
  if (!(minutes > 0)) throw new Error('Tracked time must be positive');
  const start = new Date(Date.parse(end) - minutes * 60000).toISOString();
  await ctx.tx.run(
    `INSERT INTO time_sessions (id, task_id, start_utc, end_utc, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'manual', ?, ?)`,
    [newId(), taskId, start, end, ctx.now, ctx.now],
  );
  ctx.changes.task(taskId);
}

export async function updateSession(
  ctx: Ctx,
  id: string,
  start: ISOInstant,
  end: ISOInstant | null,
): Promise<void> {
  if (end && Date.parse(end) < Date.parse(start))
    throw new Error('A session cannot end before it starts');
  const row = await ctx.tx.get<{ task_id: string }>(
    'SELECT task_id FROM time_sessions WHERE id = ?',
    [id],
  );
  if (!row) return;
  await ctx.tx.run(
    'UPDATE time_sessions SET start_utc = ?, end_utc = ?, updated_at = ? WHERE id = ?',
    [start, end, ctx.now, id],
  );
  ctx.changes.task(row.task_id);
}

export async function deleteSession(ctx: Ctx, id: string): Promise<void> {
  const row = await ctx.tx.get<{ task_id: string }>(
    'SELECT task_id FROM time_sessions WHERE id = ?',
    [id],
  );
  if (!row) return;
  await ctx.tx.run('DELETE FROM time_sessions WHERE id = ?', [id]);
  ctx.changes.task(row.task_id);
}

// ---------------------------------------------------------------------------------------
// Areas, projects, tags
// ---------------------------------------------------------------------------------------

export async function createArea(ctx: Ctx, name: string, color: string): Promise<string> {
  const id = newId();
  const max = await ctx.tx.get<{ v: number | null }>('SELECT max(sort_order) AS v FROM areas');
  await ctx.tx.run(
    'INSERT INTO areas (id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name.trim(), color, (max?.v ?? 0) + 1, ctx.now, ctx.now],
  );
  ctx.changes.table('areas');
  return id;
}

export async function updateArea(
  ctx: Ctx,
  id: string,
  patch: { name?: string; color?: string; archived?: boolean },
) {
  if (patch.name !== undefined)
    await ctx.tx.run('UPDATE areas SET name = ?, updated_at = ? WHERE id = ?', [
      patch.name.trim(),
      ctx.now,
      id,
    ]);
  if (patch.color !== undefined)
    await ctx.tx.run('UPDATE areas SET color = ?, updated_at = ? WHERE id = ?', [
      patch.color,
      ctx.now,
      id,
    ]);
  if (patch.archived !== undefined)
    await ctx.tx.run('UPDATE areas SET archived_at = ?, updated_at = ? WHERE id = ?', [
      patch.archived ? ctx.now : null,
      ctx.now,
      id,
    ]);
  ctx.changes.table('areas');
}

export async function deleteArea(ctx: Ctx, id: string): Promise<void> {
  const tasks = await ctx.tx.all<{ id: string }>('SELECT id FROM tasks WHERE area_id = ?', [id]);
  await ctx.tx.run('DELETE FROM areas WHERE id = ?', [id]);
  ctx.changes.table('areas', 'projects');
  ctx.changes.task(...tasks.map((t) => t.id));
}

export async function createProject(
  ctx: Ctx,
  input: { name: string; color: string; areaId?: string | null; notes?: string },
): Promise<string> {
  const id = newId();
  const max = await ctx.tx.get<{ v: number | null }>('SELECT max(sort_order) AS v FROM projects');
  await ctx.tx.run(
    'INSERT INTO projects (id, area_id, name, color, notes, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      input.areaId ?? null,
      input.name.trim(),
      input.color,
      input.notes ?? '',
      (max?.v ?? 0) + 1,
      ctx.now,
      ctx.now,
    ],
  );
  ctx.changes.table('projects');
  return id;
}

export async function updateProject(
  ctx: Ctx,
  id: string,
  patch: {
    name?: string;
    color?: string;
    notes?: string;
    areaId?: string | null;
    archived?: boolean;
  },
): Promise<void> {
  const cols: [string, SqlParam][] = [];
  if (patch.name !== undefined) cols.push(['name', patch.name.trim()]);
  if (patch.color !== undefined) cols.push(['color', patch.color]);
  if (patch.notes !== undefined) cols.push(['notes', patch.notes]);
  if (patch.areaId !== undefined) cols.push(['area_id', patch.areaId]);
  if (patch.archived !== undefined) cols.push(['archived_at', patch.archived ? ctx.now : null]);
  if (!cols.length) return;
  await ctx.tx.run(
    `UPDATE projects SET ${cols.map(([c]) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...cols.map(([, v]) => v), ctx.now, id],
  );
  if (patch.areaId !== undefined) {
    // Tasks follow their project's area.
    const tasks = await ctx.tx.all<{ id: string }>('SELECT id FROM tasks WHERE project_id = ?', [
      id,
    ]);
    await ctx.tx.run('UPDATE tasks SET area_id = ?, updated_at = ? WHERE project_id = ?', [
      patch.areaId,
      ctx.now,
      id,
    ]);
    ctx.changes.task(...tasks.map((t) => t.id));
  }
  ctx.changes.table('projects');
}

export async function deleteProject(ctx: Ctx, id: string): Promise<void> {
  const tasks = await ctx.tx.all<{ id: string }>('SELECT id FROM tasks WHERE project_id = ?', [id]);
  await ctx.tx.run('DELETE FROM projects WHERE id = ?', [id]);
  ctx.changes.table('projects');
  ctx.changes.task(...tasks.map((t) => t.id));
}

export async function createTag(ctx: Ctx, name: string, color: string): Promise<string> {
  const existing = await ctx.tx.get<{ id: string }>(
    'SELECT id FROM tags WHERE name = ? COLLATE NOCASE',
    [name.trim()],
  );
  if (existing) return existing.id;
  const id = newId();
  await ctx.tx.run('INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)', [
    id,
    name.trim(),
    color,
    ctx.now,
  ]);
  ctx.changes.table('tags');
  return id;
}

export async function updateTag(
  ctx: Ctx,
  id: string,
  patch: { name?: string; color?: string },
): Promise<void> {
  if (patch.name !== undefined)
    await ctx.tx.run('UPDATE tags SET name = ? WHERE id = ?', [patch.name.trim(), id]);
  if (patch.color !== undefined)
    await ctx.tx.run('UPDATE tags SET color = ? WHERE id = ?', [patch.color, id]);
  ctx.changes.table('tags');
}

export async function deleteTag(ctx: Ctx, id: string): Promise<void> {
  const tasks = await ctx.tx.all<{ task_id: string }>(
    'SELECT task_id FROM task_tags WHERE tag_id = ?',
    [id],
  );
  await ctx.tx.run('DELETE FROM tags WHERE id = ?', [id]);
  ctx.changes.table('tags');
  ctx.changes.task(...tasks.map((t) => t.task_id));
}

// ---------------------------------------------------------------------------------------
// Rituals
// ---------------------------------------------------------------------------------------

export async function saveRitual(
  ctx: Ctx,
  kind: RitualKind,
  period: ISODate,
  patch: {
    reflection?: string;
    data?: Record<string, unknown>;
    started?: boolean;
    completed?: boolean;
  },
): Promise<void> {
  const existing = await ctx.tx.get<{ id: string; data: string; started_at: string | null }>(
    'SELECT id, data, started_at FROM rituals WHERE kind = ? AND period = ?',
    [kind, period],
  );
  if (!existing) {
    await ctx.tx.run(
      `INSERT INTO rituals (id, kind, period, started_at, completed_at, reflection, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        kind,
        period,
        ctx.now,
        patch.completed ? ctx.now : null,
        patch.reflection ?? '',
        JSON.stringify(patch.data ?? {}),
        ctx.now,
        ctx.now,
      ],
    );
  } else {
    const data = {
      ...parseJson<Record<string, unknown>>(existing.data, {}),
      ...(patch.data ?? {}),
    };
    const sets = ['data = ?', 'updated_at = ?'];
    const params: SqlParam[] = [JSON.stringify(data), ctx.now];
    if (patch.reflection !== undefined) {
      sets.push('reflection = ?');
      params.push(patch.reflection);
    }
    if (patch.completed !== undefined) {
      sets.push('completed_at = ?');
      params.push(patch.completed ? ctx.now : null);
    }
    if (!existing.started_at) {
      sets.push('started_at = ?');
      params.push(ctx.now);
    }
    await ctx.tx.run(`UPDATE rituals SET ${sets.join(', ')} WHERE id = ?`, [
      ...params,
      existing.id,
    ]);
  }
  ctx.changes.table('rituals');
}

// ---------------------------------------------------------------------------------------
// Calendars & events (local)
// ---------------------------------------------------------------------------------------

export async function createCalendar(
  ctx: Ctx,
  input: {
    name: string;
    color: string;
    source?: string;
    accountId?: string | null;
    isWritable?: boolean;
    timezone?: string | null;
  },
): Promise<string> {
  const id = newId();
  const max = await ctx.tx.get<{ v: number | null }>('SELECT max(sort_order) AS v FROM calendars');
  await ctx.tx.run(
    `INSERT INTO calendars (id, account_id, source, name, color, timezone, is_writable, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.accountId ?? null,
      input.source ?? 'local',
      input.name.trim(),
      input.color,
      input.timezone ?? null,
      input.isWritable ?? true,
      (max?.v ?? 0) + 1,
      ctx.now,
      ctx.now,
    ],
  );
  ctx.changes.table('calendars');
  return id;
}

export async function updateCalendar(
  ctx: Ctx,
  id: string,
  patch: { name?: string; color?: string; isVisible?: boolean; countsForAvailability?: boolean },
): Promise<void> {
  const cols: [string, SqlParam][] = [];
  if (patch.name !== undefined) cols.push(['name', patch.name.trim()]);
  if (patch.color !== undefined) cols.push(['color', patch.color]);
  if (patch.isVisible !== undefined) cols.push(['is_visible', patch.isVisible]);
  if (patch.countsForAvailability !== undefined)
    cols.push(['counts_for_availability', patch.countsForAvailability]);
  if (!cols.length) return;
  await ctx.tx.run(
    `UPDATE calendars SET ${cols.map(([c]) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...cols.map(([, v]) => v), ctx.now, id],
  );
  ctx.changes.table('calendars');
}

export async function deleteCalendar(ctx: Ctx, id: string): Promise<void> {
  await ctx.tx.run('DELETE FROM calendars WHERE id = ?', [id]);
  ctx.changes.table('calendars', 'events');
}

export interface EventInput {
  calendarId: string;
  title: string;
  description?: string;
  location?: string;
  url?: string | null;
  allDay: boolean;
  startUtc?: ISOInstant | null;
  endUtc?: ISOInstant | null;
  startDate?: ISODate | null;
  endDate?: ISODate | null;
  tz?: string | null;
  rrule?: string | null;
  exdates?: string[];
  /** Omitted on update: keep the stored ones. */
  rdates?: string[];
  status?: 'confirmed' | 'tentative' | 'cancelled';
  busy?: boolean;
  uid?: string | null;
  recurrenceId?: string | null;
}

function validateEvent(e: EventInput) {
  if (!e.title.trim()) throw new Error('An event needs a title');
  if (e.allDay) {
    if (!e.startDate || !e.endDate || e.endDate <= e.startDate)
      throw new Error('All-day events need a start and a later end date');
  } else if (!e.startUtc || !e.endUtc || Date.parse(e.endUtc) < Date.parse(e.startUtc)) {
    throw new Error('Events need a start and an end after it');
  }
}

export async function createEvent(ctx: Ctx, e: EventInput): Promise<string> {
  validateEvent(e);
  const id = newId();
  await ctx.tx.run(
    `INSERT INTO calendar_events (id, calendar_id, uid, recurrence_id, title, description, location, url, all_day,
       start_utc, end_utc, start_date, end_date, tz, rrule, exdates, rdates, status, busy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      e.calendarId,
      e.uid ?? `${id}@keel.local`,
      e.recurrenceId ?? null,
      e.title.trim(),
      e.description ?? '',
      e.location ?? '',
      e.url ?? null,
      e.allDay,
      e.allDay ? null : e.startUtc!,
      e.allDay ? null : e.endUtc!,
      e.allDay ? e.startDate! : null,
      e.allDay ? e.endDate! : null,
      e.tz ?? ctx.zone,
      e.rrule ?? null,
      JSON.stringify(e.exdates ?? []),
      JSON.stringify(e.rdates ?? []),
      e.status ?? 'confirmed',
      e.busy ?? true,
      ctx.now,
      ctx.now,
    ],
  );
  ctx.changes.table('events');
  return id;
}

export async function updateEvent(ctx: Ctx, id: string, e: EventInput): Promise<void> {
  validateEvent(e);
  await ctx.tx.run(
    `UPDATE calendar_events SET calendar_id = ?, title = ?, description = ?, location = ?, url = ?, all_day = ?,
       start_utc = ?, end_utc = ?, start_date = ?, end_date = ?, tz = ?, rrule = ?, exdates = ?,
       rdates = coalesce(?, rdates), status = ?, busy = ?,
       uid = coalesce(?, uid), recurrence_id = coalesce(?, recurrence_id), updated_at = ? WHERE id = ?`,
    [
      e.calendarId,
      e.title.trim(),
      e.description ?? '',
      e.location ?? '',
      e.url ?? null,
      e.allDay,
      e.allDay ? null : e.startUtc!,
      e.allDay ? null : e.endUtc!,
      e.allDay ? e.startDate! : null,
      e.allDay ? e.endDate! : null,
      e.tz ?? ctx.zone,
      e.rrule ?? null,
      JSON.stringify(e.exdates ?? []),
      e.rdates ? JSON.stringify(e.rdates) : null,
      e.status ?? 'confirmed',
      e.busy ?? true,
      e.uid ?? null,
      e.recurrenceId ?? null,
      ctx.now,
      id,
    ],
  );
  ctx.changes.table('events');
}

export async function deleteEvent(ctx: Ctx, id: string): Promise<void> {
  await ctx.tx.run('DELETE FROM calendar_events WHERE id = ?', [id]);
  ctx.changes.table('events');
}

/** Excludes one occurrence of a recurring event (ISO instant for timed, date for all-day). */
export async function excludeOccurrence(ctx: Ctx, id: string, key: string): Promise<void> {
  const row = await ctx.tx.get<{ exdates: string }>(
    'SELECT exdates FROM calendar_events WHERE id = ?',
    [id],
  );
  if (!row) return;
  const list = parseJson<string[]>(row.exdates, []);
  if (!list.includes(key)) list.push(key);
  await ctx.tx.run('UPDATE calendar_events SET exdates = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(list),
    ctx.now,
    id,
  ]);
  ctx.changes.table('events');
}

/**
 * Inserts or updates events in a calendar keyed by (uid, recurrence-id), so importing the
 * same file twice does not duplicate anything. With `removeMissing`, events in the calendar
 * that are not in `events` are deleted (used for read-only subscriptions).
 */
export async function upsertEvents(
  ctx: Ctx,
  calendarId: string,
  events: Omit<EventInput, 'calendarId'>[],
  options: { removeMissing?: boolean } = {},
): Promise<{ created: number; updated: number; removed: number }> {
  let created = 0;
  let updated = 0;
  const seen = new Set<string>();
  for (const e of events) {
    const input = { ...e, calendarId };
    if (e.uid) {
      const existing = await ctx.tx.get<{ id: string }>(
        "SELECT id FROM calendar_events WHERE calendar_id = ? AND uid = ? AND ifnull(recurrence_id, '') = ?",
        [calendarId, e.uid, e.recurrenceId ?? ''],
      );
      if (existing) {
        await updateEvent(ctx, existing.id, input);
        seen.add(existing.id);
        updated++;
        continue;
      }
    }
    seen.add(await createEvent(ctx, input));
    created++;
  }
  let removed = 0;
  if (options.removeMissing) {
    const all = await ctx.tx.all<{ id: string }>(
      'SELECT id FROM calendar_events WHERE calendar_id = ?',
      [calendarId],
    );
    for (const row of all) {
      if (!seen.has(row.id)) {
        await ctx.tx.run('DELETE FROM calendar_events WHERE id = ?', [row.id]);
        removed++;
      }
    }
  }
  ctx.changes.table('events');
  return { created, updated, removed };
}
