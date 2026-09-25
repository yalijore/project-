import { useEffect, useMemo, useState } from 'react';
import { Dialog as RDialog } from 'radix-ui';
import { Check, ChevronRight, Minimize2, Pause, Play, Plus } from 'lucide-react';
import { ui, useUi } from '@/app/ui';
import {
  addSubtask,
  run,
  setComplete,
  startTimer,
  stopTimer,
  updateSubtask,
  updateTask,
} from '@/data/actions';
import { isOpen, tasksOnDate, useClosedMinutes, useRunningSession } from '@/data/selectors';
import { useData } from '@/data/store';
import { formatElapsed } from '@/domain/dates';
import { EstimatePanel } from '@/ui/pickers';
import { AutoTextarea, Button, ColorDot, Kbd, Popover, cn } from '@/ui/primitives';
import { TaskCheckbox, useNow } from '../task/TaskCard';

const sectionLabel = 'mb-2 text-[11px] font-semibold tracking-wide text-subtle uppercase';

/**
 * Focus mode: one task, its actual time against the time planned for it, and the task's
 * subtasks and notes. "Actual" is everything tracked on the task (all sessions), so pausing
 * and resuming continues the count rather than starting over.
 */
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
  const [planOpen, setPlanOpen] = useState(false);
  const [newSubtask, setNewSubtask] = useState('');
  useEffect(() => setNotes(task?.notes ?? ''), [task?.notes]);

  const upNext = useMemo(
    () => tasksOnDate(tasks, today).filter((t) => isOpen(t) && t.id !== taskId)[0] ?? null,
    [tasks, today, taskId],
  );

  if (!task) return null;
  const actualMs =
    (closed.get(taskId) ?? 0) * 60_000 + (isRunning ? now - Date.parse(running.startUtc) : 0);
  const plannedMs = task.estimateMin ? task.estimateMin * 60_000 : 0;
  const over = plannedMs > 0 && actualMs > plannedMs;
  const project = task.projectId ? projects[task.projectId] : null;
  const done = !!task.completedAt;
  const status = isRunning ? 'Focusing' : done ? 'Completed' : actualMs > 0 ? 'Paused' : 'Ready';

  const saveNotes = () => {
    if (notes !== task.notes) run(updateTask(task.id, { notes }, 'Edit notes'));
  };
  const complete = () => {
    saveNotes();
    run(setComplete(task.id, true));
    setJustDone(true);
  };
  const toggleTimer = () => run(isRunning ? stopTimer() : startTimer(task.id));
  const addNewSubtask = () => {
    const title = newSubtask.trim();
    if (!title) return;
    setNewSubtask('');
    run(addSubtask(task.id, title));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-6 py-4">
        <span className="flex items-center gap-2 text-[12.5px] text-muted" aria-live="polite">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              isRunning ? 'animate-soft-pulse bg-accent' : 'bg-line-strong',
            )}
          />
          {status}
        </span>
        <Button variant="ghost" size="sm" onClick={() => ui.focus(null)}>
          <Minimize2 size={14} /> Exit focus <Kbd>Esc</Kbd>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-10">
        <div className="mx-auto flex w-full max-w-[620px] flex-col pt-4">
          {project && (
            <span className="mb-2 flex items-center gap-1.5 text-[12.5px] text-muted">
              <ColorDot color={project.color} /> {project.name}
            </span>
          )}
          <RDialog.Title
            className={cn(
              'text-[28px] leading-tight font-semibold tracking-tight',
              done && 'text-subtle line-through',
            )}
          >
            {task.title}
          </RDialog.Title>

          <section
            aria-label="Time"
            className="mt-7 flex items-center gap-6 rounded-2xl border border-line bg-surface px-6 py-5"
          >
            <div className="flex flex-col">
              <span className={sectionLabel}>Actual</span>
              <span
                className={cn(
                  'text-[40px] leading-none font-semibold tracking-tight tabular',
                  over && 'text-warn',
                )}
                aria-label={`Actual time ${formatElapsed(actualMs)}`}
              >
                {formatElapsed(actualMs)}
              </span>
            </div>
            <span aria-hidden className="h-12 w-px bg-line" />
            <div className="flex flex-col">
              <span className={sectionLabel}>Planned</span>
              <Popover
                open={planOpen}
                onOpenChange={setPlanOpen}
                trigger={
                  <button
                    type="button"
                    aria-label={`Planned time ${plannedMs ? formatElapsed(plannedMs) : 'not set'} — change`}
                    className="rounded-md text-left text-[24px] leading-none font-medium text-muted tabular hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    {plannedMs ? formatElapsed(plannedMs) : '—:—'}
                  </button>
                }
              >
                <EstimatePanel
                  value={task.estimateMin}
                  onChange={(m) => {
                    setPlanOpen(false);
                    run(updateTask(task.id, { estimateMin: m }, 'Set estimate'));
                  }}
                />
              </Popover>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {!done && !justDone && (
                <>
                  <button
                    type="button"
                    onClick={toggleTimer}
                    aria-label={
                      isRunning ? 'Pause timer' : actualMs > 0 ? 'Resume timer' : 'Start timer'
                    }
                    title={isRunning ? 'Pause' : 'Start'}
                    className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-fg shadow-sm transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {isRunning ? (
                      <Pause size={22} />
                    ) : (
                      <Play size={22} className="translate-x-px" />
                    )}
                  </button>
                  <Button variant="secondary" onClick={complete} className="h-10 px-4">
                    <Check size={16} /> Complete
                  </Button>
                </>
              )}
            </div>
          </section>
          <div
            aria-hidden
            className="mx-6 mt-2 h-1 overflow-hidden rounded-full bg-line/70"
            title={plannedMs ? undefined : 'Set a planned time to see progress'}
          >
            {plannedMs > 0 && (
              <div
                className={cn(
                  'h-full transition-[width] duration-1000',
                  over ? 'bg-warn' : 'bg-accent',
                )}
                style={{ width: `${Math.min(100, (actualMs / plannedMs) * 100)}%` }}
              />
            )}
          </div>
          <p className="mx-6 mt-1.5 text-[12px] text-subtle tabular">
            {!plannedMs
              ? 'No planned time — click Planned to set one.'
              : over
                ? `${formatElapsed(actualMs - plannedMs)} over plan`
                : `${formatElapsed(plannedMs - actualMs)} left`}
          </p>

          <section className="mt-9" aria-label="Subtasks">
            <h3 className={sectionLabel}>Subtasks</h3>
            <div className="flex flex-col gap-0.5">
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
              <div className="flex items-center gap-2.5 rounded-lg px-2 py-1">
                <Plus size={16} className="text-subtle" aria-hidden />
                <input
                  aria-label="Add a subtask"
                  placeholder="Add a subtask"
                  value={newSubtask}
                  onChange={(e) => setNewSubtask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addNewSubtask();
                    }
                  }}
                  onBlur={addNewSubtask}
                  className="min-w-0 flex-1 bg-transparent py-0.5 text-[14px] outline-none placeholder:text-subtle"
                />
              </div>
            </div>
          </section>

          <section className="mt-8" aria-label="Notes">
            <h3 className={sectionLabel}>Notes</h3>
            <AutoTextarea
              aria-label="Notes"
              placeholder="Capture thoughts, blockers, links…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={saveNotes}
              minRows={4}
            />
          </section>
        </div>
      </div>

      <div className="border-t border-line bg-surface/60 px-6 py-3">
        <div className="mx-auto flex w-full max-w-[620px] items-center gap-3">
          {justDone || done ? (
            upNext ? (
              <>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
                  Done. Up next: <span className="text-fg">{upNext.title}</span>
                </span>
                <Button
                  variant="primary"
                  onClick={() => {
                    setJustDone(false);
                    ui.focus(upNext.id);
                    run(startTimer(upNext.id));
                  }}
                >
                  Start next <ChevronRight size={15} />
                </Button>
              </>
            ) : (
              <>
                <span className="flex-1 text-[13px] text-muted">
                  Everything planned for today is done.
                </span>
                <Button variant="primary" onClick={() => ui.focus(null)}>
                  All done for today — back to plan
                </Button>
              </>
            )
          ) : upNext ? (
            <>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-subtle">
                Up next: <span className="text-muted">{upNext.title}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  ui.focus(upNext.id);
                  run(startTimer(upNext.id));
                }}
              >
                Switch to it <ChevronRight size={14} />
              </Button>
            </>
          ) : (
            <span className="text-[12.5px] text-subtle">
              This is the last open task planned for today.
            </span>
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
