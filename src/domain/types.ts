import type { ISODate, ISOInstant } from './dates';

export type Priority = 0 | 1 | 2 | 3;

export const PRIORITY_LABELS: Record<Priority, string> = {
  0: 'None',
  1: 'Low',
  2: 'Medium',
  3: 'High',
};

export interface Area {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  archivedAt: ISOInstant | null;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

export interface Project {
  id: string;
  areaId: string | null;
  name: string;
  color: string;
  notes: string;
  sortOrder: number;
  archivedAt: ISOInstant | null;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  createdAt: ISOInstant;
}

export interface Subtask {
  id: string;
  taskId: string;
  title: string;
  completedAt: ISOInstant | null;
  sortOrder: number;
}

export interface TaskLink {
  id: string;
  taskId: string;
  url: string;
  title: string;
  sortOrder: number;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  projectId: string | null;
  areaId: string | null;
  priority: Priority;
  estimateMin: number | null;
  /** Deadline. Independent of when the task is planned or scheduled. */
  dueDate: ISODate | null;
  backlogOrder: number;
  completedAt: ISOInstant | null;
  archivedAt: ISOInstant | null;
  recurrenceId: string | null;
  recurrenceDate: ISODate | null;
  source: string;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
  /** The day the task is planned for (from its current day_plan_entries row). */
  planDate: ISODate | null;
  planOrder: number;
  planEntryId: string | null;
  /** How many times this task was carried forward to a later day. */
  rolloverCount: number;
  tagIds: string[];
  subtasks: Subtask[];
  links: TaskLink[];
}

export interface RecurrenceSeries {
  id: string;
  rrule: string;
  dtstart: ISODate;
  title: string;
  notes: string;
  projectId: string | null;
  areaId: string | null;
  priority: Priority;
  estimateMin: number | null;
  tagIds: string[];
  subtasks: string[];
  startTime: string | null;
  dueOffsetDays: number | null;
  generatedThrough: ISODate | null;
  endedAt: ISOInstant | null;
  /** Occurrence dates skipped or deleted by the user. */
  skipDates: ISODate[];
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

export interface TimeBlock {
  id: string;
  taskId: string;
  startUtc: ISOInstant;
  endUtc: ISOInstant;
  tz: string;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

export interface TimeSession {
  id: string;
  taskId: string;
  startUtc: ISOInstant;
  endUtc: ISOInstant | null;
  heartbeatUtc: ISOInstant | null;
  source: 'timer' | 'manual';
  note: string;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

export interface Calendar {
  id: string;
  accountId: string | null;
  source: string;
  name: string;
  color: string;
  timezone: string | null;
  isVisible: boolean;
  isWritable: boolean;
  countsForAvailability: boolean;
  sortOrder: number;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

export type EventStatus = 'confirmed' | 'tentative' | 'cancelled';

export interface CalendarEvent {
  id: string;
  calendarId: string;
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
  /** Extra occurrences (RDATE): UTC instants for timed events, dates for all-day ones. */
  rdates: string[];
  status: EventStatus;
  busy: boolean;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

/** A concrete, displayable event occurrence (recurring series expanded). */
export interface EventOccurrence {
  /** Unique per occurrence: `${eventId}` or `${eventId}@${key}`. */
  key: string;
  event: CalendarEvent;
  allDay: boolean;
  start: number;
  end: number;
  startDate: ISODate | null;
  endDate: ISODate | null;
}

export type RitualKind = 'plan' | 'shutdown' | 'weekly';

export interface Ritual {
  id: string;
  kind: RitualKind;
  period: ISODate;
  startedAt: ISOInstant | null;
  completedAt: ISOInstant | null;
  reflection: string;
  data: Record<string, unknown>;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

export type AccountStatus = 'connected' | 'needs_reauth' | 'error' | 'disconnected';

export interface IntegrationAccount {
  id: string;
  provider: string;
  label: string;
  status: AccountStatus;
  config: Record<string, unknown>;
  syncState: Record<string, unknown>;
  lastSyncAt: ISOInstant | null;
  lastError: string | null;
  createdAt: ISOInstant;
  updatedAt: ISOInstant;
}

export type ThemePref = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';
export type RolloverMode = 'auto' | 'manual';

export interface Settings {
  onboarded: boolean;
  theme: ThemePref;
  density: Density;
  /** ISO weekday the week starts on: 1 = Monday, 7 = Sunday, 6 = Saturday. */
  weekStartsOn: number;
  hour12: boolean;
  /** 'system' follows the OS zone; otherwise an IANA zone. */
  timeZone: string;
  /** Optional second zone shown alongside the calendar. */
  secondaryTimeZone: string | null;
  workingDays: number[];
  workdayStart: string;
  workdayEnd: string;
  /** Planned-work threshold per day, in minutes (tasks + meetings). */
  dailyCapacityMin: number;
  /** Gap kept around meetings when auto-scheduling. */
  bufferMin: number;
  defaultEstimateMin: number;
  /** Carry unfinished tasks forward automatically at the start of a new day. */
  rolloverMode: RolloverMode;
  /** Minutes of calendar grid per snap step. */
  calendarSnapMin: number;
  calendarHourHeight: number;
  visibleDays: number;
  notificationsEnabled: boolean;
  notifyBlockStart: boolean;
  notifyEstimateReached: boolean;
  notifyShutdown: boolean;
  shutdownReminderTime: string;
  /** A timer running across a gap longer than this (e.g. sleep) asks before counting it. */
  idleThresholdMin: number;
  shortcuts: Record<string, string>;
  /** Zone recorded at last launch, to detect time zone changes. */
  lastKnownZone: string | null;
  lastRolloverDate: ISODate | null;
  lastAutoBackupAt: ISOInstant | null;
  autoBackup: boolean;
  defaultCalendarId: string | null;
  showCompletedInBoard: boolean;
  /** Show the floating focus bar automatically when a timer starts. */
  focusBarOnTimerStart: boolean;
  /** Show the floating focus bar automatically when Focus mode opens. */
  focusBarOnFocus: boolean;
  /** System-wide shortcut (Tauri accelerator syntax) to show/hide the focus bar; '' = off. */
  globalShortcutBar: string;
  /** System-wide shortcut to start/pause the timer; '' = off. */
  globalShortcutTimer: string;
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  theme: 'system',
  density: 'comfortable',
  weekStartsOn: 1,
  hour12: false,
  timeZone: 'system',
  secondaryTimeZone: null,
  workingDays: [1, 2, 3, 4, 5],
  workdayStart: '09:00',
  workdayEnd: '17:30',
  dailyCapacityMin: 6 * 60,
  bufferMin: 5,
  defaultEstimateMin: 30,
  rolloverMode: 'auto',
  calendarSnapMin: 15,
  calendarHourHeight: 56,
  visibleDays: 5,
  notificationsEnabled: false,
  notifyBlockStart: true,
  notifyEstimateReached: true,
  notifyShutdown: false,
  shutdownReminderTime: '17:15',
  idleThresholdMin: 20,
  shortcuts: {},
  lastKnownZone: null,
  lastRolloverDate: null,
  lastAutoBackupAt: null,
  autoBackup: true,
  defaultCalendarId: null,
  showCompletedInBoard: true,
  focusBarOnTimerStart: true,
  focusBarOnFocus: true,
  globalShortcutBar: 'CommandOrControl+Alt+Shift+F',
  globalShortcutTimer: 'CommandOrControl+Alt+Shift+Space',
};

export const PALETTE = [
  '#2F8F83',
  '#3E7CB1',
  '#7A5EA8',
  '#C0587E',
  '#D1703C',
  '#C9A227',
  '#5E8C3A',
  '#6B7280',
  '#1E6F9F',
  '#A0522D',
] as const;
