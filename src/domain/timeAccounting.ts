/**
 * Time tracking math. Sessions are wall-clock instants, so elapsed time survives restarts:
 * a running session is simply one whose end is "now".
 */
import type { ISODate, ISOInstant } from './dates';
import { dayBounds } from './dates';
import type { Interval } from './scheduling';
import { MINUTE, clip, intervalMinutes } from './scheduling';
import type { TimeSession } from './types';

export function sessionInterval(
  s: Pick<TimeSession, 'startUtc' | 'endUtc'>,
  now: number,
): Interval {
  const start = Date.parse(s.startUtc);
  const end = s.endUtc ? Date.parse(s.endUtc) : Math.max(start, now);
  return { start, end };
}

export function sessionMinutes(s: Pick<TimeSession, 'startUtc' | 'endUtc'>, now: number): number {
  return intervalMinutes(sessionInterval(s, now));
}

/** Total tracked minutes per task. */
export function trackedByTask(sessions: TimeSession[], now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) out.set(s.taskId, (out.get(s.taskId) ?? 0) + sessionMinutes(s, now));
  return out;
}

/** Minutes of each session that fall on `date` in `zone` (sessions crossing midnight are split). */
export function trackedOnDay(
  sessions: TimeSession[],
  date: ISODate,
  zone: string,
  now: number,
): Map<string, number> {
  const { start, end } = dayBounds(date, zone);
  const day = { start: Date.parse(start), end: Date.parse(end) };
  const out = new Map<string, number>();
  for (const s of sessions) {
    const part = clip(sessionInterval(s, now), day);
    if (part) out.set(s.taskId, (out.get(s.taskId) ?? 0) + intervalMinutes(part));
  }
  return out;
}

export interface GapCheck {
  /** Whether the running timer should ask the user about an unattended gap. */
  gap: boolean;
  gapStart: ISOInstant | null;
  gapMinutes: number;
}

/**
 * The app records a heartbeat on the running session every ~30s while it is awake.
 * If the last heartbeat is older than `thresholdMin`, the machine was asleep (or the app
 * closed) and the time between the heartbeat and now may not have been work.
 */
export function detectGap(
  session: Pick<TimeSession, 'startUtc' | 'heartbeatUtc' | 'endUtc'>,
  now: number,
  thresholdMin: number,
): GapCheck {
  if (session.endUtc) return { gap: false, gapStart: null, gapMinutes: 0 };
  const last = Date.parse(session.heartbeatUtc ?? session.startUtc);
  const minutes = (now - last) / MINUTE;
  if (minutes >= thresholdMin) {
    return { gap: true, gapStart: new Date(last).toISOString(), gapMinutes: Math.round(minutes) };
  }
  return { gap: false, gapStart: null, gapMinutes: 0 };
}

export interface EstimateProgress {
  estimateMin: number | null;
  actualMin: number;
  /** Positive when over the estimate. */
  varianceMin: number | null;
  ratio: number | null;
}

export function estimateProgress(estimateMin: number | null, actualMin: number): EstimateProgress {
  if (estimateMin == null || estimateMin <= 0) {
    return { estimateMin, actualMin, varianceMin: null, ratio: null };
  }
  return {
    estimateMin,
    actualMin,
    varianceMin: actualMin - estimateMin,
    ratio: actualMin / estimateMin,
  };
}
