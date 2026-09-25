import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, Plus, Sunrise, Trash2 } from 'lucide-react';
import { ui } from '@/app/ui';
import {
  deleteTasks,
  moveTask,
  moveTasks,
  reorderDay,
  run,
  saveRitual,
  updateTask,
} from '@/data/actions';
import {
  backlogTasks,
  inboxTasks,
  isOpen,
  overdueTasks,
  tasksOnDate,
  useBlocksByTask,
  useWorkload,
} from '@/data/selectors';
import { useData } from '@/data/store';
import type { ISODate } from '@/domain/dates';
import {
  addDays,
  diffDays,
  formatDateLong,
  formatDuration,
  relativeDateLabel,
} from '@/domain/dates';
import type { Priority, Task } from '@/domain/types';
import { PRIORITY_LABELS } from '@/domain/types';
import { AutoTextarea, Button, ColorDot, EmptyState, Label, Segmented, cn } from '@/ui/primitives';
import { AddTaskInline } from '../capture/AddTaskInline';
import { autoSchedule } from '../calendar/autoSchedule';
import { TimeGrid } from '../calendar/TimeGrid';
import type { MoveResult } from '../dnd/TaskDnd';
import { TaskDndProvider, TaskList } from '../dnd/TaskDnd';
import { RitualFrame, RitualTaskRow } from './RitualFrame';
import { Stat } from './ShutdownRitual';

const QUICK_ESTIMATES = [15, 30, 45, 60, 90, 120];

function ProjectLabel({ task }: { task: Task }) {
  const projects = useData((s) => s.projects);
  const areas = useData((s) => s.areas);
  const p = task.projectId ? projects[task.projectId] : null;
  const a = !p && task.areaId ? areas[task.areaId] : null;
  const x = p ?? a;
  if (!x) return null;
  return (
    <span className="flex items-center gap-1 text-[11.5px] text-muted">
      <ColorDot color={x.color} size={7} /> {x.name}
    </span>
  );
}

type Source = 'due' | 'inbox' | 'backlog';

