import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useUi } from '@/app/ui';
import { useData } from '@/data/store';
import type { ISODate } from '@/domain/dates';
import { addDays, formatDateShort, relativeDateLabel } from '@/domain/dates';
import { Button, IconButton } from '@/ui/primitives';
import { TimeGrid } from './TimeGrid';

export function CalendarPanel() {
  const today = useData((s) => s.today);
  const hourHeight = useData((s) => s.settings.calendarHourHeight);
  const date = useUi((s) => s.panelDate) ?? today;
  const set = (d: ISODate) => useUi.setState({ panelDate: d });

  return (
    <aside
      aria-label="Calendar"
      className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface"
    >
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-semibold">
            {relativeDateLabel(date, today)}
          </span>
          <span className="text-[11.5px] text-muted">{formatDateShort(date, today)}</span>
        </div>
        <IconButton label="Previous day" onClick={() => set(addDays(date, -1))}>
          <ChevronLeft size={16} />
        </IconButton>
        <Button size="xs" variant="ghost" onClick={() => set(today)} disabled={date === today}>
          Today
        </Button>
        <IconButton label="Next day" onClick={() => set(addDays(date, 1))}>
          <ChevronRight size={16} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 pr-1">
        <TimeGrid
          days={[date]}
          hourHeight={hourHeight}
          scrollKey={date}
          onCreateEvent={(d, startMin, endMin) =>
            useUi.setState({ eventDraft: { date: d, startMin, endMin } })
          }
        />
      </div>
      <p className="border-t border-line px-3 py-2 text-[11px] leading-snug text-subtle">
        Drag tasks here to timebox them. Drag on empty time to add an event.
      </p>
    </aside>
  );
}
