/** Mapping between SQLite rows (snake_case, 0/1 booleans, JSON text) and domain objects. */
import type { SqlValue } from '@/db/driver';
import type {
  AccountStatus,
  IntegrationAccount,
  Area,
  Calendar,
  CalendarEvent,
  EventStatus,
  Priority,
  Project,
  RecurrenceSeries,
  Ritual,
  RitualKind,
  Subtask,
  Tag,
  Task,
  TaskLink,
  TimeBlock,
  TimeSession,
} from '@/domain/types';

type R = Record<string, SqlValue>;

type V = SqlValue | undefined;
const s = (v: V): string => (v == null ? '' : String(v));
const sn = (v: V): string | null => (v == null ? null : String(v));
const n = (v: V): number => (v == null ? 0 : Number(v));
const nn = (v: V): number | null => (v == null ? null : Number(v));
const b = (v: V): boolean => Number(v) === 1;

export function parseJson<T>(v: V, fallback: T): T {
  if (v == null || v === '') return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}

export function rowToArea(r: R): Area {
  return {
    id: s(r.id),
    name: s(r.name),
    color: s(r.color),
    sortOrder: n(r.sort_order),
    archivedAt: sn(r.archived_at),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export function rowToProject(r: R): Project {
  return {
    id: s(r.id),
    areaId: sn(r.area_id),
    name: s(r.name),
    color: s(r.color),
    notes: s(r.notes),
    sortOrder: n(r.sort_order),
    archivedAt: sn(r.archived_at),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export function rowToTag(r: R): Tag {
  return { id: s(r.id), name: s(r.name), color: s(r.color), createdAt: s(r.created_at) };
}

export function rowToSubtask(r: R): Subtask {
  return {
    id: s(r.id),
    taskId: s(r.task_id),
    title: s(r.title),
    completedAt: sn(r.completed_at),
    sortOrder: n(r.sort_order),
  };
}

export function rowToLink(r: R): TaskLink {
  return {
    id: s(r.id),
    taskId: s(r.task_id),
    url: s(r.url),
    title: s(r.title),
    sortOrder: n(r.sort_order),
  };
}

export function rowToTask(r: R): Task {
  return {
    id: s(r.id),
    title: s(r.title),
    notes: s(r.notes),
    projectId: sn(r.project_id),
    areaId: sn(r.area_id),
    priority: n(r.priority) as Priority,
    estimateMin: nn(r.estimate_min),
    dueDate: sn(r.due_date),
    backlogOrder: n(r.backlog_order),
    completedAt: sn(r.completed_at),
    archivedAt: sn(r.archived_at),
    recurrenceId: sn(r.recurrence_id),
    recurrenceDate: sn(r.recurrence_date),
    source: s(r.source) || 'local',
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
    planDate: sn(r.plan_date),
    planOrder: n(r.plan_order),
    planEntryId: sn(r.plan_entry_id),
    rolloverCount: n(r.rollover_count),
    tagIds: [],
    subtasks: [],
    links: [],
  };
}

export function rowToSeries(r: R): RecurrenceSeries {
  return {
    id: s(r.id),
    rrule: s(r.rrule),
    dtstart: s(r.dtstart),
    title: s(r.title),
    notes: s(r.notes),
    projectId: sn(r.project_id),
    areaId: sn(r.area_id),
    priority: n(r.priority) as Priority,
    estimateMin: nn(r.estimate_min),
    tagIds: parseJson<string[]>(r.tag_ids, []),
    subtasks: parseJson<string[]>(r.subtasks, []),
    startTime: sn(r.start_time),
    dueOffsetDays: nn(r.due_offset_days),
    generatedThrough: sn(r.generated_through),
    endedAt: sn(r.ended_at),
    skipDates: [],
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export function rowToBlock(r: R): TimeBlock {
  return {
    id: s(r.id),
    taskId: s(r.task_id),
    startUtc: s(r.start_utc),
    endUtc: s(r.end_utc),
    tz: s(r.tz),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export function rowToSession(r: R): TimeSession {
  return {
    id: s(r.id),
    taskId: s(r.task_id),
    startUtc: s(r.start_utc),
    endUtc: sn(r.end_utc),
    heartbeatUtc: sn(r.heartbeat_utc),
    source: s(r.source) === 'manual' ? 'manual' : 'timer',
    note: s(r.note),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export function rowToCalendar(r: R): Calendar {
  return {
    id: s(r.id),
    accountId: sn(r.account_id),
    source: s(r.source),
    name: s(r.name),
    color: s(r.color),
    timezone: sn(r.timezone),
    isVisible: b(r.is_visible),
    isWritable: b(r.is_writable),
    countsForAvailability: b(r.counts_for_availability),
    sortOrder: n(r.sort_order),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export function rowToEvent(r: R): CalendarEvent {
  return {
    id: s(r.id),
    calendarId: s(r.calendar_id),
    uid: sn(r.uid),
    recurrenceId: sn(r.recurrence_id),
    title: s(r.title),
    description: s(r.description),
    location: s(r.location),
    url: sn(r.url),
    allDay: b(r.all_day),
    startUtc: sn(r.start_utc),
    endUtc: sn(r.end_utc),
    startDate: sn(r.start_date),
    endDate: sn(r.end_date),
    tz: sn(r.tz),
    rrule: sn(r.rrule),
    exdates: parseJson<string[]>(r.exdates, []),
    status: (s(r.status) || 'confirmed') as EventStatus,
    busy: b(r.busy),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export function rowToRitual(r: R): Ritual {
  return {
    id: s(r.id),
    kind: s(r.kind) as RitualKind,
    period: s(r.period),
    startedAt: sn(r.started_at),
    completedAt: sn(r.completed_at),
    reflection: s(r.reflection),
    data: parseJson<Record<string, unknown>>(r.data, {}),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export function rowToAccount(r: R): IntegrationAccount {
  return {
    id: s(r.id),
    provider: s(r.provider),
    label: s(r.label),
    status: (s(r.status) || 'connected') as AccountStatus,
    config: parseJson<Record<string, unknown>>(r.config, {}),
    syncState: parseJson<Record<string, unknown>>(r.sync_state, {}),
    lastSyncAt: sn(r.last_sync_at),
    lastError: sn(r.last_error),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}
