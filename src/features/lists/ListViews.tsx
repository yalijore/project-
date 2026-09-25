import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Inbox,
  Layers,
  MoreHorizontal,
  Trash2,
} from 'lucide-react';
import { ui, useUi } from '@/app/ui';
import {
  deleteArea,
  deleteProject,
  deleteTag,
  moveTask,
  placeInBacklog,
  reorderDay,
  run,
  updateArea,
  updateProject,
  updateTag,
} from '@/data/actions';
import type { TaskPatch } from '@/data/repo';
import {
  backlogTasks,
  inboxTasks,
  isOpen,
  sortByBacklog,
  sortByPlan,
  useClosedMinutes,
} from '@/data/selectors';
import { useData } from '@/data/store';
import { dateOfInstant, formatDateLong, relativeDateLabel } from '@/domain/dates';
import type { Task } from '@/domain/types';
import { PALETTE } from '@/domain/types';
import { DropdownMenu } from '@/ui/menu';
import {
  AutoTextarea,
  Button,
  ColorDot,
  EmptyState,
  IconButton,
  Popover,
  cn,
} from '@/ui/primitives';
import { AddTaskInline } from '../capture/AddTaskInline';
import { CalendarPanel } from '../calendar/CalendarPanel';
import { ViewHeader } from '../common/ViewHeader';
import type { Containers, MoveResult } from '../dnd/TaskDnd';
import { TaskDndProvider, TaskList } from '../dnd/TaskDnd';
import { TaskCard } from '../task/TaskCard';
import { BulkBar } from './BulkBar';

function useEscClearsSelection() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useUi.getState().selection.length) ui.select([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Shared frame for list views: header, scrolling body, optional calendar panel, bulk bar. */
export function ListLayout({
  header,
  children,
  containers,
  onMove,
}: {
  header: ReactNode;
  children: ReactNode;
  containers: Containers;
  onMove: (r: MoveResult) => void;
}) {
  const panel = useUi((s) => s.calendarPanel);
  useEscClearsSelection();
  return (
    <TaskDndProvider containers={containers} onMove={onMove}>
      <div className="flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col">
          {header}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24">
            <div className="mx-auto flex max-w-[760px] flex-col gap-6">{children}</div>
          </div>
        </div>
        {panel && <CalendarPanel />}
      </div>
      <BulkBar />
    </TaskDndProvider>
  );
}

function Group({
  title,
  color,
  count,
  children,
  collapsible,
  defaultOpen = true,
  action,
}: {
  title: ReactNode;
  color?: string;
  count?: number;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="flex items-center gap-2 text-[13px] font-semibold text-fg"
            aria-expanded={open}
          >
            {open ? (
              <ChevronDown size={14} className="text-subtle" />
            ) : (
              <ChevronRight size={14} className="text-subtle" />
            )}
            {color && <ColorDot color={color} />}
            {title}
          </button>
        ) : (
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
            {color && <ColorDot color={color} />}
            {title}
          </h2>
        )}
        {count !== undefined && <span className="text-[12px] text-subtle tabular">{count}</span>}
        <div className="ml-auto">{action}</div>
      </div>
      {open && children}
    </section>
  );
}

function neighbors(ids: string[], index: number): [string | undefined, string | undefined] {
  return [ids[index - 1], ids[index + 1]];
}

function groupPatch(container: string): TaskPatch | null {
  if (container.startsWith('group:p:')) return { projectId: container.slice(8) };
  if (container.startsWith('group:a:')) return { areaId: container.slice(8), projectId: null };
  if (container === 'group:none') return { projectId: null, areaId: null };
  return null;
}

/** onMove for backlog-ordered lists; moving across groups reassigns project/area. */
function backlogMove({ taskId, from, to, index, ids }: MoveResult) {
  const [before, after] = neighbors(ids, index);
  run(placeInBacklog(taskId, from !== to ? groupPatch(to) : null, before, after));
}

// ---------------------------------------------------------------------------------------

