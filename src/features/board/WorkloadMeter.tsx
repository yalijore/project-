import { AlertTriangle } from 'lucide-react';
import { useWorkload } from '@/data/selectors';
import type { ISODate } from '@/domain/dates';
import { formatDuration } from '@/domain/dates';
import { Tooltip, cn } from '@/ui/primitives';

/** Planned work versus the day's capacity. Informational, never a score. */
export function WorkloadMeter({ date, isToday }: { date: ISODate; isToday: boolean }) {
  const w = useWorkload(date);
  const load = w.remainingMin + (isToday ? 0 : w.meetingMin);
  const capacity = w.capacityMin;
  const pctTasks = capacity ? Math.min(100, (w.remainingMin / capacity) * 100) : 0;
  const pctMeetings = capacity ? Math.min(100 - pctTasks, (w.meetingMin / capacity) * 100) : 0;
  // Today, the useful question is whether the work left fits in the time left; on other
  // days, whether the day's plan exceeds its capacity.
  const wontFit = isToday && w.overOpenTime && w.wontFitMin > 0;
  const warn = wontFit || w.overCapacity;
  const warning = wontFit
    ? `${formatDuration(w.wontFitMin)} won’t fit today`
    : `${formatDuration(w.overCapacityMin)} over capacity`;

  const detail = (
    <div className="flex max-w-[260px] flex-col gap-0.5">
      <span>Estimated work left: {formatDuration(w.remainingMin)}</span>
      {w.scheduledMin > 0 && (
        <span>
          Of that, timeboxed{isToday ? ' later today' : ''}: {formatDuration(w.scheduledMin)}
        </span>
      )}
      <span>Meetings: {formatDuration(w.meetingMin)}</span>
      {isToday && <span>Free work time left today: {formatDuration(w.freeMin)}</span>}
      <span>Daily capacity: {formatDuration(capacity)}</span>
      {w.unestimatedCount > 0 && (
        <span>{w.unestimatedCount} without estimate (counted as default)</span>
      )}
      {wontFit && (
        <span className="pt-1">
          {formatDuration(w.remainingMin - w.scheduledMin)} of work has no time block ahead, and
          only {formatDuration(w.freeMin)} of your working hours is still free. Timebox it later,
          move some to another day, or shorten estimates.
        </span>
      )}
      {!wontFit && w.overCapacity && (
        <span className="pt-1">
          Work left plus meetings is more than the {formatDuration(capacity)} you plan per day.
        </span>
      )}
    </div>
  );

  if (w.plannedMin === 0 && w.remainingMin === 0 && w.meetingMin === 0) {
    return (
      <div className="h-[18px] text-[11.5px] text-subtle">
        {w.isWorkingDay ? 'Nothing planned yet' : 'Day off'}
      </div>
    );
  }

  return (
    <Tooltip content={detail} side="bottom">
      <div
        className="flex flex-col gap-1"
        aria-label={`Workload: ${formatDuration(w.remainingMin)} of tasks left, ${formatDuration(w.meetingMin)} of meetings, capacity ${formatDuration(capacity)}${warn ? `; ${warning}` : ''}`}
      >
        <div className="flex h-1.5 overflow-hidden rounded-full bg-line/70">
          <div
            className={cn('h-full transition-all', warn ? 'bg-warn' : 'bg-accent')}
            style={{ width: `${pctTasks}%` }}
          />
          <div className="h-full bg-muted/40" style={{ width: `${pctMeetings}%` }} />
        </div>
        <div className="flex items-center gap-1.5 text-[11.5px] text-muted tabular">
          {warn && <AlertTriangle size={12} className="text-warn" aria-hidden />}
          <span className={cn(warn && 'font-medium text-warn')}>
            {formatDuration(load)} / {formatDuration(capacity)}
          </span>
          {w.meetingMin > 0 && (
            <span className="text-subtle">· {formatDuration(w.meetingMin)} meetings</span>
          )}
          {warn && <span className="font-medium text-warn">· {warning}</span>}
        </div>
      </div>
    </Tooltip>
  );
}
