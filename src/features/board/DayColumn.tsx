import { memo } from 'react';
import { CalendarClock, MoreHorizontal, Repeat, SkipForward } from 'lucide-react';
import { ui } from '@/app/ui';
import { materializeOccurrence, moveTasks, run, skipOccurrence } from '@/data/actions';
import type { VirtualTask } from '@/data/selectors';
import { isOpen, useTasksOnDate } from '@/data/selectors';
import { useData } from '@/data/store';
import type { ISODate } from '@/domain/dates';
import {
  addDays,
  dayOfMonth,
  formatDuration,
  relativeDateLabel,
  weekdayShort,
} from '@/domain/dates';
import { DropdownMenu } from '@/ui/menu';
import { IconButton, cn } from '@/ui/primitives';
import { AddTaskInline } from '../capture/AddTaskInline';
import { autoSchedule } from '../calendar/autoSchedule';
import { TaskList } from '../dnd/TaskDnd';
import { WorkloadMeter } from './WorkloadMeter';

function VirtualCard({ v }: { v: VirtualTask }) {
  const open = () =>
    run(
      materializeOccurrence(v.series.id, v.date).then((id) => {
        ui.openTask(id);
      }),
    );
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
      aria-label={`${v.series.title}, repeats — upcoming occurrence`}
      className="group flex items-center gap-2.5 rounded-[var(--radius)] border border-dashed border-line-strong px-[var(--card-px)] py-[var(--card-py)] text-[13px] text-muted hover:border-accent/60 hover:text-fg"
    >
      <span className="h-[18px] w-[18px] shrink-0 rounded-full border-[1.5px] border-dashed border-line-strong" />
      <span className="flex-1 truncate">{v.series.title}</span>
      {v.series.estimateMin ? (
        <span className="text-[11.5px] tabular">{formatDuration(v.series.estimateMin)}</span>
      ) : null}
      <Repeat size={12} className="shrink-0 opacity-60" />
      <IconButton
        label="Skip this occurrence"
        size="xs"
        className="opacity-0 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          run(skipOccurrence(v.series.id, v.date));
        }}
      >
        <SkipForward size={12} />
      </IconButton>
    </div>
  );
}

export const DayColumn = memo(function DayColumn({
  date,
  virtual,
}: {
  date: ISODate;
  virtual: VirtualTask[];
}) {
  const today = useData((s) => s.today);
  const tasks = useTasksOnDate(date);
  const isToday = date === today;
  const isPast = date < today;
  const open = tasks.filter(isOpen);
  const done = tasks.length - open.length;
  const unscheduled = open.map((t) => t.id);

  return (
    <section
      aria-label={relativeDateLabel(date, today)}
      className={cn('flex w-[288px] shrink-0 flex-col rounded-2xl', isToday && 'bg-accent/[0.035]')}
    >
      <header className="flex flex-col gap-2 px-2 pt-3 pb-2">
        <div className="flex items-start justify-between">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                'text-[22px] leading-none font-semibold tabular',
                isToday ? 'text-accent-text' : isPast ? 'text-subtle' : 'text-fg',
              )}
            >
              {dayOfMonth(date)}
            </span>
            <div className="flex flex-col">
              <span className={cn('text-[13px] font-semibold', isPast ? 'text-muted' : 'text-fg')}>
                {relativeDateLabel(date, today)}
              </span>
              <span className="text-[11px] text-subtle">
                {weekdayShort(date)}
                {tasks.length > 0 && ` · ${done}/${tasks.length} done`}
              </span>
            </div>
          </div>
          <DropdownMenu
            trigger={
              <IconButton label={`Actions for ${relativeDateLabel(date, today)}`} size="xs">
                <MoreHorizontal size={14} />
              </IconButton>
            }
            items={[
              {
                label: 'Timebox open tasks',
                icon: <CalendarClock size={14} />,
                disabled: unscheduled.length === 0 || isPast,
                onSelect: () => run(autoSchedule(unscheduled, date)),
              },
              {
                label: 'Move unfinished to next day',
                disabled: open.length === 0,
                onSelect: () =>
                  run(
                    moveTasks(
                      open.map((t) => t.id),
                      addDays(isPast ? today : date, isPast ? 0 : 1),
                    ),
                  ),
              },
              { kind: 'separator' },
              { label: 'Plan this day…', onSelect: () => ui.ritual({ kind: 'plan', date }) },
              ...(date <= today
                ? [
                    {
                      label: 'Shut down this day…',
                      onSelect: () => ui.ritual({ kind: 'shutdown', date }),
                    },
                  ]
                : []),
            ]}
          />
        </div>
        <WorkloadMeter date={date} isToday={isToday} />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-6">
        <AddTaskInline planDate={date} />
        <TaskList container={`day:${date}`} listDate={date} className="pb-2" />
        {virtual.map((v) => (
          <VirtualCard key={`${v.series.id}|${v.date}`} v={v} />
        ))}
      </div>
    </section>
  );
});
