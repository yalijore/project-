import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@/db/driver';
import { undoLast, undoable } from '@/db/undo';
import { createTestDb } from '@/test/testDb';
import type { Ctx } from './repo';
import * as repo from './repo';

const ZONE = 'America/New_York';
let db: Database;
let clock = '2026-09-25T14:00:00.000Z'; // Fri 10:00 New York
let today = '2026-09-25';

async function act<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  return db.transaction((tx) =>
    fn({ tx, now: clock, today, zone: ZONE, changes: new repo.ChangeSet() }),
  );
}

async function task(id: string) {
  const [t] = await repo.loadTasks(db, [id]);
  return t!;
}

async function dayIds(date: string) {
  const all = await repo.loadTasks(db);
  return all
    .filter((t) => t.planDate === date)
    .sort((a, b) => a.planOrder - b.planOrder)
    .map((t) => t.title);
}

beforeEach(async () => {
  db = await createTestDb();
  clock = '2026-09-25T14:00:00.000Z';
  today = '2026-09-25';
});

describe('capture and planning', () => {
  it('keeps deadline, planned day and time block independent', async () => {
    const id = await act((ctx) =>
      repo.createTask(ctx, {
        title: 'Report',
        dueDate: '2026-10-01',
        planDate: '2026-09-26',
        estimateMin: 60,
      }),
    );
    await act((ctx) =>
      repo.createBlock(ctx, id, '2026-09-26T13:00:00.000Z', '2026-09-26T14:00:00.000Z'),
    );
    const t = await task(id);
    expect(t.dueDate).toBe('2026-10-01');
    expect(t.planDate).toBe('2026-09-26');
    const blocks = await repo.loadBlocks(db, [id]);
    expect(blocks).toHaveLength(1);
  });

  it('orders tasks within a day and moves between days', async () => {
    for (const title of ['A', 'B', 'C'])
      await act((ctx) => repo.createTask(ctx, { title, planDate: today }));
    expect(await dayIds(today)).toEqual(['A', 'B', 'C']);
    const c = (await repo.loadTasks(db)).find((t) => t.title === 'C')!;
    await act((ctx) => repo.planTask(ctx, c.id, today, { index: 0 }));
    expect(await dayIds(today)).toEqual(['C', 'A', 'B']);
    await act((ctx) => repo.planTask(ctx, c.id, '2026-09-26', 'top'));
    expect(await dayIds(today)).toEqual(['A', 'B']);
    expect(await dayIds('2026-09-26')).toEqual(['C']);
    const history = await db.all<{ status: string }>(
      'SELECT status FROM day_plan_entries WHERE task_id = ? ORDER BY created_at',
      [c.id],
    );
    expect(history.map((h) => h.status).sort()).toEqual(['active', 'moved']);
  });

  it('shifts upcoming blocks to the same local time when a task moves days', async () => {
    const id = await act((ctx) => repo.createTask(ctx, { title: 'Deep work', planDate: today }));
    // 15:00–16:00 New York today (in the future relative to 10:00)
    await act((ctx) =>
      repo.createBlock(ctx, id, '2026-09-25T19:00:00.000Z', '2026-09-25T20:00:00.000Z'),
    );
    await act((ctx) => repo.planTask(ctx, id, '2026-09-28'));
    const [b] = await repo.loadBlocks(db, [id]);
    expect(b!.startUtc).toBe('2026-09-28T19:00:00.000Z');
    expect(b!.endUtc).toBe('2026-09-28T20:00:00.000Z');
  });

  it('removes upcoming blocks when a task goes back to the backlog', async () => {
    const id = await act((ctx) => repo.createTask(ctx, { title: 'X', planDate: today }));
    await act((ctx) =>
      repo.createBlock(ctx, id, '2026-09-25T19:00:00.000Z', '2026-09-25T20:00:00.000Z'),
    );
    await act((ctx) => repo.unplanTask(ctx, id));
    expect((await task(id)).planDate).toBeNull();
    expect(await repo.loadBlocks(db, [id])).toHaveLength(0);
  });

  it('timeboxing an unplanned task plans it for that day', async () => {
    const id = await act((ctx) => repo.createTask(ctx, { title: 'Inbox item' }));
    await act((ctx) =>
      repo.createBlock(ctx, id, '2026-09-29T13:00:00.000Z', '2026-09-29T13:30:00.000Z'),
    );
    expect((await task(id)).planDate).toBe('2026-09-29');
  });

  it('moving a block to another day re-plans the task', async () => {
    const id = await act((ctx) => repo.createTask(ctx, { title: 'Y', planDate: today }));
    const blockId = await act((ctx) =>
      repo.createBlock(ctx, id, '2026-09-25T19:00:00.000Z', '2026-09-25T20:00:00.000Z'),
    );
    await act((ctx) =>
      repo.updateBlock(ctx, blockId, '2026-09-26T19:00:00.000Z', '2026-09-26T20:00:00.000Z'),
    );
    expect((await task(id)).planDate).toBe('2026-09-26');
  });
});