export function InboxView() {
  const tasks = useData((s) => s.tasks);
  const list = useMemo(() => inboxTasks(tasks), [tasks]);
  const containers = useMemo(() => ({ 'list:inbox': list.map((t) => t.id) }), [list]);
  return (
    <ListLayout
      containers={containers}
      onMove={backlogMove}
      header={<ViewHeader title="Inbox" subtitle="Captured, not yet sorted" calendarToggle />}
    >
      <div className="flex flex-col gap-1.5">
        <AddTaskInline planDate={null} label="Capture a task" />
        <TaskList
          container="list:inbox"
          empty={
            <EmptyState icon={<Inbox size={28} />} title="Inbox zero">
              New tasks without a day, project or area land here. Give them a home: plan a day
              (T/M), pick a project, or drag them onto the calendar.
            </EmptyState>
          }
        />
      </div>
    </ListLayout>
  );
}

export function BacklogView() {
  const tasks = useData((s) => s.tasks);
  const projects = useData((s) => s.projects);
  const areas = useData((s) => s.areas);
  const groups = useMemo(() => {
    const list = backlogTasks(tasks);
    const out: { key: string; title: string; color?: string; ids: string[] }[] = [];
    const byKey = new Map<string, string[]>();
    for (const t of list) {
      const key = t.projectId
        ? `group:p:${t.projectId}`
        : t.areaId
          ? `group:a:${t.areaId}`
          : 'group:none';
      byKey.set(key, [...(byKey.get(key) ?? []), t.id]);
    }
    for (const a of Object.values(areas)
      .filter((x) => !x.archivedAt)
      .sort((x, y) => x.sortOrder - y.sortOrder)) {
      out.push({
        key: `group:a:${a.id}`,
        title: a.name,
        color: a.color,
        ids: byKey.get(`group:a:${a.id}`) ?? [],
      });
      for (const p of Object.values(projects).filter((x) => x.areaId === a.id && !x.archivedAt)) {
        out.push({
          key: `group:p:${p.id}`,
          title: `${a.name} / ${p.name}`,
          color: p.color,
          ids: byKey.get(`group:p:${p.id}`) ?? [],
        });
      }
    }
    for (const p of Object.values(projects).filter((x) => !x.areaId && !x.archivedAt)) {
      out.push({
        key: `group:p:${p.id}`,
        title: p.name,
        color: p.color,
        ids: byKey.get(`group:p:${p.id}`) ?? [],
      });
    }
    // Tasks in archived projects/areas still show, under their own group.
    for (const [key, ids] of byKey)
      if (!out.some((g) => g.key === key))
        out.push({
          key,
          title: key.startsWith('group:p:')
            ? (projects[key.slice(8)]?.name ?? 'Project')
            : key.startsWith('group:a:')
              ? (areas[key.slice(8)]?.name ?? 'Area')
              : 'No project or area',
          ids,
        });
    if (!out.some((g) => g.key === 'group:none'))
      out.push({
        key: 'group:none',
        title: 'No project or area',
        ids: byKey.get('group:none') ?? [],
      });
    return out;
  }, [tasks, projects, areas]);
  const containers = useMemo(() => Object.fromEntries(groups.map((g) => [g.key, g.ids])), [groups]);
  const total = groups.reduce((s, g) => s + g.ids.length, 0);

  return (
    <ListLayout
      containers={containers}
      onMove={backlogMove}
      header={
        <ViewHeader
          title="Backlog"
          subtitle={`${total} open task${total === 1 ? '' : 's'} not planned for a day`}
          calendarToggle
        />
      }
    >
      {total === 0 && (
        <EmptyState icon={<Layers size={28} />} title="Your backlog is empty">
          Tasks you haven’t planned for a specific day collect here, grouped by project and area.
        </EmptyState>
      )}
      {groups
        .filter((g) => g.ids.length > 0 || g.key === 'group:none')
        .map((g) => (
          <Group key={g.key} title={g.title} color={g.color} count={g.ids.length} collapsible>
            <TaskList
              container={g.key}
              empty={
                <p className="rounded-xl border border-dashed border-line px-3 py-3 text-[12px] text-subtle">
                  Drop tasks here
                </p>
              }
            />
          </Group>
        ))}
    </ListLayout>
  );
}

