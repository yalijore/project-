/**
 * Review charts, following the dataviz method: thin marks with 4px rounded data-ends,
 * hairline recessive grid, legend for ≥2 series, per-mark hover/focus tooltips, and a
 * table view for every chart. Series colors are validated tokens (--chart-planned /
 * --chart-tracked); text always uses text tokens.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ISODate } from '@/domain/dates';
import { formatDuration, weekdayShort, dayOfMonth } from '@/domain/dates';
import type { CategoryTime, DayStat } from '@/domain/stats';
import { Button, ColorDot, cn } from '@/ui/primitives';

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setWidth(Math.max(240, Math.floor(entry!.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Clean hour ticks for a max value in minutes. */
function hourTicks(maxMin: number): number[] {
  const maxH = Math.max(1, Math.ceil(maxMin / 60));
  const step = maxH <= 4 ? 1 : maxH <= 8 ? 2 : maxH <= 20 ? 4 : Math.ceil(maxH / 5);
  const ticks: number[] = [];
  for (let h = 0; h <= maxH + (maxH % step ? step - (maxH % step) : 0); h += step)
    ticks.push(h * 60);
  return ticks;
}

/** A column with a 4px rounded top and a square base, as an SVG path. */
function columnPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function barPath(x: number, y: number, w: number, h: number): string {
  if (w <= 0) return '';
  const r = Math.min(4, h / 2, w);
  return `M${x},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x},${y + h} Z`;
}

function ChartCard({
  title,
  subtitle,
  legend,
  children,
  table,
}: {
  title: string;
  subtitle?: string;
  legend?: ReactNode;
  children: ReactNode;
  table: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div>
          <h3 className="text-[13.5px] font-semibold">{title}</h3>
          {subtitle && <p className="text-[12px] text-muted">{subtitle}</p>}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {legend}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setShowTable(!showTable)}
            aria-pressed={showTable}
          >
            {showTable ? 'Show chart' : 'Show table'}
          </Button>
        </div>
      </div>
      {showTable ? table : children}
    </section>
  );
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-muted">
      <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}

interface Tip {
  x: number;
  y: number;
  lines: { label: string; value: string; color?: string }[];
  title: string;
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 min-w-[140px] -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] shadow-md"
      style={{ left: tip.x, top: tip.y - 8 }}
    >
      <div className="mb-1 font-medium text-muted">{tip.title}</div>
      {tip.lines.map((l) => (
        <div key={l.label} className="flex items-center gap-2">
          {l.color && (
            <span className="h-[2px] w-3 rounded" style={{ background: l.color }} aria-hidden />
          )}
          <span className="font-semibold text-fg tabular">{l.value}</span>
          <span className="text-muted">{l.label}</span>
        </div>
      ))}
    </div>
  );
}

const PLANNED = 'var(--chart-planned)';
const TRACKED = 'var(--chart-tracked)';

