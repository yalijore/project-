import { useEffect, useMemo, useState } from 'react';
import { Dialog as RDialog } from 'radix-ui';
import { Check, ChevronRight, Minimize2, Pause, Play } from 'lucide-react';
import { ui, useUi } from '@/app/ui';
import { run, setComplete, startTimer, stopTimer, updateSubtask, updateTask } from '@/data/actions';
import { isOpen, tasksOnDate, useClosedMinutes, useRunningSession } from '@/data/selectors';
import { useData } from '@/data/store';
import { formatDuration, formatElapsed } from '@/domain/dates';
import { AutoTextarea, Button, ColorDot, Kbd, cn } from '@/ui/primitives';
import { TaskCheckbox, useNow } from '../task/TaskCard';

function Ring({ pct, over }: { pct: number; over: boolean }) {
  const r = 120;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 280 280" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden>
      <circle cx="140" cy="140" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
      <circle
        cx="140"
        cy="140"
        r={r}
        fill="none"
        stroke={over ? 'var(--warn)' : 'var(--accent)'}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, pct))}
        className="transition-[stroke-dashoffset] duration-1000"
      />
    </svg>
  );
}

function FocusBody({ taskId }: { taskId: string }) {
  const task = useData((s) => s.tasks[taskId]);
  const tasks = useData((s) => s.tasks);
  const today = useData((s) => s.today);
  const projects = useData((s) => s.projects);
  const running = useRunningSession();
  const closed = useClosedMinutes();
  const isRunning = running?.taskId === taskId;
  const now = useNow(1000, isRunning);
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [justDone, setJustDone] = useState(false);
  useEffect(() => setNotes(task?.notes ?? ''), [task?.notes]);

  const upNext = useMemo(
    () => tasksOnDate(tasks, today).filter((t) => isOpen(t) && t.id !== taskId)[0] ?? null,
    [tasks, today, taskId],
  );

  if (!task) return null;
  const sessionMs = isRunning ? now - Date.parse(running.startUtc) : 0;
  const totalMin = (closed.get(taskId) ?? 0) + sessionMs / 60_000;
  const est = task.estimateMin;
  const over = !!est && totalMin > est;
  const project = task.projectId ? projects[task.projectId] : null;
  const done = !!task.completedAt;

  const saveNotes = () => {
    if (notes !== task.notes) run(updateTask(task.id, { notes }, 'Edit notes'));
  };

  const complete = () => {
    saveNotes();
    run(setComplete(task.id, true));
    setJustDone(true);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-6 py-4">
        <span className="flex items-center gap-2 text-[12.5px] text-muted">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              isRunning ? 'animate-soft-pulse bg-accent' : 'bg-line-strong',
            )}
          />
          {isRunning ? 'Focusing' : done ? 'Completed' : 'Paused'}
        </span>
        <Button variant="ghost" size="sm" onClick={() => ui.focus(null)}>
          <Minimize2 size={14} /> Exit focus <Kbd>Esc</Kbd>
        </Button>
      </div>

      <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 pb-10">
        <div className="flex w-full max-w-[560px] flex-col items-center">
          {project && (
            <span className="mb-2 flex items-center gap-1.5 text-[12.5px] text-muted">
              <ColorDot color={project.color} /> {project.name}
            </span>
          )}
          <RDialog.Title
            className={cn(
              'text-center text-[26px] leading-tight font-semibold tracking-tight',
              done && 'text-subtle line-through',
            )}
          >
            {task.title}
          </RDialog.Title>

          <div className="relative mt-8 flex h-[260px] w-[260px] items-center justify-center">
            <Ring pct={est ? totalMin / est : 0} over={over} />
            <div className="flex flex-col items-center">
              <span className="text-[44px] font-semibold tracking-tight tabular" aria-live="off">
                {formatElapsed(isRunning ? sessionMs : 0)}
              </span>
              <span className={cn('text-[13px] tabular', over ? 'text-warn' : 'text-muted')}>
                {formatDuration(totalMin)} {est ? `of ${formatDuration(est)}` : 'tracked'}
              </span>
            </div>
          </div>

          <div className="mt-8 flex items-center gap-3">
            {justDone || done ? (
              upNext ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    setJustDone(false);
                    run(startTimer(upNext.id).then(() => ui.focus(upNext.id)));
                  }}
                >
                  Up next: {upNext.title} <ChevronRight size={15} />
                </Button>
              ) : (
                <Button variant="primary" onClick={() => ui.focus(null)}>
                  All done for today — back to plan
                </Button>
              )
            ) : (
              <>
                {isRunning ? (
                  <Button
                    variant="secondary"
                    onClick={() => run(stopTimer())}
                    className="h-10 px-5"
                  >
                    <Pause size={16} /> Pause
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => run(startTimer(task.id))}
                    className="h-10 px-5"
                  >
                    <Play size={16} /> Resume
                  </Button>
                )}
                <Button variant="primary" onClick={complete} className="h-10 px-5">
                  <Check size={16} /> Complete
                </Button>
              </>
            )}
          </div>

          {task.subtasks.length > 0 && (
            <div className="mt-10 w-full">
              <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-subtle uppercase">
                Subtasks
              </h3>
              <div className="flex flex-col gap-1">
                {[...task.subtasks]
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((st) => (
                    <label
                      key={st.id}
                      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-sunken"
                    >
                      <TaskCheckbox
                        size={16}
                        done={!!st.completedAt}
                        label={st.title}
                        onToggle={() => run(updateSubtask(st.id, { done: !st.completedAt }))}
                      />
                      <span
                        className={cn('text-[14px]', st.completedAt && 'text-subtle line-through')}
                      >
                        {st.title}
                      </span>
                    </label>
                  ))}
              </div>
            </div>
          )}

          <div className="mt-8 w-full">
            <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-subtle uppercase">
              Notes
            </h3>
            <AutoTextarea
              aria-label="Notes"
              placeholder="Capture thoughts, blockers, links…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={saveNotes}
              minRows={4}
            />
          </div>

          {upNext && !justDone && !done && (
            <p className="mt-6 text-[12.5px] text-subtle">
              Up next: <span className="text-muted">{upNext.title}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function FocusOverlay() {
  const taskId = useUi((s) => s.focusTaskId);
  return (
    <RDialog.Root open={!!taskId} onOpenChange={(o) => !o && ui.focus(null)}>
      <RDialog.Portal>
        <RDialog.Content
          aria-describedby={undefined}
          className="animate-fade-in fixed inset-0 z-50 bg-bg outline-none"
        >
          {taskId && <FocusBody taskId={taskId} />}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
