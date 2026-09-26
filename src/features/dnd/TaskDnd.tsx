/**
 * Drag and drop for tasks across lists ("containers": day columns, backlog, project lists)
 * and onto the calendar to timebox them. Uses dnd-kit (pointer + keyboard sensors, so every
 * drag has a keyboard equivalent). While dragging, a local ordering overrides the store so
 * cards move smoothly; the drop commits one action.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type {
  CollisionDetection,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
} from '@dnd-kit/core';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useUi } from '@/app/ui';
import { run, scheduleTask } from '@/data/actions';
import { useBlocksByTask, useClosedMinutes, useRunningSession } from '@/data/selectors';
import { getData, useData } from '@/data/store';
import type { ISODate } from '@/domain/dates';
import { addMinutes, wallTimeToInstant } from '@/domain/dates';
import { snap } from '@/domain/scheduling';
import type { Task } from '@/domain/types';
import { cn } from '@/ui/primitives';
import { useDragGhost } from '../calendar/dragGhost';
import { TaskCard } from '../task/TaskCard';

export type Containers = Record<string, string[]>;

export interface MoveResult {
  taskId: string;
  from: string;
  to: string;
  index: number;
  /** Final order of the destination container. */
  ids: string[];
}

interface Ctx {
  items: (container: string) => string[];
  activeId: string | null;
  onMove: (result: MoveResult) => void;
}

const DndCtx = createContext<Ctx>({ items: () => [], activeId: null, onMove: () => undefined });

function findContainer(containers: Containers, id: string): string | null {
  if (id in containers) return id;
  for (const [c, ids] of Object.entries(containers)) if (ids.includes(id)) return c;
  return null;
}

/** Pointer inside a calendar column wins; otherwise the nearest list item/container. */
const collision: CollisionDetection = (args) => {
  const timeline = pointerWithin(args).find((c) => String(c.id).startsWith('timeline:'));
  if (timeline) return [timeline];
  return closestCorners({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (c) => !String(c.id).startsWith('timeline:'),
    ),
  });
};

export function TaskDndProvider({
  containers,
  onMove,
  children,
}: {
  containers: Containers;
  onMove: (result: MoveResult) => void;
  children: ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [local, setLocal] = useState<Containers | null>(null);
  const origin = useRef<string | null>(null);
  // The live pointer position. dnd-kit's `delta` includes scroll adjustments of the dragged
  // item's scroll containers, so it can't be used to locate the pointer over the calendar.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const tasks = useData((s) => s.tasks);
  // Keyboard users reorder with Alt+↑/↓ and move with T/M/B (see TaskList/TaskCard), so the
  // dnd-kit keyboard sensor (which would claim Space/Enter) is not used.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const current = local ?? containers;

  const items = useCallback((c: string) => current[c] ?? [], [current]);

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActiveId(id);
    setLocal(containers);
    origin.current = findContainer(containers, id);
    const ev = e.activatorEvent as PointerEvent;
    pointer.current = 'clientX' in ev ? { x: ev.clientX, y: ev.clientY } : null;
    const track = (p: PointerEvent) => {
      pointer.current = { x: p.clientX, y: p.clientY };
    };
    window.addEventListener('pointermove', track, true);
    stopTracking.current = () => window.removeEventListener('pointermove', track, true);
  };

  const updateGhost = (e: DragMoveEvent) => {
    const overId = e.over ? String(e.over.id) : '';
    // A move can still be reported after the drop; only a live drag has a preview.
    if (!overId.startsWith('timeline:') || !pointer.current || !origin.current) {
      if (useDragGhost.getState().ghost) useDragGhost.setState({ ghost: null });
      return;
    }
    const date = overId.slice('timeline:'.length) as ISODate;
    const el = document.querySelector<HTMLElement>(`[data-timeline-day="${date}"]`);
    const task = getData().tasks[String(e.active.id)];
    if (!el || !task) return;
    const rect = el.getBoundingClientRect();
    const { settings } = getData();
    const y = pointer.current.y;
    const minutes = ((y - rect.top) / rect.height) * 24 * 60;
    const duration = task.estimateMin ?? settings.defaultEstimateMin;
    // Anchor the block's top slightly above the pointer so it feels held by its title.
    const startMin = Math.max(
      0,
      Math.min(24 * 60 - duration, snap(minutes - 10, settings.calendarSnapMin)),
    );
    const ghost = useDragGhost.getState().ghost;
    if (!ghost || ghost.date !== date || ghost.startMin !== startMin) {
      useDragGhost.setState({
        ghost: { date, startMin, durationMin: duration, title: task.title },
      });
    }
  };

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over || !local) return;
    const overId = String(over.id);
    if (overId.startsWith('timeline:')) return;
    const activeC = findContainer(local, String(active.id));
    const overC = findContainer(local, overId);
    if (!activeC || !overC || activeC === overC) return;
    setLocal((prev) => {
      if (!prev) return prev;
      const from = prev[activeC]!.filter((id) => id !== active.id);
      const to = [...prev[overC]!];
      const overIndex = to.indexOf(overId);
      const index = overIndex >= 0 ? overIndex : to.length;
      to.splice(index, 0, String(active.id));
      return { ...prev, [activeC]: from, [overC]: to };
    });
  };

  const stopTracking = useRef<() => void>(() => undefined);

  const reset = () => {
    stopTracking.current();
    setActiveId(null);
    setLocal(null);
    origin.current = null;
    pointer.current = null;
    useDragGhost.setState({ ghost: null });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    const id = String(active.id);
    const ghost = useDragGhost.getState().ghost;
    const from = origin.current;
    const state = local;
    reset();
    if (!over || !state || !from) return;
    const overId = String(over.id);

    if (overId.startsWith('timeline:')) {
      if (!ghost) return;
      const { zone } = getData();
      const start = wallTimeToInstant(ghost.date, ghost.startMin, zone);
      run(scheduleTask(id, start, addMinutes(start, ghost.durationMin)));
      return;
    }

    const to = findContainer(state, overId) ?? findContainer(state, id);
    if (!to) return;
    let ids = state[to]!;
    const oldIndex = ids.indexOf(id);
    const overIndex = ids.indexOf(overId);
    if (oldIndex >= 0 && overIndex >= 0 && oldIndex !== overIndex)
      ids = arrayMove(ids, oldIndex, overIndex);
    const unchanged = to === from && JSON.stringify(ids) === JSON.stringify(containers[to]);
    if (unchanged) return;
    onMove({ taskId: id, from, to, index: ids.indexOf(id), ids });
  };

  const ctx = useMemo(() => ({ items, activeId, onMove }), [items, activeId, onMove]);
  const activeTask = activeId ? tasks[activeId] : null;

  return (
    <DndCtx.Provider value={ctx}>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        autoScroll={{ threshold: { x: 0.04, y: 0.12 }, acceleration: 6 }}
        onDragStart={onDragStart}
        onDragMove={updateGhost}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={reset}
        accessibility={{
          screenReaderInstructions: {
            draggable:
              'Drag with the mouse, or use Alt+Up and Alt+Down to reorder and T, M or B to move the task to today, the next day or the backlog.',
          },
        }}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {activeTask ? <OverlayCard task={activeTask} /> : null}
        </DragOverlay>
      </DndContext>
    </DndCtx.Provider>
  );
}

