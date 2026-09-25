/** Places tasks into free time on a day, respecting working hours, meetings and buffers. */
import { toast } from 'sonner';
import { perform } from '@/data/actions';
import { busyIntervals, occurrencesInRange, workingHoursOf } from '@/data/selectors';
import * as repo from '@/data/repo';
import { getData } from '@/data/store';
import type { ISODate } from '@/domain/dates';
import { dayBounds, formatTime, isoWeekday } from '@/domain/dates';
import type { Interval } from '@/domain/scheduling';
import { packIntoSlots, workingInterval } from '@/domain/scheduling';

function dayWindow(date: ISODate): Interval {
  const { settings, zone } = getData();
  const work = workingInterval(date, isoWeekday(date), workingHoursOf(settings), zone);
  if (work) return work;
  // Non-working day: allow 08:00–20:00.
  const { start } = dayBounds(date, zone);
  return { start: Date.parse(start) + 8 * 3600_000, end: Date.parse(start) + 20 * 3600_000 };
}

function busyOn(date: ISODate, excludeTaskIds: Set<string>): Interval[] {
  const state = getData();
  const occ = occurrencesInRange(state, date, date);
  const blocks = Object.values(state.blocks)
    .filter((b) => !excludeTaskIds.has(b.taskId) && !state.tasks[b.taskId]?.completedAt)
    .map((b) => ({ start: Date.parse(b.startUtc), end: Date.parse(b.endUtc) }));
  return [...busyIntervals(occ, state.calendars), ...blocks];
}

/**
 * Timeboxes `taskIds` (in order) into the earliest free slots on `date`. Tasks that do not
 * fit are reported, never squeezed into overlapping times.
 */
export async function autoSchedule(
  taskIds: string[],
  date: ISODate,
): Promise<{ placed: number; unplaced: string[] }> {
  const { tasks, settings, today, zone } = getData();
  const items = taskIds
    .map((id) => tasks[id])
    .filter((t): t is NonNullable<typeof t> => !!t && !t.completedAt)
    .map((t) => ({ id: t.id, durationMin: t.estimateMin ?? settings.defaultEstimateMin }));
  const from = date === today ? Date.now() : undefined;
  const { placed, unplaced } = packIntoSlots(
    items,
    dayWindow(date),
    busyOn(date, new Set(taskIds)),
    settings.bufferMin,
    from,
    settings.calendarSnapMin >= 5 ? 5 : settings.calendarSnapMin,
  );
  if (placed.length) {
    await perform(
      { label: placed.length === 1 ? 'Timebox task' : 'Timebox tasks' },
      async (ctx) => {
        for (const p of placed) {
          await repo.createBlock(
            ctx,
            p.id,
            new Date(p.interval.start).toISOString(),
            new Date(p.interval.end).toISOString(),
          );
        }
      },
    );
  }
  if (placed.length === 1 && unplaced.length === 0) {
    const p = placed[0]!;
    toast(
      `Timeboxed at ${formatTime(new Date(p.interval.start).toISOString(), zone, settings.hour12)}`,
    );
  } else if (unplaced.length) {
    toast.warning(
      `${unplaced.length} task${unplaced.length === 1 ? '' : 's'} didn’t fit in the free time left${date === today ? ' today' : ''}.`,
    );
  }
  return { placed: placed.length, unplaced };
}