export function PlannedTrackedChart({ days, today }: { days: DayStat[]; today: ISODate }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const height = 200;
  const pad = { top: 8, right: 8, bottom: 30, left: 36 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(60, ...days.map((d) => Math.max(d.plannedMin, d.trackedMin)));
  const ticks = hourTicks(max);
  const top = ticks.at(-1)!;
  const y = (m: number) => pad.top + plotH - (m / top) * plotH;
  const band = plotW / Math.max(1, days.length);
  const barW = Math.min(24, Math.max(6, (band - 16) / 2));

  const show = (d: DayStat, cx: number) =>
    setTip({
      x: cx,
      y: y(Math.max(d.plannedMin, d.trackedMin)),
      title: `${weekdayShort(d.date)} ${dayOfMonth(d.date)}`,
      lines: [
        { label: 'planned', value: formatDuration(d.plannedMin), color: PLANNED },
        { label: 'tracked', value: formatDuration(d.trackedMin), color: TRACKED },
        { label: 'completed', value: `${d.completedCount}/${d.plannedCount}` },
      ],
    });

  const table = (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="border-b border-line text-left text-muted">
          <th className="py-1.5 font-medium">Day</th>
          <th className="py-1.5 text-right font-medium">Planned</th>
          <th className="py-1.5 text-right font-medium">Tracked</th>
          <th className="py-1.5 text-right font-medium">Meetings</th>
          <th className="py-1.5 text-right font-medium">Done</th>
          <th className="py-1.5 text-right font-medium">Carried forward</th>
        </tr>
      </thead>
      <tbody className="tabular">
        {days.map((d) => (
          <tr key={d.date} className="border-b border-line/60">
            <td className="py-1.5">
              {weekdayShort(d.date)} {dayOfMonth(d.date)}
            </td>
            <td className="py-1.5 text-right">{formatDuration(d.plannedMin)}</td>
            <td className="py-1.5 text-right">{formatDuration(d.trackedMin)}</td>
            <td className="py-1.5 text-right">{formatDuration(d.meetingMin)}</td>
            <td className="py-1.5 text-right">
              {d.completedCount}/{d.plannedCount}
            </td>
            <td className="py-1.5 text-right">{d.rolledOverCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <ChartCard
      title="Planned vs tracked"
      subtitle="Estimated time of planned tasks compared with time you actually tracked, per day."
      legend={
        <>
          <LegendKey color={PLANNED} label="Planned" />
          <LegendKey color={TRACKED} label="Tracked" />
        </>
      }
      table={table}
    >
      <div ref={ref} className="relative" onPointerLeave={() => setTip(null)}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Planned versus tracked time per day. Use Show table for values."
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--line)"
                strokeWidth={1}
              />
              <text
                x={pad.left - 6}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                fontSize={10.5}
                fill="var(--fg-subtle)"
                className="tabular"
              >
                {t / 60}h
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const cx = pad.left + band * i + band / 2;
            const x1 = cx - barW - 1;
            const x2 = cx + 1;
            return (
              <g
                key={d.date}
                tabIndex={0}
                role="img"
                aria-label={`${weekdayShort(d.date)} ${dayOfMonth(d.date)}: planned ${formatDuration(d.plannedMin)}, tracked ${formatDuration(d.trackedMin)}`}
                onPointerEnter={() => show(d, cx)}
                onFocus={() => show(d, cx)}
                onBlur={() => setTip(null)}
                className="outline-none"
              >
                <rect
                  x={cx - band / 2}
                  y={pad.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                />
                <path
                  d={columnPath(x1, y(d.plannedMin), barW, y(0) - y(d.plannedMin))}
                  fill={PLANNED}
                />
                <path
                  d={columnPath(x2, y(d.trackedMin), barW, y(0) - y(d.trackedMin))}
                  fill={TRACKED}
                />
                <text
                  x={cx}
                  y={height - 12}
                  textAnchor="middle"
                  fontSize={11}
                  fill={d.date === today ? 'var(--fg)' : 'var(--fg-muted)'}
                  fontWeight={d.date === today ? 600 : 400}
                >
                  {days.length > 10
                    ? dayOfMonth(d.date)
                    : `${weekdayShort(d.date)} ${dayOfMonth(d.date)}`}
                </text>
              </g>
            );
          })}
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--line-strong)"
            strokeWidth={1}
          />
        </svg>
        <Tooltip tip={tip} />
      </div>
    </ChartCard>
  );
}

export function CategoryBars({ items }: { items: CategoryTime[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();
  const shown = items.slice(0, 7);
  const rest = items.slice(7);
  const rows = rest.length
    ? [
        ...shown,
        {
          key: 'other',
          label: `Other (${rest.length})`,
          color: null,
          minutes: rest.reduce((s, r) => s + r.minutes, 0),
        },
      ]
    : shown;
  const total = rows.reduce((s, r) => s + r.minutes, 0);
  const labelW = Math.min(180, width * 0.36);
  const valueW = 64;
  const barMax = Math.max(40, width - labelW - valueW - 8);
  const max = Math.max(1, ...rows.map((r) => r.minutes));
  const rowH = 28;

  const table = (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="border-b border-line text-left text-muted">
          <th className="py-1.5 font-medium">Project / area</th>
          <th className="py-1.5 text-right font-medium">Tracked</th>
          <th className="py-1.5 text-right font-medium">Share</th>
        </tr>
      </thead>
      <tbody className="tabular">
        {items.map((r) => (
          <tr key={r.key} className="border-b border-line/60">
            <td className="py-1.5">{r.label}</td>
            <td className="py-1.5 text-right">{formatDuration(r.minutes)}</td>
            <td className="py-1.5 text-right">
              {total ? Math.round((r.minutes / total) * 100) : 0}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <ChartCard
      title="Where your time went"
      subtitle="Tracked time by project (or area when a task has no project)."
      table={table}
    >
      {rows.length === 0 ? (
        <p className="py-6 text-center text-[12.5px] text-subtle">
          No tracked time in this period yet. Start a timer on a task to see it here.
        </p>
      ) : (
        <div ref={ref} className="relative" onPointerLeave={() => setTip(null)}>
          {rows.map((r, i) => {
            const w = (r.minutes / max) * barMax;
            const show = () =>
              setTip({
                x: labelW + Math.min(w, barMax) / 2,
                y: i * rowH + 4,
                title: r.label,
                lines: [
                  { label: 'tracked', value: formatDuration(r.minutes), color: TRACKED },
                  {
                    label: 'of total',
                    value: `${total ? Math.round((r.minutes / total) * 100) : 0}%`,
                  },
                ],
              });
            return (
              <div
                key={r.key}
                className="flex items-center outline-none"
                style={{ height: rowH }}
                tabIndex={0}
                role="img"
                aria-label={`${r.label}: ${formatDuration(r.minutes)}`}
                onPointerEnter={show}
                onFocus={show}
                onBlur={() => setTip(null)}
              >
                <div
                  className="flex shrink-0 items-center gap-1.5 truncate pr-2 text-[12.5px] text-fg"
                  style={{ width: labelW }}
                >
                  {r.color ? (
                    <ColorDot color={r.color} size={8} />
                  ) : (
                    <span className="h-2 w-2 shrink-0 rounded-full border border-line-strong" />
                  )}
                  <span className="truncate">{r.label}</span>
                </div>
                <svg width={barMax} height={14} aria-hidden>
                  <path d={barPath(0, 0, Math.max(2, w), 14)} fill={TRACKED} />
                </svg>
                <span
                  className={cn('pl-2 text-[12px] text-muted tabular')}
                  style={{ width: valueW }}
                >
                  {formatDuration(r.minutes)}
                </span>
              </div>
            );
          })}
          <Tooltip tip={tip} />
        </div>
      )}
    </ChartCard>
  );
}

export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-sm">
      <div className="text-[12px] text-muted">{label}</div>
      <div className="mt-1 text-[22px] font-semibold tracking-tight">{value}</div>
      {detail && <div className="mt-0.5 text-[11.5px] text-subtle">{detail}</div>}
    </div>
  );
}