function Candidates({ date }: { date: ISODate }) {
  const tasks = useData((s) => s.tasks);
  const today = useData((s) => s.today);
  const [source, setSource] = useState<Source>('due');
  const lists = useMemo(() => {
    const backlog = backlogTasks(tasks);
    const due = Object.values(tasks)
      .filter(
        (t) => isOpen(t) && t.dueDate && diffDays(date, t.dueDate) <= 3 && t.planDate !== date,
      )
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
    return { due, inbox: inboxTasks(tasks), backlog };
  }, [tasks, date]);
  const list = lists[source];
  return (
    <div className="flex min-h-0 flex-col rounded-2xl border border-line bg-sunken/60 p-3">
      <Segmented<Source>
        label="Suggestions"
        size="xs"
        value={source}
        onChange={setSource}
        options={[
          { value: 'due', label: `Due soon (${lists.due.length})` },
          { value: 'inbox', label: `Inbox (${lists.inbox.length})` },
          { value: 'backlog', label: `Backlog (${lists.backlog.length})` },
        ]}
      />
      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {list.length === 0 && (
          <p className="px-2 py-6 text-center text-[12.5px] text-subtle">Nothing here.</p>
        )}
        {list.map((t) => (
          <div
            key={t.id}
            className="group flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 shadow-sm"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{t.title}</div>
              <div className="flex gap-2">
                <ProjectLabel task={t} />
                {t.dueDate && (
                  <span
                    className={cn('text-[11.5px]', t.dueDate < today ? 'text-danger' : 'text-warn')}
                  >
                    Due {relativeDateLabel(t.dueDate, today)}
                  </span>
                )}
                {t.planDate && (
                  <span className="text-[11.5px] text-subtle">
                    Planned {relativeDateLabel(t.planDate, today)}
                  </span>
                )}
              </div>
            </div>
            {t.estimateMin ? (
              <span className="text-[11.5px] text-muted tabular">
                {formatDuration(t.estimateMin)}
              </span>
            ) : null}
            <Button
              size="xs"
              variant="secondary"
              onClick={() => run(moveTask(t.id, date))}
              aria-label={`Add “${t.title}” to ${relativeDateLabel(date, today)}`}
            >
              <Plus size={12} /> Add
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverloadSuggestions({ date, tasks }: { date: ISODate; tasks: Task[] }) {
  const w = useWorkload(date);
  const today = useData((s) => s.today);
  const defaultEstimate = useData((s) => s.settings.defaultEstimateMin);
  const tomorrow = addDays(date, 1);
  const suggestions = useMemo(() => {
    // Lowest priority first; among equals, later (or no) deadline first. Keep anything due on this day.
    const open = tasks
      .filter((t) => isOpen(t) && !(t.dueDate && t.dueDate <= date))
      .sort(
        (a, b) =>
          a.priority - b.priority || (b.dueDate ?? '9999').localeCompare(a.dueDate ?? '9999'),
      );
    const out: Task[] = [];
    let excess = w.overByMin;
    for (const t of open) {
      if (excess <= 0) break;
      out.push(t);
      excess -= t.estimateMin ?? defaultEstimate;
    }
    return out;
  }, [tasks, w.overByMin, date, defaultEstimate]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set(suggestions.map((t) => t.id))), [suggestions]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-4 gap-3">
        <Stat label="Tasks left" value={formatDuration(w.remainingMin)} />
        <Stat label="Meetings" value={formatDuration(w.meetingMin)} />
        <Stat label="Capacity" value={formatDuration(w.capacityMin)} sub="Settings → Planning" />
        <Stat
          label={date === today ? 'Open time left' : 'Open time'}
          value={formatDuration(w.openMin)}
          sub="in working hours"
        />
      </div>
      {w.overCapacity || w.overOpenTime ? (
        <div className="rounded-2xl border border-warn/40 bg-warn-soft p-4">
          <div className="flex items-center gap-2 font-medium text-fg">
            <AlertTriangle size={16} className="text-warn" />
            This day is overcommitted by about {formatDuration(w.overByMin)}.
          </div>
          <p className="mt-1 text-[12.5px] text-muted">
            Suggested to move to {relativeDateLabel(tomorrow, today)} (lowest priority first,
            nothing due today):
          </p>
          <div className="mt-3 flex flex-col gap-1.5">
            {suggestions.map((t) => (
              <label
                key={t.id}
                className="flex items-center gap-2.5 rounded-lg bg-surface px-3 py-2 text-[13px]"
              >
                <input
                  type="checkbox"
                  checked={picked.has(t.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(t.id);
                    else next.delete(t.id);
                    setPicked(next);
                  }}
                  className="accent-[var(--accent)]"
                />
                <span className="flex-1">{t.title}</span>
                <span className="text-[11.5px] text-muted">{PRIORITY_LABELS[t.priority]}</span>
                <span className="text-[11.5px] text-muted tabular">
                  {formatDuration(t.estimateMin ?? defaultEstimate)}
                </span>
              </label>
            ))}
          </div>
          <Button
            className="mt-3"
            variant="primary"
            size="sm"
            disabled={picked.size === 0}
            onClick={() => run(moveTasks([...picked], tomorrow))}
          >
            Move {picked.size} to {relativeDateLabel(tomorrow, today)}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-2xl border border-ok/30 bg-ok-soft p-4 text-[13.5px]">
          <CheckCircle2 size={16} className="text-ok" /> This plan fits your day
          {w.unestimatedCount
            ? ` (${w.unestimatedCount} task${w.unestimatedCount === 1 ? '' : 's'} have no estimate yet)`
            : ''}
          .
        </div>
      )}
    </div>
  );
}

export function PlanningRitual({ date }: { date: ISODate }) {
  const tasks = useData((s) => s.tasks);
  const today = useData((s) => s.today);
  const hourHeight = useData((s) => s.settings.calendarHourHeight);
  const existing = useData((s) =>
    Object.values(s.rituals).find((r) => r.kind === 'plan' && r.period === date),
  );
  const blocksByTask = useBlocksByTask();
  const [index, setIndex] = useState(0);
  const [intention, setIntention] = useState(String(existing?.data.intention ?? ''));

  useEffect(() => {
    run(saveRitual('plan', date, {}));
  }, [date]);

  const dayTasks = useMemo(() => tasksOnDate(tasks, date), [tasks, date]);
  const openToday = dayTasks.filter(isOpen);
  const overdue = useMemo(
    () => (date === today ? overdueTasks(tasks, today) : []),
    [tasks, today, date],
  );
  const carried = openToday.filter((t) => t.rolloverCount > 0);
  const yesterday = addDays(date, -1);
  const yesterdayDone = useMemo(
    () => tasksOnDate(tasks, yesterday).filter((t) => t.completedAt).length,
    [tasks, yesterday],
  );
  const unscheduled = openToday.filter(
    (t) =>
      !(blocksByTask.get(t.id) ?? []).some((b) => b.startUtc.slice(0, 10) >= addDays(date, -1)),
  );

  const containers = useMemo(
    () => ({
      [`day:${date}`]: dayTasks.map((t) => t.id),
      'list:unscheduled': unscheduled.map((t) => t.id),
    }),
    [dayTasks, unscheduled, date],
  );
  const onMove = useCallback(
    ({ taskId, to, index: i, ids }: MoveResult) => {
      if (to === `day:${date}`) {
        if (tasks[taskId]?.planDate === date) run(reorderDay(date, ids));
        else run(moveTask(taskId, date, { index: i }));
      }
    },
    [date, tasks],
  );

  const reviewRows = [...overdue, ...carried];

  const steps = [
    {
      id: 'review',
      title: 'Review unfinished work',
      hint:
        reviewRows.length > 0
          ? 'These were planned before and are still open. Decide what to do with each so nothing lingers by accident.'
          : undefined,
      content:
        reviewRows.length === 0 ? (
          <EmptyState icon={<CheckCircle2 size={28} />} title="A clean slate">
            Nothing is carried over
            {yesterdayDone
              ? ` — and you finished ${yesterdayDone} task${yesterdayDone === 1 ? '' : 's'} yesterday`
              : ''}
            .
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-2">
            {reviewRows.map((t) => (
              <RitualTaskRow key={t.id}>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px]">{t.title}</div>
                  <div className="flex gap-2 text-[11.5px] text-muted">
                    <ProjectLabel task={t} />
                    {t.planDate && t.planDate < date && (
                      <span className="text-warn">from {relativeDateLabel(t.planDate, today)}</span>
                    )}
                    {t.rolloverCount > 0 && (
                      <span className="text-warn">carried forward {t.rolloverCount}×</span>
                    )}
                  </div>
                </div>
                <Button
                  size="xs"
                  variant={t.planDate === date ? 'ghost' : 'primary'}
                  disabled={t.planDate === date}
                  onClick={() => run(moveTask(t.id, date))}
                >
                  {t.planDate === date ? 'Kept' : 'Keep'}
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => run(moveTask(t.id, addDays(date, 1)))}
                >
                  {relativeDateLabel(addDays(date, 1), today)}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => run(moveTask(t.id, null))}>
                  Backlog
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Delete “${t.title}”`}
                  onClick={() => run(deleteTasks([t.id]))}
                >
                  <Trash2 size={12} />
                </Button>
              </RitualTaskRow>
            ))}
          </div>
        ),
    },
    {
      id: 'choose',
      title: 'Choose today’s work',
      hint: 'Pull in what matters from your backlog, inbox and upcoming deadlines. Drag to set the order.',
      wide: true,
      content: (
        <div className="grid h-full min-h-[420px] grid-cols-2 gap-5">
          <Candidates date={date} />
          <div className="flex min-h-0 flex-col rounded-2xl border border-line p-3">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[13px] font-semibold">{relativeDateLabel(date, today)}</span>
              <span className="text-[12px] text-muted tabular">
                {openToday.length} open ·{' '}
                {formatDuration(openToday.reduce((s, t) => s + (t.estimateMin ?? 0), 0))}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <AddTaskInline planDate={date} />
              <TaskList container={`day:${date}`} listDate={date} className="mt-1.5" />
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'estimate',
      title: 'Estimate and prioritize',
      hint: 'Realistic estimates make the workload check meaningful. Rough is fine.',
      content:
        openToday.length === 0 ? (
          <EmptyState title="No open tasks planned yet">Go back a step to add some.</EmptyState>
        ) : (
          <div className="flex flex-col gap-2">
            {openToday.map((t) => (
              <RitualTaskRow key={t.id} className={cn(!t.estimateMin && 'border-warn/40')}>
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{t.title}</span>
                <div className="flex gap-0.5" role="group" aria-label={`Estimate for ${t.title}`}>
                  {QUICK_ESTIMATES.map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={t.estimateMin === m}
                      onClick={() => run(updateTask(t.id, { estimateMin: m }, 'Set estimate'))}
                      className={cn(
                        'h-6 rounded-md px-1.5 text-[11.5px] font-medium tabular',
                        t.estimateMin === m
                          ? 'bg-accent text-accent-fg'
                          : 'text-muted hover:bg-sunken',
                      )}
                    >
                      {formatDuration(m)}
                    </button>
                  ))}
                </div>
                <Segmented<Priority>
                  label={`Priority for ${t.title}`}
                  size="xs"
                  value={t.priority}
                  onChange={(p) => run(updateTask(t.id, { priority: p }, 'Change priority'))}
                  options={([0, 1, 2, 3] as Priority[]).map((p) => ({
                    value: p,
                    label: p === 0 ? '–' : PRIORITY_LABELS[p][0]!,
                    title: PRIORITY_LABELS[p],
                  }))}
                />
              </RitualTaskRow>
            ))}
          </div>
        ),
    },
    {
      id: 'timebox',
      title: 'Timebox your day',
      hint: 'Drag tasks onto the calendar, or let Keel place them in your free time around meetings.',
      wide: true,
      content: (
        <div className="grid h-full min-h-[460px] grid-cols-[1fr_1.2fr] gap-5">
          <div className="flex min-h-0 flex-col rounded-2xl border border-line p-3">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[13px] font-semibold">
                Not yet timeboxed ({unscheduled.length})
              </span>
              <Button
                size="xs"
                variant="primary"
                disabled={unscheduled.length === 0}
                onClick={() =>
                  run(
                    autoSchedule(
                      unscheduled.map((t) => t.id),
                      date,
                    ),
                  )
                }
              >
                <CalendarClock size={12} /> Auto-timebox
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TaskList
                container="list:unscheduled"
                listDate={date}
                empty={
                  <p className="py-8 text-center text-[12.5px] text-subtle">
                    Everything is on the calendar.
                  </p>
                }
              />
            </div>
          </div>
          <div className="min-h-0 overflow-hidden rounded-2xl border border-line bg-surface">
            <TimeGrid days={[date]} hourHeight={hourHeight} scrollKey={`plan-${date}`} />
          </div>
        </div>
      ),
    },
    {
      id: 'workload',
      title: 'Check your workload',
      hint: 'Compare what you planned with the time you actually have.',
      content: <OverloadSuggestions date={date} tasks={dayTasks} />,
    },
    {
      id: 'intention',
      title: 'Set an intention',
      hint: 'Optional. One sentence to come back to when the day gets noisy.',
      content: (
        <div className="flex flex-col gap-2">
          <Label htmlFor="intention">
            What would make {date === today ? 'today' : formatDateLong(date)} a good day?
          </Label>
          <AutoTextarea
            id="intention"
            value={intention}
            onChange={(e) => setIntention(e.target.value)}
            minRows={3}
            placeholder="e.g. Ship the draft before lunch, then protect the afternoon for deep work."
          />
        </div>
      ),
    },
  ];

  const persist = (completed?: boolean) =>
    run(
      saveRitual('plan', date, {
        data: {
          intention,
          taskCount: openToday.length,
          plannedMin: dayTasks.reduce((s, t) => s + (t.estimateMin ?? 0), 0),
        },
        completed,
      }),
    );

  return (
    <TaskDndProvider containers={containers} onMove={onMove}>
      <RitualFrame
        title={`Plan ${date === today ? 'your day' : formatDateLong(date)}`}
        icon={<Sunrise size={18} />}
        steps={steps}
        index={index}
        onIndex={(i) => setIndex(Math.max(0, Math.min(steps.length - 1, i)))}
        onClose={() => {
          persist();
          ui.ritual(null);
        }}
        onFinish={() => {
          persist(true);
          ui.ritual(null);
          ui.navigate({ name: 'today' });
        }}
        finishLabel="Start the day"
      />
    </TaskDndProvider>
  );
}
