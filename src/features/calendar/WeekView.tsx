import { useCallback, useMemo } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { ui, useUi } from '@/app/ui';
import { moveTask, reorderDay, run } from '@/data/actions';
import { isOpen, tasksOnDate, useBlocksByTask } from '@/data/selectors';
import { useData } from '@/data/store';
import {
  addDays,
  dateOfInstant,
  dateRange,
  formatDateShort,
  formatDuration,
  relativeDateLabel,
  startOfWeek,
} from '@/domain/dates';
import { Button, IconButton } from '@/ui/primitives';
import { ViewHeader } from '../common/ViewHeader';
import type { MoveResult } from '../dnd/TaskDnd';
import { TaskDndProvider, TaskList } from '../dnd/TaskDnd';
import { autoSchedule } from './autoSchedule';
import { TimeGrid } from './TimeGrid';

export function WeekView() {
  const today = useData((s) => s.today);
  const weekStartsOn = useData((s) => s.settings.weekStartsOn);
  const hourHeight = useData((s) => s.settings.calendarHourHeight);
  const tasks = useData((s) => s.tasks);
  const zone = useData((s) => s.zone);
  const weekStart = useUi((s) => s.weekStart) ?? startOfWeek(today, weekStartsOn);
  const days = useMemo(() => dateRange(weekStart, addDays(weekStart, 6)), [weekStart]);
  const blocksByTask = useBlocksByTask();

  const unscheduled = useMemo(
    () =>
      Object.fromEntries(
        days.map((d) => [
          `day:${d}`,
          tasksOnDate(tasks, d)
            .filter(
              (t) =>
                isOpen(t) &&
                !(blocksByTask.get(t.id) ?? []).some((b) => dateOfInstant(b.startUtc, zone) === d),
            )
            .map((t) => t.id),
        ]),
      ),
    [days, tasks, blocksByTask, zone],
  );

  const onMove = useCallback(
    ({ taskId, from, to, index, ids }: MoveResult) => {
      if (!to.startsWith('day:')) return;
      const date = to.slice(4);
      if (from === to) {
        const full = tasksOnDate(tasks, date).map((t) => t.id);
        const rest = full.filter((id) => !ids.includes(id));
        run(reorderDay(date, [...ids, ...rest]));
      } else run(moveTask(taskId, date, { index }));
    },
    [tasks],
  );

  const set = (d: string) => useUi.setState({ weekStart: d });
  const end = days.at(-1)!;

  return (
    <TaskDndProvider containers={unscheduled} onMove={onMove}>
      <div className="flex h-full min-h-0 flex-col">
        <ViewHeader
          title="Week"
          subtitle={`${formatDateShort(weekStart, today)} – ${formatDateShort(end, today)}`}
          left={
            <div className="ml-2 flex items-center gap-0.5">
              <IconButton label="Previous week ([)" onClick={() => set(addDays(weekStart, -7))}>
                <ChevronLeft size={16} />
              </IconButton>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => set(startOfWeek(today, weekStartsOn))}
              >
                This week
              </Button>
              <IconButton label="Next week (])" onClick={() => set(addDays(weekStart, 7))}>
                <ChevronRight size={16} />
              </IconButton>
            </div>
          }
          right={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => ui.ritual({ kind: 'weekly', date: startOfWeek(today, weekStartsOn) })}
            >
              Weekly review
            </Button>
          }
        />
        <div className="flex min-h-0 flex-1 border-t border-line">
          <aside
            aria-label="Tasks not yet timeboxed"
            className="flex w-[272px] shrink-0 flex-col border-r border-line"
          >
            <div className="px-3 pt-3 pb-2">
              <h2 className="text-[13px] font-semibold">Not yet timeboxed</h2>
              <p className="text-[11.5px] text-subtle">
                Drag onto the calendar, or auto-place a day.
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
              {days.map((d) => {
                const ids = unscheduled[`day:${d}`] ?? [];
                const minutes = ids.reduce((s, id) => s + (tasks[id]?.estimateMin ?? 0), 0);
                return (
                  <section key={d} className="mb-2">
                    <div className="mb-1.5 flex items-center gap-2">
                      <span
                        className={
                          d === today
                            ? 'text-[12px] font-semibold text-accent-text'
                            : 'text-[12px] font-semibold text-muted'
                        }
                      >
                        {relativeDateLabel(d, today)}
                      </span>
                      <span className="text-[11px] text-subtle tabular">
                        {ids.length ? `${ids.length} · ${formatDuration(minutes)}` : ''}
                      </span>
                      {ids.length > 0 && d >= today && (
                        <IconButton
                          label={`Auto-timebox ${relativeDateLabel(d, today)}`}
                          size="xs"
                          className="ml-auto"
                          onClick={() => run(autoSchedule(ids, d))}
                        >
                          <CalendarClock size={13} />
                        </IconButton>
                      )}
                    </div>
                    <TaskList container={`day:${d}`} listDate={d} compact />
                  </section>
                );
              })}
            </div>
          </aside>
          <div className="min-w-0 flex-1 bg-surface">
            <TimeGrid
              days={days}
              hourHeight={hourHeight}
              showDayHeaders
              scrollKey={weekStart}
              onCreateEvent={(date, startMin, endMin) =>
                useUi.setState({ eventDraft: { date, startMin, endMin } })
              }
            />
          </div>
        </div>
      </div>
    </TaskDndProvider>
  );
}
