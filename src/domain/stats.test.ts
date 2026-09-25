import { describe, expect, it } from 'vitest';
import type { StatsInput } from './stats';
import { computeRangeStats } from './stats';

const session = (taskId: string, start: string, end: string) => ({
  id: `${taskId}-${start}`,
  taskId,
  startUtc: start,
  endUtc: end,
  heartbeatUtc: null,
  source: 'timer' as const,
  note: '',
  createdAt: start,
  updatedAt: start,
});

const base: StatsInput = {
  from: '2026-09-21',
  to: '2026-09-22',
  zone: 'America/New_York',
  now: Date.parse('2026-09-25T00:00:00Z'),
  entries: [
    { planDate: '2026-09-21', status: 'done', taskId: 'a' },
    { planDate: '2026-09-21', status: 'rolled_over', taskId: 'b' },
    { planDate: '2026-09-21', status: 'moved', taskId: 'c' },
    { planDate: '2026-09-22', status: 'done', taskId: 'b' },
  ],
  tasks: {
    a: {
      id: 'a',
      estimateMin: 30,
      completedAt: '2026-09-21T15:00:00Z',
      projectId: 'p1',
      areaId: null,
    },
    b: {
      id: 'b',
      estimateMin: 60,
      completedAt: '2026-09-22T15:00:00Z',
      projectId: null,
      areaId: 'x',
    },
    c: { id: 'c', estimateMin: 45, completedAt: null, projectId: null, areaId: null },
  },
  sessions: [
    session('a', '2026-09-21T13:00:00Z', '2026-09-21T13:40:00Z'),
    session('b', '2026-09-22T13:00:00Z', '2026-09-22T13:50:00Z'),
  ],
  meetings: [
    { start: Date.parse('2026-09-21T14:00:00Z'), end: Date.parse('2026-09-21T15:00:00Z') },
  ],
  categories: {
    projects: { p1: { name: 'Launch', color: '#111' } },
    areas: { x: { name: 'Home', color: '#222' } },
  },
};

describe('range stats', () => {
  it('counts planned, completed and carried-forward work per day, ignoring moved entries', () => {
    const s = computeRangeStats(base);
    expect(s.days[0]).toMatchObject({
      date: '2026-09-21',
      plannedCount: 2,
      completedCount: 1,
      rolledOverCount: 1,
      plannedMin: 90,
      trackedMin: 40,
      meetingMin: 60,
    });
    expect(s.days[1]).toMatchObject({
      date: '2026-09-22',
      plannedCount: 1,
      completedCount: 1,
      plannedMin: 60,
      trackedMin: 50,
    });
    expect(s.totals.completedCount).toBe(2);
  });

  it('groups tracked time by project, then area', () => {
    const s = computeRangeStats(base);
    expect(s.byCategory.map((c) => [c.label, c.minutes])).toEqual([
      ['Home', 50],
      ['Launch', 40],
    ]);
  });

  it('measures estimate accuracy only for completed tasks with both numbers', () => {
    const s = computeRangeStats(base);
    expect(s.estimateAccuracy).toEqual({ estimatedMin: 90, trackedMin: 90, taskCount: 2 });
  });
});