function OverlayCard({ task }: { task: Task }) {
  const closed = useClosedMinutes();
  const ghost = useDragGhost((s) => s.ghost);
  if (ghost) return null; // the calendar shows its own preview
  return (
    <div className="w-[260px]">
      <TaskCard
        task={task}
        trackedMin={closed.get(task.id) ?? 0}
        runningSince={null}
        blocks={[]}
        overlay
      />
    </div>
  );
}

export function useDndItems(container: string): string[] {
  return useContext(DndCtx).items(container);
}

function SortableTask({
  task,
  container,
  showPlanDate,
  listDate,
}: {
  task: Task;
  container: string;
  showPlanDate?: boolean;
  listDate?: ISODate | null;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { container },
  });
  const closed = useClosedMinutes();
  const running = useRunningSession();
  const blocksByTask = useBlocksByTask();
  const selection = useSelection();
  const blocks = useMemo(
    () =>
      (blocksByTask.get(task.id) ?? []).filter(
        (b) => Date.parse(b.endUtc) > Date.now() - 12 * 3600_000,
      ),
    [blocksByTask, task.id],
  );
  const { role: _role, tabIndex: _tabIndex, ...dragAttrs } = attributes;
  return (
    <TaskCard
      task={task}
      trackedMin={closed.get(task.id) ?? 0}
      runningSince={running?.taskId === task.id ? Date.parse(running.startUtc) : null}
      blocks={blocks}
      showPlanDate={showPlanDate}
      selected={selection.includes(task.id)}
      dragging={isDragging}
      cardRef={setNodeRef}
      dragProps={{ ...dragAttrs, ...listeners }}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      listDate={listDate}
    />
  );
}

function useSelection() {
  return useUi((s) => s.selection);
}

/** A sortable, droppable list of task cards bound to a container id. */
export function TaskList({
  container,
  showPlanDate,
  listDate,
  empty,
  className,
  footer,
  compact,
}: {
  container: string;
  showPlanDate?: boolean;
  listDate?: ISODate | null;
  empty?: ReactNode;
  className?: string;
  footer?: ReactNode;
  /** Minimal drop area when empty (for dense trays). */
  compact?: boolean;
}) {
  const ids = useDndItems(container);
  const { onMove } = useContext(DndCtx);
  const tasks = useData((s) => s.tasks);
  const { setNodeRef, isOver } = useDroppable({ id: container, data: { container } });
  const visible = ids.map((id) => tasks[id]).filter(Boolean) as Task[];
  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const id = (e.target as HTMLElement).dataset.taskId;
    if (!id) return;
    const i = ids.indexOf(id);
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ids.length) return;
    e.preventDefault();
    const next = arrayMove(ids, i, j);
    onMove({ taskId: id, from: container, to: container, index: j, ids: next });
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-task-card][data-task-id="${id}"]`)?.focus(),
    );
  };
  return (
    <SortableContext id={container} items={ids} strategy={verticalListSortingStrategy}>
      <div
        ref={setNodeRef}
        data-task-list={container}
        onKeyDown={onKeyDown}
        className={cn(
          'flex flex-col gap-1.5 rounded-xl transition-colors',
          compact ? 'min-h-[10px]' : 'min-h-[48px]',
          isOver && visible.length === 0 && 'min-h-[48px] bg-accent/5',
          className,
        )}
      >
        {visible.map((t) => (
          <SortableTask
            key={t.id}
            task={t}
            container={container}
            showPlanDate={showPlanDate}
            listDate={listDate}
          />
        ))}
        {visible.length === 0 && empty}
        {footer}
      </div>
    </SortableContext>
  );
}
