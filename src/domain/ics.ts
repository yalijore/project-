/**
 * iCalendar (RFC 5545) import and export.
 *
 * Import uses ical.js for parsing and Luxon for zone math. TZIDs may be IANA names, Windows
 * names (Outlook/Exchange — mapped via CLDR), or custom VTIMEZONE definitions (converted by
 * ical.js; recurring series then expand in the importing user's zone, noted in the README).
 * Export writes UTC times for one-off events and TZID + generated VTIMEZONE blocks for
 * recurring ones, so "every Monday 09:00" stays at 09:00 local time in other calendar apps.
 */
import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import type { ISODate, ISOInstant } from './dates';
import { addDays, isValidZone } from './dates';
import { WINDOWS_TO_IANA } from './windowsZones';

export interface ParsedEvent {
  uid: string | null;
  recurrenceId: string | null;
  title: string;
  description: string;
  location: string;
  url: string | null;
  allDay: boolean;
  startUtc: ISOInstant | null;
  endUtc: ISOInstant | null;
  startDate: ISODate | null;
  endDate: ISODate | null;
  tz: string;
  rrule: string | null;
  exdates: string[];
  status: 'confirmed' | 'tentative' | 'cancelled';
  busy: boolean;
}

export interface ParsedCalendar {
  name: string | null;
  events: ParsedEvent[];
  warnings: string[];
}

/** Resolves a TZID to an IANA zone, or null if unknown. */
export function resolveTzid(tzid: string | null | undefined): string | null {
  if (!tzid) return null;
  const clean = tzid.replace(/^"|"$/g, '').trim();
  if (isValidZone(clean)) return clean;
  if (WINDOWS_TO_IANA[clean]) return WINDOWS_TO_IANA[clean]!;
  // Mozilla-style prefixes, e.g. "/mozilla.org/20050126_1/Europe/Berlin" or "/Europe/Berlin".
  const m = /([A-Za-z_]+\/[A-Za-z_+\-0-9]+(?:\/[A-Za-z_+\-0-9]+)?)$/.exec(clean);
  if (m && isValidZone(m[1]!)) return m[1]!;
  return null;
}

type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalProperty = InstanceType<typeof ICAL.Property>;

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0');
}

function timeToDate(t: IcalTime): ISODate {
  return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
}

/** Converts a property's time value to an absolute instant, given the fallback zone. */
function timeToInstant(
  prop: IcalProperty,
  value: IcalTime,
  fallbackZone: string,
): { instant: ISOInstant; zone: string | null } {
  const tzid = prop.getParameter('tzid') as string | undefined;
  const isUtc = value.zone?.tzid === 'UTC' || (value.toString().endsWith('Z') && !tzid);
  if (isUtc) return { instant: new Date(value.toUnixTime() * 1000).toISOString(), zone: 'UTC' };
  const zone = tzid ? resolveTzid(tzid) : fallbackZone;
  if (zone) {
    const dt = DateTime.fromObject(
      {
        year: value.year,
        month: value.month,
        day: value.day,
        hour: value.hour,
        minute: value.minute,
        second: value.second,
      },
      { zone },
    );
    return { instant: dt.toUTC().toISO()!, zone: tzid ? zone : null };
  }
  // Unknown TZID: trust ical.js's conversion using the file's VTIMEZONE, if it had one.
  return { instant: value.toJSDate().toISOString(), zone: null };
}

function propTime(
  vevent: InstanceType<typeof ICAL.Component>,
  name: string,
): { prop: IcalProperty; value: IcalTime } | null {
  const prop = vevent.getFirstProperty(name);
  if (!prop) return null;
  const value = prop.getFirstValue() as IcalTime | null;
  return value ? { prop, value } : null;
}

