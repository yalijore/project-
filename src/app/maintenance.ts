/**
 * Work that happens when a day starts (app launch or midnight): materialize recurring tasks,
 * carry unfinished work forward (if enabled), take the daily automatic backup, and notice
 * time zone changes.
 */
import { toast } from 'sonner';
import { clearUndoHistory, perform, refreshAll } from '@/data/actions';
import { materializeDue } from '@/data/recurrenceRepo';
import { rolloverTasks, saveSettings as saveSettingsRepo } from '@/data/repo';
import { isTauri } from '@/data/runtime';
import { getData, useData } from '@/data/store';
import { systemZone } from '@/domain/dates';
import { native } from './native';
import { useUi } from './ui';

let running: Promise<void> | null = null;

export function runDayStart(): Promise<void> {
  running ??= doDayStart().finally(() => {
    running = null;
  });
  return running;
}

async function doDayStart() {
  const { today, settings } = getData();
  const result = await perform({ label: null, quiet: true }, async (ctx) => {
    const created = await materializeDue(ctx, today);
    let moved: string[] = [];
    if (settings.rolloverMode === 'auto' && settings.lastRolloverDate !== today) {
      moved = await rolloverTasks(ctx, today);
    }
    if (settings.lastRolloverDate !== today)
      await saveSettingsRepo(ctx, { lastRolloverDate: today });
    // Background changes can invalidate older undo steps.
    if (created.length || moved.length) await clearUndoHistory(ctx.tx);
    return { created, moved };
  }).catch((e) => {
    console.error('Day start failed', e);
    return { created: [], moved: [] };
  });
  if (result.created.length || result.moved.length) await refreshAll();
  if (result.moved.length) {
    toast(
      `Carried ${result.moved.length} unfinished task${result.moved.length === 1 ? '' : 's'} forward to today`,
    );
  }
  await autoBackup();
}

async function autoBackup() {
  const { settings } = getData();
  // Nothing worth backing up before onboarding (fresh install or right after "Delete all data").
  if (!isTauri() || !settings.autoBackup || !settings.onboarded) return;
  const last = settings.lastAutoBackupAt ? Date.parse(settings.lastAutoBackupAt) : 0;
  if (Date.now() - last < 20 * 3600_000) return;
  try {
    await native.createBackup('auto');
    await perform({ label: null, quiet: true }, (ctx) =>
      saveSettingsRepo(ctx, { lastAutoBackupAt: ctx.now }),
    );
  } catch (e) {
    console.error('Automatic backup failed', e);
    toast.error('Automatic backup failed. You can create one manually in Settings → Data.');
  }
}

/**
 * When Keel follows the system zone and it changed since last launch, ask what to do with
 * upcoming time blocks (see README "Time zones"). Until answered, blocks keep their
 * absolute times — nothing is changed silently.
 */
export async function checkZoneChange() {
  const { settings } = getData();
  if (settings.timeZone !== 'system') return;
  const current = systemZone();
  if (!settings.lastKnownZone) {
    await perform({ label: null, quiet: true }, (ctx) =>
      saveSettingsRepo(ctx, { lastKnownZone: current }),
    );
    return;
  }
  if (settings.lastKnownZone !== current && !useUi.getState().zoneChange) {
    useUi.setState({ zoneChange: { from: settings.lastKnownZone, to: current } });
    useData.setState({ zone: current });
  }
}
