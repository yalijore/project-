/** Adapter contracts for optional, networked integrations. The core app never needs them. */
import type { ISODate, ISOInstant } from '@/domain/dates';
import type { Priority } from '@/domain/types';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: [string, string][];
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** An HTTP function already bound to one account's credentials (attached in Rust). */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'network' | 'rate-limit' | 'gone' | 'provider' | 'config',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export interface RemoteCalendar {
  externalId: string;
  name: string;
  color: string | null;
  writable: boolean;
  primary: boolean;
  timezone: string | null;
}

export interface RemoteEvent {
  externalId: string;
  etag: string | null;
  /** For an overridden instance of a recurring series: the series' external id. */
  seriesExternalId: string | null;
  /** Events Keel itself created (pushed time blocks); never imported back as meetings. */
  keelOwned: boolean;
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
  tz: string | null;
  rrule: string | null;
  exdates: string[];
  /** Extra occurrences (RDATE). */
  rdates: string[];
  status: 'confirmed' | 'tentative' | 'cancelled';
  busy: boolean;
}

export interface EventSyncResult {
  upserts: RemoteEvent[];
  deletedIds: string[];
  cursor: string | null;
  /** The provider invalidated the cursor; local copies must be replaced wholesale. */
  fullResync: boolean;
}

export interface BlockPayload {
  title: string;
  notes: string;
  startUtc: ISOInstant;
  endUtc: ISOInstant;
  tz: string;
}

export interface CalendarAdapter {
  listCalendars(http: Http): Promise<RemoteCalendar[]>;
  syncEvents(
    http: Http,
    calendarId: string,
    cursor: string | null,
    window: { from: ISOInstant; to: ISOInstant },
  ): Promise<EventSyncResult>;
  /** Creates or updates a Keel time block as an event Keel owns. Returns null if the remote event is gone. */
  upsertBlock?(
    http: Http,
    calendarId: string,
    externalId: string | null,
    block: BlockPayload,
  ): Promise<{ externalId: string; etag: string | null } | null>;
  deleteBlock?(http: Http, calendarId: string, externalId: string): Promise<void>;
}

export interface RemoteTask {
  externalId: string;
  title: string;
  notes: string;
  url: string | null;
  dueDate: ISODate | null;
  completed: boolean;
  priority: Priority;
  estimateMin: number | null;
  container: string | null;
  /** Anything that changes when the remote task changes (timestamp or hash). */
  version: string;
}

export interface TaskAdapter {
  /** All open tasks assigned to the user (the adapter handles pagination). */
  fetchOpenTasks(http: Http, config: Record<string, unknown>): Promise<RemoteTask[]>;
  setCompleted?(
    http: Http,
    config: Record<string, unknown>,
    externalId: string,
    done: boolean,
  ): Promise<void>;
}
