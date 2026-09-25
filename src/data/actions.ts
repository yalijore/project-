/**
 * User-facing actions. Each one:
 *   1. optionally patches the in-memory store (optimistic UI for drag & drop, checkboxes),
 *   2. commits to SQLite in one transaction — as a labelled undo step when it changes data,
 *   3. refreshes exactly the entities the repository reported as touched.
 * On failure the touched entities are reloaded from the database, discarding the optimistic
 * patch, and the error is shown.
 */
import { toast } from 'sonner';
import type { Executor } from '@/db/driver';
import { peekUndo, undoLast, undoable } from '@/db/undo';
import type { ISODate, ISOInstant } from '@/domain/dates';
import { addMinutes, diffDays, formatClock, wallTimeToInstant } from '@/domain/dates';
import { nextOccurrence, presetRule } from '@/domain/recurrence';
import type { CaptureResult } from '@/domain/quickCapture';
import type { Priority, RitualKind, Settings, Task } from '@/domain/types';
import { PALETTE } from '@/domain/types';
import type { Ctx, EventInput, GapDecision, NewTask, Position, TableKey, TaskPatch } from './repo';
import * as recurrence from './recurrenceRepo';
import type { SeriesInput, SeriesPatch } from './recurrenceRepo';
import * as repo from './repo';
import { getDb } from './runtime';
import {
  applySnapshot,
  applyTasks,
  byId,
  getData,
  patchTasks,
  setSettingsState,
  useData,
} from './store';

function context(tx: Executor, changes: repo.ChangeSet): Ctx {
  const { zone, today } = getData();
  return { tx, now: new Date().toISOString(), today, zone, changes };
}

async function refreshTables(keys: Set<TableKey>) {
  const db = getDb();
  const patch: Partial<ReturnType<typeof getData>> = {};
  if (keys.has('areas')) patch.areas = byId(await repo.loadAreas(db));
  if (keys.has('projects')) patch.projects = byId(await repo.loadProjects(db));
  if (keys.has('tags')) patch.tags = byId(await repo.loadTags(db));
  if (keys.has('series')) patch.series = byId(await repo.loadSeries(db));
  if (keys.has('calendars')) patch.calendars = byId(await repo.loadCalendars(db));
  if (keys.has('events')) patch.events = byId(await repo.loadEvents(db));
  if (keys.has('rituals')) patch.rituals = byId(await repo.loadRituals(db));
  useData.setState(patch);
  if (keys.has('settings')) setSettingsState(await repo.loadSettings(db));
}

export async function refreshAll() {
  applySnapshot(await repo.loadSnapshot(getDb()));
  await refreshUndo();
}

async function refresh(changes: repo.ChangeSet) {
  if (changes.all) return refreshAll();
  const db = getDb();
  if (changes.tasks.size) {
    const ids = [...changes.tasks];
    applyTasks(
      ids,
      await repo.loadTasks(db, ids),
      await repo.loadBlocks(db, ids),
      await repo.loadSessions(db, ids),
    );
  }
  if (changes.tables.size) await refreshTables(changes.tables);
}

async function refreshUndo() {
  useData.setState({ undo: await peekUndo(getDb()) });
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Something went wrong';
}

interface PerformOptions {
  /** Undo label; null makes the change non-undoable (settings, reflections, heartbeats). */
  label: string | null;
  optimistic?: () => void;
  quiet?: boolean;
}

export async function perform<T>(opts: PerformOptions, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const db = getDb();
  const changes = new repo.ChangeSet();
  opts.optimistic?.();
  try {
    const result = opts.label
      ? await undoable(db, opts.label, (tx) => fn(context(tx, changes)))
      : await db.transaction((tx) => fn(context(tx, changes)));
    await refresh(changes);
    if (opts.label) await refreshUndo();
    return result;
  } catch (e) {
    // Discard optimistic state: reload what we know was touched, or everything.
    if (opts.optimistic) await refreshAll();
    else if (!changes.empty) await refresh(changes);
    if (!opts.quiet) toast.error(errorMessage(e));
    throw e;
  }
}

/** Fire-and-forget wrapper for UI handlers; errors are already shown as toasts. */
export function run(p: Promise<unknown>): void {
  p.catch(() => undefined);
}

// ---------------------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------------------

