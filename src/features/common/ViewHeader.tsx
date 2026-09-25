import type { ReactNode } from 'react';
import { PanelLeft, PanelRight } from 'lucide-react';
import { MOD_LABEL } from '@/app/platform';
import { useUi } from '@/app/ui';
import { IconButton, cn } from '@/ui/primitives';

export function ViewHeader({
  title,
  subtitle,
  left,
  right,
  calendarToggle,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  calendarToggle?: boolean;
  className?: string;
}) {
  const sidebar = useUi((s) => s.sidebar);
  const panel = useUi((s) => s.calendarPanel);
  return (
    <header className={cn('flex h-14 shrink-0 items-center gap-3 px-4', className)}>
      {!sidebar && (
        <IconButton
          label={`Show sidebar (${MOD_LABEL}+B)`}
          onClick={() => useUi.setState({ sidebar: true })}
        >
          <PanelLeft size={16} />
        </IconButton>
      )}
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="truncate text-[17px] font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle && <span className="truncate text-[13px] text-muted">{subtitle}</span>}
      </div>
      {left}
      <div className="ml-auto flex items-center gap-1.5">
        {right}
        {calendarToggle && (
          <IconButton
            label={`${panel ? 'Hide' : 'Show'} calendar (${MOD_LABEL}+J)`}
            active={panel}
            onClick={() => useUi.setState({ calendarPanel: !panel })}
          >
            <PanelRight size={16} />
          </IconButton>
        )}
      </div>
    </header>
  );
}
