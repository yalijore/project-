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
  unestimatedCount: number;
  overCapacity: boolean;
  /** remaining work doesn't fit into open time. */
  overOpenTime: boolean;
  overByMin: number;
  isWorkingDay: boolean;
}

export function computeWorkload(input: WorkloadInput): Workload {
  const window = workingInterval(input.date, input.weekday, input.workingHours, input.zone);
  const isWorkingDay = window !== null;
  let plannedMin = 0;
  let remainingMin = 0;
  let unestimatedCount = 0;
  for (const t of input.tasks) {
    const estimate = t.estimateMin ?? input.defaultEstimateMin;
    if (t.estimateMin == null && !t.done) unestimatedCount++;
    plannedMin += t.estimateMin ?? 0;
    if (!t.done) remainingMin += Math.max(estimate - t.actualMin, 0);
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

  const load = remainingMin + upcomingMeetings;
  const overCapacity = load > input.capacityMin;
  const overOpenTime = remainingMin > openMin;
  const overByMin = Math.max(load - input.capacityMin, remainingMin - openMin, 0);

  return {
    plannedMin,
    remainingMin,
    meetingMin,
    capacityMin: input.capacityMin,
    openMin,
    unestimatedCount,
    overCapacity,
    overOpenTime,
    overByMin: Math.round(overByMin),
    isWorkingDay,
  };
}
