import { memo, useEffect, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent, Ref } from 'react';
import {
  AlignLeft,
  CalendarClock,
  CornerDownRight,
  Flag,
  Link2,
  MoreHorizontal,
  Pause,
  Play,
  Repeat,
} from 'lucide-react';
import { isMac } from '@/app/platform';
import { ui } from '@/app/ui';
import { deleteTasks, moveTask, run, setComplete, stopTimer, updateTask } from '@/data/actions';
import { getData, useData } from '@/data/store';
import type { ISODate } from '@/domain/dates';
import {
  addDays,
  dateOfInstant,
  diffDays,
  formatDuration,
  formatElapsed,
  formatTimeRange,
  relativeDateLabel,
  weekdayShort,
} from '@/domain/dates';
import type { Priority, Task, TimeBlock } from '@/domain/types';
import { ContextMenu, DropdownMenu } from '@/ui/menu';
import { EstimatePanel } from '@/ui/pickers';
import { ColorDot, IconButton, Popover, Tooltip, cn } from '@/ui/primitives';
import { autoSchedule } from '../calendar/autoSchedule';
import { startFocus, taskMenuItems } from './taskMenu';

export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

export const PRIORITY_COLORS: Record<Priority, string> = {
  0: 'transparent',
  1: '#4F86C6',
  2: '#D1902C',
  3: '#D2493D',
};

export function TaskCheckbox({
  done,
  onToggle,
  label,
  priority = 0,
  size = 18,
}: {
  done: boolean;
  onToggle: () => void;
  label: string;
  priority?: Priority;
  size?: number;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? `Mark “${label}” incomplete` : `Complete “${label}”`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        'group/check relative mt-px flex shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors',
        done
          ? 'animate-check border-accent bg-accent'
          : 'border-line-strong hover:border-accent hover:bg-accent-soft',
      )}
      style={{
        width: size,
        height: size,
        borderColor: !done && priority ? PRIORITY_COLORS[priority] : undefined,
      }}
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden
        className={cn(
          'h-[70%] w-[70%] transition-opacity',
          done ? 'opacity-100' : 'opacity-0 group-hover/check:opacity-60',
        )}
      >
        <path
          d="M3.5 8.5l3 3 6-7"
          fill="none"
          stroke={done ? 'var(--accent-fg)' : 'var(--accent)'}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function RunningTime({ startMs, baseMin }: { startMs: number; baseMin: number }) {
  const now = useNow(1000);
  return <span className="tabular">{formatElapsed(baseMin * 60_000 + (now - startMs))}</span>;
}

export /**
 * The time block a card shows: one on the card's own day, else the next one ahead (labelled
 * with its weekday). A past block on another day (left behind when the task moved) is not
 * shown on the card; it stays on its day's calendar.
 */
function pickBlock(
  blocks: TimeBlock[],
  listDate: ISODate | null,
  today: ISODate,
  zone: string,
): { block: TimeBlock; date: ISODate; otherDay: boolean } | null {
  const sorted = blocks.slice().sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  const withDate = sorted.map((block) => ({ block, date: dateOfInstant(block.startUtc, zone) }));
  const sameDay = listDate ? withDate.find((b) => b.date === listDate) : undefined;
  if (sameDay) return { ...sameDay, otherDay: false };
  const next = withDate.find((b) => Date.parse(b.block.endUtc) > Date.now());
  if (!next) return null;
  return { ...next, otherDay: next.date !== (listDate ?? today) };
}

interface TaskCardProps {
  task: Task;
  /** Minutes from finished sessions; a running session is added live. */
  trackedMin: number;
  runningSince: number | null;
  blocks: TimeBlock[];
  /** Show the planned date (lists outside the day board). */
  showPlanDate?: boolean;
  selected?: boolean;
  dragging?: boolean;
  overlay?: boolean;
  style?: CSSProperties;
  cardRef?: Ref<HTMLDivElement>;
  dragProps?: Record<string, unknown>;
  /** Date of the list the card is shown in, for "move to next day". */
  listDate?: ISODate | null;
}

function focusSibling(el: HTMLElement, delta: number) {
  const list = el.closest('[data-task-list]') ?? document;
  const cards = Array.from(list.querySelectorAll<HTMLElement>('[data-task-card]'));
  const i = cards.indexOf(el);
  cards[i + delta]?.focus();
}

