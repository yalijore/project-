/**
 * The floating focus bar window. It is a remote control and display only: state arrives from
 * the main window as snapshots, and every button sends a command back. The one-second tick
 * here only redraws elapsed time from the session's start instant; nothing is counted or
 * stored in this window.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { Check, EyeOff, GripVertical, Pause, Play } from 'lucide-react';
import { formatDuration, formatElapsed, formatTime } from '@/domain/dates';
import type { BarAction, BarState } from './protocol';
import { COMMAND_EVENT, STATE_EVENT, elapsedMs } from './protocol';

// Kept local so this window's bundle stays small (no UI kit, no data layer).
function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

function commandId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function BarButton({
  label,
  onClick,
  disabled,
  children,
  primary,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-40',
        primary
          ? 'bg-accent text-accent-fg hover:bg-accent-hover'
          : 'text-muted hover:bg-sunken hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 shrink-0 rounded-md border border-line px-2 text-[12px] font-medium text-fg hover:bg-sunken focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

function planLabel(state: BarState, elapsed: number, now: number): string {
  const task = state.task;
  if (!task) return '';
  if (task.estimateMin) {
    const left = task.estimateMin - elapsed / 60_000;
    if (left >= 0.5) return `${formatDuration(left)} left of ${formatDuration(task.estimateMin)}`;
    if (left > -0.5) return `${formatDuration(task.estimateMin)} planned · time’s up`;
    return `${formatDuration(-left)} over ${formatDuration(task.estimateMin)}`;
  }
  if (state.blockEndUtc && Date.parse(state.blockEndUtc) > now)
    return `until ${formatTime(state.blockEndUtc, state.zone, state.hour12)}`;
  return 'no estimate';
}

export function FocusBar() {
  const [state, setState] = useState<BarState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<BarAction | null>(null);
  const [announce, setAnnounce] = useState('');
  const last = useRef<BarState | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<BarState>(STATE_EVENT, (e) => {
      const next = e.payload;
      if (last.current && next.seq <= last.current.seq) return;
      const prev = last.current;
      last.current = next;
      setState(next);
      setPending(null);
      if (prev?.task?.id !== next.task?.id) setAnnounce(next.task ? `Now: ${next.task.title}` : '');
      else if (prev?.running !== next.running)
        setAnnounce(next.running ? 'Timer running' : 'Timer paused');
    }).then((u) => {
      if (cancelled) u();
      else {
        unlisten = u;
        send('ready');
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (state?.theme) document.documentElement.dataset.theme = state.theme;
  }, [state?.theme]);

  useEffect(() => {
    if (!state?.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => clearInterval(t);
  }, [state?.running]);

  // If the main window never answers a click, allow trying again.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), 5000);
    return () => clearTimeout(t);
  }, [pending]);

  function send(action: BarAction) {
    if (action !== 'ready' && action !== 'openMain') setPending(action);
    void emitTo('main', COMMAND_EVENT, {
      id: commandId(),
      action,
      taskId: last.current?.task?.id ?? null,
    }).catch(() => setPending(null));
  }

  // Pressing anywhere on the bar except a control moves it (the window has no title bar).
  const onMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    e.preventDefault();
    void invoke('focusbar_start_drag').catch(() => undefined);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      send('hide');
    }
  };

  const task = state?.task ?? null;
  const elapsed = state ? elapsedMs(state, now) : 0;
  const pct = task?.estimateMin ? Math.min(1, elapsed / 60_000 / task.estimateMin) : 0;
  const over = !!task?.estimateMin && elapsed / 60_000 > task.estimateMin;

  let body: ReactNode;
  if (!state) {
    body = <span className="flex-1 text-[12.5px] text-muted">Connecting to Keel…</span>;
  } else if (!task) {
    body = (
      <>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
          {state.allDone ? 'All planned tasks are done' : 'No task in focus'}
        </span>
        <TextButton onClick={() => send('openMain')}>Open Keel</TextButton>
      </>
    );
  } else {
    body = (
      <>
        <span
          aria-hidden
          className={cn(
            'h-2.5 w-2.5 shrink-0 rounded-full',
            task.done ? 'bg-ok' : state.running ? 'animate-soft-pulse bg-accent' : 'bg-line-strong',
          )}
          style={
            !state.running && !task.done && task.color ? { background: task.color } : undefined
          }
        />
        <button
          type="button"
          onClick={() => send('openMain')}
          title="Open Keel"
          aria-label={`${task.title} — open Keel`}
          className={cn(
            'min-w-0 flex-1 truncate rounded px-1 text-left text-[13.5px] font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-accent',
            task.done && 'text-subtle line-through',
          )}
        >
          {task.title}
        </button>
        {state.gapMinutes !== null ? (
          <div
            className="flex shrink-0 items-center gap-1.5 text-[12px]"
            role="group"
            aria-label="Unattended time"
          >
            <span className="text-fg">Away {formatDuration(state.gapMinutes)} — count it?</span>
            <TextButton onClick={() => send('keepGap')}>Keep</TextButton>
            <TextButton onClick={() => send('discardGap')}>Discard</TextButton>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 flex-col items-end leading-tight">
              <span
                className={cn('text-[16px] font-semibold tabular', over ? 'text-warn' : 'text-fg')}
                aria-label={`Elapsed ${formatElapsed(elapsed)}`}
              >
                {formatElapsed(elapsed)}
              </span>
              <span className="text-[11px] text-muted tabular">
                {planLabel(state, elapsed, now)}
              </span>
            </div>
            <BarButton
              primary
              label={state.running ? 'Pause timer' : elapsed > 0 ? 'Resume timer' : 'Start timer'}
              disabled={task.done || pending === 'toggle'}
              onClick={() => send('toggle')}
            >
              {state.running ? <Pause size={15} /> : <Play size={15} />}
            </BarButton>
            <BarButton
              label="Complete task"
              disabled={task.done || pending === 'complete'}
              onClick={() => send('complete')}
            >
              <Check size={16} />
            </BarButton>
          </>
        )}
      </>
    );
  }

  return (
    <div
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      role="toolbar"
      aria-label="Keel focus bar"
      className="relative flex h-[52px] w-screen items-center gap-2 overflow-hidden border border-line bg-surface pr-1.5 pl-1 text-fg select-none"
    >
      <span aria-hidden className="h-full w-1 shrink-0 bg-accent" />
      {/* Tauri drags only when the pressed element itself carries the attribute, so the icon
          lets presses through to its wrapper. */}
      <span
        data-grip
        aria-hidden
        className="flex h-full w-5 shrink-0 cursor-grab items-center justify-center text-subtle"
      >
        <GripVertical size={14} className="pointer-events-none" />
      </span>
      {body}
      <BarButton label="Hide focus bar (the timer keeps running)" onClick={() => send('hide')}>
        <EyeOff size={15} />
      </BarButton>
      {task?.estimateMin ? (
        <span
          aria-hidden
          className={cn('absolute bottom-0 left-0 h-[2px]', over ? 'bg-warn' : 'bg-accent')}
          style={{ width: `${pct * 100}%` }}
        />
      ) : null}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
