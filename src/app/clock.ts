/**
 * The app heartbeat: every 15 seconds (and whenever the window regains focus, e.g. after
 * sleep) it advances "today", keeps the running timer's heartbeat fresh, asks about
 * unattended gaps, and sends due notifications.
 */
import { heartbeat } from '@/data/actions';
import { getData, effectiveZone, useData } from '@/data/store';
import { formatTime, todayIn, wallTimeToInstant, parseClock, isoWeekday } from '@/domain/dates';
import { detectGap, sessionMinutes } from '@/domain/timeAccounting';
import { checkZoneChange, runDayStart } from './maintenance';
import { sendNotification } from './notify';
import { useUi } from './ui';

const TICK_MS = 15_000;
const HEARTBEAT_MS = 30_000;
const notified = new Set<string>();
let lastHeartbeat = 0;
let started = false;
let ticking = false;

export function startClock() {
  if (started) return;
  started = true;
  void tick();
  setInterval(() => void tick(), TICK_MS);
  window.addEventListener('focus', () => void tick());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void tick();
  });
}

export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await advanceDay();
    await checkZoneChange();
    await timerHousekeeping();
    await notifications();
  } catch (e) {
    console.error('Clock tick failed', e);
  } finally {
    ticking = false;
  }
}

async function advanceDay() {
  const state = getData();
  const zone = useUi.getState().zoneChange ? state.zone : effectiveZone(state.settings);
  const today = todayIn(zone);
  if (zone !== state.zone || today !== state.today) {
    useData.setState({ zone, today });
    if (today !== state.today) await runDayStart();
  }
}

async function timerHousekeeping() {
  const { sessions, settings } = getData();
  const running = Object.values(sessions).find((s) => !s.endUtc);
  const prompt = useUi.getState().gapPrompt;
  // A pending "were you working?" question is moot once that timer stopped or another started.
  if (prompt && prompt.sessionId !== running?.id) useUi.setState({ gapPrompt: null });
  if (!running) return;
  const now = Date.now();
  const gap = detectGap(running, now, settings.idleThresholdMin);
  if (gap.gap) {
    if (!useUi.getState().gapPrompt) {
      useUi.setState({
        gapPrompt: {
          sessionId: running.id,
          taskId: running.taskId,
          gapStart: gap.gapStart!,
          gapMinutes: gap.gapMinutes,
        },
      });
    }
    return;
  }
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    await heartbeat();
    const at = new Date(now).toISOString();
    useData.setState((s) => {
      const current = s.sessions[running.id];
      return current
        ? { sessions: { ...s.sessions, [running.id]: { ...current, heartbeatUtc: at } } }
        : {};
    });
  }
}

async function notifications() {
  const { settings, blocks, tasks, sessions, zone, today, rituals } = getData();
  if (!settings.notificationsEnabled) return;
  const now = Date.now();

  if (settings.notifyBlockStart) {
    for (const b of Object.values(blocks)) {
      const start = Date.parse(b.startUtc);
      const task = tasks[b.taskId];
      if (!task || task.completedAt || start < now - 60_000 || start > now + TICK_MS + 5_000)
        continue;
      const key = `block:${b.id}:${b.startUtc}`;
      if (notified.has(key)) continue;
      notified.add(key);
      await sendNotification(
        `Time for “${task.title}”`,
        `Scheduled ${formatTime(b.startUtc, zone, settings.hour12)} – ${formatTime(b.endUtc, zone, settings.hour12)}`,
      );
    }
  }

  if (settings.notifyEstimateReached) {
    const running = Object.values(sessions).find((s) => !s.endUtc);
    const task = running ? tasks[running.taskId] : undefined;
    if (running && task?.estimateMin) {
      const total = Object.values(sessions)
        .filter((s) => s.taskId === task.id)
        .reduce((sum, s) => sum + sessionMinutes(s, now), 0);
      const key = `estimate:${task.id}:${task.estimateMin}`;
      if (total >= task.estimateMin && !notified.has(key)) {
        notified.add(key);
        await sendNotification(
          `Estimate reached: ${task.title}`,
          `You planned ${task.estimateMin} minutes. Keep going, or wrap up?`,
        );
      }
    }
  }

  if (settings.notifyShutdown && settings.workingDays.includes(isoWeekday(today))) {
    const at = Date.parse(
      wallTimeToInstant(today, parseClock(settings.shutdownReminderTime), zone),
    );
    const done = Object.values(rituals).some(
      (r) => r.kind === 'shutdown' && r.period === today && r.completedAt,
    );
    const key = `shutdown:${today}`;
    if (!done && now >= at && now < at + 30 * 60_000 && !notified.has(key)) {
      notified.add(key);
      await sendNotification(
        'Time to wrap up',
        'Review what you did today and plan what carries over.',
      );
    }
  }
}
