/**
 * The main window's focus-bar controller against a fake Tauri bridge: the bar's commands run
 * once each, in order, through the planner's own actions, and the state it publishes is
 * derived from the database's sessions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '@/data/repo';
import { setDatabase } from '@/data/runtime';
import { applySnapshot, getData } from '@/data/store';
import type { Database } from '@/db/driver';
import type { BarCommand, BarState } from '@/focusbar/protocol';
import { elapsedMs } from '@/focusbar/protocol';
import { buildBarState, nextPlannedTask } from '@/focusbar/state';
import { createTestDb } from '@/test/testDb';

const bridge = vi.hoisted(() => ({
  invoked: [] as string[],
  emitted: [] as BarState[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    bridge.invoked.push(cmd);
    if (cmd === 'focusbar_is_visible' || cmd === 'focusbar_was_visible') return false;
    return undefined;
  },
}));
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: async (_target: string, _event: string, payload: BarState) => {
    bridge.emitted.push(payload);
  },
  listen: async () => () => undefined,
}));
vi.mock('sonner', () => ({
  toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }),
}));

const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.__TAURI_INTERNALS__ = {};
g.matchMedia = () => ({
  matches: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const bar = await import('./focusBar');
const { ui, useUi } = await import('./ui');
const actions = await import('@/data/actions');

let db: Database;
let n = 0;
const cmd = (action: BarCommand['action'], taskId: string | null): BarCommand => ({
  id: `c${++n}`,
  action,
  taskId,
});
const flush = () => new Promise((r) => setTimeout(r, 5));

async function sessionsOf(taskId: string) {
  return db.all<{ start_utc: string; end_utc: string | null }>(
    'SELECT start_utc, end_utc FROM time_sessions WHERE task_id = ? ORDER BY start_utc',
    [taskId],
  );
}

let stop: () => void = () => undefined;

beforeEach(async () => {
  stop();
  db = await createTestDb();
  setDatabase(db);
  applySnapshot(await repo.loadSnapshot(db));
  useUi.setState({ barTaskId: null, barVisible: false, focusTaskId: null, gapPrompt: null });
  bridge.invoked.length = 0;
  bridge.emitted.length = 0;
  stop = bar.startFocusBarController();
});

async function planned(title: string, estimateMin: number | null = 30) {
  return actions.addTask({ title, planDate: getData().today, estimateMin });
}

describe('focus bar controller', () => {
  it('shows the bar when a timer starts (if enabled) and follows the running task', async () => {
    const a = await planned('Write brief');
    await actions.startTimer(a);
    await flush();
    expect(bridge.invoked).toContain('focusbar_show');
    expect(useUi.getState().barTaskId).toBe(a);
    const state = bridge.emitted.at(-1)!;
    expect(state.task).toMatchObject({ id: a, title: 'Write brief', estimateMin: 30 });
    expect(state.running).toBe(true);

    await actions.stopTimer();
    await actions.saveSettings({ focusBarOnTimerStart: false });
    await bar.hideBar();
    bridge.invoked.length = 0;
    await actions.startTimer(a);
    await flush();
    expect(bridge.invoked).not.toContain('focusbar_show');
  });

  it('opening Focus mode shows the bar when that toggle is on', async () => {
    const a = await planned('Deep work');
    await actions.saveSettings({ focusBarOnTimerStart: false, focusBarOnFocus: true });
    ui.focus(a);
    await flush();
    expect(bridge.invoked).toContain('focusbar_show');
    expect(useUi.getState().barTaskId).toBe(a);
  });

  it('pause, resume, hide and complete: one completion, no duplicate or dangling session', async () => {
    const a = await planned('Acceptance task');
    await actions.startTimer(a);
    await bar.handleBarCommand(cmd('toggle', a)); // pause
    expect(await sessionsOf(a)).toHaveLength(1);
    expect((await sessionsOf(a))[0]!.end_utc).not.toBeNull();
    await bar.handleBarCommand(cmd('toggle', a)); // resume
    expect(await sessionsOf(a)).toHaveLength(2);
    await bar.handleBarCommand(cmd('hide', a));
    expect(bridge.invoked).toContain('focusbar_hide');
    expect((await sessionsOf(a)).at(-1)!.end_utc).toBeNull(); // hiding keeps the timer running

    const complete = cmd('complete', a);
    await Promise.all([
      bar.handleBarCommand(complete),
      bar.handleBarCommand(complete), // delivered twice
      bar.handleBarCommand(cmd('complete', a)), // clicked twice
    ]);
    const sessions = await sessionsOf(a);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.end_utc)).toBe(true);
    const task = (await repo.loadTasks(db, [a]))[0]!;
    expect(task.completedAt).not.toBeNull();
    const undo = await db.all<{ label: string }>(
      "SELECT label FROM undo_groups WHERE label = 'Complete task'",
    );
    expect(undo).toHaveLength(1); // exactly one completion was applied
  });

  it('after completion, advances to the next planned task only if there is one', async () => {
    const a = await planned('First');
    const b = await planned('Second');
    await actions.startTimer(a);
    await bar.handleBarCommand(cmd('complete', a));
    await flush();
    expect(useUi.getState().barTaskId).toBe(b);
    const s = bar.currentBarState();
    expect(s.task?.id).toBe(b);
    expect(s.running).toBe(false); // the next task is not started for you

    await bar.handleBarCommand(cmd('toggle', b));
    await bar.handleBarCommand(cmd('complete', b));
    await flush();
    expect(useUi.getState().barTaskId).toBeNull();
    expect(bar.currentBarState()).toMatchObject({ task: null, allDone: true });
  });

  it('ignores clicks made on a stale snapshot', async () => {
    const a = await planned('Shown');
    const b = await planned('Other');
    await actions.startTimer(a);
    await bar.handleBarCommand(cmd('complete', b));
    expect((await repo.loadTasks(db, [b]))[0]!.completedAt).toBeNull();
    await bar.handleBarCommand(cmd('toggle', b));
    expect((await sessionsOf(a)).at(-1)!.end_utc).toBeNull();
  });

  it('start/pause with nothing running starts the bar task, else the next planned one', async () => {
    const a = await planned('Planned first');
    await bar.toggleTimer();
    expect((await sessionsOf(a)).at(-1)!.end_utc).toBeNull();
    await bar.toggleTimer();
    expect((await sessionsOf(a)).at(-1)!.end_utc).not.toBeNull();
  });
});

describe('bar state', () => {
  it('derives elapsed time from finished sessions plus the running session start', () => {
    const now = Date.parse('2026-09-25T15:00:00Z');
    const state = buildBarState(
      {
        tasks: {
          t: {
            id: 't',
            title: 'T',
            projectId: null,
            completedAt: null,
            archivedAt: null,
            estimateMin: 60,
            planDate: '2026-09-25',
            planOrder: 0,
            createdAt: '',
          } as never,
        },
        sessions: {
          s1: {
            id: 's1',
            taskId: 't',
            startUtc: '2026-09-25T13:00:00Z',
            endUtc: '2026-09-25T13:20:00Z',
          } as never,
          s2: { id: 's2', taskId: 't', startUtc: '2026-09-25T14:50:00Z', endUtc: null } as never,
        },
        blocks: {
          b: {
            id: 'b',
            taskId: 't',
            startUtc: '2026-09-25T14:30:00Z',
            endUtc: '2026-09-25T15:30:00Z',
          } as never,
        },
        projects: {},
        today: '2026-09-25',
        zone: 'UTC',
        hour12: false,
        dark: true,
        barTaskId: null,
        gap: null,
        now,
      },
      1,
    );
    expect(state).toMatchObject({
      running: true,
      closedMin: 20,
      theme: 'dark',
      blockEndUtc: '2026-09-25T15:30:00Z',
    });
    // 20 min closed + 10 min running; after a (sleep) jump the value is still exact.
    expect(elapsedMs(state, now)).toBe(30 * 60_000);
    expect(elapsedMs(state, now + 3 * 3_600_000)).toBe((30 + 180) * 60_000);
  });

  it('next planned task wraps to earlier open tasks', () => {
    const base = { archivedAt: null, planDate: '2026-09-25', createdAt: '' };
    const tasks = {
      a: { ...base, id: 'a', planOrder: 0, completedAt: null },
      b: { ...base, id: 'b', planOrder: 1, completedAt: 'x' },
      c: { ...base, id: 'c', planOrder: 2, completedAt: null },
    } as never;
    expect(nextPlannedTask(tasks, '2026-09-25', 'c')?.id).toBe('a');
    expect(nextPlannedTask(tasks, '2026-09-25', 'a')?.id).toBe('c');
  });
});