describe('completion', () => {
  it('completes on the planned day and reopens', async () => {
    const id = await act((ctx) => repo.createTask(ctx, { title: 'T', planDate: today }));
    await act((ctx) => repo.completeTask(ctx, id));
    let t = await task(id);
    expect(t.completedAt).toBe(clock);
    expect(t.planDate).toBe(today);
    await act((ctx) => repo.reopenTask(ctx, id));
    t = await task(id);
    expect(t.completedAt).toBeNull();
    expect(t.planDate).toBe(today);
  });

  it('moves backlog and future tasks to today when completed', async () => {
    const backlog = await act((ctx) => repo.createTask(ctx, { title: 'Backlog' }));
    const future = await act((ctx) =>
      repo.createTask(ctx, { title: 'Future', planDate: '2026-10-02' }),
    );
    await act((ctx) => repo.completeTask(ctx, backlog));
    await act((ctx) => repo.completeTask(ctx, future));
    expect((await task(backlog)).planDate).toBe(today);
    expect((await task(future)).planDate).toBe(today);
  });

  it('stops the running timer on completion', async () => {
    const id = await act((ctx) => repo.createTask(ctx, { title: 'Timed', planDate: today }));
    await act((ctx) => repo.startTimer(ctx, id));
    clock = '2026-09-25T14:25:00.000Z';
    await act((ctx) => repo.completeTask(ctx, id));
    expect(await repo.runningSession(db)).toBeNull();
    const [s] = await repo.loadSessions(db, [id]);
    expect(s!.endUtc).toBe('2026-09-25T14:25:00.000Z');
  });
});