function PlannedAndBacklog({ open, containerPrefix }: { open: Task[]; containerPrefix: string }) {
  const planned = open
    .filter((t) => t.planDate)
    .sort((a, b) => a.planDate!.localeCompare(b.planDate!) || sortByPlan(a, b));
  const backlog = open.filter((t) => !t.planDate).sort(sortByBacklog);
  return (
    <>
      {planned.length > 0 && (
        <Group title="Planned" count={planned.length}>
          <TaskList container={`${containerPrefix}:planned`} showPlanDate />
        </Group>
      )}
      <Group title="Not planned yet" count={backlog.length}>
        <TaskList
          container={`${containerPrefix}:backlog`}
          empty={
            <p className="px-1 text-[12.5px] text-subtle">
              Nothing waiting. {planned.length === 0 && `Add a task above.`}
            </p>
          }
        />
      </Group>
    </>
  );
}

function CompletedGroup({ tasks }: { tasks: Task[] }) {
  const zone = useData((s) => s.zone);
  const today = useData((s) => s.today);
  const closed = useClosedMinutes();
  const done = tasks
    .filter((t) => t.completedAt)
    .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!));
  if (done.length === 0) return null;
  return (
    <Group title="Completed" count={done.length} collapsible defaultOpen={false}>
      <div className="flex flex-col gap-1.5">
        {done.slice(0, 100).map((t) => (
          <div key={t.id} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <TaskCard
                task={t}
                trackedMin={closed.get(t.id) ?? 0}
                runningSince={null}
                blocks={[]}
              />
            </div>
            <span className="w-24 shrink-0 text-right text-[11.5px] text-subtle">
              {relativeDateLabel(dateOfInstant(t.completedAt!, zone), today)}
            </span>
          </div>
        ))}
      </div>
    </Group>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <Popover
      trigger={
        <button
          type="button"
          aria-label="Change color"
          className="rounded-full p-1 hover:bg-sunken"
        >
          <ColorDot color={value} size={14} />
        </button>
      }
    >
      <div className="grid grid-cols-5 gap-1.5 p-1">
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Color ${c}`}
            onClick={() => onChange(c)}
            className={cn(
              'h-7 w-7 rounded-full border-2',
              c === value ? 'border-fg' : 'border-transparent',
            )}
            style={{ background: c }}
          />
        ))}
      </div>
    </Popover>
  );
}

function EditableTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      aria-label="Name"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => (text.trim() && text !== value ? onSave(text) : setText(value))}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className="min-w-0 rounded-md bg-transparent px-1 text-[17px] font-semibold tracking-tight outline-none hover:bg-sunken focus:bg-sunken"
    />
  );
}

function useProjectLikeContainers(open: Task[], prefix: string) {
  return useMemo(() => {
    const planned = open
      .filter((t) => t.planDate)
      .sort((a, b) => a.planDate!.localeCompare(b.planDate!) || sortByPlan(a, b));
    const backlog = open.filter((t) => !t.planDate).sort(sortByBacklog);
    return {
      [`${prefix}:planned`]: planned.map((t) => t.id),
      [`${prefix}:backlog`]: backlog.map((t) => t.id),
    };
  }, [open, prefix]);
}

function useProjectLikeMove(prefix: string) {
  const tasks = useData((s) => s.tasks);
  return useCallback(
    ({ taskId, from, to, index, ids }: MoveResult) => {
      if (to === `${prefix}:backlog` && from !== to) {
        // Dragged out of "Planned": unplan it (to put it on a day, drag it onto the calendar).
        run(moveTask(taskId, null));
      } else if (to === `${prefix}:backlog`) {
        const [before, after] = neighbors(ids, index);
        run(placeInBacklog(taskId, null, before, after));
      } else if (to === `${prefix}:planned` && from === to) {
        const t = tasks[taskId];
        if (t?.planDate)
          run(
            reorderDay(
              t.planDate,
              ids.filter((id) => tasks[id]?.planDate === t.planDate),
            ),
          );
      }
    },
    [prefix, tasks],
  );
}

export function ProjectView({ id }: { id: string }) {
  const project = useData((s) => s.projects[id]);
  const areas = useData((s) => s.areas);
  const tasks = useData((s) => s.tasks);
  const mine = useMemo(
    () => Object.values(tasks).filter((t) => t.projectId === id && !t.archivedAt),
    [tasks, id],
  );
  const open = useMemo(() => mine.filter(isOpen), [mine]);
  const prefix = `project:${id}`;
  const containers = useProjectLikeContainers(open, prefix);
  const onMove = useProjectLikeMove(prefix);
  const [notes, setNotes] = useState(project?.notes ?? '');
  useEffect(() => setNotes(project?.notes ?? ''), [project?.notes]);
  if (!project) return <EmptyState title="Project not found" />;
  const doneCount = mine.length - open.length;

  return (
    <ListLayout
      containers={containers}
      onMove={onMove}
      header={
        <ViewHeader
          title={
            <span className="flex items-center gap-1">
              <ColorPicker
                value={project.color}
                onChange={(c) => run(updateProject(id, { color: c }))}
              />
              <EditableTitle
                value={project.name}
                onSave={(name) => run(updateProject(id, { name }))}
              />
            </span>
          }
          subtitle={`${open.length} open · ${doneCount} done${project.archivedAt ? ' · archived' : ''}`}
          calendarToggle
          right={
            <>
              <select
                aria-label="Area"
                value={project.areaId ?? ''}
                onChange={(e) => run(updateProject(id, { areaId: e.target.value || null }))}
                className="h-7 rounded-md border border-line bg-surface px-2 text-[12.5px] text-fg"
              >
                <option value="">No area</option>
                {Object.values(areas).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <DropdownMenu
                trigger={
                  <IconButton label="Project actions">
                    <MoreHorizontal size={16} />
                  </IconButton>
                }
                items={[
                  {
                    label: project.archivedAt ? 'Unarchive project' : 'Archive project',
                    icon: <Archive size={14} />,
                    onSelect: () => run(updateProject(id, { archived: !project.archivedAt })),
                  },
                  {
                    label: 'Delete project (keeps its tasks)',
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onSelect: () => {
                      ui.navigate({ name: 'backlog' });
                      run(deleteProject(id));
                    },
                  },
                ]}
              />
            </>
          }
        />
      }
    >
      <AutoTextarea
        aria-label="Project notes"
        placeholder="Project notes, goals, links…"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => notes !== project.notes && run(updateProject(id, { notes }))}
        minRows={1}
        className="border-transparent bg-transparent hover:border-line"
      />
      <AddTaskInline projectId={id} planDate={null} />
      <PlannedAndBacklog open={open} containerPrefix={prefix} />
      <CompletedGroup tasks={mine} />
    </ListLayout>
  );
}

export function AreaView({ id }: { id: string }) {
  const area = useData((s) => s.areas[id]);
  const projects = useData((s) => s.projects);
  const tasks = useData((s) => s.tasks);
  const mine = useMemo(
    () => Object.values(tasks).filter((t) => t.areaId === id && !t.projectId && !t.archivedAt),
    [tasks, id],
  );
  const open = useMemo(() => mine.filter(isOpen), [mine]);
  const prefix = `area:${id}`;
  const containers = useProjectLikeContainers(open, prefix);
  const onMove = useProjectLikeMove(prefix);
  if (!area) return <EmptyState title="Area not found" />;
  const areaProjects = Object.values(projects).filter((p) => p.areaId === id && !p.archivedAt);
  const openByProject = (pid: string) =>
    Object.values(tasks).filter((t) => t.projectId === pid && isOpen(t)).length;

  return (
    <ListLayout
      containers={containers}
      onMove={onMove}
      header={
        <ViewHeader
          title={
            <span className="flex items-center gap-1">
              <ColorPicker value={area.color} onChange={(c) => run(updateArea(id, { color: c }))} />
              <EditableTitle value={area.name} onSave={(name) => run(updateArea(id, { name }))} />
            </span>
          }
          calendarToggle
          right={
            <DropdownMenu
              trigger={
                <IconButton label="Area actions">
                  <MoreHorizontal size={16} />
                </IconButton>
              }
              items={[
                {
                  label: area.archivedAt ? 'Unarchive area' : 'Archive area',
                  icon: <Archive size={14} />,
                  onSelect: () => run(updateArea(id, { archived: !area.archivedAt })),
                },
                {
                  label: 'Delete area (keeps projects and tasks)',
                  icon: <Trash2 size={14} />,
                  danger: true,
                  onSelect: () => {
                    ui.navigate({ name: 'backlog' });
                    run(deleteArea(id));
                  },
                },
              ]}
            />
          }
        />
      }
    >
      {areaProjects.length > 0 && (
        <Group title="Projects" count={areaProjects.length}>
          <div className="grid grid-cols-2 gap-2">
            {areaProjects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => ui.navigate({ name: 'project', id: p.id })}
                className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-[13px] shadow-sm hover:border-line-strong"
              >
                <ColorDot color={p.color} />
                <span className="flex-1 truncate font-medium">{p.name}</span>
                <span className="text-[12px] text-subtle tabular">{openByProject(p.id)}</span>
              </button>
            ))}
          </div>
        </Group>
      )}
      <AddTaskInline areaId={id} planDate={null} />
      <PlannedAndBacklog open={open} containerPrefix={prefix} />
      <CompletedGroup tasks={mine} />
    </ListLayout>
  );
}

export function TagView({ id }: { id: string }) {
  const tag = useData((s) => s.tags[id]);
  const tasks = useData((s) => s.tasks);
  const mine = useMemo(
    () => Object.values(tasks).filter((t) => t.tagIds.includes(id) && !t.archivedAt),
    [tasks, id],
  );
  const open = useMemo(() => mine.filter(isOpen), [mine]);
  const prefix = `tag:${id}`;
  const containers = useProjectLikeContainers(open, prefix);
  const onMove = useProjectLikeMove(prefix);
  if (!tag) return <EmptyState title="Tag not found" />;
  return (
    <ListLayout
      containers={containers}
      onMove={onMove}
      header={
        <ViewHeader
          title={
            <span className="flex items-center gap-1">
              <ColorPicker value={tag.color} onChange={(c) => run(updateTag(id, { color: c }))} />@
              <EditableTitle value={tag.name} onSave={(name) => run(updateTag(id, { name }))} />
            </span>
          }
          calendarToggle
          right={
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              onClick={() => {
                ui.navigate({ name: 'backlog' });
                run(deleteTag(id));
              }}
            >
              <Trash2 size={14} /> Delete tag
            </Button>
          }
        />
      }
    >
      <PlannedAndBacklog open={open} containerPrefix={prefix} />
      <CompletedGroup tasks={mine} />
    </ListLayout>
  );
}

export function CompletedView() {
  const tasks = useData((s) => s.tasks);
  const zone = useData((s) => s.zone);
  const today = useData((s) => s.today);
  const closed = useClosedMinutes();
  const [limit, setLimit] = useState(200);
  const byDay = useMemo(() => {
    const done = Object.values(tasks)
      .filter((t) => t.completedAt)
      .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!));
    const groups = new Map<string, Task[]>();
    for (const t of done.slice(0, limit)) {
      const d = dateOfInstant(t.completedAt!, zone);
      groups.set(d, [...(groups.get(d) ?? []), t]);
    }
    return { groups: [...groups.entries()], total: done.length };
  }, [tasks, zone, limit]);

  return (
    <ListLayout
      containers={{}}
      onMove={() => undefined}
      header={
        <ViewHeader
          title="Completed"
          subtitle={`${byDay.total} task${byDay.total === 1 ? '' : 's'} done`}
        />
      }
    >
      {byDay.total === 0 && (
        <EmptyState icon={<CheckCircle2 size={28} />} title="Nothing completed yet">
          Finished tasks are kept here as a record of what you did, grouped by the day you completed
          them.
        </EmptyState>
      )}
      {byDay.groups.map(([date, list]) => (
        <Group
          key={date}
          title={`${relativeDateLabel(date, today)} · ${formatDateLong(date)}`}
          count={list.length}
        >
          <div className="flex flex-col gap-1.5">
            {list.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                trackedMin={closed.get(t.id) ?? 0}
                runningSince={null}
                blocks={[]}
              />
            ))}
          </div>
        </Group>
      ))}
      {byDay.total > limit && (
        <Button variant="secondary" className="self-center" onClick={() => setLimit(limit + 200)}>
          Show more
        </Button>
      )}
    </ListLayout>
  );
}
