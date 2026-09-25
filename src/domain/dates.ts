/**
 * Date/time primitives. Two kinds of values flow through Keel:
 *
 *   ISODate    "2026-09-25"                 a floating calendar day (deadlines, planned days,
 *                                           all-day events). Arithmetic is done in UTC so DST
 *                                           never shifts a day.
 *   ISOInstant "2026-09-25T13:00:00.000Z"   an absolute moment (time blocks, events, sessions).
 *                                           Rendered in the user's zone; DST handled by Luxon.
 */
import { DateTime, IANAZone } from 'luxon';

export type ISODate = string;
export type ISOInstant = string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(value: unknown): value is ISODate {
  return typeof value === 'string' && DATE_RE.test(value) && DateTime.fromISO(value).isValid;
}

export function systemZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

function floating(date: ISODate): DateTime {
  const dt = DateTime.fromISO(date, { zone: 'utc' });
  if (!dt.isValid) throw new Error(`Invalid date: ${date}`);
  return dt;
}

export function toISODate(dt: DateTime): ISODate {
  return dt.toISODate()!;
}

export function todayIn(zone: string, now: Date = new Date()): ISODate {
  return toISODate(DateTime.fromJSDate(now, { zone }));
}

export function dateOfInstant(instant: ISOInstant, zone: string): ISODate {
  return toISODate(DateTime.fromISO(instant, { zone }));
}

export function addDays(date: ISODate, days: number): ISODate {
  return toISODate(floating(date).plus({ days }));
}

export function addMonths(date: ISODate, months: number): ISODate {
  return toISODate(floating(date).plus({ months }));
}

/** Whole days from `a` to `b` (positive if b is later). */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round(floating(b).diff(floating(a), 'days').days);
}

export function compareDates(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
export function isoWeekday(date: ISODate): number {
  return floating(date).weekday;
}

/**
 * First day of the week containing `date`.
 * @param weekStartsOn ISO weekday the week starts on (1 = Monday, 7 = Sunday, 6 = Saturday).
 */
export function startOfWeek(date: ISODate, weekStartsOn: number): ISODate {
  const wd = isoWeekday(date);
  const back = (wd - weekStartsOn + 7) % 7;
  return addDays(date, -back);
}

export function startOfMonth(date: ISODate): ISODate {
  return toISODate(floating(date).startOf('month'));
}

/** Inclusive list of dates. */
export function dateRange(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The instants bounding a calendar day in `zone` (23 or 25 hours long on DST days). */
export function dayBounds(date: ISODate, zone: string): { start: ISOInstant; end: ISOInstant } {
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  const end = start.plus({ days: 1 }).startOf('day');
  return { start: start.toUTC().toISO()!, end: end.toUTC().toISO()! };
}

/** "HH:MM" → minutes after midnight. */
export function parseClock(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`Invalid time: ${value}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`Invalid time: ${value}`);
  return h * 60 + min;
}

export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The instant at wall-clock `minutes` after midnight on `date` in `zone`.
 * Times that do not exist (spring-forward gap) resolve to the first valid time after
 * the gap; ambiguous times (fall-back) resolve to the earlier offset — Luxon's behaviour.
 */
export function wallTimeToInstant(date: ISODate, minutes: number, zone: string): ISOInstant {
  const base = DateTime.fromISO(date, { zone }).startOf('day');
  const dt = DateTime.fromObject(
    {
      year: base.year,
      month: base.month,
      day: base.day,
      hour: Math.floor(minutes / 60),
      minute: minutes % 60,
    },
    { zone },
  );
  // 24:00 means the start of the next day.
  const resolved = minutes >= 24 * 60 ? base.plus({ days: 1 }) : dt;
  return resolved.toUTC().toISO()!;
}

/** Minutes after local midnight of `date` at which `instant` falls (may be <0 or >1440). */
export function minutesIntoDay(instant: ISOInstant, date: ISODate, zone: string): number {
  const dayStart = DateTime.fromISO(date, { zone }).startOf('day');
  return DateTime.fromISO(instant).diff(dayStart, 'minutes').minutes;
}

export function addMinutes(instant: ISOInstant, minutes: number): ISOInstant {
  return DateTime.fromISO(instant, { zone: 'utc' }).plus({ minutes }).toISO()!;
}

export function minutesBetween(a: ISOInstant, b: ISOInstant): number {
  return (Date.parse(b) - Date.parse(a)) / 60000;
}

export function nowInstant(now: Date = new Date()): ISOInstant {
  return now.toISOString();
}

export function zoned(instant: ISOInstant, zone: string): DateTime {
  return DateTime.fromISO(instant, { zone });
}

export function formatTime(instant: ISOInstant, zone: string, hour12: boolean): string {
  const dt = zoned(instant, zone);
  if (hour12) {
    return dt
      .toFormat(dt.minute === 0 ? 'h a' : 'h:mm a')
      .replace(' ', '')
      .toLowerCase();
  }
  return dt.toFormat('HH:mm');
}

export function formatTimeRange(
  start: ISOInstant,
  end: ISOInstant,
  zone: string,
  hour12: boolean,
): string {
  return `${formatTime(start, zone, hour12)} – ${formatTime(end, zone, hour12)}`;
}

export function formatClockMinutes(minutes: number, hour12: boolean): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  if (!hour12) return formatClock(minutes);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

/** "Thursday, September 25" */
export function formatDateLong(date: ISODate): string {
  return floating(date).toFormat('cccc, LLLL d');
}

/** "Thu, Sep 25" (adds the year when it differs from `relativeTo`'s). */
export function formatDateShort(date: ISODate, relativeTo?: ISODate): string {
  const dt = floating(date);
  const sameYear = !relativeTo || relativeTo.slice(0, 4) === date.slice(0, 4);
  return dt.toFormat(sameYear ? 'ccc, LLL d' : 'ccc, LLL d, yyyy');
}

export function weekdayShort(date: ISODate): string {
  return floating(date).toFormat('ccc');
}

export function dayOfMonth(date: ISODate): number {
  return floating(date).day;
}

export function monthName(date: ISODate): string {
  return floating(date).toFormat('LLLL yyyy');
}

/** Friendly relative label for a date: Today, Tomorrow, Yesterday, weekday within a week, else short date. */
export function relativeDateLabel(date: ISODate, today: ISODate): string {
  const d = diffDays(today, date);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  if (d > 1 && d < 7) return floating(date).toFormat('cccc');
  return formatDateShort(date, today);
}

/** "1h 30m", "45m", "2h". */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return '';
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Compact variant for tight chips: "1:30", "0:45". */
export function formatDurationClock(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Timer display "1:02:05" / "12:05". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  return h > 0
    ? `${h}:${mm}:${String(sec).padStart(2, '0')}`
    : `${mm}:${String(sec).padStart(2, '0')}`;
}

/**
 * Parses user duration input: "45", "45m", "1h", "1.5h", "1h30", "1h 30m", "1:30", "90min".
 * Bare numbers are minutes. Returns null for invalid/empty input.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+):(\d{1,2})$/.exec(s))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = /^(\d+(?:\.\d+)?)(?:m|min|mins|minutes?)?$/.exec(s))) return Math.round(Number(m[1]));
  if ((m = /^(\d+(?:\.\d+)?)(?:h|hr|hrs|hours?)$/.exec(s))) return Math.round(Number(m[1]) * 60);
  if ((m = /^(\d+)(?:h|hr|hrs)(\d+)(?:m|min|mins)?$/.exec(s)))
    return Number(m[1]) * 60 + Number(m[2]);
  return null;
}
