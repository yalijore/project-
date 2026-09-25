/**
 * System-wide shortcuts (work while another app is in front): show/hide the focus bar and
 * start/pause the timer. Registered from the main window, which owns timer state; each has
 * a live status (active, off, conflict, unavailable) for Settings to show.
 */
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { create } from 'zustand';
import { errorMessage, run } from '@/data/actions';
import { isTauri } from '@/data/runtime';
import { getData, useData } from '@/data/store';
import type { Settings } from '@/domain/types';
import { toggleBar, toggleTimer } from './focusBar';
import { shortcutProblem } from './globalShortcutRules';
import { platform } from './platform';
import { COMMANDS, keysFor } from './shortcuts';

export type GlobalShortcutKey = 'globalShortcutBar' | 'globalShortcutTimer';

export const GLOBAL_SHORTCUTS: {
  key: GlobalShortcutKey;
  label: string;
  action: () => Promise<void>;
}[] = [
  { key: 'globalShortcutBar', label: 'Show or hide the focus bar', action: toggleBar },
  { key: 'globalShortcutTimer', label: 'Start or pause the timer', action: toggleTimer },
];

export type ShortcutStatus =
  | { state: 'active' }
  | { state: 'off' }
  | { state: 'conflict'; reason: string }
  | { state: 'unavailable'; reason: string };

export const useGlobalShortcutStatus = create<Record<GlobalShortcutKey, ShortcutStatus>>(() => ({
  globalShortcutBar: { state: 'off' },
  globalShortcutTimer: { state: 'off' },
}));

/** Why this accelerator can't be used for `key` given the current settings, or null. */
export function problemFor(key: GlobalShortcutKey, acc: string, settings: Settings): string | null {
  const other = GLOBAL_SHORTCUTS.find((g) => g.key !== key)!;
  return shortcutProblem(acc, {
    platform,
    other: settings[other.key]
      ? { label: other.label, accelerator: settings[other.key] }
      : undefined,
    inApp: COMMANDS.map((c) => ({ label: c.label, spec: keysFor(c.id, settings.shortcuts) })),
  });
}

let registered: string[] = [];
let chain: Promise<void> = Promise.resolve();

async function apply(settings: Settings): Promise<void> {
  for (const acc of registered) await unregister(acc).catch(() => undefined);
  registered = [];
  const status: Partial<Record<GlobalShortcutKey, ShortcutStatus>> = {};
  for (const g of GLOBAL_SHORTCUTS) {
    const acc = settings[g.key].trim();
    if (!acc) {
      status[g.key] = { state: 'off' };
      continue;
    }
    const problem = problemFor(g.key, acc, settings);
    if (problem) {
      status[g.key] = { state: 'conflict', reason: problem };
      continue;
    }
    try {
      await register(acc, (e) => {
        if (e.state === 'Pressed') run(g.action());
      });
      registered.push(acc);
      status[g.key] = { state: 'active' };
    } catch (e) {
      status[g.key] = {
        state: 'unavailable',
        reason: `Another app or the system already uses this shortcut (${errorMessage(e)}).`,
      };
    }
  }
  useGlobalShortcutStatus.setState(status);
}

/** Registers the shortcuts now and whenever the relevant settings change. */
export function startGlobalShortcuts(): () => void {
  if (!isTauri()) return () => undefined;
  const schedule = () => {
    chain = chain.then(() => apply(getData().settings)).catch(() => undefined);
  };
  schedule();
  const unsub = useData.subscribe((s, prev) => {
    if (
      s.settings.globalShortcutBar !== prev.settings.globalShortcutBar ||
      s.settings.globalShortcutTimer !== prev.settings.globalShortcutTimer ||
      s.settings.shortcuts !== prev.settings.shortcuts
    )
      schedule();
  });
  return () => {
    unsub();
    chain = chain.then(async () => {
      for (const acc of registered) await unregister(acc).catch(() => undefined);
      registered = [];
    });
  };
}
