import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ISODate } from '@/domain/dates';
import {
  addDays,
  addMonths,
  dayOfMonth,
  formatDuration,
  monthName,
  parseDuration,
  startOfMonth,
  startOfWeek,
  weekdayShort,
} from '@/domain/dates';
import { Button, IconButton, Input, cn } from './primitives';

export function MonthGrid({
  value,
  onSelect,
  today,
  weekStartsOn,
  markers,
}: {
  value: ISODate | null;
  onSelect: (d: ISODate) => void;
  today: ISODate;
  weekStartsOn: number;
  /** Dates to mark with a dot (e.g. days with plans). */
  markers?: Set<ISODate>;
}) {
  const [month, setMonth] = useState(startOfMonth(value ?? today));
  const [focus, setFocus] = useState<ISODate>(value ?? today);
  const gridRef = useRef<HTMLDivElement>(null);

  const days = useMemo(() => {
    const first = startOfWeek(month, weekStartsOn);
    return Array.from({ length: 42 }, (_, i) => addDays(first, i));
  }, [month, weekStartsOn]);

  useEffect(() => {
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focus}"]`);
    if (el && gridRef.current?.contains(document.activeElement)) el.focus();
  }, [focus]);

  const move = (delta: number) => {
    const next = addDays(focus, delta);
    setFocus(next);
    if (startOfMonth(next) !== month) setMonth(startOfMonth(next));
  };

  const onKey = (e: KeyboardEvent) => {
    const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in map) {
      e.preventDefault();
      move(map[e.key]!);
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const next = addMonths(focus, e.key === 'PageUp' ? -1 : 1);
      setFocus(next);
      setMonth(startOfMonth(next));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(focus);
    }
  };

  return (
    <div className="w-[236px] select-none">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[12.5px] font-semibold text-fg">{monthName(month)}</span>
        <div className="flex">
          <IconButton
            label="Previous month"
            size="xs"
            onClick={() => setMonth(addMonths(month, -1))}
          >
            <ChevronLeft size={14} />
          </IconButton>
          <IconButton label="Next month" size="xs" onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight size={14} />
          </IconButton>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[10.5px] font-medium text-subtle">
        {days.slice(0, 7).map((d) => (
          <div key={d} className="py-1">
            {weekdayShort(d).slice(0, 2)}
          </div>
        ))}
      </div>
      <div
        ref={gridRef}
        role="grid"
        aria-label={monthName(month)}
        className="grid grid-cols-7 gap-y-0.5"
        onKeyDown={onKey}
      >
        {days.map((d) => {
          const inMonth = startOfMonth(d) === month;
          const selected = d === value;
          const isToday = d === today;
          return (
            <button
              key={d}
              type="button"
              data-date={d}
              tabIndex={d === focus ? 0 : -1}
              aria-selected={selected}
              aria-label={d}
              onClick={() => onSelect(d)}
              onFocus={() => setFocus(d)}
              className={cn(
                'relative mx-auto flex h-7 w-7 items-center justify-center rounded-full text-[12px] tabular transition-colors',
                !inMonth && 'text-subtle/60',
                inMonth && !selected && 'text-fg hover:bg-sunken',
                isToday && !selected && 'font-semibold text-accent-text',
                selected && 'bg-accent font-semibold text-accent-fg',
              )}
            >
              {dayOfMonth(d)}
              {markers?.has(d) && !selected && (
                <span className="absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent/70" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DatePickerPanel({
  value,
  onChange,
  today,
  weekStartsOn,
  allowClear = true,
  clearLabel = 'No date',
  quick = true,
}: {
  value: ISODate | null;
  onChange: (d: ISODate | null) => void;
  today: ISODate;
  weekStartsOn: number;
  allowClear?: boolean;
  clearLabel?: string;
  quick?: boolean;
}) {
  const nextWeek = addDays(startOfWeek(today, weekStartsOn), 7);
  return (
    <div className="flex flex-col gap-2 p-1">
      {quick && (
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant="subtle" onClick={() => onChange(today)}>
            Today
          </Button>
          <Button size="xs" variant="subtle" onClick={() => onChange(addDays(today, 1))}>
            Tomorrow
          </Button>
          <Button size="xs" variant="subtle" onClick={() => onChange(nextWeek)}>
            Next week
          </Button>
          {allowClear && (
            <Button size="xs" variant="ghost" onClick={() => onChange(null)}>
              {clearLabel}
            </Button>
          )}
        </div>
      )}
      <MonthGrid value={value} onSelect={onChange} today={today} weekStartsOn={weekStartsOn} />
    </div>
  );
}

export const ESTIMATE_PRESETS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];

export function EstimatePanel({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (min: number | null) => void;
}) {
  const [text, setText] = useState(value ? formatDuration(value) : '');
  const parsed = parseDuration(text);
  return (
    <div className="flex w-[228px] flex-col gap-2 p-1">
      <div className="grid grid-cols-4 gap-1">
        {ESTIMATE_PRESETS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            className={cn(
              'h-7 rounded-md text-[12px] font-medium tabular transition-colors',
              value === m ? 'bg-accent text-accent-fg' : 'bg-sunken text-fg hover:bg-line/70',
            )}
          >
            {formatDuration(m)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onChange(null)}
          className="h-7 rounded-md text-[12px] font-medium text-muted hover:bg-sunken"
        >
          Clear
        </button>
      </div>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed !== null && parsed >= 0 && parsed <= 24 * 60) onChange(parsed || null);
        }}
      >
        <Input
          aria-label="Custom estimate"
          placeholder="e.g. 1h 15m"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-7.5"
        />
        <Button type="submit" size="sm" variant="primary" disabled={parsed === null}>
          Set
        </Button>
      </form>
    </div>
  );
}

/** Parses "9", "9:30", "930", "9:30am", "14:00", "2pm" into minutes after midnight. */
export function parseTimeInput(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '').replace('.', ':');
  let m = /^(\d{1,2})(?::?(\d{2}))?(a|am|p|pm)?$/.exec(s);
  if (!m) return null;
  if (!s.includes(':') && m[1]!.length === 2 && !m[2] && Number(m[1]) > 24) m = null;
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3].startsWith('p') && h !== 12) h += 12;
    if (m[3].startsWith('a') && h === 12) h = 0;
  }
  if (h > 23) return null;
  return h * 60 + min;
}
