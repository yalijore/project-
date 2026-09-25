/**
 * Recurring tasks.
 *
 * A series is a template plus an RRULE. Occurrences become real task rows lazily:
 *   - `materializeDue` creates today's occurrence (and at most one missed occurrence) when a
 *     day starts, so a week away does not produce seven copies of a daily task;
 *   - future occurrences are shown as *virtual* cards and materialized on first interaction.
 * `UNIQUE(recurrence_id, recurrence_date)` makes materialization idempotent, and
 * `recurrence_exceptions` remembers skipped/deleted occurrences so they never come back.
 * Completing or editing an instance only touches that task row — never the series.
 */
import type { ISODate } from '@/domain/dates';
import { addDays, addMinutes, parseClock, wallTimeToInstant } from '@/domain/dates';
import {
  endRuleOn,
  nextOccurrence,
  occurrencesBetween,
  previousOccurrence,
} from '@/domain/recurrence';
import type { Priority, RecurrenceSeries } from '@/domain/types';
import { rowToSeries } from './rows';
import type { Ctx } from './repo';
import { createBlock, createTask, newId } from './repo';

export interface SeriesInput {
  rrule: string;
  dtstart: ISODate;
  title: string;
  notes?: string;
  projectId?: string | null;
  areaId?: string | null;
  priority?: Priority;
  estimateMin?: number | null;
  tagIds?: string[];
  subtasks?: string[];
  startTime?: string | null;
  dueOffsetDays?: number | null;
}

export async function getSeries(ctx: Ctx, id: string): Promise<RecurrenceSeries | null> {
  const row = await ctx.tx.get('SELECT * FROM recurrence_series WHERE id = ?', [id]);
  return row ? rowToSeries(row) : null;
}