export function parseIcs(text: string, userZone: string): ParsedCalendar {
  const warnings: string[] = [];
  let root: InstanceType<typeof ICAL.Component>;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch (e) {
    throw new Error(
      `This file is not a valid iCalendar (.ics) file: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  const cal = root.name === 'vcalendar' ? root : root.getFirstSubcomponent('vcalendar');
  if (!cal) throw new Error('No VCALENDAR found in this file');
  for (const vtz of cal.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(vtz);
    } catch {
      warnings.push('A time zone definition in the file could not be read.');
    }
  }
  const name = (cal.getFirstPropertyValue('x-wr-calname') as string | null) ?? null;
  const events: ParsedEvent[] = [];
  const unknownZones = new Set<string>();

  for (const vevent of cal.getAllSubcomponents('vevent')) {
    const start = propTime(vevent, 'dtstart');
    if (!start) {
      warnings.push('Skipped an event without a start time.');
      continue;
    }
    const tzParam = start.prop.getParameter('tzid') as string | undefined;
    if (tzParam && !resolveTzid(tzParam)) unknownZones.add(tzParam);
    const uid = (vevent.getFirstPropertyValue('uid') as string | null) ?? null;
    const statusRaw = String(vevent.getFirstPropertyValue('status') ?? 'CONFIRMED').toUpperCase();
    const transp = String(vevent.getFirstPropertyValue('transp') ?? 'OPAQUE').toUpperCase();
    const rruleValue = vevent.getFirstPropertyValue('rrule') as InstanceType<
      typeof ICAL.Recur
    > | null;
    const base = {
      uid,
      title: String(vevent.getFirstPropertyValue('summary') ?? '').trim() || '(No title)',
      description: String(vevent.getFirstPropertyValue('description') ?? ''),
      location: String(vevent.getFirstPropertyValue('location') ?? ''),
      url: (vevent.getFirstPropertyValue('url') as string | null) ?? null,
      rrule: rruleValue ? rruleValue.toString() : null,
      status: (statusRaw === 'CANCELLED'
        ? 'cancelled'
        : statusRaw === 'TENTATIVE'
          ? 'tentative'
          : 'confirmed') as ParsedEvent['status'],
      busy: transp !== 'TRANSPARENT',
    };

    const recurrence = propTime(vevent, 'recurrence-id');
    const exdates: string[] = [];
    for (const prop of vevent.getAllProperties('exdate')) {
      for (const v of prop.getValues() as IcalTime[]) {
        exdates.push(v.isDate ? timeToDate(v) : timeToInstant(prop, v, userZone).instant);
      }
    }

    if (start.value.isDate) {
      const startDate = timeToDate(start.value);
      const end = propTime(vevent, 'dtend');
      let endDate = end && end.value.isDate ? timeToDate(end.value) : null;
      const duration = vevent.getFirstPropertyValue('duration') as InstanceType<
        typeof ICAL.Duration
      > | null;
      if (!endDate && duration)
        endDate = addDays(startDate, Math.max(1, Math.round(duration.toSeconds() / 86400)));
      if (!endDate || endDate <= startDate) endDate = addDays(startDate, 1);
      events.push({
        ...base,
        allDay: true,
        startDate,
        endDate,
        startUtc: null,
        endUtc: null,
        tz: userZone,
        exdates,
        recurrenceId: recurrence
          ? recurrence.value.isDate
            ? timeToDate(recurrence.value)
            : timeToInstant(recurrence.prop, recurrence.value, userZone).instant
          : null,
      });
      continue;
    }

    const s = timeToInstant(start.prop, start.value, userZone);
    let endUtc: string;
    const end = propTime(vevent, 'dtend');
    const duration = vevent.getFirstPropertyValue('duration') as InstanceType<
      typeof ICAL.Duration
    > | null;
    if (end && !end.value.isDate) endUtc = timeToInstant(end.prop, end.value, userZone).instant;
    else if (duration)
      endUtc = new Date(Date.parse(s.instant) + duration.toSeconds() * 1000).toISOString();
    else endUtc = s.instant;
    if (Date.parse(endUtc) < Date.parse(s.instant)) endUtc = s.instant;
    events.push({
      ...base,
      allDay: false,
      startUtc: s.instant,
      endUtc,
      startDate: null,
      endDate: null,
      tz: s.zone && s.zone !== 'UTC' ? s.zone : userZone,
      exdates,
      recurrenceId: recurrence
        ? recurrence.value.isDate
          ? timeToDate(recurrence.value)
          : timeToInstant(recurrence.prop, recurrence.value, userZone).instant
        : null,
    });
  }
  if (unknownZones.size) {
    warnings.push(
      `Unrecognized time zone(s): ${[...unknownZones].join(', ')}. Times were converted using the file's own definitions; repeating events use your time zone.`,
    );
  }
  return { name, events, warnings };
}

// ---------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------

export interface ExportEvent {
  uid: string;
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
  recurrenceId?: string | null;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  busy?: boolean;
  categories?: string[];
}

export function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Folds a content line at 75 octets (RFC 5545 §3.1), never splitting a UTF-8 sequence. */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const len = encoder.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (bytes + len > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += len;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function utcStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function localStamp(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { zone }).toFormat("yyyyMMdd'T'HHmmss");
}

function dateStamp(d: string): string {
  return d.replace(/-/g, '');
}

