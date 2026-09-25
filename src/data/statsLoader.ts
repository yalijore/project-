import { useEffect, useMemo, useState } from 'react';
import type { ISODate } from '@/domain/dates';
import type { PlanEntryRow, RangeStats } from '@/domain/stats';
import { computeRangeStats } from '@/domain/stats';
import { busyIntervals, occurrencesInRange } from './selectors';
import { getDb } from './runtime';
import { useData } from './store';

export async function loadPlanEntries(from: ISODate, to: ISODate): Promise<PlanEntryRow[]> {
  const rows = await getDb().all<{
    plan_date: string;
    status: PlanEntryRow['status'];
    task_id: string;
  }>('SELECT plan_date, status, task_id FROM day_plan_entries WHERE plan_date BETWEEN ? AND ?', [
    from,
    to,
  ]);
  return rows.map((r) => ({ planDate: r.plan_date, status: r.status, taskId: r.task_id }));
}

/** Review statistics for [from, to], recomputed when tasks, sessions or events change. */
export function useRangeStats(from: ISODate, to: ISODate): RangeStats | null {
  const tasks = useData((s) => s.tasks);
  const sessions = useData((s) => s.sessions);
  const events = useData((s) => s.events);
  const calendars = useData((s) => s.calendars);
  const projects = useData((s) => s.projects);
  const areas = useData((s) => s.areas);
  const zone = useData((s) => s.zone);
  const [entries, setEntries] = useState<PlanEntryRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPlanEntries(from, to)
      .then((rows) => !cancelled && setEntries(rows))
      .catch((e) => console.error(e));
    return () => {
      cancelled = true;
    };
  }, [from, to, tasks]);

  return useMemo(() => {
    if (!entries) return null;
    const occ = occurrencesInRange({ events, calendars, zone }, from, to);
    return computeRangeStats({
      from,
      to,
      zone,
      now: Date.now(),
      entries,
      tasks,
      sessions: Object.values(sessions),
      meetings: busyIntervals(occ, calendars),
      categories: { projects, areas },
    });
  }, [entries, events, calendars, zone, from, to, tasks, sessions, projects, areas]);
}
