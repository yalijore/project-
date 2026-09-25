/**
 * Local review statistics: planned vs actual per day, where time went, estimate accuracy.
 * Descriptive only — Keel deliberately computes no "productivity score".
 */
import type { ISODate } from './dates';
import { dateOfInstant, dateRange, dayBounds } from './dates';
import type { Interval } from './scheduling';
import { clip, totalMinutes } from './scheduling';
import { trackedOnDay } from './timeAccounting';
import type { Task, TimeSession } from './types';

export interface PlanEntryRow {
  planDate: ISODate;
  status: 'active' | 'done' | 'rolled_over' | 'moved' | 'removed';
  taskId: string;
}

export interface DayStat {
  date: ISODate;
  /** Tasks that were on this day's plan and stayed there (done, still open, or carried forward). */
  plannedCount: number;
  completedCount: number;
  rolledOverCount: number;
  /** Sum of estimates of the tasks planned this day. */
  plannedMin: number;
  trackedMin: number;
  meetingMin: number;
}

export interface CategoryTime {
  key: string;
  label: string;
  color: string | null;
  minutes: number;
}

export interface RangeStats {
  days: DayStat[];
  totals: {
    plannedCount: number;
    completedCount: number;
    rolledOverCount: number;
    plannedMin: number;
    trackedMin: number;
    meetingMin: number;
  };
  byCategory: CategoryTime[];
  /** Tracked ÷ estimated for tasks completed in range that had both. */
  estimateAccuracy: { estimatedMin: number; trackedMin: number; taskCount: number } | null;
}

export interface StatsInput {
  from: ISODate;
  to: ISODate;
  zone: string;
  now: number;
  entries: PlanEntryRow[];
  tasks: Record<string, Pick<Task, 'id' | 'estimateMin' | 'completedAt' | 'projectId' | 'areaId'>>;
  sessions: TimeSession[];
  /** Busy meeting intervals overlapping the range. */
  meetings: Interval[];
  categories: {
    projects: Record<string, { name: string; color: string }>;
    areas: Record<string, { name: string; color: string }>;
  };
}

export function computeRangeStats(input: StatsInput): RangeStats {
  const dates = dateRange(input.from, input.to);
  const days: DayStat[] = dates.map((date) => {
    const entries = input.entries.filter(
      (e) =>
        e.planDate === date &&
        (e.status === 'active' || e.status === 'done' || e.status === 'rolled_over'),
    );
    const ids = new Set(entries.map((e) => e.taskId));
    const tracked = trackedOnDay(input.sessions, date, input.zone, input.now);
    const bounds = dayBounds(date, input.zone);
    const day = { start: Date.parse(bounds.start), end: Date.parse(bounds.end) };
    return {
      date,
      plannedCount: ids.size,
      completedCount: entries.filter((e) => e.status === 'done').length,
      rolledOverCount: entries.filter((e) => e.status === 'rolled_over').length,
      plannedMin: [...ids].reduce((sum, id) => sum + (input.tasks[id]?.estimateMin ?? 0), 0),
      trackedMin: [...tracked.values()].reduce((a, b) => a + b, 0),
      meetingMin: totalMinutes(
        input.meetings.map((m) => clip(m, day)).filter(Boolean) as Interval[],
      ),
    };
  });

  const totals = days.reduce(
    (t, d) => ({
      plannedCount: t.plannedCount + d.plannedCount,
      completedCount: t.completedCount + d.completedCount,
      rolledOverCount: t.rolledOverCount + d.rolledOverCount,
      plannedMin: t.plannedMin + d.plannedMin,
      trackedMin: t.trackedMin + d.trackedMin,
      meetingMin: t.meetingMin + d.meetingMin,
    }),
    {
      plannedCount: 0,
      completedCount: 0,
      rolledOverCount: 0,
      plannedMin: 0,
      trackedMin: 0,
      meetingMin: 0,
    },
  );

  // Where time went: tracked minutes in range grouped by project → area → none.
  const rangeStart = Date.parse(dayBounds(input.from, input.zone).start);
  const rangeEnd = Date.parse(dayBounds(input.to, input.zone).end);
  const byKey = new Map<string, CategoryTime>();
  const perTask = new Map<string, number>();
  for (const s of input.sessions) {
    const start = Date.parse(s.startUtc);
    const end = s.endUtc ? Date.parse(s.endUtc) : Math.max(start, input.now);
    const part = clip({ start, end }, { start: rangeStart, end: rangeEnd });
    if (!part) continue;
    const minutes = (part.end - part.start) / 60_000;
    perTask.set(s.taskId, (perTask.get(s.taskId) ?? 0) + minutes);
    const task = input.tasks[s.taskId];
    const project = task?.projectId ? input.categories.projects[task.projectId] : undefined;
    const area = !project && task?.areaId ? input.categories.areas[task.areaId] : undefined;
    const key = project ? `p:${task!.projectId}` : area ? `a:${task!.areaId}` : 'none';
    const entry = byKey.get(key) ?? {
      key,
      label: project?.name ?? area?.name ?? 'No project or area',
      color: project?.color ?? area?.color ?? null,
      minutes: 0,
    };
    entry.minutes += minutes;
    byKey.set(key, entry);
  }
  const byCategory = [...byKey.values()].sort((a, b) => b.minutes - a.minutes);

  let estimatedMin = 0;
  let trackedMin = 0;
  let taskCount = 0;
  for (const t of Object.values(input.tasks)) {
    if (!t.completedAt || !t.estimateMin) continue;
    const doneOn = dateOfInstant(t.completedAt, input.zone);
    if (doneOn < input.from || doneOn > input.to) continue;
    const tracked = perTask.get(t.id);
    if (!tracked) continue;
    estimatedMin += t.estimateMin;
    trackedMin += tracked;
    taskCount++;
  }

  return {
    days,
    totals,
    byCategory,
    estimateAccuracy: taskCount ? { estimatedMin, trackedMin, taskCount } : null,
  };
}
