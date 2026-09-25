/**
 * In-memory mirror of the database, used for rendering. The database is the source of
 * truth: every write goes through `actions.ts`, which commits to SQLite first (or applies an
 * optimistic patch and then reconciles) and refreshes exactly the entities it touched.
 */
import { create } from 'zustand';
import type { ISODate } from '@/domain/dates';
import { systemZone, todayIn } from '@/domain/dates';
import type {
  Area,
  Calendar,
  CalendarEvent,
  Project,
  RecurrenceSeries,
  Ritual,
  Settings,
  Tag,
  Task,
  TimeBlock,
  TimeSession,
} from '@/domain/types';
import { DEFAULT_SETTINGS } from '@/domain/types';
import type { UndoStep } from '@/db/undo';
import type { Snapshot } from './repo';

type ById<T> = Record<string, T>;

export interface DataState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  tasks: ById<Task>;
  areas: ById<Area>;
  projects: ById<Project>;
  tags: ById<Tag>;
  series: ById<RecurrenceSeries>;
  blocks: ById<TimeBlock>;
  sessions: ById<TimeSession>;
  calendars: ById<Calendar>;
  events: ById<CalendarEvent>;
  rituals: ById<Ritual>;
  settings: Settings;
  undo: UndoStep | null;
  /** Effective IANA zone (settings or system). */
  zone: string;
  today: ISODate;
}

export const byId = <T extends { id: string }>(items: T[]): ById<T> => {
  const out: ById<T> = {};
  for (const item of items) out[item.id] = item;
  return out;
};

export function effectiveZone(settings: Settings): string {
  return settings.timeZone === 'system' ? systemZone() : settings.timeZone;
}

export const useData = create<DataState>(() => ({
  status: 'loading',
  error: null,
  tasks: {},
  areas: {},
  projects: {},
  tags: {},
  series: {},
  blocks: {},
  sessions: {},
  calendars: {},
  events: {},
  rituals: {},
  settings: DEFAULT_SETTINGS,
  undo: null,
  zone: systemZone(),
  today: todayIn(systemZone()),
}));

export const getData = () => useData.getState();

export function applySnapshot(s: Snapshot) {
  const zone = effectiveZone(s.settings);
  useData.setState({
    status: 'ready',
    error: null,
    tasks: byId(s.tasks),
    areas: byId(s.areas),
    projects: byId(s.projects),
    tags: byId(s.tags),
    series: byId(s.series),
    blocks: byId(s.blocks),
    sessions: byId(s.sessions),
    calendars: byId(s.calendars),
    events: byId(s.events),
    rituals: byId(s.rituals),
    settings: s.settings,
    zone,
    today: todayIn(zone),
  });
}

/** Replaces the given tasks (and their blocks/sessions); ids missing from `tasks` were deleted. */
export function applyTasks(
  ids: string[],
  tasks: Task[],
  blocks: TimeBlock[],
  sessions: TimeSession[],
) {
  useData.setState((state) => {
    const idSet = new Set(ids);
    const nextTasks = { ...state.tasks };
    for (const id of ids) delete nextTasks[id];
    for (const t of tasks) nextTasks[t.id] = t;
    const nextBlocks: ById<TimeBlock> = {};
    for (const b of Object.values(state.blocks)) if (!idSet.has(b.taskId)) nextBlocks[b.id] = b;
    for (const b of blocks) nextBlocks[b.id] = b;
    const nextSessions: ById<TimeSession> = {};
    for (const s of Object.values(state.sessions)) if (!idSet.has(s.taskId)) nextSessions[s.id] = s;
    for (const s of sessions) nextSessions[s.id] = s;
    return { tasks: nextTasks, blocks: nextBlocks, sessions: nextSessions };
  });
}

/** Optimistically patches tasks in memory before the database write completes. */
export function patchTasks(patches: Record<string, Partial<Task>>) {
  useData.setState((state) => {
    const tasks = { ...state.tasks };
    for (const [id, patch] of Object.entries(patches)) {
      const t = tasks[id];
      if (t) tasks[id] = { ...t, ...patch };
    }
    return { tasks };
  });
}

export function setSettingsState(settings: Settings) {
  const zone = effectiveZone(settings);
  useData.setState({ settings, zone, today: todayIn(zone) });
}