function offsetString(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** Finds offset transitions of `zone` in [from, to) (epoch ms). */
export function zoneTransitions(
  zone: string,
  from: number,
  to: number,
): { at: number; before: number; after: number }[] {
  const offsetAt = (ms: number) => DateTime.fromMillis(ms, { zone }).offset;
  const out: { at: number; before: number; after: number }[] = [];
  const step = 7 * 86_400_000;
  let t = from;
  let prev = offsetAt(t);
  while (t < to) {
    const next = Math.min(t + step, to);
    const off = offsetAt(next);
    if (off !== prev) {
      let lo = t;
      let hi = next;
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
        if (offsetAt(mid) === prev) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, before: prev, after: off });
      prev = off;
    }
    t = next;
  }
  return out;
}

/** A VTIMEZONE for `zone` covering the given years, built from real transitions. */
export function buildVTimezone(zone: string, fromYear: number, toYear: number): string[] {
  const start = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear + 1, 0, 1);
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
  const transitions = zoneTransitions(zone, start, end);
  if (transitions.length === 0) {
    const off = DateTime.fromMillis(start, { zone }).offset;
    lines.push(
      'BEGIN:STANDARD',
      `DTSTART:${fromYear}0101T000000`,
      `TZOFFSETFROM:${offsetString(off)}`,
      `TZOFFSETTO:${offsetString(off)}`,
      'END:STANDARD',
    );
  } else {
    for (const tr of transitions) {
      const kind = tr.after > tr.before ? 'DAYLIGHT' : 'STANDARD';
      const local = DateTime.fromMillis(tr.at, { zone: 'utc' })
        .plus({ minutes: tr.before })
        .toFormat("yyyyMMdd'T'HHmmss");
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:${local}`,
        `TZOFFSETFROM:${offsetString(tr.before)}`,
        `TZOFFSETTO:${offsetString(tr.after)}`,
        `END:${kind}`,
      );
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

export function generateIcs(
  calendarName: string,
  events: ExportEvent[],
  now: Date = new Date(),
): string {
  const stamp = utcStamp(now.toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Keel//Keel Planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];

  // Zones needed for recurring timed events (and their overrides).
  const zones = new Map<string, { min: number; max: number }>();
  for (const e of events) {
    if (e.allDay || !(e.rrule || e.recurrenceId) || !e.tz || e.tz === 'UTC' || !isValidZone(e.tz))
      continue;
    const y = Number((e.startUtc ?? '').slice(0, 4)) || now.getUTCFullYear();
    const cur = zones.get(e.tz) ?? { min: y, max: y };
    zones.set(e.tz, {
      min: Math.min(cur.min, y),
      max: Math.max(cur.max, y, now.getUTCFullYear() + 5),
    });
  }
  for (const [zone, range] of zones) lines.push(...buildVTimezone(zone, range.min - 1, range.max));

  for (const e of events) {
    const useZone =
      !e.allDay && !!(e.rrule || e.recurrenceId) && !!e.tz && zones.has(e.tz) ? e.tz : null;
    const timed = (prop: string, iso: string) =>
      useZone ? `${prop};TZID=${useZone}:${localStamp(iso, useZone)}` : `${prop}:${utcStamp(iso)}`;
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp}`);
    if (e.allDay) {
      lines.push(
        `DTSTART;VALUE=DATE:${dateStamp(e.startDate!)}`,
        `DTEND;VALUE=DATE:${dateStamp(e.endDate!)}`,
      );
    } else {
      lines.push(timed('DTSTART', e.startUtc!), timed('DTEND', e.endUtc!));
    }
    if (e.recurrenceId) {
      lines.push(
        /^\d{4}-\d{2}-\d{2}$/.test(e.recurrenceId)
          ? `RECURRENCE-ID;VALUE=DATE:${dateStamp(e.recurrenceId)}`
          : timed('RECURRENCE-ID', e.recurrenceId),
      );
    }
    if (e.rrule) lines.push(`RRULE:${e.rrule.replace(/^RRULE:/i, '')}`);
    for (const x of e.exdates ?? []) {
      lines.push(
        /^\d{4}-\d{2}-\d{2}$/.test(x) ? `EXDATE;VALUE=DATE:${dateStamp(x)}` : timed('EXDATE', x),
      );
    }
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    if (e.status && e.status !== 'confirmed') lines.push(`STATUS:${e.status.toUpperCase()}`);
    if (e.busy === false) lines.push('TRANSP:TRANSPARENT');
    if (e.categories?.length) lines.push(`CATEGORIES:${e.categories.map(escapeText).join(',')}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
