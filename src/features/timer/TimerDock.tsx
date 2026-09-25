import { Maximize2, Pause } from 'lucide-react';
import { ui } from '@/app/ui';
import { run, stopTimer } from '@/data/actions';
import { useClosedMinutes, useRunningSession } from '@/data/selectors';
import { useData } from '@/data/store';
import { formatElapsed } from '@/domain/dates';
import { IconButton, cn } from '@/ui/primitives';
import { useNow } from '../task/TaskCard';

/** "Now working on" card at the bottom of the sidebar while a timer runs. */
export function TimerDock() {
  const running = useRunningSession();
  const tasks = useData((s) => s.tasks);
  const closed = useClosedMinutes();
  const now = useNow(1000, !!running);
  if (!running) return null;
  const task = tasks[running.taskId];
  if (!task) return null;
  // Actual time on the task (every session), as in Focus mode and the focus bar.
  const actualMs = (closed.get(task.id) ?? 0) * 60_000 + (now - Date.parse(running.startUtc));
  const plannedMs = task.estimateMin ? task.estimateMin * 60_000 : 0;
  const over = plannedMs > 0 && actualMs > plannedMs;
  const pct = plannedMs ? Math.min(100, (actualMs / plannedMs) * 100) : 0;

  return (
    <div
      className="mx-2 mb-2 rounded-xl border border-accent/30 bg-surface p-2.5 shadow-sm"
      role="status"
      aria-label="Running timer"
    >
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 animate-soft-pulse rounded-full bg-accent" />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium hover:underline"
          onClick={() => ui.openTask(task.id)}
        >
          {task.title}
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <span className={cn('text-[18px] font-semibold tabular', over && 'text-warn')}>
          {formatElapsed(actualMs)}
        </span>
        {plannedMs > 0 && (
          <span className="ml-0.5 text-[11.5px] text-subtle tabular">
            / {formatElapsed(plannedMs)}
          </span>
        )}
        <div className="ml-auto flex">
          <IconButton label="Focus mode" size="xs" onClick={() => ui.focus(task.id)}>
            <Maximize2 size={13} />
          </IconButton>
          <IconButton label="Pause timer" size="xs" onClick={() => run(stopTimer())}>
            <Pause size={13} />
          </IconButton>
        </div>
      </div>
      {task.estimateMin ? (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line/70">
          <div
            className={cn('h-full', over ? 'bg-warn' : 'bg-accent')}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