export async function undo(): Promise<void> {
  const db = getDb();
  try {
    const step = await undoLast(db);
    await refreshAll();
    if (step) toast(`Undid “${step.label}”`);
    else toast('Nothing to undo');
  } catch (e) {
    // The data changed underneath this step (e.g. a background rollover). Drop it.
    const step = await peekUndo(db);
    if (step) {
      await db.transaction(async (tx) => {
        await tx.run('DELETE FROM undo_log WHERE group_id = ?', [step.id]);
        await tx.run('DELETE FROM undo_groups WHERE id = ?', [step.id]);
      });
    }
    await refreshAll();
    toast.error(
      `Couldn't undo “${step?.label ?? 'last change'}” — the data has changed since. ${errorMessage(e)}`,
    );
  }
}

/** Background changes (rollover, sync) can invalidate older undo steps; clear them. */
export async function clearUndoHistory(tx: Executor) {
  await tx.run('DELETE FROM undo_log');
  await tx.run('DELETE FROM undo_groups');
}

function undoToast(message: string) {
  toast(message, { action: { label: 'Undo', onClick: () => void undo() } });
}

// ---------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------

export async function addTask(input: NewTask): Promise<string> {
  return perform({ label: 'Add task' }, (ctx) => repo.createTask(ctx, input));
}

function nextColor(used: number): string {
  return PALETTE[used % PALETTE.length]!;
}

/** Creates a task from a quick-capture parse result, including new tags, repeats and a timebox. */
export async function captureTask(
  parsed: CaptureResult,
  defaults: { planDate?: ISODate | null; projectId?: string | null; areaId?: string | null } = {},
): Promise<string> {
  const { settings, zone } = getData();
  return perform({ label: 'Add task' }, async (ctx) => {
    const tagIds = [...parsed.tagIds];
    let n = Object.keys(getData().tags).length;
    for (const name of parsed.newTags) tagIds.push(await repo.createTag(ctx, name, nextColor(n++)));
    let planDate = parsed.planDate === undefined ? (defaults.planDate ?? null) : parsed.planDate;
    if (parsed.startMin !== null && !planDate) planDate = ctx.today;
    const projectId = parsed.projectId ?? defaults.projectId ?? null;
    const areaId = parsed.areaId ?? defaults.areaId ?? null;

    if (parsed.repeat) {
      const anchor = planDate ?? ctx.today;
      const rrule =
        typeof parsed.repeat === 'string' ? presetRule(parsed.repeat, anchor) : parsed.repeat.rrule;
      const first = nextOccurrence(rrule, anchor, anchor) ?? anchor;
      const seriesId = await recurrence.createSeries(ctx, {
        rrule,
        dtstart: first,
        title: parsed.title,
        projectId,
        areaId,
        priority: parsed.priority ?? 0,
        estimateMin: parsed.estimateMin,
        tagIds,
        startTime: parsed.startMin !== null ? formatClock(parsed.startMin) : null,
        dueOffsetDays: parsed.dueDate ? diffDays(first, parsed.dueDate) : null,
      });
      const id = await recurrence.materializeOccurrence(ctx, seriesId, first);
      if (!id) throw new Error('Could not create the first occurrence');
      return id;
    }

    const id = await repo.createTask(ctx, {
      title: parsed.title,
      planDate,
      planPosition: 'bottom',
      estimateMin: parsed.estimateMin,
      priority: parsed.priority ?? 0,
      dueDate: parsed.dueDate,
      projectId,
      areaId,
      tagIds,
    });
    if (parsed.startMin !== null && planDate) {
      const start = wallTimeToInstant(planDate, parsed.startMin, zone);
      await repo.createBlock(
        ctx,
        id,
        start,
        addMinutes(start, parsed.estimateMin ?? settings.defaultEstimateMin),
      );
    }
    return id;
  });
}

export async function updateTask(id: string, patch: TaskPatch, label = 'Edit task'): Promise<void> {
  await perform({ label, optimistic: () => patchTasks({ [id]: patch as Partial<Task> }) }, (ctx) =>
    repo.updateTasks(ctx, [id], patch),
  );
}

export async function bulkUpdate(
  ids: string[],
  patch: TaskPatch,
  label = 'Edit tasks',
): Promise<void> {
  await perform({ label }, (ctx) => repo.updateTasks(ctx, ids, patch));
  undoToast(`${label} (${ids.length})`);
}

