/**
 * Recurrence rules (RFC 5545 RRULE) for tasks and calendar events.
 *
 * rrule.js computes in UTC. We feed it *wall-clock* values disguised as UTC ("floating"),
 * then convert each wall-clock occurrence to a real instant in the series' time zone with
 * Luxon. That keeps a 09:00 weekly meeting at 09:00 local time across DST transitions.
 */
import { DateTime } from 'luxon';
import type { Options } from 'rrule';
import { RRule } from 'rrule';
import type { ISODate, ISOInstant } from './dates';
import { addDays, isoWeekday } from './dates';

const DAY_MS = 86_400_000;

function floatingDate(date: ISODate): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromFloating(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

/** Normalizes user/ICS input like "RRULE:FREQ=DAILY" to "FREQ=DAILY". */
export function normalizeRule(rule: string): string {
  return rule
    .trim()
    .replace(/^RRULE:/i, '')
    .toUpperCase();
}

export function parseRule(rule: string): Partial<Options> {
  return RRule.parseString(normalizeRule(rule));
}

export function isValidRule(rule: string): boolean {
  try {
    const opts = parseRule(rule);
    return opts.freq !== undefined;
  } catch {
    return false;
  }
}

function buildRule(rule: string, dtstart: Date): RRule {
  const opts = parseRule(rule);
  if (opts.freq === undefined) throw new Error(`Recurrence rule has no FREQ: ${rule}`);
  return new RRule({ ...opts, dtstart, tzid: null });
}

/** Occurrence dates of a floating-date series within [from, to] (inclusive). */
export function occurrencesBetween(
  rule: string,
  dtstart: ISODate,
  from: ISODate,
  to: ISODate,
): ISODate[] {
  if (to < from) return [];
  const rr = buildRule(rule, floatingDate(dtstart));
  return rr
    .between(floatingDate(from), new Date(floatingDate(to).getTime() + DAY_MS - 1), true)
    .map(fromFloating);
}

/** The first occurrence on or after `from`, or null if the series has ended. */
export function nextOccurrence(rule: string, dtstart: ISODate, from: ISODate): ISODate | null {
  const rr = buildRule(rule, floatingDate(dtstart));
  const next = rr.after(floatingDate(from), true);
  return next ? fromFloating(next) : null;
}

/** The last occurrence on or before `to`, or null. */
export function previousOccurrence(rule: string, dtstart: ISODate, to: ISODate): ISODate | null {
  const rr = buildRule(rule, floatingDate(dtstart));
  const prev = rr.before(new Date(floatingDate(to).getTime() + DAY_MS - 1), true);
  return prev ? fromFloating(prev) : null;
}

export function describeRule(rule: string, dtstart?: ISODate): string {
  try {
    const rr = buildRule(rule, floatingDate(dtstart ?? '2026-01-05'));
    const text = rr.toText();
    return text.charAt(0).toUpperCase() + text.slice(1);
  } catch {
    return 'Custom repeat';
  }
}

const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

export type RepeatPreset =
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'biweekly'
  | 'monthly-day'
  | 'monthly-nth'
  | 'monthly-last'
  | 'yearly';

/** Builds a rule for a preset anchored on `date` (e.g. weekly → that weekday). */
export function presetRule(preset: RepeatPreset, date: ISODate): string {
  const wd = RRULE_DAYS[isoWeekday(date) - 1]!;
  const day = Number(date.slice(8, 10));
  switch (preset) {
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${wd}`;
    case 'biweekly':
      return `FREQ=WEEKLY;INTERVAL=2;BYDAY=${wd}`;
    case 'monthly-day':
      return `FREQ=MONTHLY;BYMONTHDAY=${day}`;
    case 'monthly-nth': {
      const nth = Math.ceil(day / 7);
      return `FREQ=MONTHLY;BYDAY=+${Math.min(nth, 4)}${wd}`;
    }
    case 'monthly-last':
      return 'FREQ=MONTHLY;BYMONTHDAY=-1';
    case 'yearly':
      return 'FREQ=YEARLY';
  }
}

export interface CustomRuleInput {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  /** ISO weekdays for weekly rules. */
  weekdays?: number[];
  end?: { kind: 'never' } | { kind: 'until'; date: ISODate } | { kind: 'count'; count: number };
}

export function buildCustomRule(input: CustomRuleInput): string {
  const parts = [`FREQ=${input.freq}`];
  if (input.interval > 1) parts.push(`INTERVAL=${Math.floor(input.interval)}`);
  if (input.freq === 'WEEKLY' && input.weekdays?.length) {
    const days = [...new Set(input.weekdays)].sort().map((d) => RRULE_DAYS[d - 1]);
    parts.push(`BYDAY=${days.join(',')}`);
  }
  if (input.end?.kind === 'until') parts.push(`UNTIL=${input.end.date.replace(/-/g, '')}T235959Z`);
  if (input.end?.kind === 'count') parts.push(`COUNT=${Math.max(1, Math.floor(input.end.count))}`);
  return parts.join(';');
}

/** Replaces or adds an UNTIL so the series ends after `lastDate`. */
export function endRuleOn(rule: string, lastDate: ISODate): string {
  const parts = normalizeRule(rule)
    .split(';')
    .filter((p) => p && !p.startsWith('UNTIL=') && !p.startsWith('COUNT='));
  parts.push(`UNTIL=${lastDate.replace(/-/g, '')}T235959Z`);
  return parts.join(';');
}

// ---------------------------------------------------------------------------------------
// Calendar event expansion (time zone aware)
// ---------------------------------------------------------------------------------------

export interface RecurringTimedEvent {
  startUtc: ISOInstant;
  endUtc: ISOInstant;
  tz: string;
  /** Null for an event that recurs only on its RDATEs. */
  rrule: string | null;
  /** Excluded occurrence starts (ISO instants). */
  exdates: ISOInstant[];
  /** Extra occurrence starts (RDATE, ISO instants), each lasting as long as the first. */
  rdates?: ISOInstant[];
}

export interface Occurrence {
  start: number;
  end: number;
  /** Original start of this occurrence (what RECURRENCE-ID would reference). */
  key: ISOInstant;
}

function wallAsFloating(dt: DateTime): Date {
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second));
}

/** Expands a timed recurring event into occurrences overlapping [rangeStart, rangeEnd). */
export function expandTimedEvent(
  ev: RecurringTimedEvent,
  rangeStart: number,
  rangeEnd: number,
): Occurrence[] {
  const startLocal = DateTime.fromISO(ev.startUtc, { zone: ev.tz });
  if (!startLocal.isValid) return [];
  const duration = Date.parse(ev.endUtc) - Date.parse(ev.startUtc);
  // Search a slightly wider floating window; offsets are at most ±14h.
  const margin = 2 * DAY_MS;
  const candidates = ev.rrule
    ? buildRule(ev.rrule, wallAsFloating(startLocal)).between(
        new Date(rangeStart - duration - margin),
        new Date(rangeEnd + margin),
        true,
      )
    : [wallAsFloating(startLocal)]; // RDATE-only: the first occurrence is DTSTART
  const excluded = new Set(ev.exdates.map((d) => Date.parse(d)));
  const out: Occurrence[] = [];
  const seen = new Set<number>();
  const add = (start: number) => {
    if (excluded.has(start) || seen.has(start)) return;
    seen.add(start);
    const end = start + duration;
    if (start < rangeEnd && end > rangeStart) {
      out.push({ start, end, key: new Date(start).toISOString() });
    }
  };
  for (const r of ev.rdates ?? []) {
    const t = Date.parse(r);
    if (Number.isFinite(t)) add(t);
  }
  for (const c of candidates) {
    const local = DateTime.fromObject(
      {
        year: c.getUTCFullYear(),
        month: c.getUTCMonth() + 1,
        day: c.getUTCDate(),
        hour: c.getUTCHours(),
        minute: c.getUTCMinutes(),
        second: c.getUTCSeconds(),
      },
      { zone: ev.tz },
    );
    add(local.toMillis());
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface RecurringAllDayEvent {
  startDate: ISODate;
  endDate: ISODate; // exclusive
  /** Null for an event that recurs only on its RDATEs. */
  rrule: string | null;
  exdates: ISODate[];
  /** Extra occurrence dates (RDATE). */
  rdates?: ISODate[];
}

export interface DateOccurrence {
  startDate: ISODate;
  endDate: ISODate;
  key: ISODate;
}

/** Expands an all-day recurring event into occurrences overlapping [from, to]. */
export function expandAllDayEvent(
  ev: RecurringAllDayEvent,
  from: ISODate,
  to: ISODate,
): DateOccurrence[] {
  const spanDays = Math.max(
    1,
    Math.round(
      (floatingDate(ev.endDate).getTime() - floatingDate(ev.startDate).getTime()) / DAY_MS,
    ),
  );
  const excluded = new Set(ev.exdates);
  const first = addDays(from, -spanDays + 1);
  const dates = new Set(
    ev.rrule
      ? occurrencesBetween(ev.rrule, ev.startDate, first, to)
      : ev.startDate >= first && ev.startDate <= to
        ? [ev.startDate]
        : [],
  );
  for (const d of ev.rdates ?? []) if (d >= first && d <= to) dates.add(d.slice(0, 10));
  return [...dates]
    .filter((d) => !excluded.has(d))
    .sort()
    .map((d) => ({ startDate: d, endDate: addDays(d, spanDays), key: d }));
}

// ---------------------------------------------------------------------------------------
// Virtual (not yet materialized) task occurrences
// ---------------------------------------------------------------------------------------

export interface SeriesLike {
  id: string;
  rrule: string;
  dtstart: ISODate;
  endedAt: string | null;
  skipDates: ISODate[];
}

export interface VirtualOccurrence<S extends SeriesLike> {
  series: S;
  date: ISODate;
}

/**
 * Future occurrences (after `today`) in [from, to] that have no task row yet and were not
 * skipped. `materialized` holds `${seriesId}|${date}` for existing instances.
 */
export function virtualOccurrences<S extends SeriesLike>(
  series: S[],
  materialized: Set<string>,
  from: ISODate,
  to: ISODate,
  today: ISODate,
): VirtualOccurrence<S>[] {
  const start = from > today ? from : addDays(today, 1);
  if (start > to) return [];
  const out: VirtualOccurrence<S>[] = [];
  for (const s of series) {
    if (s.endedAt && !/UNTIL=/i.test(s.rrule)) continue;
    const skips = new Set(s.skipDates);
    let dates: ISODate[];
    try {
      dates = occurrencesBetween(s.rrule, s.dtstart, start, to);
    } catch {
      continue;
    }
    for (const date of dates) {
      if (skips.has(date) || materialized.has(`${s.id}|${date}`)) continue;
      out.push({ series: s, date });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
