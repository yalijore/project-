import { useState } from 'react';
import { Plus } from 'lucide-react';
import { captureTask, run } from '@/data/actions';
import type { ISODate } from '@/domain/dates';
import { cn } from '@/ui/primitives';
import { CaptureChips, useCaptureParse } from './CaptureChips';

/** "+ Add task" row that expands into a quick-capture field for a specific list. */
export function AddTaskInline({
  planDate,
  projectId,
  areaId,
  label = 'Add task',
  className,
}: {
  planDate?: ISODate | null;
  projectId?: string | null;
  areaId?: string | null;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const parsed = useCaptureParse(text, disabled);

  const reset = () => {
    setText('');
    setDisabled(new Set());
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] text-subtle transition-colors hover:bg-surface hover:text-fg',
          className,
        )}
      >
        <Plus size={15} /> {label}
      </button>
    );
  }

  return (
    <form
      className={cn(
        'rounded-[var(--radius)] border border-accent/50 bg-surface p-2 shadow-md ring-3 ring-accent/10',
        className,
      )}
      onSubmit={(e) => {
        e.preventDefault();
        if (!parsed.title) return;
        run(captureTask(parsed, { planDate, projectId, areaId }));
        reset();
      }}
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            reset();
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!text.trim()) setOpen(false);
        }}
        placeholder="Task name — try “30m”, “#project”, “due fri”"
        aria-label="New task"
        className="w-full bg-transparent px-1 text-[13.5px] text-fg outline-none placeholder:text-subtle"
      />
      <CaptureChips
        parsed={parsed}
        onDisable={(k) => setDisabled(new Set([...disabled, k]))}
        className="mt-1.5"
      />
      <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-subtle">
        <span>Enter to add · Esc to close</span>
      </div>
    </form>
  );
}
