import { useCallback, useMemo } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Moon, Sunrise } from 'lucide-react';
import { ui, useUi } from '@/app/ui';
import { moveTask, moveTasks, reorderDay, run } from '@/data/actions';
import { overdueTasks, tasksOnDate, useVirtualOccurrences } from '@/data/selectors';
import { useData } from '@/data/store';
import { addDays, dateRange, formatDateShort, monthName } from '@/domain/dates';
import { DatePickerPanel } from '@/ui/pickers';
import { Button, IconButton, Popover } from '@/ui/primitives';
import { CalendarPanel } from '../calendar/CalendarPanel';
import type { MoveResult } from '../dnd/TaskDnd';
import { TaskDndProvider } from '../dnd/TaskDnd';
import { ViewHeader } from '../common/ViewHeader';
import { DayColumn } from './DayColumn';

function RitualButtons() {
  const today = useData((s) => s.today);
  const rituals = useData((s) => s.rituals);
  const planned = Object.values(rituals).some(
    (r) => r.kind === 'plan' && r.period === today && r.completedAt,
  );
  const shutDown = Object.values(rituals).some(
    (r) => r.kind === 'shutdown' && r.period === today && r.completedAt,
  );
  return (
    <>
      <Button
        size="sm"
        variant={planned ? 'ghost' : 'primary'}
        onClick={() => ui.ritual({ kind: 'plan', date: today })}
        title="Plan your day (Shift+P)"
      >
        <Sunrise size={14} /> {planned ? 'Planned' : 'Plan your day'}
      </Button>
      <Button
        size="sm"
        variant={shutDown ? 'ghost' : 'secondary'}
        onClick={() => ui.ritual({ kind: 'shutdown', date: today })}
        title="Shut down (Shift+S)"
      >
        <Moon size={14} /> {shutDown ? 'Shut down' : 'Shut down'}
      </Button>
    </>
  );
}

function OverdueBanner() {
  const tasks = useData((s) => s.tasks);
  const today = useData((s) => s.today);
  const overdue = useMemo(() => overdueTasks(tasks, today), [tasks, today]);
  if (overdue.length === 0) return null;
  return (
    <div className="mx-4 mb-2 flex items-center gap-3 rounded-xl border border-warn/30 bg-warn-soft px-3 py-2 text-[12.5px] text-fg">
      <span>
        <strong>{overdue.length}</strong> unfinished task{overdue.length === 1 ? '' : 's'} from
        earlier days.
      </span>
      <div className="ml-auto flex gap-1.5">
        <Button
          size="xs"
          variant="secondary"
          onClick={() => ui.ritual({ kind: 'plan', date: today })}
        >
          Review
        </Button>
        <Button
          size="xs"
          variant="primary"
          onClick={() =>
            run(
              moveTasks(
                overdue.map((t) => t.id),
                today,
              ),
            )
          }
        >
          Move all to today
        </Button>
      </div>
    </div>
  );
}

export function BoardView() {
  const today = useData((s) => s.today);
  const visibleDays = useData((s) => s.settings.visibleDays);
  const weekStartsOn = useData((s) => s.settings.weekStartsOn);
  const tasks = useData((s) => s.tasks);
  const boardStart = useUi((s) => s.boardStart) ?? today;
  const panelOpen = useUi((s) => s.calendarPanel);
  const days = useMemo(
    () => dateRange(boardStart, addDays(boardStart, Math.max(1, visibleDays) - 1)),
    [boardStart, visibleDays],
  );
  const containers = useMemo(
    () => Object.fromEntries(days.map((d) => [`day:${d}`, tasksOnDate(tasks, d).map((t) => t.id)])),
    [tasks, days],
  );
  const virtual = useVirtualOccurrences(days[0]!, days.at(-1)!);

  const onMove = useCallback(({ taskId, from, to, index, ids }: MoveResult) => {
    if (!to.startsWith('day:')) return;
    const date = to.slice(4);
    if (from === to) run(reorderDay(date, ids));
    else run(moveTask(taskId, date, { index }));
  }, []);

  const shift = (delta: number) => {
    useUi.setState({
      boardStart: addDays(boardStart, delta),
      panelDate: addDays(useUi.getState().panelDate ?? today, delta),
    });
  };

  return (
    <TaskDndProvider containers={containers} onMove={onMove}>
      <div className="flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col">
          <ViewHeader
            title={boardStart === today ? 'Today' : formatDateShort(boardStart, today)}
            subtitle={monthName(boardStart)}
            calendarToggle
            left={
              <div className="ml-2 flex items-center gap-0.5">
                <IconButton label="Previous day ([)" onClick={() => shift(-1)}>
                  <ChevronLeft size={16} />
                </IconButton>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => useUi.setState({ boardStart: today, panelDate: today })}
                  disabled={boardStart === today}
                >
                  Today
                </Button>
                <IconButton label="Next day (])" onClick={() => shift(1)}>
                  <ChevronRight size={16} />
                </IconButton>
                <Popover
                  trigger={
                    <IconButton label="Jump to date">
                      <CalendarDays size={15} />
                    </IconButton>
                  }
                >
                  <DatePickerPanel
                    value={boardStart}
                    today={today}
                    weekStartsOn={weekStartsOn}
                    allowClear={false}
                    onChange={(d) => d && useUi.setState({ boardStart: d, panelDate: d })}
                  />
                </Popover>
              </div>
            }
            right={<RitualButtons />}
          />
          <OverdueBanner />
          <div
            className="flex min-h-0 flex-1 gap-2 overflow-x-auto px-3"
            role="region"
            aria-label="Day plans"
          >
            {days.map((d) => (
              <DayColumn key={d} date={d} virtual={virtual.filter((v) => v.date === d)} />
            ))}
          </div>
        </div>
        {panelOpen && <CalendarPanel />}
      </div>
    </TaskDndProvider>
  );
}
