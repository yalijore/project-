import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';
import { forwardRef, useLayoutEffect, useRef } from 'react';
import {
  Dialog as RDialog,
  Popover as RPopover,
  Switch as RSwitch,
  Tooltip as RTooltip,
} from 'radix-ui';
import { X } from 'lucide-react';

export function cn(...parts: (string | number | false | null | undefined)[]): string {
  return parts.filter((p) => typeof p === 'string' && p).join(' ');
}

// ---------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'xs' | 'sm' | 'md';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-sm',
  secondary:
    'bg-surface text-fg border border-line hover:bg-surface-hover hover:border-line-strong shadow-sm',
  ghost: 'text-muted hover:text-fg hover:bg-sunken',
  subtle: 'bg-sunken text-fg hover:bg-line/60',
  danger: 'bg-danger text-white hover:brightness-110 shadow-sm',
};

const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-[12px] gap-1 rounded-md',
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-md',
  md: 'h-8.5 px-3.5 text-[13px] gap-2 rounded-lg',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: 'xs' | 'sm' | 'md';
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'sm', active, className, type = 'button', ...props },
  ref,
) {
  const dims = size === 'xs' ? 'h-6 w-6' : size === 'sm' ? 'h-7 w-7' : 'h-8 w-8';
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-sunken hover:text-fg disabled:opacity-40',
        active && 'bg-accent-soft text-accent-text hover:bg-accent-soft',
        dims,
        className,
      )}
      {...props}
    />
  );
});

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-surface px-1 font-sans text-[10.5px] font-medium text-muted shadow-[0_1px_0_var(--line)]',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

// ---------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-8.5 w-full rounded-lg border border-line bg-surface px-3 text-[13px] text-fg placeholder:text-subtle transition-colors outline-none hover:border-line-strong focus:border-accent focus:ring-3 focus:ring-accent/15',
          className,
        )}
        {...props}
      />
    );
  },
);

/** A textarea that grows with its content. */
export const AutoTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number }
>(function AutoTextarea({ className, minRows = 2, value, ...props }, forwarded) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        if (typeof forwarded === 'function') forwarded(el);
        else if (forwarded) forwarded.current = el;
      }}
      rows={minRows}
      value={value}
      className={cn(
        'w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-fg placeholder:text-subtle outline-none hover:border-line-strong focus:border-accent focus:ring-3 focus:ring-accent/15',
        className,
      )}
      {...props}
    />
  );
});

export function Label({
  children,
  htmlFor,
  className,
}: {
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={cn('text-[12px] font-medium text-muted', className)}>
      {children}
    </label>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  id,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      disabled={disabled}
      className="relative inline-flex h-[20px] w-[34px] shrink-0 cursor-pointer items-center rounded-full bg-line-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-50"
    >
      <RSwitch.Thumb className="block h-4 w-4 translate-x-[2px] rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[16px]" />
    </RSwitch.Root>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size = 'sm',
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'xs' | 'sm';
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md font-medium transition-colors',
            size === 'xs' ? 'h-6 px-2 text-[11.5px]' : 'h-7 px-2.5 text-[12.5px]',
            o.value === value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------------------

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 520,
  hideTitle,
  className,
  onOpenAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  width?: number;
  hideTitle?: boolean;
  className?: string;
  onOpenAutoFocus?: (e: Event) => void;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-fade-in fixed inset-0 z-40 bg-[var(--overlay)]" />
        <RDialog.Content
          onOpenAutoFocus={onOpenAutoFocus}
          aria-describedby={description ? undefined : undefined}
          style={{ maxWidth: width }}
          className={cn(
            'animate-pop-in fixed top-[12vh] left-1/2 z-50 max-h-[80vh] w-[calc(100vw-48px)] -translate-x-1/2 overflow-y-auto rounded-2xl border border-line bg-surface shadow-lg outline-none',
            className,
          )}
        >
          {hideTitle ? (
            <RDialog.Title className="sr-only">{title}</RDialog.Title>
          ) : (
            <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-1">
              <div>
                <RDialog.Title className="text-[15px] font-semibold text-fg">{title}</RDialog.Title>
                {description && (
                  <RDialog.Description className="mt-0.5 text-[12.5px] text-muted">
                    {description}
                  </RDialog.Description>
                )}
              </div>
              <RDialog.Close asChild>
                <IconButton label="Close" size="sm">
                  <X size={16} />
                </IconButton>
              </RDialog.Close>
            </div>
          )}
          {hideTitle && description && (
            <RDialog.Description className="sr-only">{description}</RDialog.Description>
          )}
          {!description && <RDialog.Description className="sr-only">{title}</RDialog.Description>}
          {children}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = 'start',
  side = 'bottom',
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'animate-pop-in z-50 rounded-xl border border-line bg-surface p-2 shadow-md outline-none',
            className,
          )}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

export const PopoverClose = RPopover.Close;

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <RTooltip.Root delayDuration={450}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="animate-fade-in z-[60] max-w-[260px] rounded-md bg-fg px-2 py-1 text-[11.5px] leading-snug text-bg shadow-md"
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export const TooltipProvider = RTooltip.Provider;

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-10 text-center', className)}
    >
      {icon && <div className="mb-3 text-subtle">{icon}</div>}
      <div className="text-[13.5px] font-medium text-fg">{title}</div>
      {children && <div className="mt-1 max-w-[340px] text-[12.5px] text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ColorDot({
  color,
  size = 8,
  className,
}: {
  color: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 rounded-full', className)}
      style={{ width: size, height: size, background: color }}
    />
  );
}
