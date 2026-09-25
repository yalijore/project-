/**
 * Interval arithmetic for timeboxing: free/busy computation, slot finding, conflict
 * detection and side-by-side layout of overlapping calendar items.
 * Intervals are half-open [start, end) in epoch milliseconds.
 */
import type { ISODate, ISOInstant } from './dates';
import { dayBounds, wallTimeToInstant } from './dates';

export interface Interval {
  start: number;
  end: number;
}

export interface WorkingHours {
  /** ISO weekdays that are working days (1 = Monday … 7 = Sunday). */
  days: number[];
  /** Minutes after midnight. */
  startMin: number;
  endMin: number;
}

export const MINUTE = 60_000;

export function toInterval(start: ISOInstant, end: ISOInstant): Interval {
  return { start: Date.parse(start), end: Date.parse(end) };
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function intervalMinutes(i: Interval): number {
  return Math.max(0, (i.end - i.start) / MINUTE);
}

/** Sorts and merges overlapping or touching intervals. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** `base` minus every interval in `remove`. */
export function subtractIntervals(base: Interval[], remove: Interval[]): Interval[] {
  const cuts = mergeIntervals(remove);
  const out: Interval[] = [];
  for (const b of mergeIntervals(base)) {
    let cursor = b.start;
    for (const c of cuts) {
      if (c.end <= cursor || c.start >= b.end) continue;
      if (c.start > cursor) out.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
      if (cursor >= b.end) break;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out;
}

export function clip(i: Interval, bounds: Interval): Interval | null {
  const start = Math.max(i.start, bounds.start);
  const end = Math.min(i.end, bounds.end);
  return end > start ? { start, end } : null;
}

export function totalMinutes(intervals: Interval[]): number {
  return mergeIntervals(intervals).reduce((sum, i) => sum + intervalMinutes(i), 0);
}

/** The working-hours interval for a date, or null on non-working days. */
export function workingInterval(
  date: ISODate,
  weekday: number,
  wh: WorkingHours,
  zone: string,
): Interval | null {
  if (!wh.days.includes(weekday) || wh.endMin <= wh.startMin) return null;
  return toInterval(
    wallTimeToInstant(date, wh.startMin, zone),
    wallTimeToInstant(date, wh.endMin, zone),
  );
}

export function dayInterval(date: ISODate, zone: string): Interval {
  const { start, end } = dayBounds(date, zone);
  return toInterval(start, end);
}

/**
 * Free time within `window`, after removing busy intervals padded by `bufferMin` on both
 * sides (so blocks are not placed back-to-back with meetings), starting no earlier than `from`.
 */
export function freeSlots(
  window: Interval,
  busy: Interval[],
  bufferMin: number,
  from?: number,
): Interval[] {
  const pad = bufferMin * MINUTE;
  const padded = busy.map((b) => ({ start: b.start - pad, end: b.end + pad }));
  const start = from != null ? Math.max(window.start, from) : window.start;
  if (start >= window.end) return [];
  return subtractIntervals([{ start, end: window.end }], padded);
}

/** Rounds an epoch-ms time up to the next multiple of `stepMin` minutes. */
export function ceilToStep(ms: number, stepMin: number): number {
  const step = stepMin * MINUTE;
  return Math.ceil(ms / step) * step;
}

/** First slot that fits `durationMin`, aligned to `stepMin`. */
export function findSlot(slots: Interval[], durationMin: number, stepMin = 5): Interval | null {
  const need = durationMin * MINUTE;
  for (const s of slots) {
    const start = ceilToStep(s.start, stepMin);
    if (start + need <= s.end) return { start, end: start + need };
  }
  return null;
}

export interface Placement {
  id: string;
  interval: Interval;
}

/**
 * Greedy auto-scheduling: places each item (in order) into the earliest free slot that
 * fits, treating previously placed items as busy. Items that do not fit are returned in
 * `unplaced` — never silently dropped or squeezed.
 */
export function packIntoSlots(
  items: { id: string; durationMin: number }[],
  window: Interval,
  busy: Interval[],
  bufferMin: number,
  from?: number,
  stepMin = 5,
): { placed: Placement[]; unplaced: string[] } {
  const taken = [...busy];
  const placed: Placement[] = [];
  const unplaced: string[] = [];
  for (const item of items) {
    const slot = findSlot(freeSlots(window, taken, bufferMin, from), item.durationMin, stepMin);
    if (slot) {
      placed.push({ id: item.id, interval: slot });
      // Placed blocks can sit back-to-back with each other; the buffer applies around busy time.
      taken.push(slot);
    } else {
      unplaced.push(item.id);
    }
  }
  return { placed, unplaced };
}

export interface LayoutItem {
  id: string;
  start: number;
  end: number;
}

export interface LayoutResult {
  column: number;
  columns: number;
}

/**
 * Side-by-side layout for overlapping items (classic calendar column packing).
 * Items in the same overlap cluster share the column count.
 */
export function layoutOverlapping(items: LayoutItem[]): Map<string, LayoutResult> {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const result = new Map<string, LayoutResult>();
  let cluster: { id: string; column: number }[] = [];
  let columnsEnd: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const columns = columnsEnd.length;
    for (const c of cluster) result.set(c.id, { column: c.column, columns });
    cluster = [];
    columnsEnd = [];
    clusterEnd = -Infinity;
  };

  for (const item of sorted) {
    if (item.start >= clusterEnd && cluster.length) flush();
    let col = columnsEnd.findIndex((end) => end <= item.start);
    if (col === -1) {
      col = columnsEnd.length;
      columnsEnd.push(item.end);
    } else {
      columnsEnd[col] = item.end;
    }
    cluster.push({ id: item.id, column: col });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return result;
}

export interface ConflictItem {
  id: string;
  kind: 'block' | 'event';
  interval: Interval;
  busy: boolean;
}

/** Pairs of overlapping items where at least one is a time block and the other is busy. */
export function findConflicts(items: ConflictItem[]): [string, string][] {
  const sorted = [...items].sort((a, b) => a.interval.start - b.interval.start);
  const out: [string, string][] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.interval.start >= a.interval.end) break;
      if (!overlaps(a.interval, b.interval)) continue;
      const involvesBlock = a.kind === 'block' || b.kind === 'block';
      const bothCount = (a.kind === 'block' || a.busy) && (b.kind === 'block' || b.busy);
      if (involvesBlock && bothCount) out.push([a.id, b.id]);
    }
  }
  return out;
}

/** Snaps minutes to the nearest multiple of `step`. */
export function snap(minutes: number, step: number): number {
  return Math.round(minutes / step) * step;
}
