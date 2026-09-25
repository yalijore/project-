import { describe, expect, it } from 'vitest';
import { computeWorkload } from './capacity';
import { MINUTE } from './scheduling';
import {
  detectGap,
  estimateProgress,
  sessionMinutes,
  trackedByTask,
  trackedOnDay,
} from './timeAccounting';
import type { TimeSession } from './types';

const session = (
  id: string,
  taskId: string,
  start: string,
  end: string | null,
  heartbeat?: string,
): TimeSession => ({
  id,
  taskId,
  startUtc: start,
  endUtc: end,
  heartbeatUtc: heartbeat ?? null,
  source: 'timer',
  note: '',
  createdAt: start,
  updatedAt: start,
});

describe('time accounting', () => {
  const now = Date.parse('2026-09-25T15:00:00Z');

  it('counts running sessions up to now', () => {
    expect(sessionMinutes(session('s', 't', '2026-09-25T14:30:00Z', null), now)).toBe(30);
  });

  it('sums per task', () => {
    const map = trackedByTask(
      [
        session('1', 'a', '2026-09-25T10:00:00Z', '2026-09-25T10:25:00Z'),
        session('2', 'a', '2026-09-25T11:00:00Z', '2026-09-25T11:05:00Z'),
        session('3', 'b', '2026-09-25T14:50:00Z', null),
      ],
      now,
    );
    expect(map.get('a')).toBe(30);
    expect(map.get('b')).toBe(10);
  });

  it('splits sessions that cross local midnight', () => {
    const s = [session('1', 'a', '2026-09-25T03:00:00Z', '2026-09-25T05:00:00Z')]; // 23:00–01:00 New York
    expect(trackedOnDay(s, '2026-09-24', 'America/New_York', now).get('a')).toBe(60);
    expect(trackedOnDay(s, '2026-09-25', 'America/New_York', now).get('a')).toBe(60);
  });

  it('detects sleep gaps from stale heartbeats', () => {
    const running = session('1', 'a', '2026-09-25T13:00:00Z', null, '2026-09-25T13:10:00Z');
    expect(detectGap(running, now, 20)).toEqual({
      gap: true,
      gapStart: '2026-09-25T13:10:00.000Z',
      gapMinutes: 110,
    });
    const fresh = session('1', 'a', '2026-09-25T13:00:00Z', null, '2026-09-25T14:59:40Z');
    expect(detectGap(fresh, now, 20).gap).toBe(false);
  });

  it('reports estimate variance', () => {
    expect(estimateProgress(30, 45)).toEqual({
      estimateMin: 30,
      actualMin: 45,
      varianceMin: 15,
      ratio: 1.5,
    });
    expect(estimateProgress(null, 10).varianceMin).toBeNull();
  });
});

describe('workload', () => {
  const zone = 'America/New_York';
  const wh = { days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 };
  const base = {
    date: '2026-09-25',
    weekday: 5,
    zone,
    workingHours: wh,
    capacityMin: 6 * 60,
    defaultEstimateMin: 30,
  };
  const nine = Date.parse('2026-09-25T13:00:00Z');

  it('flags overcommitment when tasks plus meetings exceed capacity', () => {
    const w = computeWorkload({
      ...base,
      now: nine - 60 * MINUTE,
      isToday: false,
      tasks: [
        { id: 'a', estimateMin: 180, actualMin: 0, done: false },
        { id: 'b', estimateMin: 120, actualMin: 30, done: false },
        { id: 'c', estimateMin: 60, actualMin: 60, done: true },
        { id: 'd', estimateMin: null, actualMin: 0, done: false },
      ],
      meetings: [{ start: nine + 60 * MINUTE, end: nine + 150 * MINUTE }],
    });
    expect(w.plannedMin).toBe(360);
    expect(w.remainingMin).toBe(180 + 90 + 30);
    expect(w.meetingMin).toBe(90);
    expect(w.unestimatedCount).toBe(1);
    expect(w.overCapacity).toBe(true);
    expect(w.openMin).toBe(8 * 60 - 90);
    expect(w.overOpenTime).toBe(false);
  });

  it('uses only the remaining part of today', () => {
    const w = computeWorkload({
      ...base,
      now: nine + 6 * 60 * MINUTE, // 15:00
      isToday: true,
      tasks: [{ id: 'a', estimateMin: 180, actualMin: 0, done: false }],
      meetings: [{ start: nine + 60 * MINUTE, end: nine + 120 * MINUTE }],
    });
    expect(w.openMin).toBe(120);
    expect(w.overOpenTime).toBe(true);
    expect(w.overByMin).toBe(60);
  });

  it('knows weekends are not working days', () => {
    const w = computeWorkload({
      ...base,
      date: '2026-09-26',
      weekday: 6,
      now: nine,
      isToday: false,
      tasks: [],
      meetings: [],
    });
    expect(w.isWorkingDay).toBe(false);
    expect(w.openMin).toBe(0);
  });
});
