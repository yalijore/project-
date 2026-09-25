/** Derived data for views. Pure functions over the store plus React hooks that memoize them. */
import { useMemo } from 'react';
import type { ISODate } from '@/domain/dates';
import { dayBounds, isoWeekday, parseClock } from '@/domain/dates';
import type { Workload } from '@/domain/capacity';
import { computeWorkload } from '@/domain/capacity';
import { expandEvents } from '@/domain/events';
import { virtualOccurrences } from '@/domain/recurrence';
import type { Interval } from '@/domain/scheduling';
import { clip } from '@/domain/scheduling';
import { sessionMinutes } from '@/domain/timeAccounting';
import type {
  EventOccurrence,
  RecurrenceSeries,
  Settings,
  Task,
  TimeBlock,
  TimeSession,
} from '@/domain/types';
import type { DataState } from './store';
import { useData } from './store';

export function sortByPlan(a: Task, b: Task) {
  return a.planOrder - b.planOrder || a.createdAt.localeCompare(b.createdAt);
}

export function sortByBacklog(a: Task, b: Task) {
  return a.backlogOrder - b.backlogOrder || a.createdAt.localeCompare(b.createdAt);
}

export function isOpen(t: Task) {
  return !t.completedAt && !t.archivedAt;
}

/** Tasks planned for a day (completed ones included, archived excluded). */
export function tasksOnDate(tasks: Record<string, Task>, date: ISODate): Task[] {
  return Object.values(tasks)
    .filter((t) => t.planDate === date && !t.archivedAt)
    .sort(sortByPlan);
}

/** Inbox: captured tasks with no day, project or area yet. */
export function inboxTasks(tasks: Record<string, Task>): Task[] {
  return Object.values(tasks)
    .filter((t) => isOpen(t) && !t.planDate && !t.projectId && !t.areaId)
    .sort(sortByBacklog);
}

/** Backlog: every open task that is not planned for a day. */
export function backlogTasks(tasks: Record<string, Task>): Task[] {
  return Object.values(tasks)
    .filter((t) => isOpen(t) && !t.planDate)
    .sort(sortByBacklog);
}

/** Open tasks planned before `today` (only possible when auto-rollover is off). */
export function overdueTasks(tasks: Record<string, Task>, today: ISODate): Task[] {
  return Object.values(tasks)
    .filter((t) => isOpen(t) && t.planDate && t.planDate < today)
    .sort((a, b) =>
      a.planDate! < b.planDate! ? -1 : a.planDate! > b.planDate! ? 1 : sortByPlan(a, b),
    );
}

export function trackedMinutesByTask(
  sessions: Record<string, TimeSession>,
  now: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of Object.values(sessions))
    out.set(s.taskId, (out.get(s.taskId) ?? 0) + sessionMinutes(s, now));
  return out;
}

/** Minutes from finished sessions only (running time is added live by the UI). */
export function closedMinutesByTask(sessions: Record<string, TimeSession>): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of Object.values(sessions)) {
    if (!s.endUtc) continue;
    out.set(s.taskId, (out.get(s.taskId) ?? 0) + sessionMinutes(s, 0));
  }
  return out;
}

export function useClosedMinutes(): Map<string, number> {
  const sessions = useData((s) => s.sessions);
  return useMemo(() => closedMinutesByTask(sessions), [sessions]);
}

/** Blocks grouped by task id. */
export function useBlocksByTask(): Map<string, TimeBlock[]> {
  const blocks = useData((s) => s.blocks);
  return useMemo(() => {
    const m = new Map<string, TimeBlock[]>();
    for (const b of Object.values(blocks)) {
      const list = m.get(b.taskId);
      if (list) list.push(b);
      else m.set(b.taskId, [b]);
    }
    return m;
  }, [blocks]);
}

export function runningSession(sessions: Record<string, TimeSession>): TimeSession | null {
  for (const s of Object.values(sessions)) if (!s.endUtc) return s;
  return null;
}

