import { useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { Dialog as RDialog } from 'radix-ui';
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Command as CommandIcon,
  FolderOpen,
  Hash,
  Moon,
  Search,
  Sun,
  Sunrise,
} from 'lucide-react';
import { runCommand } from '@/app/commands';
import { COMMANDS, keysFor } from '@/app/shortcuts';
import { ui, useUi } from '@/app/ui';
import { run, saveSettings } from '@/data/actions';
import { useData } from '@/data/store';
import { relativeDateLabel } from '@/domain/dates';
import { ColorDot, Kbd } from '@/ui/primitives';
import { shortcutLabel } from '../system/ShortcutsDialog';

const itemClass =
  'flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-fg data-[selected=true]:bg-sunken aria-selected:bg-sunken';

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const tasks = useData((s) => s.tasks);
  const projects = useData((s) => s.projects);
  const areas = useData((s) => s.areas);
  const tags = useData((s) => s.tags);
  const today = useData((s) => s.today);
  const overrides = useData((s) => s.settings.shortcuts);
  const [query, setQuery] = useState('');

  const close = () => {
    useUi.setState({ paletteOpen: false });
    setQuery('');
  };
  const exec = (fn: () => void) => {
    close();
    setTimeout(fn, 0);
  };

  const taskMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return Object.values(tasks)
      .filter(
        (t) =>
          !t.archivedAt && (t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q)),
      )
      .sort(
        (a, b) =>
          Number(!!a.completedAt) - Number(!!b.completedAt) ||
          b.updatedAt.localeCompare(a.updatedAt),
      )
      .slice(0, 12);
  }, [tasks, query]);

  return (
    <RDialog.Root
      open={open}
      onOpenChange={(o) => (o ? useUi.setState({ paletteOpen: true }) : close())}
    >
      <RDialog.Portal>
        <RDialog.Overlay className="animate-fade-in fixed inset-0 z-40 bg-[var(--overlay)]" />
        <RDialog.Content
          aria-describedby={undefined}
          className="animate-pop-in fixed top-[14vh] left-1/2 z-50 w-[calc(100vw-48px)] max-w-[620px] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-lg outline-none"
        >
          <RDialog.Title className="sr-only">Command palette</RDialog.Title>
          <Command label="Command palette" shouldFilter loop>
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Search size={16} className="text-subtle" />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Search tasks, jump to a view, or run a command…"
                className="h-12 flex-1 bg-transparent text-[14.5px] text-fg outline-none placeholder:text-subtle"
              />
            </div>
            <Command.List className="max-h-[56vh] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-[13px] text-subtle">
                No matches.
              </Command.Empty>

              {taskMatches.length > 0 && (
                <Command.Group
                  heading="Tasks"
                  className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-subtle [&_[cmdk-group-heading]]:uppercase"
                >
                  {taskMatches.map((t) => (
                    <Command.Item
                      key={t.id}
                      value={`task ${t.title} ${t.id}`}
                      onSelect={() => exec(() => ui.openTask(t.id))}
                      className={itemClass}
                    >
                      {t.completedAt ? (
                        <CheckCircle2 size={15} className="text-accent-text" />
                      ) : (
                        <Circle size={15} className="text-subtle" />
                      )}
                      <span className="flex-1 truncate">{t.title}</span>
                      <span className="text-[11.5px] text-subtle">
                        {t.planDate ? relativeDateLabel(t.planDate, today) : 'Backlog'}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              <Command.Group
                heading="Actions"
                className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-subtle [&_[cmdk-group-heading]]:uppercase"
              >
                <Command.Item
                  value="add task new capture"
                  onSelect={() => exec(() => ui.capture())}
                  className={itemClass}
                >
                  <CommandIcon size={15} className="text-subtle" />{' '}
                  <span className="flex-1">Add a task</span>
                  <Kbd>{shortcutLabel(keysFor('capture', overrides))}</Kbd>
                </Command.Item>
                <Command.Item
                  value="plan your day morning ritual"
                  onSelect={() => exec(() => ui.ritual({ kind: 'plan', date: today }))}
                  className={itemClass}
                >
                  <Sunrise size={15} className="text-subtle" />{' '}
                  <span className="flex-1">Plan your day</span>
                </Command.Item>
                <Command.Item
                  value="shut down end of day ritual"
                  onSelect={() => exec(() => ui.ritual({ kind: 'shutdown', date: today }))}
                  className={itemClass}
                >
                  <Moon size={15} className="text-subtle" />{' '}
                  <span className="flex-1">Shut down the day</span>
                </Command.Item>
                <Command.Item
                  value="theme light"
                  onSelect={() => exec(() => run(saveSettings({ theme: 'light' })))}
                  className={itemClass}
                >
                  <Sun size={15} className="text-subtle" />{' '}
                  <span className="flex-1">Use light theme</span>
                </Command.Item>
                <Command.Item
                  value="theme dark"
                  onSelect={() => exec(() => run(saveSettings({ theme: 'dark' })))}
                  className={itemClass}
                >
                  <Moon size={15} className="text-subtle" />{' '}
                  <span className="flex-1">Use dark theme</span>
                </Command.Item>
                <Command.Item
                  value="theme system"
                  onSelect={() => exec(() => run(saveSettings({ theme: 'system' })))}
                  className={itemClass}
                >
                  <CommandIcon size={15} className="text-subtle" />{' '}
                  <span className="flex-1">Follow system theme</span>
                </Command.Item>
                {COMMANDS.filter(
                  (c) => !['capture', 'palette', 'plan', 'shutdown'].includes(c.id),
                ).map((c) => (
                  <Command.Item
                    key={c.id}
                    value={`${c.label} ${c.id}`}
                    onSelect={() => exec(() => runCommand(c.id))}
                    className={itemClass}
                  >
                    <ArrowRight size={15} className="text-subtle" />{' '}
                    <span className="flex-1">{c.label}</span>
                    <Kbd>{shortcutLabel(keysFor(c.id, overrides))}</Kbd>
                  </Command.Item>
                ))}
              </Command.Group>

              <Command.Group
                heading="Go to"
                className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-subtle [&_[cmdk-group-heading]]:uppercase"
              >
                {Object.values(areas)
                  .filter((a) => !a.archivedAt)
                  .map((a) => (
                    <Command.Item
                      key={a.id}
                      value={`area ${a.name}`}
                      onSelect={() => exec(() => ui.navigate({ name: 'area', id: a.id }))}
                      className={itemClass}
                    >
                      <ColorDot color={a.color} /> <span className="flex-1">{a.name}</span>{' '}
                      <span className="text-[11.5px] text-subtle">Area</span>
                    </Command.Item>
                  ))}
                {Object.values(projects)
                  .filter((p) => !p.archivedAt)
                  .map((p) => (
                    <Command.Item
                      key={p.id}
                      value={`project ${p.name}`}
                      onSelect={() => exec(() => ui.navigate({ name: 'project', id: p.id }))}
                      className={itemClass}
                    >
                      <FolderOpen size={15} className="text-subtle" />{' '}
                      <span className="flex-1">{p.name}</span>{' '}
                      <span className="text-[11.5px] text-subtle">Project</span>
                    </Command.Item>
                  ))}
                {Object.values(tags).map((t) => (
                  <Command.Item
                    key={t.id}
                    value={`tag ${t.name}`}
                    onSelect={() => exec(() => ui.navigate({ name: 'tag', id: t.id }))}
                    className={itemClass}
                  >
                    <Hash size={15} className="text-subtle" />{' '}
                    <span className="flex-1">@{t.name}</span>{' '}
                    <span className="text-[11.5px] text-subtle">Tag</span>
                  </Command.Item>
                ))}
                {query.trim().length >= 2 && (
                  <Command.Item
                    value={`search all ${query}`}
                    onSelect={() => exec(() => ui.navigate({ name: 'search', query }))}
                    className={itemClass}
                  >
                    <Search size={15} className="text-subtle" />{' '}
                    <span className="flex-1">Search all tasks for “{query}”</span>
                  </Command.Item>
                )}
              </Command.Group>
            </Command.List>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
