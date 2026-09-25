import { useMemo } from 'react';
import { X } from 'lucide-react';
import { useData } from '@/data/store';
import { formatDateShort } from '@/domain/dates';
import type { CaptureResult, CaptureToken } from '@/domain/quickCapture';
import { parseCapture } from '@/domain/quickCapture';
import { cn } from '@/ui/primitives';

export function useCaptureParse(text: string, disabled: Set<string>): CaptureResult {
  const today = useData((s) => s.today);
  const weekStartsOn = useData((s) => s.settings.weekStartsOn);
  const projects = useData((s) => s.projects);
  const areas = useData((s) => s.areas);
  const tags = useData((s) => s.tags);
  return useMemo(
    () =>
      parseCapture(
        text,
        {
          today,
          weekStartsOn,
          projects: Object.values(projects).filter((p) => !p.archivedAt),
          areas: Object.values(areas).filter((a) => !a.archivedAt),
          tags: Object.values(tags),
        },
        disabled,
      ),
    [text, disabled, today, weekStartsOn, projects, areas, tags],
  );
}

const KIND_STYLE: Record<CaptureToken['kind'], string> = {
  plan: 'bg-accent-soft text-accent-text',
  due: 'bg-danger-soft text-danger',
  estimate: 'bg-sunken text-fg',
  priority: 'bg-warn-soft text-warn',
  project: 'bg-sunken text-fg',
  area: 'bg-sunken text-fg',
  tag: 'bg-sunken text-fg',
  time: 'bg-accent-soft text-accent-text',
  repeat: 'bg-accent-soft text-accent-text',
  backlog: 'bg-sunken text-muted',
};

function tokenLabel(t: CaptureToken, today: string): string {
  const date = /(\d{4}-\d{2}-\d{2})/.exec(t.label)?.[1];
  if (date && (t.kind === 'plan' || t.kind === 'due'))
    return `${t.kind === 'due' ? 'Due ' : ''}${formatDateShort(date, today)}`;
  if (t.kind === 'project' || t.kind === 'area') return `#${t.label}`;
  if (t.kind === 'tag') return `@${t.label}`;
  return t.label;
}

/** Shows what quick capture recognized; clicking a chip keeps that text in the title instead. */
export function CaptureChips({
  parsed,
  onDisable,
  className,
}: {
  parsed: CaptureResult;
  onDisable: (key: string) => void;
  className?: string;
}) {
  const today = useData((s) => s.today);
  if (parsed.tokens.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1', className)} aria-label="Recognized details">
      {parsed.tokens.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onDisable(t.key)}
          title={`Recognized “${t.text}”. Click to keep it as text.`}
          className={cn(
            'group flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium',
            KIND_STYLE[t.kind],
          )}
        >
          {tokenLabel(t, today)}
          <X size={10} className="opacity-50 group-hover:opacity-100" />
        </button>
      ))}
    </div>
  );
}