export async function deleteTasks(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const title = ids.length === 1 ? getData().tasks[ids[0]!]?.title : `${ids.length} tasks`;
  await perform({ label: ids.length === 1 ? 'Delete task' : 'Delete tasks' }, (ctx) =>
    repo.deleteTasks(ctx, ids),
  );
  undoToast(`Deleted ${title ? `“${title}”` : 'task'}`);
}

export async function setComplete(id: string, done: boolean): Promise<void> {
  const { today } = getData();
  await perform(
    {
      label: done ? 'Complete task' : 'Reopen task',
      optimistic: () =>
        patchTasks({
          [id]: done
            ? {
                completedAt: new Date().toISOString(),
                planDate: getData().tasks[id]?.planDate ?? today,
              }
            : { completedAt: null },
        }),
    },
    (ctx) => (done ? repo.completeTask(ctx, id) : repo.reopenTask(ctx, id)),
  );
}

export async function bulkComplete(ids: string[], done: boolean): Promise<void> {
  await perform({ label: done ? 'Complete tasks' : 'Reopen tasks' }, async (ctx) => {
    for (const id of ids) await (done ? repo.completeTask(ctx, id) : repo.reopenTask(ctx, id));
  });
  undoToast(`${done ? 'Completed' : 'Reopened'} ${ids.length} task${ids.length === 1 ? '' : 's'}`);
}

/**
 * Plans a task for a day (null = backlog) at a position. The board applies its own local
 * ordering while dragging; here we patch plan fields optimistically.
 */
export async function moveTask(
  id: string,
  date: ISODate | null,
  position: Position = 'bottom',
): Promise<void> {
  await perform(
    {
      label: date ? 'Move task' : 'Move to backlog',
      optimistic: () => patchTasks({ [id]: { planDate: date } }),
    },
    (ctx) => (date ? repo.planTask(ctx, id, date, position) : repo.unplanTask(ctx, id)),
  );
}

export async function moveTasks(ids: string[], date: ISODate | null): Promise<void> {
  await perform({ label: date ? 'Move tasks' : 'Move to backlog' }, async (ctx) => {
    for (const id of ids)
      await (date ? repo.planTask(ctx, id, date, 'bottom') : repo.unplanTask(ctx, id));
  });
}

export async function reorderDay(date: ISODate, orderedIds: string[]): Promise<void> {
  const patches: Record<string, Partial<Task>> = {};
  orderedIds.forEach((id, i) => (patches[id] = { planOrder: i + 1, planDate: date }));
  await perform({ label: 'Reorder', optimistic: () => patchTasks(patches) }, (ctx) =>
    repo.reorderDay(ctx, date, orderedIds),
  );
}

export async function reorderBacklog(id: string, before?: string, after?: string): Promise<void> {
  await perform({ label: 'Reorder' }, (ctx) => repo.reorderBacklog(ctx, id, before, after));
}

export async function rollover(
  target: ISODate,
  taskIds?: string[],
  label: string | null = 'Carry tasks forward',
) {
  return perform({ label }, (ctx) => repo.rolloverTasks(ctx, target, taskIds));
}

export async function setPriority(id: string, priority: Priority) {
  await updateTask(id, { priority }, 'Change priority');
}

// Subtasks & links
export const addSubtask = (taskId: string, title: string) =>
  perform({ label: 'Add subtask' }, (ctx) => repo.addSubtask(ctx, taskId, title));
export const updateSubtask = (
  id: string,
  patch: { title?: string; done?: boolean; sortOrder?: number },
) => perform({ label: 'Edit subtask' }, (ctx) => repo.updateSubtask(ctx, id, patch));
export const deleteSubtask = (id: string) =>
  perform({ label: 'Delete subtask' }, (ctx) => repo.deleteSubtask(ctx, id));
export const addLink = (taskId: string, url: string, title?: string) =>
  perform({ label: 'Add link' }, (ctx) => repo.addLink(ctx, taskId, url, title));
export const deleteLink = (id: string) =>
  perform({ label: 'Remove link' }, (ctx) => repo.deleteLink(ctx, id));
