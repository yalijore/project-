/**
 * Builds the focus bar's state in the main window (the single authority over timer state).
 * Pure functions, unit-tested; see protocol.ts for the contract.
 */
import type { ISODate } from '@/domain/dates';
import type { Project, Task, TimeBlock, TimeSession } from '@/domain/types';
import { closedMinutesByTask, isOpen, tasksOnDate } from '@/data/selectors';
import type { BarState } from './protocol';

export interface BarInputs {
  tasks: Record<string, Task>;
  sessions: Record<string, TimeSession>;
  blocks: Record<string, TimeBlock>;
  projects: Record<string, Project>;
  today: ISODate;
  zone: string;
  hour12: boolean;
  dark: boolean;
  barTaskId: string | null;
  /** A pending "were you working?" question, for one specific session. */
  gap: { sessionId: string; minutes: number } | null;
  now: number;
}

export function runningSession(sessions: Record<string, TimeSession>): TimeSession | null {
  return Object.values(sessions).find((s) => !s.endUtc) ?? null;
}

/** The task the bar is about: the running one, else the one the user last focused. */
export function barTaskOf(i: Pick<BarInputs, 'sessions' | 'tasks' | 'barTaskId'>): Task | null {
  const running = runningSession(i.sessions);
  if (running && i.tasks[running.taskId]) return i.tasks[running.taskId]!;
  return i.barTaskId ? (i.tasks[i.barTaskId] ?? null) : null;
}

/** The next open task in today's plan after `afterId` (wrapping to earlier ones), if any. */
export function nextPlannedTask(
  tasks: Record<string, Task>,
  today: ISODate,
  afterId: string | null,
): Task | null {
  const day = tasksOnDate(tasks, today);
  const idx = afterId ? day.findIndex((t) => t.id === afterId) : -1;
  const ordered = idx >= 0 ? [...day.slice(idx + 1), ...day.slice(0, idx)] : day;
  return ordered.find((t) => isOpen(t) && t.id !== afterId) ?? null;
}

export function buildBarState(i: BarInputs, seq: number): BarState {
  const task = barTaskOf(i);
  const running = runningSession(i.sessions);
  const isRunning = !!running && running.taskId === task?.id;
  const block = task
    ? Object.values(i.blocks).find(
        (b) =>
          b.taskId === task.id && Date.parse(b.startUtc) <= i.now && Date.parse(b.endUtc) > i.now,
      )
    : undefined;
  return {
    seq,
    theme: i.dark ? 'dark' : 'light',
    task: task
      ? {
          id: task.id,
          title: task.title,
          color: task.projectId ? (i.projects[task.projectId]?.color ?? null) : null,
          done: !!task.completedAt,
          estimateMin: task.estimateMin,
        }
      : null,
    running: isRunning,
    sessionStartUtc: isRunning ? running.startUtc : null,
    closedMin: task ? (closedMinutesByTask(i.sessions).get(task.id) ?? 0) : 0,
    blockEndUtc: block?.endUtc ?? null,
    gapMinutes: isRunning && i.gap?.sessionId === running.id ? i.gap.minutes : null,
    allDone:
      !task && !nextPlannedTask(i.tasks, i.today, null) && tasksOnDate(i.tasks, i.today).length > 0,
    hour12: i.hour12,
    zone: i.zone,
  };
}
