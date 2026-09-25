import type { ReactNode } from 'react';
import { ContextMenu as RContext, DropdownMenu as RDropdown } from 'radix-ui';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from './primitives';

const contentClass =
  'animate-pop-in z-50 min-w-[200px] overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-md outline-none';
const itemClass =
  'relative flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-fg outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-sunken';

export interface MenuItemSpec {
  kind?: 'item' | 'separator' | 'label' | 'sub' | 'check';
  label?: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onSelect?: () => void;
  items?: MenuItemSpec[];
}

type Parts = typeof RDropdown | typeof RContext;

function renderItems(P: Parts, items: MenuItemSpec[]): ReactNode {
  return items.map((item, i) => {
    const key = i;
    if (item.kind === 'separator') return <P.Separator key={key} className="my-1 h-px bg-line" />;
    if (item.kind === 'label')
      return (
        <P.Label
          key={key}
          className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase"
        >
          {item.label}
        </P.Label>
      );
    if (item.kind === 'sub' && item.items)
      return (
        <P.Sub key={key}>
          <P.SubTrigger className={itemClass}>
            <span className="flex w-4 justify-center text-muted">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            <ChevronRight size={14} className="text-subtle" />
          </P.SubTrigger>
          <P.Portal>
            <P.SubContent
              className={cn(contentClass, 'max-h-[60vh] overflow-y-auto')}
              sideOffset={4}
            >
              {renderItems(P, item.items)}
            </P.SubContent>
          </P.Portal>
        </P.Sub>
      );
    return (
      <P.Item
        key={key}
        disabled={item.disabled}
        onSelect={item.onSelect}
        className={cn(itemClass, item.danger && 'text-danger data-[highlighted]:bg-danger-soft')}
      >
        <span className="flex w-4 justify-center text-muted">
          {item.kind === 'check' ? item.checked ? <Check size={14} /> : null : item.icon}
        </span>
        <span className="flex-1 truncate">{item.label}</span>
        {item.shortcut && <span className="ml-4 text-[11px] text-subtle">{item.shortcut}</span>}
      </P.Item>
    );
  });
}

export function DropdownMenu({
  trigger,
  items,
  align = 'end',
  onOpenChange,
}: {
  trigger: ReactNode;
  items: MenuItemSpec[];
  align?: 'start' | 'end' | 'center';
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <RDropdown.Root onOpenChange={onOpenChange} modal={false}>
      <RDropdown.Trigger asChild>{trigger}</RDropdown.Trigger>
      <RDropdown.Portal>
        <RDropdown.Content
          align={align}
          sideOffset={4}
          collisionPadding={12}
          className={contentClass}
        >
          {renderItems(RDropdown, items)}
        </RDropdown.Content>
      </RDropdown.Portal>
    </RDropdown.Root>
  );
}

export function ContextMenu({
  children,
  items,
  onOpenChange,
}: {
  children: ReactNode;
  items: MenuItemSpec[] | (() => MenuItemSpec[]);
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <RContext.Root onOpenChange={onOpenChange} modal={false}>
      <RContext.Trigger asChild>{children}</RContext.Trigger>
      <RContext.Portal>
        <RContext.Content collisionPadding={12} className={contentClass}>
          {renderItems(RContext, typeof items === 'function' ? items() : items)}
        </RContext.Content>
      </RContext.Portal>
    </RContext.Root>
  );
}
