import { formatShortcut } from '@/app/platform';
import { COMMANDS, TASK_KEYS, keysFor } from '@/app/shortcuts';
import { ui, useUi } from '@/app/ui';
import { useData } from '@/data/store';
import { Button, Dialog, Kbd } from '@/ui/primitives';

export function shortcutLabel(keys: string): string {
  return keys
    .split(' ')
    .map((k) => formatShortcut(k))
    .join(' then ');
}

export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  const overrides = useData((s) => s.settings.shortcuts);
  const groups = ['General', 'Navigation', 'Planning'] as const;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => useUi.setState({ shortcutsOpen: o })}
      title="Keyboard shortcuts"
      width={720}
    >
      <div className="grid grid-cols-2 gap-x-8 gap-y-5 px-5 pt-2 pb-5">
        {groups.map((g) => (
          <section key={g}>
            <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">
              {g}
            </h3>
            {COMMANDS.filter((c) => c.group === g).map((c) => (
              <div key={c.id} className="flex h-7 items-center justify-between text-[13px]">
                <span>{c.label}</span>
                <Kbd>{shortcutLabel(keysFor(c.id, overrides))}</Kbd>
              </div>
            ))}
          </section>
        ))}
        <section>
          <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">
            On a focused task
          </h3>
          {TASK_KEYS.map(([k, label]) => (
            <div key={k} className="flex h-7 items-center justify-between text-[13px]">
              <span>{label}</span>
              <Kbd>{k}</Kbd>
            </div>
          ))}
        </section>
        <div className="col-span-2 flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              useUi.setState({ shortcutsOpen: false });
              ui.navigate({ name: 'settings', section: 'shortcuts' });
            }}
          >
            Customize shortcuts…
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
