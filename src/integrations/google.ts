/**
 * Google Calendar (API v3). Scopes: calendar.readonly (read), calendar.events (only if the
 * user enables "show my time blocks in Google Calendar").
 * Sync: full sync from 60 days ago, then incremental with syncToken; HTTP 410 → full resync.
 */
import { DateTime } from 'luxon';
import { addDays } from '@/domain/dates';
import { resolveTzid } from '@/domain/ics';
import { expectOk, getJson, qs, sendJson } from './http';
import type {
  BlockPayload,
  CalendarAdapter,
  EventSyncResult,
  Http,
  RemoteCalendar,
  RemoteEvent,
} from './types';
import { IntegrationError } from './types';

const API = 'https://www.googleapis.com/calendar/v3';

interface GCalendarListEntry {
  id: string;
  summary: string;
  summaryOverride?: string;
  backgroundColor?: string;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  primary?: boolean;
  timeZone?: string;
  hidden?: boolean;
}

interface GTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GEvent {
  id: string;
  etag?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: GTime;
  end?: GTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GTime;
  transparency?: 'opaque' | 'transparent';
  iCalUID?: string;
  extendedProperties?: { private?: Record<string, string> };
}

interface GEventsPage {
  items?: GEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
  timeZone?: string;
}

function toInstant(t: GTime | undefined, fallbackZone: string): string | null {
  if (!t?.dateTime) return null;
  const dt = DateTime.fromISO(t.dateTime, { zone: t.timeZone ?? fallbackZone, setZone: false });
  return dt.isValid ? dt.toUTC().toISO() : null;
}