describe('rollover', () => {
  it('carries unfinished tasks forward in order and counts rollovers', async () => {
    today = '2026-09-24';
    clock = '2026-09-24T14:00:00.000Z';
    const a = await act((ctx) => repo.createTask(ctx, { title: 'A', planDate: today }));
    await act((ctx) => repo.createTask(ctx, { title: 'B', planDate: today }));
    const done = await act((ctx) => repo.createTask(ctx, { title: 'Done', planDate: today }));
    await act((ctx) => repo.completeTask(ctx, done));

    today = '2026-09-25';
    clock = '2026-09-25T12:00:00.000Z';
    await act((ctx) => repo.createTask(ctx, { title: 'Existing', planDate: today }));
    const moved = await act((ctx) => repo.rolloverTasks(ctx, today));
    expect(moved).toHaveLength(2);
    expect(await dayIds('2026-09-25')).toEqual(['A', 'B', 'Existing']);
    expect(await dayIds('2026-09-24')).toEqual(['Done']);
    expect((await task(a)).rolloverCount).toBe(1);
    // Idempotent.
    expect(await act((ctx) => repo.rolloverTasks(ctx, today))).toEqual([]);
  });

  it('does not duplicate a recurring task when a newer instance exists', async () => {
    const seriesId = 'series-1';
    await db.run(
      `INSERT INTO recurrence_series (id, rrule, dtstart, title, created_at, updated_at) VALUES (?, 'FREQ=DAILY', '2026-09-24', 'Stretch', ?, ?)`,
      [seriesId, clock, clock],
    );
    const old = await act((ctx) =>
      repo.createTask(ctx, {
        title: 'Stretch',
        planDate: '2026-09-24',
        recurrenceId: seriesId,
        recurrenceDate: '2026-09-24',
      }),
    );
    await act((ctx) =>
      repo.createTask(ctx, {
        title: 'Stretch',
        planDate: '2026-09-25',
        recurrenceId: seriesId,
        recurrenceDate: '2026-09-25',
      }),
    );
    const moved = await act((ctx) => repo.rolloverTasks(ctx, today));
    expect(moved).toEqual([]);
    const t = await task(old);
    expect(t.archivedAt).not.toBeNull();
    expect(t.planDate).toBeNull();
    expect(await dayIds(today)).toEqual(['Stretch']);
  });
});

describe('timer', () => {
  it('switching tasks stops the previous session and plans the new task today', async () => {
    const a = await act((ctx) => repo.createTask(ctx, { title: 'A', planDate: today }));
    const b = await act((ctx) => repo.createTask(ctx, { title: 'B' }));
    await act((ctx) => repo.startTimer(ctx, a));
    clock = '2026-09-25T14:30:00.000Z';
    await act((ctx) => repo.startTimer(ctx, b));
    const running = await repo.runningSession(db);
    expect(running?.taskId).toBe(b);
    const [sa] = await repo.loadSessions(db, [a]);
    expect(sa!.endUtc).toBe('2026-09-25T14:30:00.000Z');
    expect((await task(b)).planDate).toBe(today);
  });

  it('discards an unattended gap and keeps timing', async () => {
    const a = await act((ctx) => repo.createTask(ctx, { title: 'A', planDate: today }));
    await act((ctx) => repo.startTimer(ctx, a));
    clock = '2026-09-25T16:00:00.000Z';
    await act((ctx) => repo.resolveGap(ctx, 'discard', '2026-09-25T14:20:00.000Z'));
    const sessions = await repo.loadSessions(db, [a]);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.endUtc)?.endUtc).toBe('2026-09-25T14:20:00.000Z');
    expect(sessions.find((s) => !s.endUtc)?.startUtc).toBe('2026-09-25T16:00:00.000Z');
  });

  it('rejects non-positive manual time', async () => {
    const a = await act((ctx) => repo.createTask(ctx, { title: 'A' }));
    await expect(act((ctx) => repo.addManualTime(ctx, a, 0))).rejects.toThrow();
    await act((ctx) => repo.addManualTime(ctx, a, 25));
    const [s] = await repo.loadSessions(db, [a]);
    expect(s!.source).toBe('manual');
    expect((Date.parse(s!.endUtc!) - Date.parse(s!.startUtc)) / 60000).toBe(25);
  });
});