export const setTaskTags = (taskId: string, tagIds: string[]) =>
  perform({ label: 'Change tags' }, (ctx) => repo.setTaskTags(ctx, taskId, tagIds));
export const tagTasks = (taskIds: string[], tagId: string, add: boolean) =>
  perform({ label: add ? 'Add tag' : 'Remove tag' }, (ctx) =>
    repo.addTagToTasks(ctx, taskIds, tagId, add),
  );

// ---------------------------------------------------------------------------------------
// Timeboxing
// ---------------------------------------------------------------------------------------

export const scheduleTask = (taskId: string, start: ISOInstant, end: ISOInstant) =>
  perform({ label: 'Timebox task' }, (ctx) => repo.createBlock(ctx, taskId, start, end));

export const moveBlock = (blockId: string, start: ISOInstant, end: ISOInstant) =>
  perform(
    {
      label: 'Move time block',
      optimistic: () =>
        useData.setState((s) => {
          const b = s.blocks[blockId];
          return b
            ? { blocks: { ...s.blocks, [blockId]: { ...b, startUtc: start, endUtc: end } } }
            : {};
        }),
    },
    (ctx) => repo.updateBlock(ctx, blockId, start, end),
  );

export const deleteBlock = (blockId: string) =>
  perform({ label: 'Remove time block' }, (ctx) => repo.deleteBlock(ctx, blockId));

// ---------------------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------------------

export const startTimer = (taskId: string) =>
  perform({ label: 'Start timer' }, (ctx) => repo.startTimer(ctx, taskId));
export const stopTimer = () => perform({ label: 'Stop timer' }, (ctx) => repo.stopTimer(ctx));
export const resolveGap = (decision: GapDecision, gapStart: ISOInstant) =>
  perform({ label: decision === 'keep' ? null : 'Discard idle time' }, (ctx) =>
    repo.resolveGap(ctx, decision, gapStart),
  );
export const addManualTime = (taskId: string, minutes: number) =>
  perform({ label: 'Add tracked time' }, (ctx) => repo.addManualTime(ctx, taskId, minutes));
export const updateSession = (id: string, start: ISOInstant, end: ISOInstant | null) =>
  perform({ label: 'Edit tracked time' }, (ctx) => repo.updateSession(ctx, id, start, end));
export const deleteSession = (id: string) =>
  perform({ label: 'Delete tracked time' }, (ctx) => repo.deleteSession(ctx, id));

export async function heartbeat(): Promise<void> {
  const db = getDb();
  await db.transaction((tx) => repo.heartbeat(context(tx, new repo.ChangeSet())));
}

// ---------------------------------------------------------------------------------------
// Areas, projects, tags
// ---------------------------------------------------------------------------------------

export const createArea = (name: string, color?: string) =>
  perform({ label: 'Add area' }, (ctx) =>
    repo.createArea(ctx, name, color ?? nextColor(Object.keys(getData().areas).length)),
  );
export const updateArea = (
  id: string,
  patch: { name?: string; color?: string; archived?: boolean },
) => perform({ label: 'Edit area' }, (ctx) => repo.updateArea(ctx, id, patch));
export const deleteArea = (id: string) =>
  perform({ label: 'Delete area' }, (ctx) => repo.deleteArea(ctx, id));
export const createProject = (input: { name: string; color?: string; areaId?: string | null }) =>
  perform({ label: 'Add project' }, (ctx) =>
    repo.createProject(ctx, {
      ...input,
      color: input.color ?? nextColor(Object.keys(getData().projects).length + 2),
    }),
  );
export const updateProject = (
  id: string,
  patch: {
    name?: string;
    color?: string;
    notes?: string;
    areaId?: string | null;
    archived?: boolean;
  },
) => perform({ label: 'Edit project' }, (ctx) => repo.updateProject(ctx, id, patch));
export const deleteProject = (id: string) =>
  perform({ label: 'Delete project' }, (ctx) => repo.deleteProject(ctx, id));
export const createTag = (name: string, color?: string) =>
  perform({ label: 'Add tag' }, (ctx) =>
    repo.createTag(ctx, name, color ?? nextColor(Object.keys(getData().tags).length + 4)),
  );
export const updateTag = (id: string, patch: { name?: string; color?: string }) =>
  perform({ label: 'Edit tag' }, (ctx) => repo.updateTag(ctx, id, patch));
