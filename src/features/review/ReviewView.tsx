import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, NotebookPen } from 'lucide-react';
import { ui } from '@/app/ui';
import { useRangeStats } from '@/data/statsLoader';
import { useData } from '@/data/store';
import type { ISODate } from '@/domain/dates';
import {
  addDays,
  addMonths,
  formatDateLong,
  formatDateShort,
  formatDuration,
  monthName,
  startOfMonth,
  startOfWeek,
} from '@/domain/dates';
import type { RangeStats } from '@/domain/stats';
import { Button, IconButton, Segmented } from '@/ui/primitives';
import { ViewHeader } from '../common/ViewHeader';
import { CategoryBars, PlannedTrackedChart, StatTile } from './charts';

type Span = 'week' | 'month' | 'day';

export function accuracyText(stats: RangeStats): { value: string; detail: string } {
  const a = stats.estimateAccuracy;
  if (!a) return { value: '—', detail: 'Needs completed tasks with an estimate and tracked time' };
  const ratio = a.trackedMin / a.estimatedMin;
  const pct = Math.round(Math.abs(ratio - 1) * 100);
  return {
    value: pct < 5 ? 'On target' : `${pct}% ${ratio > 1 ? 'over' : 'under'}`,
    detail: `${formatDuration(a.trackedMin)} tracked vs ${formatDuration(a.estimatedMin)} estimated · ${a.taskCount} task${a.taskCount === 1 ? '' : 's'}`,
  };
}

export function KpiRow({ stats }: { stats: RangeStats }) {
  const acc = accuracyText(stats);
  const t = stats.totals;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <StatTile
        label="Completed"
        value={`${t.completedCount}`}
        detail={`of ${t.plannedCount} planned`}
      />
      <StatTile
        label="Tracked"
        value={formatDuration(t.trackedMin)}
        detail={`${formatDuration(t.plannedMin)} estimated`}
      />
      <StatTile label="Meetings" value={formatDuration(t.meetingMin)} />
      <StatTile
        label="Carried forward"
        value={`${t.rolledOverCount}`}
        detail="times a task moved to a later day"
      />
      <StatTile label="Estimates" value={acc.value} detail={acc.detail} />
    </div>
  );
}

export function Reflections({ from, to }: { from: ISODate; to: ISODate }) {
  const rituals = useData((s) => s.rituals);
  const today = useData((s) => s.today);
  const list = useMemo(
    () =>
      Object.values(rituals)
        .filter(
          (r) =>
            r.period >= from &&
            r.period <= to &&
            (r.reflection.trim() || String(r.data.intention ?? '').trim()),
        )
        .sort((a, b) => b.period.localeCompare(a.period) || a.kind.localeCompare(b.kind)),
    [rituals, from, to],
  );
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <h3 className="mb-3 flex items-center gap-2 text-[13.5px] font-semibold">
        <NotebookPen size={15} className="text-subtle" /> Reflections & intentions
      </h3>
      {list.length === 0 ? (
        <p className="text-[12.5px] text-subtle">
          Nothing written in this period. The planning and shutdown rituals collect these.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((r) => (
            <article key={r.id} className="rounded-xl bg-sunken/60 px-3 py-2.5">
              <div className="mb-1 text-[11.5px] font-medium text-muted">
                {formatDateShort(r.period, today)} ·{' '}
                {r.kind === 'plan'
                  ? 'Intention'
                  : r.kind === 'shutdown'
                    ? 'Shutdown'
                    : 'Weekly review'}
              </div>
              <p className="selectable text-[13px] whitespace-pre-wrap text-fg">
                {r.kind === 'plan' ? String(r.data.intention ?? '') : r.reflection}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function ReviewView() {
  const today = useData((s) => s.today);
  const weekStartsOn = useData((s) => s.settings.weekStartsOn);
  const [span, setSpan] = useState<Span>('week');
  const [anchor, setAnchor] = useState<ISODate>(today);

  const { from, to, label } = useMemo(() => {
    if (span === 'day') return { from: anchor, to: anchor, label: formatDateLong(anchor) };
    if (span === 'week') {
      const from = startOfWeek(anchor, weekStartsOn);
      const to = addDays(from, 6);
      return { from, to, label: `${formatDateShort(from, today)} – ${formatDateShort(to, today)}` };
    }
    const from = startOfMonth(anchor);
    const to = addDays(addMonths(from, 1), -1);
    return { from, to, label: monthName(from) };
  }, [span, anchor, weekStartsOn, today]);

  const stats = useRangeStats(from, to);
  const step = (dir: 1 | -1) =>
    setAnchor(
      span === 'day'
        ? addDays(anchor, dir)
        : span === 'week'
          ? addDays(anchor, 7 * dir)
          : addMonths(anchor, dir),
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title="Review"
        subtitle="Planned vs actual, from data on this computer"
        right={
          <Button
            size="sm"
            variant="primary"
            onClick={() => ui.ritual({ kind: 'weekly', date: startOfWeek(today, weekStartsOn) })}
          >
            Weekly review
          </Button>
        }
      />
      <div className="flex items-center gap-2 px-4 pb-3">
        <Segmented<Span>
          label="Period"
          size="xs"
          value={span}
          onChange={setSpan}
          options={[
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
          ]}
        />
        <IconButton label="Previous period" onClick={() => step(-1)}>
          <ChevronLeft size={16} />
        </IconButton>
        <span className="min-w-[160px] text-center text-[13px] font-medium">{label}</span>
        <IconButton label="Next period" onClick={() => step(1)}>
          <ChevronRight size={16} />
        </IconButton>
        <Button size="xs" variant="ghost" onClick={() => setAnchor(today)}>
          Current
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
        {!stats ? (
          <p className="p-6 text-[13px] text-muted">Loading…</p>
        ) : (
          <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
            <KpiRow stats={stats} />
            {span !== 'day' && <PlannedTrackedChart days={stats.days} today={today} />}
            <CategoryBars items={stats.byCategory} />
            <Reflections from={from} to={to} />
          </div>
        )}
      </div>
    </div>
  );
}