export function useRunningSession(): TimeSession | null {
  const sessions = useData((s) => s.sessions);
  return useMemo(() => runningSession(sessions), [sessions]);
}

export function useTracked(now = 0): Map<string, number> {
  const sessions = useData((s) => s.sessions);
  return useMemo(() => trackedMinutesByTask(sessions, now || Date.now()), [sessions, now]);
}

export function useTasksOnDate(date: ISODate): Task[] {
  const tasks = useData((s) => s.tasks);
  return useMemo(() => tasksOnDate(tasks, date), [tasks, date]);
}

export function occurrencesInRange(
  state: Pick<DataState, 'events' | 'calendars' | 'zone'>,
  from: ISODate,
  to: ISODate,
) {
  return expandEvents(Object.values(state.events), state.calendars, from, to, state.zone);
}

export function useOccurrences(from: ISODate, to: ISODate): EventOccurrence[] {
  const events = useData((s) => s.events);
  const calendars = useData((s) => s.calendars);
  const zone = useData((s) => s.zone);
  return useMemo(
    () => expandEvents(Object.values(events), calendars, from, to, zone),
    [events, calendars, zone, from, to],
  );
}

/** Busy intervals from events on calendars that count toward availability. */
export function busyIntervals(
  occ: EventOccurrence[],
  calendars: DataState['calendars'],
): Interval[] {
  return occ
    .filter(
      (o) =>
        !o.allDay &&
        o.event.busy &&
        o.event.status !== 'cancelled' &&
        calendars[o.event.calendarId]?.countsForAvailability,
    )
    .map((o) => ({ start: o.start, end: o.end }));
}

export function workingHoursOf(settings: Settings) {
  return {
    days: settings.workingDays,
    startMin: parseClock(settings.workdayStart),
    endMin: parseClock(settings.workdayEnd),
  };
}

export function useWorkload(date: ISODate): Workload {
  const tasks = useTasksOnDate(date);
  const sessions = useData((s) => s.sessions);
  const settings = useData((s) => s.settings);
  const zone = useData((s) => s.zone);
  const today = useData((s) => s.today);
  const occ = useOccurrences(date, date);
  const calendars = useData((s) => s.calendars);
  return useMemo(() => {
    const now = Date.now();
    const tracked = trackedMinutesByTask(sessions, now);
    const day = dayBounds(date, zone);
    const bounds = { start: Date.parse(day.start), end: Date.parse(day.end) };
    return computeWorkload({
      date,
      weekday: isoWeekday(date),
      zone,
      now,
      isToday: date === today,
      tasks: tasks.map((t) => ({
        id: t.id,
        estimateMin: t.estimateMin,
        actualMin: tracked.get(t.id) ?? 0,
        done: !!t.completedAt,
      })),
      meetings: busyIntervals(occ, calendars)
        .map((i) => clip(i, bounds))
        .filter(Boolean) as Interval[],
      workingHours: workingHoursOf(settings),
      capacityMin: settings.dailyCapacityMin,
      defaultEstimateMin: settings.defaultEstimateMin,
    });
  }, [tasks, sessions, settings, zone, today, occ, calendars, date]);
}

export interface VirtualTask {
  series: RecurrenceSeries;
  date: ISODate;
}

/** Future recurring occurrences with no task row yet, for [from, to]. */
export function useVirtualOccurrences(from: ISODate, to: ISODate): VirtualTask[] {
  const series = useData((s) => s.series);
  const tasks = useData((s) => s.tasks);
  const today = useData((s) => s.today);
  return useMemo(() => {
    const materialized = new Set<string>();
    for (const t of Object.values(tasks))
      if (t.recurrenceId) materialized.add(`${t.recurrenceId}|${t.recurrenceDate}`);
    return virtualOccurrences(Object.values(series), materialized, from, to, today);
  }, [series, tasks, today, from, to]);
}
