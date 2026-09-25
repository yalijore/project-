import { CalendarDays, Check, Flag, FolderOpen, Hourglass, Tag, Trash2, X } from 'lucide-react';
import { ui, useUi } from '@/app/ui';
import { bulkComplete, bulkUpdate, deleteTasks, moveTasks, run, tagTasks } from '@/data/actions';
import { useData } from '@/data/store';
import { addDays, formatDuration } from '@/domain/dates';
import type { Priority } from '@/domain/types';
import { PRIORITY_LABELS } from '@/domain/types';
import { DropdownMenu } from '@/ui/menu';
import { ESTIMATE_PRESETS } from '@/ui/pickers';
import { Button, IconButton } from '@/ui/primitives';

/** Appears while tasks are multi-selected (Ctrl+Click). Every action is one undo step. */
export function BulkBar() {
  const selection = useUi((s) => s.selection);
  const tasks = useData((s) => s.tasks);
  const projects = useData((s) => s.projects);
  const areas = useData((s) => s.areas);
  const tags = useData((s) => s.tags);
  const today = useData((s) => s.today);
  const ids = selection.filter((id) => tasks[id]);
  if (ids.length === 0) return null;
  const allDone = ids.every((id) => tasks[id]?.completedAt);
  const clear = () => ui.select([]);
  const act = (p: Promise<unknown>) => run(p.then(clear));

  return (
    <div
      role="toolbar"
      aria-label={`${ids.length} tasks selected`}
      className="animate-pop-in fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-line bg-surface px-2 py-1.5 shadow-lg"
    >
      <span className="px-2 text-[12.5px] font-medium tabular">{ids.length} selected</span>
      <Button size="sm" variant="ghost" onClick={() => act(bulkComplete(ids, !allDone))}>
        <Check size={14} /> {allDone ? 'Reopen' : 'Complete'}
      </Button>
      <DropdownMenu
        align="center"
        trigger={
          <Button size="sm" variant="ghost">
            <CalendarDays size={14} /> Move
          </Button>
        }
        items={[
          { label: 'Today', onSelect: () => act(moveTasks(ids, today)) },
          { label: 'Tomorrow', onSelect: () => act(moveTasks(ids, addDays(today, 1))) },
          { label: 'In a week', onSelect: () => act(moveTasks(ids, addDays(today, 7))) },
          { kind: 'separator' },
          { label: 'Backlog', onSelect: () => act(moveTasks(ids, null)) },
        ]}
      />
      <DropdownMenu
        align="center"
        trigger={
          <Button size="sm" variant="ghost">
            <FolderOpen size={14} /> Project
          </Button>
        }
        items={[
          {
            label: 'No project or area',
            onSelect: () =>
              act(bulkUpdate(ids, { projectId: null, areaId: null }, 'Clear project')),
          },
          ...Object.values(projects)
            .filter((p) => !p.archivedAt)
            .map((p) => ({
              label: p.name,
              onSelect: () => act(bulkUpdate(ids, { projectId: p.id }, 'Change project')),
            })),
          ...(Object.keys(areas).length ? [{ kind: 'label' as const, label: 'Areas' }] : []),
          ...Object.values(areas)
            .filter((a) => !a.archivedAt)
            .map((a) => ({
              label: a.name,
              onSelect: () =>
                act(bulkUpdate(ids, { areaId: a.id, projectId: null }, 'Change area')),
            })),
        ]}
      />
      <DropdownMenu
        align="center"
        trigger={
          <Button size="sm" variant="ghost">
            <Flag size={14} /> Priority
          </Button>
        }
        items={([3, 2, 1, 0] as Priority[]).map((p) => ({
          label: PRIORITY_LABELS[p],
          onSelect: () => act(bulkUpdate(ids, { priority: p }, 'Change priority')),
        }))}
      />
      <DropdownMenu
        align="center"
        trigger={
          <Button size="sm" variant="ghost">
            <Hourglass size={14} /> Estimate
          </Button>
        }
        items={[
          ...ESTIMATE_PRESETS.map((m) => ({
            label: formatDuration(m),
            onSelect: () => act(bulkUpdate(ids, { estimateMin: m }, 'Set estimate')),
          })),
          { kind: 'separator' as const },
          {
            label: 'Clear estimate',
            onSelect: () => act(bulkUpdate(ids, { estimateMin: null }, 'Clear estimate')),
          },
        ]}
      />
      {Object.keys(tags).length > 0 && (
        <DropdownMenu
          align="center"
          trigger={
            <Button size="sm" variant="ghost">
              <Tag size={14} /> Tag
            </Button>
          }
          items={Object.values(tags).map((t) => {
            const all = ids.every((id) => tasks[id]?.tagIds.includes(t.id));
            return {
              kind: 'check' as const,
              checked: all,
              label: `@${t.name}`,
              onSelect: () => run(tagTasks(ids, t.id, !all)),
            };
          })}
        />
      )}
      <Button
        size="sm"
        variant="ghost"
        className="text-danger hover:bg-danger-soft hover:text-danger"
        onClick={() => act(deleteTasks(ids))}
      >
        <Trash2 size={14} /> Delete
      </Button>
      <IconButton label="Clear selection (Esc)" onClick={clear}>
        <X size={15} />
      </IconButton>
    </div>
  );
}
