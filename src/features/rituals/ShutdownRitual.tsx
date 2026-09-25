import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, Layers, Moon } from 'lucide-react';
import { ui } from '@/app/ui';
import { moveTask, moveTasks, run, saveRitual } from '@/data/actions';
import { isOpen, tasksOnDate } from '@/data/selectors';
import { useData } from '@/data/store';
import type { ISODate } from '@/domain/dates';
import {
  addDays,
  formatDateLong,
  formatDuration,
  isoWeekday,
  relativeDateLabel,
} from '@/domain/dates';
import { trackedOnDay } from '@/domain/timeAccounting';
import { AutoTextarea, Button, EmptyState, Label } from '@/ui/primitives';
import { TaskCheckbox } from '../task/TaskCard';
import { RitualFrame, RitualTaskRow } from './RitualFrame';

const PROMPTS = [
  { key: 'wentWell', label: 'What went well today?' },
  { key: 'blockers', label: 'What got in the way?' },
  { key: 'tomorrow', label: 'Anything to remember for tomorrow?' },
] as const;

function nextWorkingDay(date: ISODate, workingDays: number[]): ISODate {
  let d = addDays(date, 1);
  for (let i = 0; i < 7 && !workingDays.includes(isoWeekday(d)); i++) d = addDays(d, 1);
  return d;
}

