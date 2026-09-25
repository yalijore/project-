/**
 * Microsoft 365 / Outlook.com calendars via Microsoft Graph. Scopes: Calendars.Read (read),
 * Calendars.ReadWrite (only for "show my time blocks in Outlook"), User.Read, offline_access.
 * Sync: calendarView delta over a rolling window (60 days back, 365 ahead). Graph expands
 * recurring series into instances, so every occurrence arrives as its own event.
 */
import { DateTime } from 'luxon';
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

const API = 'https://graph.microsoft.com/v1.0';
const PREFER_UTC: [string, string] = ['Prefer', 'outlook.timezone="UTC"'];

interface GraphCalendar {
  id: string;
  name: string;
  hexColor?: string;
  canEdit?: boolean;
  isDefaultCalendar?: boolean;
}

interface GraphTime {
  dateTime: string;
  timeZone: string;
}

export interface GraphEvent {
  id: string;
  '@removed'?: { reason: string };
  '@odata.etag'?: string;
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: GraphTime;
  end?: GraphTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere' | 'unknown';
  webLink?: string;
  iCalUId?: string;
  originalStartTimeZone?: string;
  categories?: string[];
}

interface DeltaPage {
  value: GraphEvent[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

function utcInstant(t: GraphTime | undefined): string | null {
  if (!t) return null;
  const dt = DateTime.fromISO(t.dateTime, { zone: t.timeZone === 'UTC' ? 'utc' : t.timeZone });
  return dt.isValid ? dt.toUTC().toISO() : null;
}

export function mapGraphEvent(e: GraphEvent): RemoteEvent {
  const allDay = !!e.isAllDay;
  return {
    externalId: e.id,
    etag: e['@odata.etag'] ?? null,
    seriesExternalId: null,
    keelOwned: !!e.categories?.includes('Keel'),
    uid: e.iCalUId ?? null,
    // Instances are standalone occurrences; keep them distinct by their own id.
    recurrenceId: null,
    title: e.subject?.trim() || '(No title)',
    description: e.bodyPreview ?? '',
    location: e.location?.displayName ?? '',
    url: e.webLink ?? null,
    allDay,
    startUtc: allDay ? null : utcInstant(e.start),
    endUtc: allDay ? null : utcInstant(e.end),
    startDate: allDay && e.start ? e.start.dateTime.slice(0, 10) : null,
    endDate: allDay && e.end ? e.end.dateTime.slice(0, 10) : null,
    tz: null,
    rrule: null,
    exdates: [],
    rdates: [],
    status: e.isCancelled ? 'cancelled' : e.showAs === 'tentative' ? 'tentative' : 'confirmed',
    busy: e.showAs !== 'free' && e.showAs !== 'workingElsewhere',
  };
}

export const microsoftCalendar: CalendarAdapter = {
  async listCalendars(http: Http): Promise<RemoteCalendar[]> {
    const out: RemoteCalendar[] = [];
    let url: string | undefined =
      `${API}/me/calendars${qs({ $select: 'id,name,hexColor,canEdit,isDefaultCalendar', $top: 100 })}`;
    while (url) {
      const page: { value: GraphCalendar[]; '@odata.nextLink'?: string } = await getJson(
        http,
        url,
        'List Outlook calendars',
      );
      for (const c of page.value) {
        out.push({
          externalId: c.id,
          name: c.name,
          color: c.hexColor && c.hexColor !== '' ? c.hexColor : null,
          writable: !!c.canEdit,
          primary: !!c.isDefaultCalendar,
          timezone: null,
        });
      }
      url = page['@odata.nextLink'];
    }
    return out;
  },

  async syncEvents(http, calendarId, cursor, window): Promise<EventSyncResult> {
    const upserts: RemoteEvent[] = [];
    const deletedIds: string[] = [];
    let url: string | undefined =
      cursor ??
      `${API}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta${qs({ startDateTime: window.from, endDateTime: window.to })}`;
    let deltaLink: string | null = null;
    while (url) {
      const res = await http({
        method: 'GET',
        url,
        headers: [['Accept', 'application/json'], PREFER_UTC, ['Prefer', 'odata.maxpagesize=200']],
      });
      if (res.status === 410 && cursor) {
        const full = await microsoftCalendar.syncEvents(http, calendarId, null, window);
        return { ...full, fullResync: true };
      }
      const page = JSON.parse(expectOk(res, 'Sync Outlook events').body) as DeltaPage;
      for (const e of page.value) {
        if (e['@removed'] || e.isCancelled) deletedIds.push(e.id);
        else upserts.push(mapGraphEvent(e));
      }
      url = page['@odata.nextLink'];
      if (!url) deltaLink = page['@odata.deltaLink'] ?? null;
    }
    return { upserts, deletedIds, cursor: deltaLink, fullResync: !cursor };
  },

  async upsertBlock(http, calendarId, externalId, block: BlockPayload) {
    const body = {
      subject: block.title,
      body: {
        contentType: 'text',
        content: `${block.notes ? `${block.notes}\n\n` : ''}Time block from Keel.`,
      },
      start: { dateTime: block.startUtc.replace('Z', ''), timeZone: 'UTC' },
      end: { dateTime: block.endUtc.replace('Z', ''), timeZone: 'UTC' },
      showAs: 'busy',
      categories: ['Keel'],
    };
    try {
      const saved = externalId
        ? await sendJson<GraphEvent>(
            http,
            'PATCH',
            `${API}/me/events/${encodeURIComponent(externalId)}`,
            body,
            'Update time block in Outlook',
          )
        : await sendJson<GraphEvent>(
            http,
            'POST',
            `${API}/me/calendars/${encodeURIComponent(calendarId)}/events`,
            body,
            'Add time block to Outlook',
          );
      return saved ? { externalId: saved.id, etag: saved['@odata.etag'] ?? null } : null;
    } catch (e) {
      if (e instanceof IntegrationError && e.kind === 'gone') return null;
      throw e;
    }
  },

  async deleteBlock(http, _calendarId, externalId) {
    const res = await http({
      method: 'DELETE',
      url: `${API}/me/events/${encodeURIComponent(externalId)}`,
    });
    if (res.status === 404 || res.status === 410) return;
    expectOk(res, 'Delete time block from Outlook');
  },
};
