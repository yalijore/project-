import { Maximize2, Pause } from 'lucide-react';
import { ui } from '@/app/ui';
import { run, stopTimer } from '@/data/actions';
import { useClosedMinutes, useRunningSession } from '@/data/selectors';
import { useData } from '@/data/store';
import { formatDuration, formatElapsed } from '@/domain/dates';
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
  const sessionMs = now - Date.parse(running.startUtc);
  const totalMin = (closed.get(task.id) ?? 0) + sessionMs / 60_000;
  const over = task.estimateMin ? totalMin > task.estimateMin : false;
  const pct = task.estimateMin ? Math.min(100, (totalMin / task.estimateMin) * 100) : 0;

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
        <span className="text-[18px] font-semibold tabular">{formatElapsed(sessionMs)}</span>
        <span className={cn('ml-1 text-[11px] tabular', over ? 'text-warn' : 'text-subtle')}>
          {formatDuration(totalMin)}
          {task.estimateMin ? ` / ${formatDuration(task.estimateMin)}` : ''}
        </span>
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