export function ShutdownRitual({ date }: { date: ISODate }) {
  const tasks = useData((s) => s.tasks);
  const sessions = useData((s) => s.sessions);
  const zone = useData((s) => s.zone);
  const today = useData((s) => s.today);
  const workingDays = useData((s) => s.settings.workingDays);
  const existing = useData((s) =>
    Object.values(s.rituals).find((r) => r.kind === 'shutdown' && r.period === date),
  );
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>(() => ({
    wentWell: String(existing?.data.wentWell ?? ''),
    blockers: String(existing?.data.blockers ?? ''),
    tomorrow: String(existing?.data.tomorrow ?? ''),
  }));

  useEffect(() => {
    run(saveRitual('shutdown', date, {}));
  }, [date]);

  const dayTasks = useMemo(() => tasksOnDate(tasks, date), [tasks, date]);
  const done = dayTasks.filter((t) => t.completedAt);
  const open = dayTasks.filter(isOpen);
  const tracked = useMemo(
    () => trackedOnDay(Object.values(sessions), date, zone, Date.now()),
    [sessions, date, zone],
  );
  const trackedTotal = [...tracked.values()].reduce((a, b) => a + b, 0);
  const plannedTotal = dayTasks.reduce((sum, t) => sum + (t.estimateMin ?? 0), 0);
  const doneEstimate = done.reduce((sum, t) => sum + (t.estimateMin ?? 0), 0);
  const next = nextWorkingDay(date, workingDays);

  const persist = (extra: Record<string, unknown> = {}, completed?: boolean) =>
    run(
      saveRitual('shutdown', date, {
        reflection: PROMPTS.map((p) => (answers[p.key] ? `${p.label}\n${answers[p.key]}` : ''))
          .filter(Boolean)
          .join('\n\n'),
        data: {
          ...answers,
          completedCount: done.length,
          openCount: open.length,
          plannedMin: plannedTotal,
          trackedMin: Math.round(trackedTotal),
          ...extra,
        },
        completed,
      }),
    );

  const steps = [
    {
      id: 'done',
      title: 'What you got done',
      hint: `${formatDateLong(date)}. Take a moment to notice what you finished.`,
      content: (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Completed" value={`${done.length} of ${dayTasks.length}`} />
            <Stat label="Time tracked" value={formatDuration(trackedTotal)} />
            <Stat label="Estimated (done)" value={formatDuration(doneEstimate)} />
          </div>
          {done.length === 0 ? (
            <EmptyState icon={<CheckCircle2 size={28} />} title="No tasks completed">
              Some days are like that. Planning a little less tomorrow can help.
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-1.5">
              {done.map((t) => (
                <RitualTaskRow key={t.id}>
                  <TaskCheckbox done label={t.title} onToggle={() => undefined} size={16} />
                  <span className="flex-1 text-[13.5px]">{t.title}</span>
                  <span className="text-[12px] text-muted tabular">
                    {tracked.get(t.id) ? formatDuration(tracked.get(t.id)!) : '—'}
                    {t.estimateMin ? ` / ${formatDuration(t.estimateMin)}` : ''}
                  </span>
                </RitualTaskRow>
              ))}
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'left',
      title: 'Decide what happens to the rest',
      hint: 'Move unfinished work somewhere intentional instead of letting it pile up.',
      content:
        open.length === 0 ? (
          <EmptyState icon={<CheckCircle2 size={28} />} title="Nothing left over">
            Everything planned for this day is done.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  run(
                    moveTasks(
                      open.map((t) => t.id),
                      null,
                    ),
                  )
                }
              >
                <Layers size={13} /> All to backlog
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  run(
                    moveTasks(
                      open.map((t) => t.id),
                      next,
                    ),
                  )
                }
              >
                All to {relativeDateLabel(next, today)} <ArrowRight size={13} />
              </Button>
            </div>
            {open.map((t) => (
              <RitualTaskRow key={t.id}>
                <span className="flex-1 text-[13.5px]">{t.title}</span>
                {t.estimateMin ? (
                  <span className="text-[12px] text-muted tabular">
                    {formatDuration(t.estimateMin)}
                  </span>
                ) : null}
                <Button size="xs" variant="secondary" onClick={() => run(moveTask(t.id, next))}>
                  {relativeDateLabel(next, today)}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => run(moveTask(t.id, null))}>
                  Backlog
                </Button>
                <Button size="xs" variant="ghost" onClick={() => ui.openTask(t.id)}>
                  Other day…
                </Button>
              </RitualTaskRow>
            ))}
          </div>
        ),
    },
    {
      id: 'reflect',
      title: 'Reflect',
      hint: 'A few honest sentences. This stays on your computer.',
      content: (
        <div className="flex flex-col gap-5">
          {PROMPTS.map((p) => (
            <div key={p.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`sd-${p.key}`}>{p.label}</Label>
              <AutoTextarea
                id={`sd-${p.key}`}
                value={answers[p.key]}
                onChange={(e) => setAnswers({ ...answers, [p.key]: e.target.value })}
                onBlur={() => persist()}
                minRows={2}
              />
            </div>
          ))}
        </div>
      ),
    },
    {
      id: 'close',
      title: 'Close the day',
      hint: 'When you finish, your workday is done. Rest is part of the plan.',
      content: (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <Moon size={40} className="text-accent-text" />
          <p className="max-w-[420px] text-[14px] text-muted">
            You completed {done.length} task{done.length === 1 ? '' : 's'} and tracked{' '}
            {formatDuration(trackedTotal)}.
            {open.filter((t) => t.planDate === date).length > 0 &&
              ` ${open.length} task${open.length === 1 ? ' is' : 's are'} still planned for this day and will carry forward.`}
          </p>
        </div>
      ),
    },
  ];

  const close = () => {
    persist();
    ui.ritual(null);
  };

  return (
    <RitualFrame
      title="Shut down"
      icon={<Moon size={18} />}
      steps={steps}
      index={index}
      onIndex={(i) => {
        persist();
        setIndex(Math.max(0, Math.min(steps.length - 1, i)));
      }}
      onClose={close}
      onFinish={() => {
        persist({}, true);
        ui.ritual(null);
      }}
      finishLabel="Shut down for the day"
    />
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 shadow-sm">
      <div className="text-[11.5px] font-medium text-muted">{label}</div>
      <div className="mt-0.5 text-[20px] font-semibold tabular">{value}</div>
      {sub && <div className="text-[11.5px] text-subtle">{sub}</div>}
    </div>
  );
}
