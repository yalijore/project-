/**
 * Main-window side of the floating focus bar.
 *
 * The main window is the single authority over timer state. The bar window never touches the
 * database: it shows snapshots this module sends (after every relevant change) and sends
 * commands back, which run here one at a time, each at most once, through the same actions
 * the planner uses. Elapsed time is always derived from the running session's start instant
 * in SQLite, so it survives the bar closing, Keel restarting, and the computer sleeping.
 */
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { errorMessage, resolveGap, setComplete, startTimer, stopTimer } from '@/data/actions';
import { isTauri } from '@/data/runtime';
import { getData, useData } from '@/data/store';
import type { BarCommand } from '@/focusbar/protocol';
import { BAR_LABEL, COMMAND_EVENT, STATE_EVENT } from '@/focusbar/protocol';
import { barTaskOf, buildBarState, nextPlannedTask, runningSession } from '@/focusbar/state';
import { ui, useUi } from './ui';

let seq = 0;

function prefersDark(): boolean {
  const theme = getData().settings.theme;
  return (
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  );
}

export function currentBarState() {
  const d = getData();
  const u = useUi.getState();
  // Monotonic across reloads of the main window, so the bar never drops a fresh snapshot.
  seq = Math.max(seq + 1, Date.now());
  return buildBarState(
    {
      tasks: d.tasks,
      sessions: d.sessions,
      blocks: d.blocks,
      projects: d.projects,
      today: d.today,
      zone: d.zone,
      hour12: d.settings.hour12,
      dark: prefersDark(),
      palette: d.settings.palette,
      barTaskId: u.barTaskId,
      gap: u.gapPrompt
        ? { sessionId: u.gapPrompt.sessionId, minutes: u.gapPrompt.gapMinutes }
        : null,
      now: Date.now(),
    },
    seq,
  );
}

let publishQueued = false;
/** Sends the bar a fresh snapshot (coalesced; only while the bar is open). */
export function publish() {
  if (!isTauri() || !useUi.getState().barVisible || publishQueued) return;
  publishQueued = true;
  setTimeout(() => {
    publishQueued = false;
    void emitTo(BAR_LABEL, STATE_EVENT, currentBarState()).catch(() => undefined);
  }, 0);
}

let showing: Promise<void> | null = null;
/** Opens the bar; overlapping requests (timer start and Focus mode at once) share one call. */
export function showBar(): Promise<void> {
  if (!isTauri()) {
    toast.error('The focus bar is part of the Keel desktop app.');
    return Promise.resolve();
  }
  showing ??= invoke('focusbar_show')
    .then(() => {
      useUi.setState({ barVisible: true });
      publish();
    })
    .finally(() => {
      showing = null;
    });
  return showing;
}

/** Hides the bar. The timer is not affected. */
export async function hideBar(): Promise<void> {
  if (!isTauri()) return;
  await invoke('focusbar_hide');
  useUi.setState({ barVisible: false });
}

export async function toggleBar(): Promise<void> {
  if (!isTauri()) return showBar();
  const visible = await invoke<boolean>('focusbar_is_visible');
  await (visible ? hideBar() : showBar());
}

export async function resetBarPosition(): Promise<void> {
  if (!isTauri()) return;
  await invoke('focusbar_reset_position');
}

/**
 * Start/pause for the bar and the global shortcut: pauses a running timer; otherwise starts
 * the bar's task, or the next open task planned for today.
 */
export async function toggleTimer(): Promise<void> {
  const d = getData();
  if (runningSession(d.sessions)) {
    await stopTimer();
    return;
  }
  const current = barTaskOf({
    sessions: d.sessions,
    tasks: d.tasks,
    barTaskId: useUi.getState().barTaskId,
  });
  const task = current && !current.completedAt ? current : nextPlannedTask(d.tasks, d.today, null);
  if (!task) {
    toast('Nothing to time yet — plan a task for today first.');
    if (!useUi.getState().barVisible) await showBar();
    return;
  }
  useUi.setState({ barTaskId: task.id });
  await startTimer(task.id);
}

