import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@/db/driver';
import { virtualOccurrences } from '@/domain/recurrence';
import { createTestDb } from '@/test/testDb';
import * as rec from './recurrenceRepo';
import type { Ctx } from './repo';
import * as repo from './repo';

const ZONE = 'America/New_York';
let db: Database;
let clock = '2026-09-25T12:00:00.000Z';
let today = '2026-09-25'; // Friday

async function act<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  return db.transaction((tx) =>
    fn({ tx, now: clock, today, zone: ZONE, changes: new repo.ChangeSet() }),
  );
}

async function instances(seriesId: string) {
  return (await repo.loadTasks(db))
    .filter((t) => t.recurrenceId === seriesId)
    .sort((a, b) => a.recurrenceDate!.localeCompare(b.recurrenceDate!));
}

function setDay(date: string) {
  today = date;
  clock = `${date}T12:00:00.000Z`;
}

beforeEach(async () => {
  db = await createTestDb();
  setDay('2026-09-25');
});

describe('recurring tasks', () => {
  it('materializes today’s occurrence with template fields and a timebox', async () => {
    const tag = await act((ctx) => repo.createTag(ctx, 'health', '#000'));
    const id = await act((ctx) =>
      rec.createSeries(ctx, {
        rrule: 'FREQ=DAILY',
        dtstart: '2026-09-25',
        title: 'Stretch',
        estimateMin: 15,
        tagIds: [tag],
        subtasks: ['Neck', 'Back'],
        startTime: '08:00',
        dueOffsetDays: 0,
      }),
    );
    const created = await act((ctx) => rec.materializeDue(ctx, today));
    expect(created).toHaveLength(1);
    const [t] = await instances(id);
    expect(t).toMatchObject({
      title: 'Stretch',
      planDate: today,
      estimateMin: 15,
      dueDate: today,
      tagIds: [tag],
    });
    expect(t!.subtasks.map((s) => s.title)).toEqual(['Neck', 'Back']);
    const [block] = await repo.loadBlocks(db, [t!.id]);
    expect(block!.startUtc).toBe('2026-09-25T12:00:00.000Z'); // 08:00 EDT
    // Idempotent.
    expect(await act((ctx) => rec.materializeDue(ctx, today))).toEqual([]);
  });

  it('after time away creates only today’s and the latest missed occurrence', async () => {
    const id = await act((ctx) =>
      rec.createSeries(
        ctx,
        { rrule: 'FREQ=DAILY', dtstart: '2026-09-20', title: 'Journal' },
        '2026-09-20',
      ),
    );
    await act((ctx) => rec.materializeDue(ctx, today));
    expect((await instances(id)).map((t) => t.recurrenceDate)).toEqual([
      '2026-09-24',
      '2026-09-25',
    ]);
    // Rollover then marks the stale one skipped rather than duplicating it.
    await act((ctx) => repo.rolloverTasks(ctx, today));
    const [old, current] = await instances(id);
    expect(old!.archivedAt).not.toBeNull();
    expect(current!.planDate).toBe(today);
  });

  it('carries a missed weekly occurrence forward when nothing newer exists', async () => {
    const id = await act((ctx) =>
      rec.createSeries(
        ctx,
        { rrule: 'FREQ=WEEKLY;BYDAY=MO', dtstart: '2026-09-21', title: 'Weekly report' },
        '2026-09-20',
      ),
    );
    await act((ctx) => rec.materializeDue(ctx, today));
    const [monday] = await instances(id);
    expect(monday!.planDate).toBe('2026-09-21');
    await act((ctx) => repo.rolloverTasks(ctx, today));
    const [after] = await instances(id);
    expect(after!.planDate).toBe(today);
    expect(after!.rolloverCount).toBe(1);
  });

  it('completing an instance never changes the series or other instances', async () => {
    const id = await act((ctx) =>
      rec.createSeries(ctx, { rrule: 'FREQ=DAILY', dtstart: today, title: 'Water plants' }),
    );
    await act((ctx) => rec.materializeDue(ctx, today));
    const [inst] = await instances(id);
    await act((ctx) => repo.completeTask(ctx, inst!.id));
    const series = (await repo.loadSeries(db))[0]!;
    expect(series.title).toBe('Water plants');
    expect(series.rrule).toBe('FREQ=DAILY');
    setDay('2026-09-26');
    await act((ctx) => rec.materializeDue(ctx, today));
    const all = await instances(id);
    expect(all).toHaveLength(2);
    expect(all[1]!.completedAt).toBeNull();
  });

  it('skips occurrences permanently, including deleted instances', async () => {
    const id = await act((ctx) =>
      rec.createSeries(ctx, { rrule: 'FREQ=DAILY', dtstart: today, title: 'Run' }),
    );
    await act((ctx) => rec.skipOccurrence(ctx, id, '2026-09-27'));
    const inst = await act((ctx) => rec.materializeOccurrence(ctx, id, today));
    await act((ctx) => repo.deleteTasks(ctx, [inst!]));
    expect(await act((ctx) => rec.materializeOccurrence(ctx, id, today))).toBeNull();
    expect(await act((ctx) => rec.materializeOccurrence(ctx, id, '2026-09-27'))).toBeNull();
    const series = await repo.loadSeries(db);
    expect(series[0]!.skipDates).toEqual(['2026-09-25', '2026-09-27']);
  });

  it('series edits flow to untouched open instances only', async () => {
    const id = await act((ctx) =>
      rec.createSeries(ctx, {
        rrule: 'FREQ=DAILY',
        dtstart: today,
        title: 'Review',
        estimateMin: 20,
      }),
    );
    const a = await act((ctx) => rec.materializeOccurrence(ctx, id, today));
    const b = await act((ctx) => rec.materializeOccurrence(ctx, id, '2026-09-26'));
    const c = await act((ctx) => rec.materializeOccurrence(ctx, id, '2026-09-27'));
    await act((ctx) => repo.updateTasks(ctx, [b!], { title: 'Review (special)' }));
    await act((ctx) => repo.completeTask(ctx, c!));
    await act((ctx) => rec.updateSeries(ctx, id, { title: 'Weekly review', estimateMin: 30 }));
    const [ta, tb, tc] = await repo
      .loadTasks(db, [a!, b!, c!])
      .then((ts) => [a, b, c].map((x) => ts.find((t) => t.id === x)!));
    expect(ta!.title).toBe('Weekly review');
    expect(ta!.estimateMin).toBe(30);
    expect(tb!.title).toBe('Review (special)');
    expect(tb!.estimateMin).toBe(30);
    expect(tc!.title).toBe('Review');
  });

  it('changing the rule removes open future instances that no longer match', async () => {
    const id = await act((ctx) =>
      rec.createSeries(ctx, { rrule: 'FREQ=DAILY', dtstart: today, title: 'X' }),
    );
    await act((ctx) => rec.materializeOccurrence(ctx, id, '2026-09-26')); // Saturday
    await act((ctx) => rec.materializeOccurrence(ctx, id, '2026-09-28')); // Monday
    await act((ctx) => rec.updateSeries(ctx, id, { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }));
    expect((await instances(id)).map((t) => t.recurrenceDate)).toEqual(['2026-09-28']);
  });

  it('ending a series stops future occurrences', async () => {
    const id = await act((ctx) =>
      rec.createSeries(ctx, { rrule: 'FREQ=DAILY', dtstart: today, title: 'Y' }),
    );
    await act((ctx) => rec.materializeOccurrence(ctx, id, '2026-09-28'));
    await act((ctx) => rec.endSeries(ctx, id, '2026-09-26'));
    expect(await instances(id)).toHaveLength(0);
    expect(await act((ctx) => rec.materializeOccurrence(ctx, id, '2026-09-27'))).toBeNull();
    const [s] = await repo.loadSeries(db);
    expect(
      virtualOccurrences([s!], new Set(), '2026-09-25', '2026-10-05', today).map((v) => v.date),
    ).toEqual(['2026-09-26']);
  });

  it('turns a one-off task into a series', async () => {
    const taskId = await act((ctx) =>
      repo.createTask(ctx, { title: 'Pay rent', planDate: '2026-10-01', estimateMin: 10 }),
    );
    const seriesId = await act((ctx) =>
      rec.makeTaskRecurring(ctx, taskId, 'FREQ=MONTHLY;BYMONTHDAY=1', '2026-10-01'),
    );
    const [t] = await repo.loadTasks(db, [taskId]);
    expect(t!.recurrenceId).toBe(seriesId);
    expect(t!.recurrenceDate).toBe('2026-10-01');
    const [s] = await repo.loadSeries(db);
    const materialized = new Set([`${seriesId}|2026-10-01`]);
    expect(
      virtualOccurrences([s!], materialized, '2026-09-25', '2026-12-31', today).map((v) => v.date),
    ).toEqual(['2026-11-01', '2026-12-01']);
  });
});
