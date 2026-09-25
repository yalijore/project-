/** Transient UI state (navigation, open dialogs, selection). Not persisted. */
import { create } from 'zustand';
import type { ISODate } from '@/domain/dates';

export type View =
  | { name: 'today' }
  | { name: 'week' }
  | { name: 'inbox' }
  | { name: 'backlog' }
  | { name: 'project'; id: string }
  | { name: 'area'; id: string }
  | { name: 'tag'; id: string }
  | { name: 'search'; query?: string }
  | { name: 'completed' }
  | { name: 'review' }
  | { name: 'calendars' }
  | { name: 'integrations' }
  | { name: 'settings'; section?: string };

export type Ritual =
  { kind: 'plan' | 'shutdown'; date: ISODate } | { kind: 'weekly'; date: ISODate };

export interface ZoneChange {
  from: string;
  to: string;
}

export interface GapPrompt {
  sessionId: string;
  taskId: string;
  gapStart: string;
  gapMinutes: number;
}

interface UiState {
  view: View;
  history: View[];
  /** First day shown on the board. */
  boardStart: ISODate | null;
  /** Day shown in the calendar side panel. */
  panelDate: ISODate | null;
  weekStart: ISODate | null;
  calendarPanel: boolean;
  sidebar: boolean;
  openTaskId: string | null;
  captureOpen: boolean;
  captureDefaults: { planDate?: ISODate | null; projectId?: string | null; areaId?: string | null };
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  /** The update wizard (Settings → About, or the command palette). */
  updatesOpen: boolean;
  focusTaskId: string | null;
  ritual: Ritual | null;
  selection: string[];
  zoneChange: ZoneChange | null;
  gapPrompt: GapPrompt | null;
  /** Event being edited (and which occurrence, for recurring events). */
  editEvent: { id: string; occurrenceKey?: string } | null;
  /** New event being created from a calendar selection. */
  eventDraft: { date: ISODate; startMin: number; endMin: number; allDay?: boolean } | null;
  /** Task the floating focus bar is about (the running task wins; see app/focusBar). */
  barTaskId: string | null;
  /** Whether the floating focus bar window is open. */
  barVisible: boolean;
}

export const useUi = create<UiState>(() => ({
  view: { name: 'today' },
  history: [],
  boardStart: null,
  panelDate: null,
  weekStart: null,
  calendarPanel: true,
  sidebar: true,
  openTaskId: null,
  captureOpen: false,
  captureDefaults: {},
  paletteOpen: false,
  shortcutsOpen: false,
  updatesOpen: false,
  focusTaskId: null,
  ritual: null,
  selection: [],
  zoneChange: null,
  gapPrompt: null,
  editEvent: null,
  eventDraft: null,
  barTaskId: null,
  barVisible: false,
}));

export const ui = {
  navigate(view: View) {
    useUi.setState((s) => ({
      view,
      history: [...s.history.slice(-30), s.view],
      selection: [],
    }));
  },
  back() {
    useUi.setState((s) => {
      const prev = s.history.at(-1);
      return prev ? { view: prev, history: s.history.slice(0, -1), selection: [] } : {};
    });
  },
  openTask(id: string | null) {
    useUi.setState({ openTaskId: id });
  },
  capture(defaults: UiState['captureDefaults'] = {}) {
    useUi.setState({ captureOpen: true, captureDefaults: defaults });
  },
  focus(taskId: string | null) {
    useUi.setState({ focusTaskId: taskId });
  },
  ritual(r: Ritual | null) {
    useUi.setState({ ritual: r });
  },
  select(ids: string[]) {
    useUi.setState({ selection: ids });
  },
  toggleSelect(id: string) {
    useUi.setState((s) => ({
      selection: s.selection.includes(id)
        ? s.selection.filter((x) => x !== id)
        : [...s.selection, id],
    }));
  },
};