export const TaskCard = memo(function TaskCard({
  task,
  trackedMin,
  runningSince,
  blocks,
  showPlanDate,
  selected,
  dragging,
  overlay,
  style,
  cardRef,
  dragProps,
  listDate,
}: TaskCardProps) {
  const projects = useData((s) => s.projects);
  const areas = useData((s) => s.areas);
  const tags = useData((s) => s.tags);
  const today = useData((s) => s.today);
  const zone = useData((s) => s.zone);
  const hour12 = useData((s) => s.settings.hour12);
  const [estimateOpen, setEstimateOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const done = !!task.completedAt;
  const project = task.projectId ? projects[task.projectId] : null;
  const area =
    !project && task.areaId ? areas[task.areaId] : project?.areaId ? areas[project.areaId] : null;
  const running = runningSince !== null;
  const subDone = task.subtasks.filter((s) => s.completedAt).length;
  const shownBlock = pickBlock(blocks, listDate ?? null, today, zone);
  const overdueDue = task.dueDate && !done && task.dueDate < today;
  const dueSoon = task.dueDate && !done && !overdueDue && diffDays(today, task.dueDate) <= 1;
  const over = task.estimateMin && trackedMin > task.estimateMin;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const key = e.key.toLowerCase();
    const next = listDate ? addDays(listDate, 1) : addDays(today, 1);
    if (e.altKey && (key === 'arrowup' || key === 'arrowdown')) return; // handled by list
    switch (key) {
      case 'arrowdown':
        e.preventDefault();
        focusSibling(e.currentTarget, 1);
        break;
      case 'arrowup':
        e.preventDefault();
        focusSibling(e.currentTarget, -1);
        break;
      case 'enter':
        e.preventDefault();
        ui.openTask(task.id);
        break;
      case ' ':
      case 'x':
        e.preventDefault();
        run(setComplete(task.id, !done));
        break;
      case 'f':
        if (!done) startFocus(task.id);
        break;
      case 'e':
        e.preventDefault();
        setEstimateOpen(true);
        break;
      case 's':
        if (!done)
          run(
            autoSchedule(
              [task.id],
              task.planDate && task.planDate >= today ? task.planDate : today,
            ),
          );
        break;
      case 't':
        e.stopPropagation();
        run(moveTask(task.id, today));
        break;
      case 'm':
        run(moveTask(task.id, next));
        break;
      case 'b':
        run(moveTask(task.id, null));
        break;
      case '0':
      case '1':
      case '2':
      case '3':
        run(updateTask(task.id, { priority: Number(key) as Priority }, 'Change priority'));
        break;
      case 'delete':
      case 'backspace':
        e.preventDefault();
        focusSibling(e.currentTarget, 1);
        run(deleteTasks([task.id]));
        break;
      default:
        return;
    }
    e.stopPropagation();
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (overlay) return;
    // React bubbles events from portals (menus, popovers) through the component tree; only
    // clicks that happened inside the card itself should open it.
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    if ((isMac ? e.metaKey : e.ctrlKey) || e.shiftKey) {
      ui.toggleSelect(task.id);
      return;
    }
    ui.openTask(task.id);
  };

  const planLabel = task.planDate ? relativeDateLabel(task.planDate, today) : null;

  const card = (
    <div
      ref={cardRef}
      data-task-card
      data-task-id={task.id}
      tabIndex={overlay ? -1 : 0}
      role="button"
      aria-label={`${task.title}${done ? ', completed' : ''}${task.estimateMin ? `, ${formatDuration(task.estimateMin)} estimate` : ''}`}
      style={style}
      {...dragProps}
      onKeyDown={onKeyDown}
      onClick={onClick}
      className={cn(
        'group relative flex cursor-default flex-col gap-1 rounded-[var(--radius)] border bg-surface px-[var(--card-px)] py-[var(--card-py)] text-left transition-[box-shadow,border-color,opacity] outline-none',
        'border-line shadow-sm hover:border-line-strong hover:shadow-md focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/20',
        selected && 'border-accent ring-2 ring-accent/25',
        running && 'border-accent/60 ring-1 ring-accent/30',
        dragging && 'opacity-40',
        overlay && 'rotate-[1.2deg] shadow-lg',
        done && 'bg-surface/70',
      )}
    >
      <div className="flex items-start gap-2.5">
        <TaskCheckbox
          done={done}
          priority={task.priority}
          label={task.title}
          onToggle={() => run(setComplete(task.id, !done))}
        />
        <div
          className={cn(
            'min-w-0 flex-1 text-[13.5px] leading-snug break-words',
            done ? 'text-subtle line-through decoration-subtle/60' : 'text-fg',
          )}
        >
          {task.title}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {running ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                run(stopTimer());
              }}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label="Pause timer"
              className="flex h-6 items-center gap-1 rounded-md bg-accent-soft px-1.5 text-[11.5px] font-medium text-accent-text"
            >
              <span className="h-1.5 w-1.5 animate-soft-pulse rounded-full bg-accent" />
              <RunningTime startMs={runningSince} baseMin={trackedMin} />
              <Pause size={12} />
            </button>
          ) : (
            !done &&
            !overlay && (
              <IconButton
                label="Start timer"
                size="xs"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  startFocus(task.id);
                }}
              >
                <Play size={13} />
              </IconButton>
            )
          )}
          <Popover
            open={estimateOpen}
            onOpenChange={setEstimateOpen}
            align="end"
            trigger={
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label={
                  task.estimateMin
                    ? `Estimate ${formatDuration(task.estimateMin)}, change`
                    : 'Set estimate'
                }
                className={cn(
                  'tabular flex h-6 items-center rounded-md px-1.5 text-[11.5px] font-medium transition-colors hover:bg-sunken',
                  task.estimateMin || trackedMin >= 1
                    ? 'text-muted'
                    : 'text-subtle opacity-0 group-hover:opacity-100',
                  over && 'text-warn',
                )}
              >
                {trackedMin >= 1 && !running ? `${formatDuration(trackedMin)} / ` : ''}
                {task.estimateMin
                  ? formatDuration(task.estimateMin)
                  : trackedMin >= 1 && !running
                    ? '—'
                    : running
                      ? ''
                      : '+ est'}
              </button>
            }
          >
            <EstimatePanel
              value={task.estimateMin}
              onChange={(m) => {
                setEstimateOpen(false);
                run(updateTask(task.id, { estimateMin: m }, 'Set estimate'));
              }}
            />
          </Popover>
          {!overlay && (
            <DropdownMenu
              onOpenChange={setMenuOpen}
              trigger={
                <IconButton
                  label="Task actions"
                  size="xs"
                  className={cn(
                    'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                    menuOpen && 'opacity-100',
                  )}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal size={14} />
                </IconButton>
              }
              items={taskMenuItems(task)}
            />
          )}
        </div>
      </div>

      {(project ||
        area ||
        shownBlock ||
        task.dueDate ||
        task.subtasks.length > 0 ||
        task.recurrenceId ||
        task.rolloverCount > 0 ||
        task.tagIds.length > 0 ||
        task.notes ||
        task.links.length > 0 ||
        (showPlanDate && planLabel) ||
        task.priority > 0) && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[28px] text-[11.5px] text-muted">
          {(project || area) && (
            <span className="flex max-w-[160px] items-center gap-1.5 truncate">
              <ColorDot color={(project ?? area)!.color} size={7} />
              <span className="truncate">{project ? project.name : area!.name}</span>
            </span>
          )}
          {showPlanDate && planLabel && (
            <span className={cn(task.planDate! < today && !done && 'text-warn')}>{planLabel}</span>
          )}
          {shownBlock && (
            <span className="tabular flex items-center gap-1">
              <CalendarClock size={11.5} />
              {shownBlock.otherDay && `${weekdayShort(shownBlock.date)} `}
              {formatTimeRange(shownBlock.block.startUtc, shownBlock.block.endUtc, zone, hour12)}
            </span>
          )}
          {task.dueDate && (
            <span
              className={cn(
                'flex items-center gap-1',
                overdueDue && 'font-medium text-danger',
                dueSoon && 'text-warn',
              )}
            >
              <Flag size={11} />
              Due {relativeDateLabel(task.dueDate, today)}
            </span>
          )}
          {task.priority > 0 && (
            <span
              className="flex items-center gap-1"
              style={{ color: PRIORITY_COLORS[task.priority] }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: PRIORITY_COLORS[task.priority] }}
              />
              {task.priority === 3 ? 'High' : task.priority === 2 ? 'Medium' : 'Low'}
            </span>
          )}
          {task.subtasks.length > 0 && (
            <span className="tabular flex items-center gap-1">
              <CornerDownRight size={11} />
              {subDone}/{task.subtasks.length}
            </span>
          )}
          {task.recurrenceId && (
            <Tooltip content="Repeating task">
              <Repeat size={11.5} aria-label="Repeats" />
            </Tooltip>
          )}
          {task.rolloverCount > 0 && !done && (
            <Tooltip
              content={`Carried forward ${task.rolloverCount} time${task.rolloverCount === 1 ? '' : 's'}`}
            >
              <span className="tabular rounded bg-warn-soft px-1 text-warn">
                ↻{task.rolloverCount}
              </span>
            </Tooltip>
          )}
          {task.tagIds.map((id) =>
            tags[id] ? (
              <span
                key={id}
                className="rounded px-1"
                style={{
                  background: `color-mix(in srgb, ${tags[id].color} 14%, transparent)`,
                  color: tags[id].color,
                }}
              >
                @{tags[id].name}
              </span>
            ) : null,
          )}
          {task.notes && <AlignLeft size={11.5} aria-label="Has notes" />}
          {task.links.length > 0 && <Link2 size={11.5} aria-label="Has links" />}
        </div>
      )}
    </div>
  );

  if (overlay) return card;
  return (
    <ContextMenu items={() => taskMenuItems(getData().tasks[task.id] ?? task)}>{card}</ContextMenu>
  );
});
