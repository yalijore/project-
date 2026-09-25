/**
 * Day workload: how much is planned versus how much time the day realistically has.
 * Never a score — just the arithmetic behind "this day is overcommitted".
 */
import type { ISODate } from './dates';
import type { Interval, WorkingHours } from './scheduling';
import { clip, freeSlots, mergeIntervals, totalMinutes, workingInterval } from './scheduling';

export interface WorkloadTask {
  id: string;
  estimateMin: number | null;
  actualMin: number;
  done: boolean;
  /** The task's time blocks on this day (clipped to it). */
  blocks?: Interval[];
}

export interface WorkloadInput {
  date: ISODate;
  weekday: number;
  zone: string;
  now: number;
  isToday: boolean;
  tasks: WorkloadTask[];
  /** Busy meeting intervals on this day (already expanded). */
  meetings: Interval[];
  workingHours: WorkingHours;
  capacityMin: number;
  defaultEstimateMin: number;
}

export interface Workload {
  /** Sum of estimates for every task planned on the day (done or not). */
  plannedMin: number;
  /** Estimated work still to do: max(estimate − tracked, 0) over open tasks. */
  remainingMin: number;
  /** Meeting time within working hours (overlaps counted once). */
  meetingMin: number;
  /** remaining work + remaining meetings compared against this. */
  capacityMin: number;
  /** For today: open time left in working hours after meetings; otherwise the full day's. */
  openMin: number;
  /** Remaining work that already has a time block ahead (for today: after now). */
  scheduledMin: number;
  /** Open working time not taken by those blocks either. */
  freeMin: number;
  unestimatedCount: number;
  overCapacity: boolean;
  /** Remaining work without a time block ahead doesn't fit into the free working time. */
  overOpenTime: boolean;
  overByMin: number;
  /** How far remaining work plus meetings exceeds the daily capacity. */
  overCapacityMin: number;
  /** Remaining work without a time block ahead that does not fit into the free working time. */
  wontFitMin: number;
  isWorkingDay: boolean;
}

export function computeWorkload(input: WorkloadInput): Workload {
  const window = workingInterval(input.date, input.weekday, input.workingHours, input.zone);
  const isWorkingDay = window !== null;
  // Time blocks still ahead: a task timeboxed later (even outside working hours) has a slot.
  const ahead: Interval = { start: input.isToday ? input.now : -Infinity, end: Infinity };
  let plannedMin = 0;
  let remainingMin = 0;
  let scheduledMin = 0;
  let unestimatedCount = 0;
  const blocksAhead: Interval[] = [];
  for (const t of input.tasks) {
    const estimate = t.estimateMin ?? input.defaultEstimateMin;
    if (t.estimateMin == null && !t.done) unestimatedCount++;
    plannedMin += t.estimateMin ?? 0;
    if (t.done) continue;
    const left = Math.max(estimate - t.actualMin, 0);
    remainingMin += left;
    const mine = (t.blocks ?? []).map((b) => clip(b, ahead)).filter(Boolean) as Interval[];
    blocksAhead.push(...mine);
    scheduledMin += Math.min(left, totalMinutes(mergeIntervals(mine)));
  }

  const meetingsInHours = window
    ? (mergeIntervals(input.meetings)
        .map((m) => clip(m, window))
        .filter(Boolean) as Interval[])
    : [];
  const meetingMin = totalMinutes(meetingsInHours);

  // Meetings still ahead count against today's capacity; past ones already happened.
  const upcomingMeetings = input.isToday
    ? totalMinutes(
        meetingsInHours
          .map((m) => clip(m, { start: input.now, end: Infinity }))
          .filter(Boolean) as Interval[],
      )
    : meetingMin;

  const openMin = window
    ? totalMinutes(freeSlots(window, input.meetings, 0, input.isToday ? input.now : undefined))
    : 0;

  const freeMin = window
    ? totalMinutes(
        freeSlots(
          window,
          [...input.meetings, ...blocksAhead],
          0,
          input.isToday ? input.now : undefined,
        ),
      )
    : 0;

  const load = remainingMin + upcomingMeetings;
  const unscheduledMin = remainingMin - scheduledMin;
  const overCapacity = load > input.capacityMin;
  const overOpenTime = unscheduledMin > freeMin;
  const overByMin = Math.max(load - input.capacityMin, unscheduledMin - freeMin, 0);

  return {
    plannedMin,
    remainingMin,
    meetingMin,
    capacityMin: input.capacityMin,
    openMin,
    scheduledMin,
    freeMin,
    unestimatedCount,
    overCapacity,
    overOpenTime,
    overByMin: Math.round(overByMin),
    overCapacityMin: Math.round(Math.max(load - input.capacityMin, 0)),
    wontFitMin: Math.round(Math.max(unscheduledMin - freeMin, 0)),
    isWorkingDay,
  };
}