describe('tasks, tags, projects', () => {
  it('bulk-edits and keeps project/area consistent', async () => {
    const area = await act((ctx) => repo.createArea(ctx, 'Work', '#000'));
    const project = await act((ctx) =>
      repo.createProject(ctx, { name: 'Launch', color: '#111', areaId: area }),
    );
    const ids = [
      await act((ctx) => repo.createTask(ctx, { title: 'one' })),
      await act((ctx) => repo.createTask(ctx, { title: 'two' })),
    ];
    await act((ctx) => repo.updateTasks(ctx, ids, { projectId: project, priority: 3 }));
    for (const id of ids) {
      const t = await task(id);
      expect(t.projectId).toBe(project);
      expect(t.areaId).toBe(area);
      expect(t.priority).toBe(3);
    }
    // Moving tasks to another area detaches them from the project.
    const other = await act((ctx) => repo.createArea(ctx, 'Home', '#222'));
    await act((ctx) => repo.updateTasks(ctx, ids, { areaId: other }));
    expect((await task(ids[0]!)).projectId).toBeNull();
  });

  it('dedupes tags case-insensitively and attaches them', async () => {
    const t1 = await act((ctx) => repo.createTag(ctx, 'Writing', '#333'));
    const t2 = await act((ctx) => repo.createTag(ctx, 'writing', '#444'));
    expect(t1).toBe(t2);
    const id = await act((ctx) => repo.createTask(ctx, { title: 'x', tagIds: [t1] }));
    expect((await task(id)).tagIds).toEqual([t1]);
    await act((ctx) => repo.setTaskTags(ctx, id, []));
    expect((await task(id)).tagIds).toEqual([]);
  });

  it('records deleted recurring instances as exceptions', async () => {
    await db.run(
      `INSERT INTO recurrence_series (id, rrule, dtstart, title, created_at, updated_at) VALUES ('s', 'FREQ=DAILY', '2026-09-25', 'R', ?, ?)`,
      [clock, clock],
    );
    const id = await act((ctx) =>
      repo.createTask(ctx, { title: 'R', recurrenceId: 's', recurrenceDate: '2026-09-25' }),
    );
    await act((ctx) => repo.deleteTasks(ctx, [id]));
    const ex = await db.all('SELECT * FROM recurrence_exceptions');
    expect(ex).toHaveLength(1);
  });

  it('undoes a bulk delete including subtasks, tags, plan and blocks', async () => {
    const tag = await act((ctx) => repo.createTag(ctx, 'x', '#000'));
    const id = await act((ctx) =>
      repo.createTask(ctx, {
        title: 'Rich',
        planDate: today,
        subtasks: ['a', 'b'],
        tagIds: [tag],
        links: [{ url: 'https://example.com' }],
      }),
    );
    await act((ctx) =>
      repo.createBlock(ctx, id, '2026-09-25T19:00:00.000Z', '2026-09-25T20:00:00.000Z'),
    );
    const before = await task(id);
    await undoable(db, 'Delete', (tx) =>
      repo.deleteTasks({ tx, now: clock, today, zone: ZONE, changes: new repo.ChangeSet() }, [id]),
    );
    expect(await repo.loadTasks(db, [id])).toEqual([]);
    await undoLast(db);
    const after = await task(id);
    expect(after).toEqual(before);
    expect(await repo.loadBlocks(db, [id])).toHaveLength(1);
    expect(await db.all('SELECT * FROM recurrence_exceptions')).toEqual([]);
  });
});

describe('settings and rituals', () => {
  it('persists settings patches over defaults', async () => {
    await act((ctx) => repo.saveSettings(ctx, { hour12: true, workingDays: [1, 2, 3] }));
    const s = await repo.loadSettings(db);
    expect(s.hour12).toBe(true);
    expect(s.workingDays).toEqual([1, 2, 3]);
    expect(s.weekStartsOn).toBe(1);
    await expect(act((ctx) => repo.saveSettings(ctx, { nope: 1 } as never))).rejects.toThrow();
  });

  it('upserts ritual entries and merges data', async () => {
    await act((ctx) =>
      repo.saveRitual(ctx, 'shutdown', today, { reflection: 'Good', data: { a: 1 } }),
    );
    await act((ctx) =>
      repo.saveRitual(ctx, 'shutdown', today, { data: { b: 2 }, completed: true }),
    );
    const [r] = await repo.loadRituals(db);
    expect(r!.reflection).toBe('Good');
    expect(r!.data).toEqual({ a: 1, b: 2 });
    expect(r!.completedAt).toBe(clock);
  });
});