async function execute(cmd: BarCommand): Promise<void> {
  const d = getData();
  const current =
    barTaskOf({ sessions: d.sessions, tasks: d.tasks, barTaskId: useUi.getState().barTaskId })
      ?.id ?? null;
  // A click made on an older snapshot (a different task) is ignored; the bar gets fresh state.
  const stale = cmd.taskId !== current;
  switch (cmd.action) {
    case 'ready':
      // The bar can report in before the call that opened it returns.
      if (!useUi.getState().barVisible && (await invoke<boolean>('focusbar_is_visible')))
        useUi.setState({ barVisible: true });
      publish();
      return;
    case 'toggle':
      if (stale) return publish();
      return toggleTimer();
    case 'complete': {
      const task = cmd.taskId ? d.tasks[cmd.taskId] : undefined;
      if (stale || !task || task.completedAt) return publish();
      // Completing closes the task's running session in the same transaction.
      await setComplete(task.id, true);
      return;
    }
    case 'hide':
      return hideBar();
    case 'openMain':
      await invoke('focusbar_focus_main');
      return;
    case 'keepGap':
    case 'discardGap': {
      const gap = useUi.getState().gapPrompt;
      if (!gap || stale) return publish();
      await resolveGap(cmd.action === 'keepGap' ? 'keep' : 'discard', gap.gapStart, gap.sessionId);
      useUi.setState({ gapPrompt: null });
      return;
    }
  }
}

const seen = new Set<string>();
let queue: Promise<void> = Promise.resolve();

/** Runs a bar command after the ones before it; a repeated command id is ignored. */
export function handleBarCommand(cmd: BarCommand): Promise<void> {
  if (!cmd || typeof cmd.id !== 'string' || seen.has(cmd.id)) return queue;
  seen.add(cmd.id);
  queue = queue
    .then(() => execute(cmd))
    .catch((e: unknown) => {
      toast.error(errorMessage(e));
      publish();
    });
  return queue;
}

/**
 * Wires the bar to the planner: auto-show on timer start / Focus mode (per settings), follow
 * the running or focused task, advance to the next planned task after completion, and keep
 * the bar's snapshot current. Returns a function that undoes the wiring.
 */
export function startFocusBarController(): () => void {
  const d = getData();
  let prevRunningId = runningSession(d.sessions)?.id ?? null;
  if (prevRunningId) useUi.setState({ barTaskId: runningSession(d.sessions)!.taskId });

  const unsubData = useData.subscribe((s, prev) => {
    const running = runningSession(s.sessions);
    if (running && running.id !== prevRunningId) {
      useUi.setState({ barTaskId: running.taskId });
      if (s.settings.focusBarOnTimerStart && !useUi.getState().barVisible)
        void showBar().catch(() => undefined);
    }
    prevRunningId = running?.id ?? null;
    // The bar's task was completed (from the bar or anywhere else): move on to the next
    // planned task if there is one; otherwise the bar reports that the day's plan is done.
    const barId = useUi.getState().barTaskId;
    if (barId && s.tasks[barId]?.completedAt && !prev.tasks[barId]?.completedAt) {
      const next = nextPlannedTask(s.tasks, s.today, barId);
      useUi.setState({ barTaskId: next?.id ?? null });
      if (next && useUi.getState().focusTaskId === barId) ui.focus(next.id);
    }
    publish();
  });

  const unsubUi = useUi.subscribe((u, prev) => {
    if (u.focusTaskId && u.focusTaskId !== prev.focusTaskId) {
      useUi.setState({ barTaskId: u.focusTaskId });
      if (getData().settings.focusBarOnFocus && !u.barVisible)
        void showBar().catch(() => undefined);
    }
    if (
      u.barTaskId !== prev.barTaskId ||
      u.gapPrompt !== prev.gapPrompt ||
      u.barVisible !== prev.barVisible
    )
      publish();
  });

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', publish);
  // Time blocks start and end on their own; refresh the snapshot now and then.
  const timer = setInterval(publish, 30_000);

  let unlisten: (() => void) | null = null;
  let stopped = false;
  if (isTauri()) {
    void listen<BarCommand>(COMMAND_EVENT, (e) => void handleBarCommand(e.payload)).then((u) => {
      if (stopped) u();
      else unlisten = u;
    });
    // Restore: the bar may already be open (main window reloaded), or was open when Keel
    // last exited with a timer running.
    void (async () => {
      const [visible, wasVisible] = await Promise.all([
        invoke<boolean>('focusbar_is_visible'),
        invoke<boolean>('focusbar_was_visible'),
      ]);
      if (stopped) return;
      if (visible) {
        useUi.setState({ barVisible: true });
        publish();
      } else if (wasVisible && runningSession(getData().sessions)) {
        await showBar();
      }
    })().catch(() => undefined);
  }

  return () => {
    stopped = true;
    unsubData();
    unsubUi();
    media.removeEventListener('change', publish);
    clearInterval(timer);
    unlisten?.();
  };
}
