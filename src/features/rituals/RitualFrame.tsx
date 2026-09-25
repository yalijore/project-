import type { ReactNode } from 'react';
import { Dialog as RDialog } from 'radix-ui';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { Button, IconButton, cn } from '@/ui/primitives';

export interface Step {
  id: string;
  title: string;
  hint?: string;
  content: ReactNode;
  /** Wider layout for steps with side-by-side panes. */
  wide?: boolean;
}

/** Full-screen, step-by-step guided flow used by the planning and shutdown rituals. */
export function RitualFrame({
  title,
  steps,
  index,
  onIndex,
  onClose,
  onFinish,
  finishLabel,
  icon,
}: {
  title: string;
  steps: Step[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onFinish: () => void;
  finishLabel: string;
  icon: ReactNode;
}) {
  const step = steps[index]!;
  const last = index === steps.length - 1;
  return (
    <RDialog.Root open onOpenChange={(o) => !o && onClose()}>
      <RDialog.Portal>
        <RDialog.Content
          aria-describedby={undefined}
          className="animate-fade-in fixed inset-0 z-40 flex flex-col bg-bg outline-none"
        >
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
            <span className="text-accent-text">{icon}</span>
            <RDialog.Title className="text-[14px] font-semibold">{title}</RDialog.Title>
            <nav aria-label="Steps" className="ml-6 hidden items-center gap-1 md:flex">
              {steps.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onIndex(i)}
                  aria-current={i === index ? 'step' : undefined}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors',
                    i === index
                      ? 'bg-accent-soft font-medium text-accent-text'
                      : i < index
                        ? 'text-muted hover:bg-sunken'
                        : 'text-subtle hover:bg-sunken',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded-full text-[10px] tabular',
                      i <= index ? 'bg-accent text-accent-fg' : 'bg-line text-muted',
                    )}
                  >
                    {i + 1}
                  </span>
                  {s.title}
                </button>
              ))}
            </nav>
            <IconButton label="Close (progress is kept)" className="ml-auto" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto">
            <div
              className={cn(
                'mx-auto flex h-full flex-col px-6 py-8',
                step.wide ? 'max-w-[1180px]' : 'max-w-[720px]',
              )}
            >
              <div className="mb-6">
                <p className="text-[12px] font-medium tracking-wide text-subtle uppercase">
                  Step {index + 1} of {steps.length}
                </p>
                <h2 className="mt-1 text-[24px] font-semibold tracking-tight">{step.title}</h2>
                {step.hint && (
                  <p className="mt-1 max-w-[560px] text-[13.5px] text-muted">{step.hint}</p>
                )}
              </div>
              <div className="min-h-0 flex-1">{step.content}</div>
            </div>
          </main>

          <footer className="flex h-16 shrink-0 items-center gap-2 border-t border-line bg-surface px-6">
            <Button variant="ghost" onClick={() => onIndex(index - 1)} disabled={index === 0}>
              <ArrowLeft size={15} /> Back
            </Button>
            <div className="ml-auto flex gap-2">
              {!last && (
                <Button variant="primary" onClick={() => onIndex(index + 1)}>
                  Continue <ArrowRight size={15} />
                </Button>
              )}
              {last && (
                <Button variant="primary" onClick={onFinish}>
                  {finishLabel}
                </Button>
              )}
            </div>
          </footer>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function RitualTaskRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 shadow-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}
