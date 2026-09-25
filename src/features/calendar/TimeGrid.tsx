/**
 * Time grid for one or more days: meetings, Keel time blocks, working hours, the current
 * time, conflicts, and direct manipulation (move/resize blocks, drag on empty space to
 * create an event, drop tasks from lists to timebox them).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { AlertTriangle, MapPin, Repeat } from 'lucide-react';
import { DateTime } from 'luxon';
import { ui, useUi } from '@/app/ui';
import { moveBlock, run, setComplete } from '@/data/actions';
import { useOccurrences, workingHoursOf } from '@/data/selectors';
import { useData } from '@/data/store';
import type { ISODate } from '@/domain/dates';
import {
  dayBounds,
  formatClockMinutes,
  formatDuration,
  formatTimeRange,
  isoWeekday,
  wallTimeToInstant,
} from '@/domain/dates';
import { coversDate } from '@/domain/events';
import { findConflicts, layoutOverlapping, snap } from '@/domain/scheduling';
import type { EventOccurrence, Task, TimeBlock } from '@/domain/types';
import { cn } from '@/ui/primitives';
import { TaskCheckbox, useNow } from '../task/TaskCard';
import { useDragGhost } from './dragGhost';

interface Item {
  id: string;
  kind: 'event' | 'block';
  startMin: number; // wall-clock minutes on this day (clipped to 0..1440)
  endMin: number;
  start: number;
  end: number;
  occ?: EventOccurrence;
  block?: TimeBlock;
  task?: Task;
}

function wallMinutes(ms: number, date: ISODate, zone: string): number {
  const dt = DateTime.fromMillis(ms, { zone });
  const d = dt.toISODate()!;
  if (d < date) return 0;
  if (d > date) return 24 * 60;
  return dt.hour * 60 + dt.minute + dt.second / 60;
}

interface DragState {
  blockId: string;
  mode: 'move' | 'resize';
  pointerY: number;
  pointerX: number;
  origStart: number;
  origEnd: number;
  origDay: number;
  deltaMin: number;
  dayIndex: number;
  moved: boolean;
}

interface CreateState {
  dayIndex: number;
  anchorMin: number;
  currentMin: number;
}

function DayColumnDrop({ date, children }: { date: ISODate; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `timeline:${date}`,
    data: { type: 'timeline', date },
  });
  return (
    <div
      ref={setNodeRef}
      data-timeline-day={date}
      className={cn('relative h-full', isOver && 'bg-accent/[0.04]')}
    >
      {children}
    </div>
  );
}

export function TimeGrid({
  days,
  hourHeight,
  showDayHeaders = false,
  onCreateEvent,
  scrollKey,
}: {
  days: ISODate[];
  hourHeight: number;
  showDayHeaders?: boolean;
  onCreateEvent?: (date: ISODate, startMin: number, endMin: number) => void;
  scrollKey?: string;
}) {
  const zone = useData((s) => s.zone);
  const today = useData((s) => s.today);
  const settings = useData((s) => s.settings);
  const blocks = useData((s) => s.blocks);
  const tasks = useData((s) => s.tasks);
  const calendars = useData((s) => s.calendars);
  const projects = useData((s) => s.projects);
  const occ = useOccurrences(days[0]!, days.at(-1)!);
  const ghost = useDragGhost((s) => s.ghost);
  const now = useNow(30_000);
  const scrollRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [creating, setCreating] = useState<CreateState | null>(null);
  const snapMin = settings.calendarSnapMin;
  const wh = workingHoursOf(settings);
  const pxPerMin = hourHeight / 60;

  // Scroll to the start of the working day (or now) on first render / day change.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nowMin = days.includes(today) ? wallMinutes(Date.now(), today, zone) : null;
    const target = nowMin !== null && nowMin > wh.startMin + 120 ? nowMin - 120 : wh.startMin - 60;
    el.scrollTop = Math.max(0, target * pxPerMin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, hourHeight]);

  const perDay = useMemo(() => {
    const blockList = Object.values(blocks);
    return days.map((date) => {
      const bounds = dayBounds(date, zone);
      const ds = Date.parse(bounds.start);
      const de = Date.parse(bounds.end);
      const items: Item[] = [];
      for (const o of occ) {
        if (o.allDay || o.end <= ds || o.start >= de) continue;
        items.push({
          id: `e:${o.key}`,
          kind: 'event',
          start: o.start,
          end: o.end,
          startMin: wallMinutes(o.start, date, zone),
          endMin: wallMinutes(Math.max(o.end, o.start + 15 * 60_000), date, zone),
          occ: o,
        });
      }
      for (const b of blockList) {
        const s = Date.parse(b.startUtc);
        const e = Date.parse(b.endUtc);
        const task = tasks[b.taskId];
        if (!task || e <= ds || s >= de) continue;
        items.push({
          id: `b:${b.id}`,
          kind: 'block',
          start: s,
          end: e,
          startMin: wallMinutes(s, date, zone),
          endMin: wallMinutes(e, date, zone),
          block: b,
          task,
        });
      }
      const layout = layoutOverlapping(
        items.map((i) => ({
          id: i.id,
          start: i.startMin,
          end: Math.max(i.endMin, i.startMin + 15),
        })),
      );
      const conflictPairs = findConflicts(
        items.map((i) => ({
          id: i.id,
          kind: i.kind,
          interval: { start: i.start, end: i.end },
          busy:
            i.kind === 'block'
              ? !i.task?.completedAt
              : !!i.occ &&
                i.occ.event.busy &&
                i.occ.event.status !== 'tentative' &&
                !!calendars[i.occ.event.calendarId]?.countsForAvailability,
        })),
      );
      const conflicts = new Set(conflictPairs.flat());
      const allDay = occ.filter((o) => o.allDay && coversDate(o, date));
      return { date, items, layout, conflicts, allDay };
    });
  }, [days, occ, blocks, tasks, calendars, zone]);

  const hasAllDay = perDay.some((d) => d.allDay.length > 0);

  const minutesFromPointer = (clientY: number): number => {
    const el = colsRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(24 * 60, (clientY - rect.top) / pxPerMin));
  };
  const dayFromPointer = (clientX: number): number => {
    const el = colsRef.current;
    if (!el || days.length === 1) return 0;
    const rect = el.getBoundingClientRect();
    const i = Math.floor(((clientX - rect.left) / rect.width) * days.length);
    return Math.max(0, Math.min(days.length - 1, i));
  };

  // --- block move/resize ------------------------------------------------------------
  const startBlockDrag = (
    e: ReactPointerEvent,
    item: Item,
    dayIndex: number,
    mode: 'move' | 'resize',
  ) => {
    if (e.button !== 0 || !item.block) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({
      blockId: item.block.id,
      mode,
      pointerY: e.clientY,
      pointerX: e.clientX,
      origStart: item.startMin,
      origEnd: item.endMin,
      origDay: dayIndex,
      deltaMin: 0,
      dayIndex,
      moved: false,
    });
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (drag) {
      const deltaMin = snap((e.clientY - drag.pointerY) / pxPerMin, snapMin);
      const dayIndex = drag.mode === 'move' ? dayFromPointer(e.clientX) : drag.origDay;
      const moved =
        drag.moved ||
        Math.abs(e.clientY - drag.pointerY) > 3 ||
        Math.abs(e.clientX - drag.pointerX) > 6;
      if (deltaMin !== drag.deltaMin || dayIndex !== drag.dayIndex || moved !== drag.moved)
        setDrag({ ...drag, deltaMin, dayIndex, moved });
    } else if (creating) {
      const m = snap(minutesFromPointer(e.clientY), snapMin);
      if (m !== creating.currentMin) setCreating({ ...creating, currentMin: m });
    }
  };

  const previewOf = (d: DragState) => {
    if (d.mode === 'move') {
      const dur = d.origEnd - d.origStart;
      const start = Math.max(0, Math.min(24 * 60 - dur, d.origStart + d.deltaMin));
      return { start, end: start + dur, dayIndex: d.dayIndex };
    }
    return {
      start: d.origStart,
      end: Math.max(d.origStart + snapMin, Math.min(24 * 60, d.origEnd + d.deltaMin)),
      dayIndex: d.origDay,
    };
  };

  const onPointerUp = () => {
    if (drag) {
      const d = drag;
      setDrag(null);
      if (!d.moved) {
        const task = tasks[blocks[d.blockId]?.taskId ?? ''];
        if (task) ui.openTask(task.id);
        return;
      }
      const p = previewOf(d);
      const date = days[p.dayIndex]!;
      if (p.start === d.origStart && p.end === d.origEnd && p.dayIndex === d.origDay) return;
      run(
        moveBlock(
          d.blockId,
          wallTimeToInstant(date, Math.round(p.start), zone),
          wallTimeToInstant(date, Math.round(p.end), zone),
        ),
      );
    } else if (creating) {
      const c = creating;
      setCreating(null);
      const a = Math.min(c.anchorMin, c.currentMin);
      let b = Math.max(c.anchorMin, c.currentMin);
      if (b - a < snapMin) b = a + Math.max(30, snapMin);
      onCreateEvent?.(days[c.dayIndex]!, a, Math.min(b, 24 * 60));
    }
  };

  const startCreate = (e: ReactPointerEvent, dayIndex: number) => {
    if (e.button !== 0 || !onCreateEvent || (e.target as HTMLElement).closest('[data-grid-item]'))
      return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const m = Math.floor(minutesFromPointer(e.clientY) / snapMin) * snapMin;
    setCreating({ dayIndex, anchorMin: m, currentMin: m + snapMin });
  };

  useEffect(() => {
    if (!drag && !creating) return;
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrag(null);
        setCreating(null);
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [drag, creating]);

  const hours = Array.from({ length: 24 }, (_, h) => h);
  const secondary = settings.secondaryTimeZone;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(showDayHeaders || hasAllDay) && (
        <div className="flex shrink-0 border-b border-line">
          <div className={cn('shrink-0', secondary ? 'w-[92px]' : 'w-[52px]')} />
          <div
            className="grid flex-1"
            style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
          >
            {perDay.map(({ date, allDay }) => (
              <div key={date} className="min-w-0 border-l border-line px-1 py-1 first:border-l-0">
                {showDayHeaders && (
                  <div
                    className={cn(
                      'px-1 pb-1 text-[12px] font-medium',
                      date === today ? 'text-accent-text' : 'text-muted',
                    )}
                  >
                    {DateTime.fromISO(date).toFormat('ccc d')}
                  </div>
                )}
                <div className="flex flex-col gap-0.5">
                  {allDay.map((o) => {
                    const cal = calendars[o.event.calendarId];
                    return (
                      <button
                        key={o.key}
                        type="button"
                        onClick={() =>
                          useUi.setState({ editEvent: { id: o.event.id, occurrenceKey: o.key } })
                        }
                        className="truncate rounded px-1.5 py-0.5 text-left text-[11.5px] font-medium"
                        style={{
                          background: `color-mix(in srgb, ${cal?.color ?? '#888'} 18%, var(--surface))`,
                          color: 'var(--fg)',
                        }}
                        title={o.event.title}
                      >
                        {o.event.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="flex" style={{ height: 24 * hourHeight }}>
          {/* Hour gutter */}
          <div
            className={cn('relative shrink-0 select-none', secondary ? 'w-[92px]' : 'w-[52px]')}
            aria-hidden
          >
            {hours.map((h) => (
              <div
                key={h}
                className="absolute right-2 flex -translate-y-1/2 gap-2 text-[10.5px] text-subtle tabular"
                style={{ top: h * hourHeight }}
              >
                {h > 0 && secondary && (
                  <span className="text-subtle/70">
                    {DateTime.fromISO(wallTimeToInstant(days[0]!, h * 60, zone))
                      .setZone(secondary)
                      .toFormat(settings.hour12 ? 'ha' : 'HH:mm')
                      .toLowerCase()}
                  </span>
                )}
                {h > 0 && <span>{formatClockMinutes(h * 60, settings.hour12)}</span>}
              </div>
            ))}
          </div>

          <div
            ref={colsRef}
            className="hour-grid relative grid flex-1 border-l border-line"
            style={{
              gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
              ['--hour-height' as string]: `${hourHeight}px`,
            }}
          >
            {perDay.map(({ date, items, layout, conflicts }, dayIndex) => {
              const working = wh.days.includes(isoWeekday(date));
              const nowMin = date === today ? wallMinutes(now, date, zone) : null;
              return (
                <DayColumnDrop key={date} date={date}>
                  <div
                    className={cn('absolute inset-0', dayIndex > 0 && 'border-l border-line')}
                    onPointerDown={(e) => startCreate(e, dayIndex)}
                    aria-label={`Calendar for ${date}`}
                  >
                    {/* Non-working time shading */}
                    {working ? (
                      <>
                        <div
                          className="pointer-events-none absolute inset-x-0 top-0 bg-sunken/70"
                          style={{ height: wh.startMin * pxPerMin }}
                        />
                        <div
                          className="pointer-events-none absolute inset-x-0 bottom-0 bg-sunken/70"
                          style={{ top: wh.endMin * pxPerMin }}
                        />
                      </>
                    ) : (
                      <div className="pointer-events-none absolute inset-0 bg-sunken/50" />
                    )}

                    {items.map((item) => {
                      const pos = layout.get(item.id) ?? { column: 0, columns: 1 };
                      const isDragged = drag && item.block?.id === drag.blockId;
                      const top = item.startMin * pxPerMin;
                      const height = Math.max((item.endMin - item.startMin) * pxPerMin, 18);
                      const widthPct = 100 / pos.columns;
                      const style = {
                        top,
                        height,
                        left: `calc(${pos.column * widthPct}% + 2px)`,
                        width: `calc(${widthPct}% - 4px)`,
                      };
                      const conflict = conflicts.has(item.id);
                      if (item.kind === 'event' && item.occ) {
                        const o = item.occ;
                        const cal = calendars[o.event.calendarId];
                        const color = cal?.color ?? '#888';
                        const tentative = o.event.status === 'tentative' || !o.event.busy;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            data-grid-item
                            onClick={() =>
                              useUi.setState({
                                editEvent: { id: o.event.id, occurrenceKey: o.key },
                              })
                            }
                            className={cn(
                              'absolute overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-left text-[11.5px] leading-tight shadow-sm',
                              conflict && 'ring-1 ring-danger/60',
                            )}
                            style={{
                              ...style,
                              borderColor: color,
                              background: tentative
                                ? `repeating-linear-gradient(135deg, color-mix(in srgb, ${color} 10%, var(--surface)) 0 6px, var(--surface) 6px 12px)`
                                : `color-mix(in srgb, ${color} 17%, var(--surface))`,
                              color: 'var(--fg)',
                            }}
                            title={`${o.event.title} · ${formatTimeRange(new Date(o.start).toISOString(), new Date(o.end).toISOString(), zone, settings.hour12)}`}
                          >
                            <div className="flex items-center gap-1 font-medium">
                              <span className="truncate">{o.event.title}</span>
                              {o.event.rrule && (
                                <Repeat size={10} className="shrink-0 opacity-60" />
                              )}
                            </div>
                            {height > 30 && (
                              <div className="truncate text-[10.5px] text-muted tabular">
                                {formatTimeRange(
                                  new Date(o.start).toISOString(),
                                  new Date(o.end).toISOString(),
                                  zone,
                                  settings.hour12,
                                )}
                              </div>
                            )}
                            {height > 46 && o.event.location && (
                              <div className="flex items-center gap-0.5 truncate text-[10.5px] text-muted">
                                <MapPin size={9} /> {o.event.location}
                              </div>
                            )}
                          </button>
                        );
                      }
                      const task = item.task!;
                      const project = task.projectId ? projects[task.projectId] : null;
                      const done = !!task.completedAt;
                      return (
                        <div
                          key={item.id}
                          data-grid-item
                          role="button"
                          tabIndex={0}
                          aria-label={`Time block: ${task.title}, ${formatTimeRange(item.block!.startUtc, item.block!.endUtc, zone, settings.hour12)}`}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') ui.openTask(task.id);
                          }}
                          onPointerDown={(e) => startBlockDrag(e, item, dayIndex, 'move')}
                          className={cn(
                            'group absolute flex cursor-grab touch-none flex-col overflow-hidden rounded-md border px-1.5 py-0.5 text-[11.5px] leading-tight shadow-sm active:cursor-grabbing',
                            done
                              ? 'border-line bg-sunken text-subtle'
                              : 'border-accent/40 bg-accent-soft text-fg',
                            conflict && !done && 'border-danger/70',
                            isDragged && 'opacity-30',
                          )}
                          style={style}
                        >
                          <div className="flex items-start gap-1">
                            <TaskCheckbox
                              done={done}
                              size={13}
                              label={task.title}
                              onToggle={() => run(setComplete(task.id, !done))}
                            />
                            <span
                              className={cn(
                                'min-w-0 flex-1 truncate font-medium',
                                done && 'line-through',
                              )}
                            >
                              {task.title}
                            </span>
                            {conflict && !done && (
                              <AlertTriangle
                                size={11}
                                className="shrink-0 text-danger"
                                aria-label="Overlaps another commitment"
                              />
                            )}
                          </div>
                          {height > 30 && (
                            <div className="truncate pl-[17px] text-[10.5px] text-muted tabular">
                              {formatTimeRange(
                                item.block!.startUtc,
                                item.block!.endUtc,
                                zone,
                                settings.hour12,
                              )}
                              {project ? ` · ${project.name}` : ''}
                            </div>
                          )}
                          <div
                            className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize"
                            onPointerDown={(e) => startBlockDrag(e, item, dayIndex, 'resize')}
                            aria-hidden
                          />
                        </div>
                      );
                    })}

                    {/* Move/resize preview */}
                    {drag &&
                      (() => {
                        const p = previewOf(drag);
                        if (p.dayIndex !== dayIndex || !drag.moved) return null;
                        const task = tasks[blocks[drag.blockId]?.taskId ?? ''];
                        return (
                          <div
                            className="pointer-events-none absolute inset-x-[2px] z-10 rounded-md border-2 border-accent bg-accent-soft/90 px-1.5 py-0.5 text-[11.5px] font-medium shadow-md"
                            style={{
                              top: p.start * pxPerMin,
                              height: (p.end - p.start) * pxPerMin,
                            }}
                          >
                            <div className="truncate">{task?.title}</div>
                            <div className="text-[10.5px] text-muted tabular">
                              {formatClockMinutes(Math.round(p.start), settings.hour12)} –{' '}
                              {formatClockMinutes(Math.round(p.end), settings.hour12)}
                            </div>
                          </div>
                        );
                      })()}

                    {/* New event selection */}
                    {creating && creating.dayIndex === dayIndex && (
                      <div
                        className="pointer-events-none absolute inset-x-[2px] z-10 rounded-md border border-dashed border-accent bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent-text tabular"
                        style={{
                          top: Math.min(creating.anchorMin, creating.currentMin) * pxPerMin,
                          height:
                            Math.max(Math.abs(creating.currentMin - creating.anchorMin), snapMin) *
                            pxPerMin,
                        }}
                      >
                        New event
                      </div>
                    )}

                    {/* Drop preview for a task dragged from a list */}
                    {ghost && ghost.date === date && (
                      <div
                        className="pointer-events-none absolute inset-x-[2px] z-10 rounded-md border-2 border-dashed border-accent bg-accent-soft/80 px-1.5 py-0.5 text-[11.5px] shadow-md"
                        style={{
                          top: ghost.startMin * pxPerMin,
                          height: Math.max(ghost.durationMin * pxPerMin, 18),
                        }}
                      >
                        <div className="truncate font-medium">{ghost.title}</div>
                        <div className="text-[10.5px] text-muted tabular">
                          {formatClockMinutes(ghost.startMin, settings.hour12)} ·{' '}
                          {formatDuration(ghost.durationMin)}
                        </div>
                      </div>
                    )}

                    {nowMin !== null && (
                      <div
                        className="pointer-events-none absolute inset-x-0 z-20 flex items-center"
                        style={{ top: nowMin * pxPerMin }}
                        aria-hidden
                      >
                        <span className="-ml-1 h-2 w-2 rounded-full bg-now" />
                        <span className="h-[1.5px] flex-1 bg-now" />
                      </div>
                    )}
                  </div>
                </DayColumnDrop>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