/** Parses RRULE/EXDATE lines from the `recurrence` array. RDATE is not supported. */
export function parseRecurrence(
  lines: string[] | undefined,
  zone: string,
): { rrule: string | null; exdates: string[] } {
  let rrule: string | null = null;
  const exdates: string[] = [];
  for (const line of lines ?? []) {
    if (line.startsWith('RRULE:')) rrule = line.slice(6);
    else if (line.startsWith('EXDATE')) {
      const m = /^EXDATE(?:;([^:]*))?:(.*)$/.exec(line);
      if (!m) continue;
      const params = Object.fromEntries(
        (m[1] ?? '')
          .split(';')
          .filter(Boolean)
          .map((p) => p.split('=') as [string, string]),
      );
      const tz = resolveTzid(params.TZID) ?? zone;
      for (const v of m[2]!.split(',')) {
        if (/^\d{8}$/.test(v)) exdates.push(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`);
        else {
          const utc = v.endsWith('Z');
          const dt = DateTime.fromFormat(v.replace('Z', ''), "yyyyMMdd'T'HHmmss", {
            zone: utc ? 'utc' : tz,
          });
          if (dt.isValid) exdates.push(dt.toUTC().toISO()!);
        }
      }
    }
  }
  return { rrule, exdates };
}

export function mapGoogleEvent(e: GEvent, calendarZone: string): RemoteEvent {
  const original = e.originalStartTime;
  // A cancelled instance carries only its original start; it exists to hide that occurrence.
  const start = e.start ?? original;
  const end = e.end ?? (original?.date ? { date: addDays(original.date, 1) } : original);
  const allDay = !!start?.date;
  const zone = resolveTzid(start?.timeZone) ?? calendarZone;
  const { rrule, exdates } = parseRecurrence(e.recurrence, zone);
  const recurrenceId = original ? (original.date ?? toInstant(original, zone)) : null;
  return {
    externalId: e.id,
    etag: e.etag ?? null,
    seriesExternalId: e.recurringEventId ?? null,
    keelOwned: e.extendedProperties?.private?.keel === 'time-block',
    uid:
      e.iCalUID ?? (e.recurringEventId ? `${e.recurringEventId}@google.com` : `${e.id}@google.com`),
    recurrenceId,
    title: e.summary?.trim() || '(No title)',
    description: e.description ?? '',
    location: e.location ?? '',
    url: e.htmlLink ?? null,
    allDay,
    startUtc: allDay ? null : toInstant(start, zone),
    endUtc: allDay ? null : toInstant(end, zone),
    startDate: allDay ? start!.date! : null,
    endDate: allDay ? (end?.date ?? addDays(start!.date!, 1)) : null,
    tz: zone,
    rrule,
    exdates,
    status: e.status ?? 'confirmed',
    busy: e.transparency !== 'transparent',
  };
}

export const googleCalendar: CalendarAdapter = {
  async listCalendars(http: Http): Promise<RemoteCalendar[]> {
    const out: RemoteCalendar[] = [];
    let pageToken: string | undefined;
    do {
      const page = await getJson<{ items: GCalendarListEntry[]; nextPageToken?: string }>(
        http,
        `${API}/users/me/calendarList${qs({ minAccessRole: 'reader', maxResults: 250, pageToken })}`,
        'List Google calendars',
      );
      for (const c of page.items ?? []) {
        out.push({
          externalId: c.id,
          name: c.summaryOverride ?? c.summary,
          color: c.backgroundColor ?? null,
          writable: c.accessRole === 'owner' || c.accessRole === 'writer',
          primary: !!c.primary,
          timezone: c.timeZone ?? null,
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  },

  async syncEvents(http, calendarId, cursor, window): Promise<EventSyncResult> {
    const upserts: RemoteEvent[] = [];
    const deletedIds: string[] = [];
    let pageToken: string | undefined;
    let nextSync: string | null;
    let zone = 'UTC';
    for (;;) {
      const params = cursor
        ? { syncToken: cursor, pageToken, maxResults: 250, showDeleted: true }
        : { timeMin: window.from, pageToken, maxResults: 250, showDeleted: true };
      const res = await http({
        method: 'GET',
        url: `${API}/calendars/${encodeURIComponent(calendarId)}/events${qs(params)}`,
        headers: [['Accept', 'application/json']],
      });
      if (res.status === 410 && cursor) {
        // Sync token expired: start over without it.
        const full = await googleCalendar.syncEvents(http, calendarId, null, window);
        return { ...full, fullResync: true };
      }
      const page = JSON.parse(expectOk(res, 'Sync Google events').body) as GEventsPage;
      zone = resolveTzid(page.timeZone) ?? zone;
      for (const e of page.items ?? []) {
        // Cancelled series masters/single events are deletions; cancelled instances of a
        // recurring series are kept as cancelled overrides (they hide that occurrence).
        if (e.status === 'cancelled' && !e.recurringEventId) deletedIds.push(e.id);
        else upserts.push(mapGoogleEvent(e, zone));
      }
      if (page.nextPageToken) {
        pageToken = page.nextPageToken;
        continue;
      }
      nextSync = page.nextSyncToken ?? null;
      break;
    }
    return { upserts, deletedIds, cursor: nextSync, fullResync: !cursor };
  },

  async upsertBlock(http, calendarId, externalId, block: BlockPayload) {
    const body = {
      summary: block.title,
      description: `${block.notes ? `${block.notes}\n\n` : ''}Time block from Keel.`,
      start: { dateTime: block.startUtc, timeZone: block.tz },
      end: { dateTime: block.endUtc, timeZone: block.tz },
      transparency: 'opaque',
      extendedProperties: { private: { keel: 'time-block' } },
    };
    const base = `${API}/calendars/${encodeURIComponent(calendarId)}/events`;
    try {
      const saved = await sendJson<GEvent>(
        http,
        externalId ? 'PUT' : 'POST',
        externalId ? `${base}/${encodeURIComponent(externalId)}` : base,
        body,
        'Save time block to Google',
      );
      return saved ? { externalId: saved.id, etag: saved.etag ?? null } : null;
    } catch (e) {
      if (e instanceof IntegrationError && e.kind === 'gone') return null;
      throw e;
    }
  },

  async deleteBlock(http, calendarId, externalId) {
    const res = await http({
      method: 'DELETE',
      url: `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
    });
    if (res.status === 404 || res.status === 410) return;
    expectOk(res, 'Delete time block from Google');
  },
};