export async function createSeries(
  ctx: Ctx,
  input: SeriesInput,
  generatedThrough: ISODate | null = null,
): Promise<string> {
  const id = newId();
  if (input.startTime) parseClock(input.startTime);
  await ctx.tx.run(
    `INSERT INTO recurrence_series (id, rrule, dtstart, title, notes, project_id, area_id, priority, estimate_min,
       tag_ids, subtasks, start_time, due_offset_days, generated_through, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.rrule,
      input.dtstart,
      input.title.trim(),
      input.notes ?? '',
      input.projectId ?? null,
      input.areaId ?? null,
      input.priority ?? 0,
      input.estimateMin ?? null,
      JSON.stringify(input.tagIds ?? []),
      JSON.stringify(input.subtasks ?? []),
      input.startTime ?? null,
      input.dueOffsetDays ?? null,
      generatedThrough,
      ctx.now,
      ctx.now,
    ],
  );
  ctx.changes.table('series');
  return id;
}

async function isSkipped(ctx: Ctx, seriesId: string, date: ISODate): Promise<boolean> {
  const row = await ctx.tx.get(
    'SELECT 1 AS x FROM recurrence_exceptions WHERE series_id = ? AND occurrence_date = ?',
    [seriesId, date],
  );
  return !!row;
}

async function existingInstance(ctx: Ctx, seriesId: string, date: ISODate): Promise<string | null> {
  const row = await ctx.tx.get<{ id: string }>(
    'SELECT id FROM tasks WHERE recurrence_id = ? AND recurrence_date = ?',
    [seriesId, date],
  );
  return row?.id ?? null;
}

/**
 * Creates the task row for one occurrence (planned on that date). Idempotent; returns null
 * if the occurrence was skipped/deleted or is not part of the series.
 */
export async function materializeOccurrence(
  ctx: Ctx,
  seriesId: string,
  date: ISODate,
): Promise<string | null> {
  const existing = await existingInstance(ctx, seriesId, date);
  if (existing) return existing;
  const series = await getSeries(ctx, seriesId);
  if (!series || (await isSkipped(ctx, seriesId, date))) return null;
  const valid = occurrencesBetween(series.rrule, series.dtstart, date, date);
  if (valid.length === 0) return null;
  const id = await createTask(ctx, {
    title: series.title,
    notes: series.notes,
    projectId: series.projectId,
    areaId: series.areaId,
    priority: series.priority,
    estimateMin: series.estimateMin,
    dueDate: series.dueOffsetDays != null ? addDays(date, series.dueOffsetDays) : null,
    planDate: date,
    tagIds: series.tagIds,
    subtasks: series.subtasks,
    recurrenceId: series.id,
    recurrenceDate: date,
  });
  if (series.startTime) {
    const start = wallTimeToInstant(date, parseClock(series.startTime), ctx.zone);
    await createBlock(ctx, id, start, addMinutes(start, series.estimateMin ?? 30));
  }
  return id;
}

/**
 * Brings every active series up to `today`: creates today's occurrence and, if occurrences
 * were missed while Keel was closed, only the most recent missed one (which rollover then
 * carries forward or marks skipped). Returns the created task ids.
 */
export async function materializeDue(ctx: Ctx, today: ISODate): Promise<string[]> {
  const rows = await ctx.tx.all('SELECT * FROM recurrence_series WHERE ended_at IS NULL');
  const created: string[] = [];
  for (const row of rows) {
    const s = rowToSeries(row);
    const from = s.generatedThrough ? addDays(s.generatedThrough, 1) : s.dtstart;
    if (from > today) continue;
    const dates: ISODate[] = [];
    const todays = occurrencesBetween(s.rrule, s.dtstart, today, today);
    if (from < today) {
      const lastMissed = previousOccurrence(s.rrule, s.dtstart, addDays(today, -1));
      if (lastMissed && lastMissed >= from) dates.push(lastMissed);
    }
    dates.push(...todays);
    for (const d of dates) {
      const before = await existingInstance(ctx, s.id, d);
      const id = await materializeOccurrence(ctx, s.id, d);
      if (id && !before) created.push(id);
    }
    await ctx.tx.run('UPDATE recurrence_series SET generated_through = ? WHERE id = ?', [
      today,
      s.id,
    ]);
    ctx.changes.table('series');
  }
  return created;
}

export interface SeriesPatch {
  title?: string;
  notes?: string;
  projectId?: string | null;
  areaId?: string | null;
  priority?: Priority;
  estimateMin?: number | null;
  tagIds?: string[];
  subtasks?: string[];
  startTime?: string | null;
  dueOffsetDays?: number | null;
  rrule?: string;
  dtstart?: ISODate;
}

const TEMPLATE_FIELDS: [keyof SeriesPatch, string, string][] = [
  ['title', 'title', 'title'],
  ['notes', 'notes', 'notes'],
  ['projectId', 'project_id', 'project_id'],
  ['areaId', 'area_id', 'area_id'],
  ['priority', 'priority', 'priority'],
  ['estimateMin', 'estimate_min', 'estimate_min'],
];

/**
 * Edits the series template. Open instances from today on inherit a changed field only if
 * they still have the old template value — individual edits to an instance are preserved.
 * Changing the rule removes open, not-yet-started future instances that no longer match.
 */
export async function updateSeries(ctx: Ctx, id: string, patch: SeriesPatch): Promise<void> {
  const old = await getSeries(ctx, id);
  if (!old) throw new Error('Recurring series not found');
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const oldRow = (await ctx.tx.get('SELECT * FROM recurrence_series WHERE id = ?', [id]))!;
  for (const [key, seriesCol, taskCol] of TEMPLATE_FIELDS) {
    if (patch[key] === undefined) continue;
    const value = patch[key] as string | number | null;
    sets.push(`${seriesCol} = ?`);
    params.push(key === 'title' ? String(value).trim() : value);
    await ctx.tx.run(
      `UPDATE tasks SET ${taskCol} = ?, updated_at = ?
       WHERE recurrence_id = ? AND recurrence_date >= ? AND completed_at IS NULL AND ${taskCol} IS ?`,
      [
        key === 'title' ? String(value).trim() : value,
        ctx.now,
        id,
        ctx.today,
        oldRow[seriesCol] ?? null,
      ],
    );
  }
  if (patch.tagIds !== undefined) {
    sets.push('tag_ids = ?');
    params.push(JSON.stringify(patch.tagIds));
  }
  if (patch.subtasks !== undefined) {
    sets.push('subtasks = ?');
    params.push(JSON.stringify(patch.subtasks));
  }
  if (patch.startTime !== undefined) {
    if (patch.startTime) parseClock(patch.startTime);
    sets.push('start_time = ?');
    params.push(patch.startTime);
  }
  if (patch.dueOffsetDays !== undefined) {
    sets.push('due_offset_days = ?');
    params.push(patch.dueOffsetDays);
  }
  const ruleChanged =
    (patch.rrule !== undefined && patch.rrule !== old.rrule) ||
    (patch.dtstart !== undefined && patch.dtstart !== old.dtstart);
  if (patch.rrule !== undefined) {
    sets.push('rrule = ?');
    params.push(patch.rrule);
  }
  if (patch.dtstart !== undefined) {
    sets.push('dtstart = ?');
    params.push(patch.dtstart);
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    params.push(ctx.now);
    await ctx.tx.run(`UPDATE recurrence_series SET ${sets.join(', ')} WHERE id = ?`, [
      ...params,
      id,
    ]);
  }
  if (ruleChanged) {
    const rule = patch.rrule ?? old.rrule;
    const start = patch.dtstart ?? old.dtstart;
    const future = await ctx.tx.all<{ id: string; recurrence_date: string }>(
      `SELECT t.id, t.recurrence_date FROM tasks t
       WHERE t.recurrence_id = ? AND t.recurrence_date > ? AND t.completed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM time_sessions s WHERE s.task_id = t.id)`,
      [id, ctx.today],
    );
    for (const f of future) {
      if (occurrencesBetween(rule, start, f.recurrence_date, f.recurrence_date).length === 0) {
        await ctx.tx.run('DELETE FROM tasks WHERE id = ?', [f.id]);
        ctx.changes.task(f.id);
      }
    }
  }
  const touched = await ctx.tx.all<{ id: string }>('SELECT id FROM tasks WHERE recurrence_id = ?', [
    id,
  ]);
  ctx.changes.task(...touched.map((t) => t.id));
  ctx.changes.table('series');
}

/** Stops the series after `lastDate`; open instances after it are removed. */
export async function endSeries(ctx: Ctx, id: string, lastDate: ISODate): Promise<void> {
  const s = await getSeries(ctx, id);
  if (!s) return;
  await ctx.tx.run(
    'UPDATE recurrence_series SET rrule = ?, ended_at = ?, updated_at = ? WHERE id = ?',
    [endRuleOn(s.rrule, lastDate), ctx.now, ctx.now, id],
  );
  const future = await ctx.tx.all<{ id: string }>(
    'SELECT id FROM tasks WHERE recurrence_id = ? AND recurrence_date > ? AND completed_at IS NULL',
    [id, lastDate],
  );
  for (const f of future) await ctx.tx.run('DELETE FROM tasks WHERE id = ?', [f.id]);
  ctx.changes.task(...future.map((f) => f.id));
  ctx.changes.table('series');
}

/** Skips a single occurrence (virtual or materialized-but-open). */
export async function skipOccurrence(ctx: Ctx, seriesId: string, date: ISODate): Promise<void> {
  await ctx.tx.run(
    "INSERT OR IGNORE INTO recurrence_exceptions (series_id, occurrence_date, kind, created_at) VALUES (?, ?, 'skip', ?)",
    [seriesId, date, ctx.now],
  );
  const inst = await ctx.tx.get<{ id: string }>(
    'SELECT id FROM tasks WHERE recurrence_id = ? AND recurrence_date = ? AND completed_at IS NULL',
    [seriesId, date],
  );
  if (inst) {
    await ctx.tx.run('DELETE FROM tasks WHERE id = ?', [inst.id]);
    ctx.changes.task(inst.id);
  }
  ctx.changes.table('series');
}

/** Turns an existing one-off task into the first instance of a new series. */
export async function makeTaskRecurring(
  ctx: Ctx,
  taskId: string,
  rrule: string,
  dtstart: ISODate,
): Promise<string> {
  const t = await ctx.tx.get<Record<string, string | number | null>>(
    'SELECT * FROM tasks WHERE id = ?',
    [taskId],
  );
  if (!t) throw new Error('Task not found');
  if (t.recurrence_id) throw new Error('Task already repeats');
  const tags = await ctx.tx.all<{ tag_id: string }>(
    'SELECT tag_id FROM task_tags WHERE task_id = ?',
    [taskId],
  );
  const subtasks = await ctx.tx.all<{ title: string }>(
    'SELECT title FROM subtasks WHERE task_id = ? ORDER BY sort_order',
    [taskId],
  );
  const first = nextOccurrence(rrule, dtstart, dtstart) ?? dtstart;
  const seriesId = await createSeries(
    ctx,
    {
      rrule,
      dtstart,
      title: String(t.title),
      notes: String(t.notes ?? ''),
      projectId: (t.project_id as string) ?? null,
      areaId: (t.area_id as string) ?? null,
      priority: Number(t.priority) as Priority,
      estimateMin: t.estimate_min == null ? null : Number(t.estimate_min),
      tagIds: tags.map((x) => x.tag_id),
      subtasks: subtasks.map((x) => x.title),
    },
    first,
  );
  await ctx.tx.run(
    'UPDATE tasks SET recurrence_id = ?, recurrence_date = ?, updated_at = ? WHERE id = ?',
    [seriesId, first, ctx.now, taskId],
  );
  ctx.changes.task(taskId);
  return seriesId;
}

export async function loadExceptions(ctx: Pick<Ctx, 'tx'>): Promise<Map<string, Set<string>>> {
  const rows = await ctx.tx.all<{ series_id: string; occurrence_date: string }>(
    'SELECT series_id, occurrence_date FROM recurrence_exceptions',
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!out.has(r.series_id)) out.set(r.series_id, new Set());
    out.get(r.series_id)!.add(r.occurrence_date);
  }
  return out;
}
