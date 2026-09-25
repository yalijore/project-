import { useEffect, useMemo, useState } from 'react';
import { CalendarRange } from 'lucide-react';
import { ui, useUi } from '@/app/ui';
import { run, saveRitual } from '@/data/actions';
import { isOpen } from '@/data/selectors';
import { useRangeStats } from '@/data/statsLoader';
import { useData } from '@/data/store';
import type { ISODate } from '@/domain/dates';
import { addDays, formatDateShort, formatDuration, relativeDateLabel } from '@/domain/dates';
import { AutoTextarea, Label } from '@/ui/primitives';
import { CategoryBars, PlannedTrackedChart } from '../review/charts';
import { KpiRow, Reflections } from '../review/ReviewView';
import { RitualFrame, RitualTaskRow } from './RitualFrame';

const PROMPTS = [
  { key: 'win', label: 'What was the biggest win this week?' },
  { key: 'change', label: 'What would you change about how the week went?' },
  { key: 'focus', label: 'What matters most next week?' },
] as const;

export function WeeklyReview({ weekStart }: { weekStart: ISODate }) {
  const today = useData((s) => s.today);
  const tasks = useData((s) => s.tasks);
  const existing = useData((s) =>
    Object.values(s.rituals).find((r) => r.kind === 'weekly' && r.period === weekStart),
  );
  const weekEnd = addDays(weekStart, 6);
  const stats = useRangeStats(weekStart, weekEnd);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(PROMPTS.map((p) => [p.key, String(existing?.data[p.key] ?? '')])),
  );

  useEffect(() => {
    run(saveRitual('weekly', weekStart, {}));
  }, [weekStart]);

  const nextStart = addDays(weekStart, 7);
  const nextEnd = addDays(weekStart, 13);
  const ahead = useMemo(() => {
    const open = Object.values(tasks).filter(isOpen);
    return {
      planned: open.filter((t) => t.planDate && t.planDate >= nextStart && t.planDate <= nextEnd),
      due: open
        .filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= nextEnd)
        .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)),
    };
  }, [tasks, nextStart, nextEnd, today]);

  const persist = (completed?: boolean) =>
    run(
      saveRitual('weekly', weekStart, {
        reflection: PROMPTS.map((p) => (answers[p.key] ? `${p.label}\n${answers[p.key]}` : ''))
          .filter(Boolean)
          .join('\n\n'),
        data: {
          ...answers,
          completedCount: stats?.totals.completedCount,
          trackedMin: stats ? Math.round(stats.totals.trackedMin) : undefined,
        },
        completed,
      }),
    );

  const steps = [
    {
      id: 'glance',
      title: 'Your week at a glance',
      hint: `${formatDateShort(weekStart, today)} – ${formatDateShort(weekEnd, today)}. What you planned compared with what happened.`,
      wide: true,
      content: stats ? (
        <div className="flex flex-col gap-4">
          <KpiRow stats={stats} />
          <PlannedTrackedChart days={stats.days} today={today} />
        </div>
      ) : null,
    },
    {
      id: 'time',
      title: 'Where your time went',
      wide: true,
      content: stats ? <CategoryBars items={stats.byCategory} /> : null,
    },
    {
      id: 'reflect',
      title: 'Reflect on the week',
      hint: 'Your daily notes from this week are below the prompts.',
      content: (
        <div className="flex flex-col gap-5">
          {PROMPTS.map((p) => (
            <div key={p.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`wk-${p.key}`}>{p.label}</Label>
              <AutoTextarea
                id={`wk-${p.key}`}
                value={answers[p.key]}
                onChange={(e) => setAnswers({ ...answers, [p.key]: e.target.value })}
                onBlur={() => persist()}
              />
            </div>
          ))}
          <Reflections from={weekStart} to={weekEnd} />
        </div>
      ),
    },
    {
      id: 'ahead',
      title: 'Look ahead',
      hint: 'What is already lined up for next week, and which deadlines are coming.',
      content: (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-subtle uppercase">
              Deadlines before {formatDateShort(nextEnd, today)}
            </h3>
            {ahead.due.length === 0 ? (
              <p className="text-[12.5px] text-subtle">No deadlines coming up.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {ahead.due.map((t) => (
                  <RitualTaskRow key={t.id}>
                    <button
                      type="button"
                      className="flex-1 text-left text-[13.5px] hover:underline"
                      onClick={() => ui.openTask(t.id)}
                    >
                      {t.title}
                    </button>
                    <span className="text-[12px] text-warn">
                      Due {relativeDateLabel(t.dueDate!, today)}
                    </span>
                    <span className="text-[12px] text-muted">
                      {t.planDate
                        ? `Planned ${relativeDateLabel(t.planDate, today)}`
                        : 'Not planned'}
                    </span>
                  </RitualTaskRow>
                ))}
              </div>
            )}
          </div>
          <p className="text-[13px] text-muted">
            {ahead.planned.length} task{ahead.planned.length === 1 ? '' : 's'} already planned next
            week ({formatDuration(ahead.planned.reduce((s, t) => s + (t.estimateMin ?? 0), 0))}{' '}
            estimated).
          </p>
        </div>
      ),
    },
  ];

  return (
    <RitualFrame
      title="Weekly review"
      icon={<CalendarRange size={18} />}
      steps={steps}
      index={index}
      onIndex={(i) => {
        persist();
        setIndex(Math.max(0, Math.min(steps.length - 1, i)));
      }}
      onClose={() => {
        persist();
        ui.ritual(null);
      }}
      onFinish={() => {
        persist(true);
        ui.ritual(null);
        useUi.setState({ weekStart: nextStart });
        ui.navigate({ name: 'week' });
      }}
      finishLabel="Finish & plan next week"
    />
  );
}