export const deleteTag = (id: string) =>
  perform({ label: 'Delete tag' }, (ctx) => repo.deleteTag(ctx, id));

// ---------------------------------------------------------------------------------------
// Rituals & settings (not undoable: reflections are saved as you type)
// ---------------------------------------------------------------------------------------

export const saveRitual = (
  kind: RitualKind,
  period: ISODate,
  patch: { reflection?: string; data?: Record<string, unknown>; completed?: boolean },
) => perform({ label: null, quiet: true }, (ctx) => repo.saveRitual(ctx, kind, period, patch));

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const next = { ...getData().settings, ...patch };
  setSettingsState(next);
  await perform({ label: null }, (ctx) => repo.saveSettings(ctx, patch));
}

// ---------------------------------------------------------------------------------------
// Calendars & events
// ---------------------------------------------------------------------------------------

export const createCalendar = (name: string, color: string) =>
  perform({ label: 'Add calendar' }, (ctx) => repo.createCalendar(ctx, { name, color }));
export const updateCalendar = (
  id: string,
  patch: { name?: string; color?: string; isVisible?: boolean; countsForAvailability?: boolean },
) => perform({ label: 'Edit calendar' }, (ctx) => repo.updateCalendar(ctx, id, patch));
export const deleteCalendar = (id: string) =>
  perform({ label: 'Delete calendar' }, (ctx) => repo.deleteCalendar(ctx, id));
export const createEvent = (input: EventInput) =>
  perform({ label: 'Add event' }, (ctx) => repo.createEvent(ctx, input));
export const updateEvent = (id: string, input: EventInput) =>
  perform({ label: 'Edit event' }, (ctx) => repo.updateEvent(ctx, id, input));
export const deleteEvent = (id: string) =>
  perform({ label: 'Delete event' }, (ctx) => repo.deleteEvent(ctx, id));
export const excludeOccurrence = (id: string, key: string) =>
  perform({ label: 'Delete occurrence' }, (ctx) => repo.excludeOccurrence(ctx, id, key));

// ---------------------------------------------------------------------------------------
// Recurring tasks
// ---------------------------------------------------------------------------------------

export const createRecurringTask = (input: SeriesInput) =>
  perform({ label: 'Add repeating task' }, async (ctx) => {
    const first = nextOccurrence(input.rrule, input.dtstart, input.dtstart);
    if (!first) throw new Error('This repeat rule never occurs');
    const seriesId = await recurrence.createSeries(ctx, { ...input, dtstart: first });
    await recurrence.materializeOccurrence(ctx, seriesId, first);
    return seriesId;
  });

export const makeTaskRecurring = (taskId: string, rrule: string, dtstart: ISODate) =>
  perform({ label: 'Make task repeat' }, (ctx) =>
    recurrence.makeTaskRecurring(ctx, taskId, rrule, dtstart),
  );

export const updateSeries = (id: string, patch: SeriesPatch) =>
  perform({ label: 'Edit repeating task' }, (ctx) => recurrence.updateSeries(ctx, id, patch));

export const endSeries = (id: string, lastDate: ISODate) =>
  perform({ label: 'Stop repeating' }, (ctx) => recurrence.endSeries(ctx, id, lastDate));

export const skipOccurrence = (seriesId: string, date: ISODate) =>
  perform({ label: 'Skip occurrence' }, (ctx) => recurrence.skipOccurrence(ctx, seriesId, date));

/** Turns a virtual future occurrence into a real task so it can be edited, moved or timed. */
export const materializeOccurrence = (seriesId: string, date: ISODate) =>
  perform({ label: null }, async (ctx) => {
    const id = await recurrence.materializeOccurrence(ctx, seriesId, date);
    if (!id) throw new Error('That occurrence no longer exists');
    return id;
  });

/** Moves a task within/between backlog groups: optional project/area change plus new order, as one step. */
export const placeInBacklog = (
  taskId: string,
  patch: TaskPatch | null,
  before?: string,
  after?: string,
) =>
  perform({ label: patch ? 'Move task' : 'Reorder' }, async (ctx) => {
    if (patch) await repo.updateTasks(ctx, [taskId], patch);
    await repo.reorderBacklog(ctx, taskId, before, after);
  });
