import {
  ArrowRight,
  CalendarClock,
  CalendarX,
  Check,
  Copy,
  Flag,
  FolderOpen,
  Hourglass,
  Layers,
  Maximize2,
  Play,
  RotateCcw,
  Sun,
  Trash2,
} from 'lucide-react';
import { useUi, ui } from '@/app/ui';
import {
  addTask,
  deleteBlock,
  deleteTasks,
  moveTask,
  run,
  setComplete,
  startTimer,
  updateTask,
} from '@/data/actions';
import { getData } from '@/data/store';
import { addDays, formatDuration, startOfWeek } from '@/domain/dates';
import type { Priority, Task } from '@/domain/types';
import { PRIORITY_LABELS } from '@/domain/types';
import type { MenuItemSpec } from '@/ui/menu';
import { ESTIMATE_PRESETS } from '@/ui/pickers';
import { autoSchedule } from '../calendar/autoSchedule';

export function startFocus(taskId: string) {
  // Focus mode replaces whatever dialog the task was opened from.
  ui.openTask(null);
  // Open Focus mode at once; it shows the timer as running as soon as the start is saved.
  ui.focus(taskId);
  run(startTimer(taskId));
}

export function taskMenuItems(task: Task): MenuItemSpec[] {
  const { today, settings, projects, areas, blocks } = getData();
  const tomorrow = addDays(today, 1);
  const nextWeek = addDays(startOfWeek(today, settings.weekStartsOn), 7);
  const done = !!task.completedAt;
  const taskBlocks = Object.values(blocks).filter(
    (b) => b.taskId === task.id && Date.parse(b.endUtc) > Date.now(),
  );
  const planOn = task.planDate ?? today;
  const projectItems: MenuItemSpec[] = [
    {
      kind: 'check',
      label: 'No project',
      checked: !task.projectId,
      onSelect: () => run(updateTask(task.id, { projectId: null }, 'Change project')),
    },
    ...Object.values(projects)
      .filter((p) => !p.archivedAt)
      .map<MenuItemSpec>((p) => ({
        kind: 'check',
        label: p.name,
        checked: task.projectId === p.id,
        onSelect: () => run(updateTask(task.id, { projectId: p.id }, 'Change project')),
      })),
  ];
  const areaItems: MenuItemSpec[] = Object.values(areas)
    .filter((a) => !a.archivedAt)
    .map((a) => ({
      kind: 'check',
      label: a.name,
      checked: task.areaId === a.id && !task.projectId,
      onSelect: () => run(updateTask(task.id, { areaId: a.id, projectId: null }, 'Change area')),
    }));

  return [
    {
      label: 'Open',
      icon: <Maximize2 size={14} />,
      shortcut: 'Enter',
      onSelect: () => ui.openTask(task.id),
    },
    !done && {
      label: 'Start timer & focus',
      icon: <Play size={14} />,
      shortcut: 'F',
      onSelect: () => startFocus(task.id),
    },
    {
      label: done ? 'Mark incomplete' : 'Complete',
      icon: done ? <RotateCcw size={14} /> : <Check size={14} />,
      shortcut: 'Space',
      onSelect: () => run(setComplete(task.id, !done)),
    },
    { kind: 'separator' },
    {
      kind: 'sub',
      label: 'Move to',
      icon: <ArrowRight size={14} />,
      items: [
        {
          label: 'Today',
          icon: <Sun size={14} />,
          shortcut: 'T',
          disabled: task.planDate === today,
          onSelect: () => run(moveTask(task.id, today)),
        },
        {
          label: 'Tomorrow',
          shortcut: 'M',
          disabled: task.planDate === tomorrow,
          onSelect: () => run(moveTask(task.id, tomorrow)),
        },
        { label: 'Next week', onSelect: () => run(moveTask(task.id, nextWeek)) },
        { label: 'Pick a date…', onSelect: () => useUi.setState({ openTaskId: task.id }) },
        { kind: 'separator' },
        {
          label: 'Backlog',
          icon: <Layers size={14} />,
          shortcut: 'B',
          disabled: !task.planDate,
          onSelect: () => run(moveTask(task.id, null)),
        },
      ],
    },
    !done && {
      label: 'Timebox in next free slot',
      icon: <CalendarClock size={14} />,
      shortcut: 'S',
      onSelect: () => run(autoSchedule([task.id], planOn < today ? today : planOn)),
    },
    taskBlocks.length > 0 && {
      label: taskBlocks.length === 1 ? 'Remove time block' : 'Remove time blocks',
      icon: <CalendarX size={14} />,
      onSelect: () => taskBlocks.forEach((b) => run(deleteBlock(b.id))),
    },
    {
      kind: 'sub',
      label: 'Estimate',
      icon: <Hourglass size={14} />,
      items: [
        ...ESTIMATE_PRESETS.map<MenuItemSpec>((m) => ({
          kind: 'check',
          label: formatDuration(m),
          checked: task.estimateMin === m,
          onSelect: () => run(updateTask(task.id, { estimateMin: m }, 'Set estimate')),
        })),
        { kind: 'separator' },
        {
          label: 'Clear estimate',
          onSelect: () => run(updateTask(task.id, { estimateMin: null }, 'Clear estimate')),
        },
      ],
    },
    {
      kind: 'sub',
      label: 'Priority',
      icon: <Flag size={14} />,
      items: ([3, 2, 1, 0] as Priority[]).map((p) => ({
        kind: 'check',
        label: PRIORITY_LABELS[p],
        shortcut: String(p),
        checked: task.priority === p,
        onSelect: () => run(updateTask(task.id, { priority: p }, 'Change priority')),
      })),
    },
    {
      kind: 'sub',
      label: 'Project / area',
      icon: <FolderOpen size={14} />,
      items: [
        ...projectItems,
        ...(areaItems.length
          ? [
              { kind: 'separator' } as MenuItemSpec,
              { kind: 'label', label: 'Areas' } as MenuItemSpec,
              ...areaItems,
            ]
          : []),
      ],
    },
    {
      label: 'Duplicate',
      icon: <Copy size={14} />,
      onSelect: () =>
        run(
          addTask({
            title: task.title,
            notes: task.notes,
            projectId: task.projectId,
            areaId: task.areaId,
            priority: task.priority,
            estimateMin: task.estimateMin,
            dueDate: task.dueDate,
            planDate: task.planDate,
            tagIds: task.tagIds,
            subtasks: task.subtasks.map((s) => s.title),
            links: task.links.map((l) => ({ url: l.url, title: l.title })),
          }),
        ),
    },
    { kind: 'separator' },
    {
      label: 'Delete',
      icon: <Trash2 size={14} />,
      danger: true,
      shortcut: 'Del',
      onSelect: () => run(deleteTasks([task.id])),
    },
  ].filter(Boolean) as MenuItemSpec[];
}
