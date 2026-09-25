/**
 * Microsoft 365 / Outlook.com calendars via Microsoft Graph. Scopes: Calendars.Read (read),
 * Calendars.ReadWrite (only for "show my time blocks in Outlook"), User.Read, offline_access.
 *
 * Sync: calendarView delta over a rolling window (60 days back, 365 ahead). The delta lists
 * each occurrence of a recurring series separately; Keel stores the series instead. For every
 * series the delta touches it reads the series master, turns its recurrence pattern into an
 * RRULE in the series' own time zone, keeps changed occurrences ("exceptions") as overrides,
 * and records occurrences Outlook no longer has inside the window as EXDATEs. Removed
 * occurrences arrive as bare ids, so when one is not an event Keel stores, the stored series
 * of that calendar are checked again. Patterns that cannot be written as an RRULE (or a
 * series time zone Keel cannot identify) fall back to storing the occurrences one by one.
 */
import { DateTime } from 'luxon';
import { expandAllDayEvent, expandTimedEvent } from '@/domain/recurrence';
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
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  seriesMasterId?: string;
  /** Original start of an occurrence (DateTimeOffset). */
  originalStart?: string;
  recurrence?: GraphRecurrence | null;
}

export interface GraphRecurrence {
  pattern: {
    type:
      | 'daily'
      | 'weekly'
      | 'absoluteMonthly'
      | 'relativeMonthly'
      | 'absoluteYearly'
      | 'relativeYearly';
    interval?: number;
    month?: number;
    dayOfMonth?: number;
    daysOfWeek?: string[];
    firstDayOfWeek?: string;
    index?: 'first' | 'second' | 'third' | 'fourth' | 'last';
  };
  range: {
    type: 'endDate' | 'noEnd' | 'numbered';
    startDate?: string;
    endDate?: string;
    recurrenceTimeZone?: string;
    numberOfOccurrences?: number;
  };
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

const GRAPH_HEADERS: [string, string][] = [
  ['Accept', 'application/json'],
  PREFER_UTC,
  ['Prefer', 'odata.maxpagesize=200'],
];
/** Marks delta cursors from the series-aware sync (older cursors force a full resync). */
const CURSOR_PREFIX = 'series:';

const DAYS: Record<string, string> = {
  sunday: 'SU',
  monday: 'MO',
  tuesday: 'TU',
  wednesday: 'WE',
  thursday: 'TH',
  friday: 'FR',
  saturday: 'SA',
};
const SETPOS = { first: 1, second: 2, third: 3, fourth: 4, last: -1 } as const;

/**
 * Graph's recurrence pattern as an RRULE, or null when it has no RRULE equivalent. Like
 * Outlook, a monthly or yearly day that a month lacks (the 31st, February 29) falls on the
 * month's last day.
 */
export function graphRecurrenceToRule(r: GraphRecurrence | null | undefined): string | null {
  if (!r?.pattern || !r.range) return null;
  const p = r.pattern;
  const days = (p.daysOfWeek ?? []).map((d) => DAYS[d.toLowerCase()]);
  if (days.some((d) => !d)) return null;
  const monthDay = (d: number | undefined) => {
    if (!d || d < 1 || d > 31) return null;
    if (d < 29) return [`BYMONTHDAY=${d}`];
    const upTo = Array.from({ length: d - 27 }, (_, i) => 28 + i);
    return [`BYMONTHDAY=${upTo.join(',')}`, 'BYSETPOS=-1'];
  };
  const setPos = SETPOS[p.index ?? 'first'];
  const parts: string[] = [];
  switch (p.type) {
    case 'daily':
      parts.push('FREQ=DAILY');
      break;
    case 'weekly':
      if (!days.length) return null;
      parts.push('FREQ=WEEKLY', `BYDAY=${days.join(',')}`);
      break;
    case 'absoluteMonthly': {
      const md = monthDay(p.dayOfMonth);
      if (!md) return null;
      parts.push('FREQ=MONTHLY', ...md);
      break;
    }
    case 'relativeMonthly':
      if (!days.length || !setPos) return null;
      parts.push('FREQ=MONTHLY', `BYDAY=${days.join(',')}`, `BYSETPOS=${setPos}`);
      break;
    case 'absoluteYearly': {
      const md = monthDay(p.dayOfMonth);
      if (!md || !p.month) return null;
      parts.push('FREQ=YEARLY', `BYMONTH=${p.month}`, ...md);
      break;
    }
    case 'relativeYearly':
      if (!days.length || !p.month || !setPos) return null;
      parts.push(
        'FREQ=YEARLY',
        `BYMONTH=${p.month}`,
        `BYDAY=${days.join(',')}`,
        `BYSETPOS=${setPos}`,
      );
      break;
    default:
      return null;
  }
  if ((p.interval ?? 1) > 1) parts.push(`INTERVAL=${Math.floor(p.interval!)}`);
  const wkst = p.firstDayOfWeek && DAYS[p.firstDayOfWeek.toLowerCase()];
  if (p.type === 'weekly' && wkst && wkst !== 'MO') parts.push(`WKST=${wkst}`);
  if (r.range.type === 'endDate' && r.range.endDate)
    parts.push(`UNTIL=${r.range.endDate.replace(/-/g, '')}T235959Z`);
  else if (r.range.type === 'numbered' && r.range.numberOfOccurrences)
    parts.push(`COUNT=${Math.max(1, Math.floor(r.range.numberOfOccurrences))}`);
  return parts.join(';');
}

const iso = (s: string) => new Date(Date.parse(s)).toISOString();

/** Short, stable fingerprint of a string (to fold computed EXDATEs into the change marker). */
function fingerprint(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function listInstances(
  http: Http,
  masterId: string,
  window: { from: string; to: string },
  brief: boolean,
): Promise<GraphEvent[]> {
  const out: GraphEvent[] = [];
  const query: Record<string, string> = { startDateTime: window.from, endDateTime: window.to };
  if (brief) query.$select = 'id,type,start,end,isAllDay,isCancelled,originalStart';
  let url: string | undefined =
    `${API}/me/events/${encodeURIComponent(masterId)}/instances${qs(query)}`;
  while (url) {
    const page: { value: GraphEvent[]; '@odata.nextLink'?: string } = await getJson(
      http,
      url,
      'Read an Outlook series',
      GRAPH_HEADERS.slice(1),
    );
    out.push(...page.value);
    url = page['@odata.nextLink'];
  }
  return out;
}

interface Series {
  master: RemoteEvent;
  /** The occurrence an instance stands for (its original start), in Keel's override form. */
  keyOf(e: GraphEvent): string | null;
}

/**
 * Reads a series master and builds the series: RRULE, zone, and EXDATEs for occurrences
 * inside the window that Outlook no longer lists. `known` are the series' instances from a
 * full delta (otherwise they are listed). Null when the series cannot be expressed as a rule.
 */
async function loadSeries(
  http: Http,
  masterId: string,
  known: GraphEvent[] | null,
  window: { from: string; to: string },
): Promise<Series | 'gone' | null> {
  let m: GraphEvent;
  try {
    m = await getJson<GraphEvent>(
      http,
      `${API}/me/events/${encodeURIComponent(masterId)}${qs({
        $select:
          'id,subject,bodyPreview,location,start,end,isAllDay,isCancelled,showAs,webLink,iCalUId,categories,type,recurrence,originalStartTimeZone',
      })}`,
      'Read an Outlook series',
      [PREFER_UTC],
    );
  } catch (e) {
    if (e instanceof IntegrationError && e.kind === 'gone') return 'gone';
    throw e;
  }
  if (m.isCancelled) return 'gone';
  const rrule = graphRecurrenceToRule(m.recurrence);
  if (!rrule) return null;
  const allDay = !!m.isAllDay;
  const tz =
    resolveTzid(m.recurrence?.range.recurrenceTimeZone) ?? resolveTzid(m.originalStartTimeZone);
  if (!allDay && !tz) return null;
  const base = { ...mapGraphEvent(m), rrule, tz: allDay ? null : tz };
  const instances = (known ?? (await listInstances(http, masterId, window, true))).filter(
    (e) => !e.isCancelled,
  );
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);

  if (allDay) {
    if (!base.startDate || !base.endDate) return null;
    const dates = new Set(
      expandAllDayEvent(
        { startDate: base.startDate, endDate: base.endDate, rrule, exdates: [] },
        window.from.slice(0, 10),
        window.to.slice(0, 10),
      ).map((o) => o.key),
    );
    // Graph gives an occurrence's original start as an instant; the date it stands for is
    // that instant's UTC date or its date in the series' zone.
    const keyOf = (e: GraphEvent): string | null => {
      const candidates = [
        e.type === 'occurrence' ? e.start?.dateTime.slice(0, 10) : undefined,
        e.originalStart?.slice(0, 10),
        e.originalStart && tz ? DateTime.fromISO(e.originalStart, { zone: tz }).toISODate() : null,
      ].filter((d): d is string => !!d);
      return candidates.find((d) => dates.has(d)) ?? null;
    };
    const present = new Set(instances.map(keyOf));
    const lastStart = window.to.slice(0, 10);
    const exdates = [...dates].filter(
      (d) => !present.has(d) && d >= window.from.slice(0, 10) && d < lastStart,
    );
    return {
      master: { ...base, exdates, etag: `${base.etag ?? ''}#${fingerprint(exdates.join())}` },
      keyOf,
    };
  }

  if (!base.startUtc || !base.endUtc) return null;
  const occurrences = expandTimedEvent(
    { startUtc: base.startUtc, endUtc: base.endUtc, tz: tz!, rrule, exdates: [] },
    from,
    to,
  );
  const keys = new Set(occurrences.map((o) => o.key));
  const keyOf = (e: GraphEvent): string | null => {
    const original = e.originalStart ?? utcInstant(e.start);
    if (!original) return null;
    const k = iso(original);
    return keys.has(k) ? k : null;
  };
  const present = new Set(instances.map(keyOf));
  // Only occurrences wholly inside the window: Outlook was asked about exactly that range.
  const exdates = occurrences
    .filter((o) => o.start >= from && o.end <= to && !present.has(o.key))
    .map((o) => o.key);
  return {
    master: { ...base, exdates, etag: `${base.etag ?? ''}#${fingerprint(exdates.join())}` },
    keyOf,
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

  async syncEvents(http, calendarId, cursor, window, local): Promise<EventSyncResult> {
    // Cursors from before series support point into a feed whose occurrences Keel stored
    // one by one; start over so the stored copy is replaced by series.
    const deltaLink = cursor?.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length) : null;
    const full = !deltaLink;
    let url: string | undefined =
      deltaLink ??
      `${API}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta${qs({ startDateTime: window.from, endDateTime: window.to })}`;
    const singles: GraphEvent[] = [];
    const bySeries = new Map<string, GraphEvent[]>();
    const removed: string[] = [];
    let next: string | null = null;
    while (url) {
      const res = await http({ method: 'GET', url, headers: GRAPH_HEADERS });
      if (res.status === 410 && !full) {
        const again = await microsoftCalendar.syncEvents(http, calendarId, null, window, local);
        return { ...again, fullResync: true };
      }
      const page = JSON.parse(expectOk(res, 'Sync Outlook events').body) as DeltaPage;
      for (const e of page.value) {
        if (e['@removed']) removed.push(e.id);
        else if (e.seriesMasterId) {
          const list = bySeries.get(e.seriesMasterId) ?? [];
          list.push(e);
          bySeries.set(e.seriesMasterId, list);
        } else if (e.isCancelled) removed.push(e.id);
        else singles.push(e);
      }
      url = page['@odata.nextLink'];
      if (!url) next = page['@odata.deltaLink'] ?? null;
    }

    const upserts = singles.map(mapGraphEvent);
    const deletedIds = [...removed];
    const touched = new Set(bySeries.keys());
    // A removed id Keel does not store was an occurrence of some series: check them all.
    if (!full && local && removed.some((id) => !local.ids.has(id)))
      for (const id of local.series) touched.add(id);

    for (const masterId of touched) {
      const items = bySeries.get(masterId) ?? [];
      const series = await loadSeries(http, masterId, full ? items : null, window);
      if (series === 'gone') {
        deletedIds.push(masterId);
        for (const e of items) deletedIds.push(e.id);
        continue;
      }
      if (!series) {
        // Not expressible as an RRULE: keep each occurrence as its own event, as Outlook lists them.
        const instances = full ? items : await listInstances(http, masterId, window, false);
        for (const e of instances) {
          if (e.isCancelled) deletedIds.push(e.id);
          else upserts.push(mapGraphEvent(e));
        }
        continue;
      }
      upserts.push(series.master);
      const used = new Set<string>();
      for (const e of items) {
        const key = e.type === 'exception' && !e.isCancelled ? series.keyOf(e) : null;
        if (key && !used.has(key)) {
          used.add(key);
          upserts.push({
            ...mapGraphEvent(e),
            seriesExternalId: masterId,
            recurrenceId: key,
            tz: series.master.tz,
          });
        } else if (e.type === 'exception' && !e.isCancelled) {
          upserts.push(mapGraphEvent(e)); // no matching occurrence: keep it on its own
        } else {
          // A plain occurrence is generated from the rule; drop any copy stored on its own.
          deletedIds.push(e.id);
        }
      }
    }

    const kept = new Set(upserts.map((e) => e.externalId));
    return {
      upserts,
      deletedIds: [...new Set(deletedIds)].filter((id) => !kept.has(id)),
      cursor: next ? CURSOR_PREFIX + next : null,
      fullResync: full,
    };
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
