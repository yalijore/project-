/**
 * The contract between the main window (the only writer of timer state) and the floating
 * focus bar (a remote control and display). The bar never reads or writes the database: the
 * main window sends it a BarState snapshot whenever something relevant changes, and the bar
 * sends BarCommands back. Both are Tauri events.
 */
import type { ISOInstant } from '@/domain/dates';

export const BAR_LABEL = 'focusbar';
export const STATE_EVENT = 'focusbar:state';
export const COMMAND_EVENT = 'focusbar:command';

export type BarAction =
  'ready' | 'toggle' | 'complete' | 'hide' | 'openMain' | 'keepGap' | 'discardGap';

export interface BarCommand {
  /** Unique per click, so a command delivered twice is applied once. */
  id: string;
  action: BarAction;
  /** The task the bar showed when the command was sent (guards against stale clicks). */
  taskId: string | null;
}

export interface BarState {
  /** Increases with every snapshot; the bar ignores older ones. */
  seq: number;
  theme: 'light' | 'dark';
  task: {
    id: string;
    title: string;
    color: string | null;
    done: boolean;
    estimateMin: number | null;
  } | null;
  running: boolean;
  /** Start of the running session, when running. Elapsed time derives from this instant. */
  sessionStartUtc: ISOInstant | null;
  /** Minutes already tracked on the task in finished sessions. */
  closedMin: number;
  /** End of the time block the task is scheduled in right now, if any. */
  blockEndUtc: ISOInstant | null;
  /** The timer ran across a long unattended gap (sleep); the user must decide. */
  gapMinutes: number | null;
  /** Nothing left: the last planned task of the day was completed. */
  allDone: boolean;
  hour12: boolean;
  zone: string;
}

/** Elapsed milliseconds on the task at `now` (display only; nothing is written). */
export function elapsedMs(state: BarState, now: number): number {
  const running =
    state.running && state.sessionStartUtc ? now - Date.parse(state.sessionStartUtc) : 0;
  return Math.max(0, state.closedMin * 60_000 + running);
}
