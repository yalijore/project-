import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BarChart3,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Inbox,
  Layers,
  Plug,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sun,
} from 'lucide-react';
import { createArea, createProject, run } from '@/data/actions';
import { backlogTasks, inboxTasks, isOpen } from '@/data/selectors';
import { useData } from '@/data/store';
import type { Project } from '@/domain/types';
import { DropdownMenu } from '@/ui/menu';
import { Button, ColorDot, Dialog, IconButton, Input, cn } from '@/ui/primitives';
import { TimerDock } from '@/features/timer/TimerDock';
import { MOD_LABEL } from './platform';
import type { View } from './ui';
import { ui, useUi } from './ui';

function sameView(a: View, b: View) {
  if (a.name !== b.name) return false;
  return !('id' in a) || !('id' in b) || a.id === b.id;
}

function NavItem({
  icon,
  label,
  view,
  count,
  color,
  indent,
}: {
  icon?: ReactNode;
  label: string;
  view: View;
  count?: number;
  color?: string;
  indent?: boolean;
}) {
  const current = useUi((s) => s.view);
  const active = sameView(current, view);
  return (
    <button
      type="button"
      onClick={() => ui.navigate(view)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors',
        indent && 'pl-7',
        active
          ? 'bg-surface font-medium text-fg shadow-sm'
          : 'text-muted hover:bg-surface/60 hover:text-fg',
      )}
    >
      {color ? (
        <ColorDot color={color} size={8} className="mx-[3px]" />
      ) : (
        <span className="flex w-4 justify-center">{icon}</span>
      )}
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="tabular text-[11.5px] text-subtle">{count}</span>
      )}
    </button>
  );
}

function NewItemForm({
  kind,
  areas,
  onSubmit,
}: {
  kind: 'area' | 'project';
  areas: { id: string; name: string }[];
  onSubmit: (name: string, areaId: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [areaId, setAreaId] = useState<string>('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit(name.trim(), areaId || null);
      }}
      className="flex flex-col gap-3 px-5 pt-2 pb-5"
    >
      <Input
        autoFocus
        aria-label="Name"
        placeholder={kind === 'area' ? 'e.g. Work' : 'e.g. Website refresh'}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {kind === 'project' && areas.length > 0 && (
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          Area
          <select
            value={areaId}
            onChange={(e) => setAreaId(e.target.value)}
            className="h-8 flex-1 rounded-lg border border-line bg-surface px-2 text-[13px] text-fg"
          >
            <option value="">No area</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          Create {kind}
        </Button>
      </div>
    </form>
  );
}

export function Sidebar() {
  const tasks = useData((s) => s.tasks);
  const areas = useData((s) => s.areas);
  const projects = useData((s) => s.projects);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState<
    null | { kind: 'area' } | { kind: 'project'; areaId: string | null }
  >(null);

  const inboxCount = useMemo(() => inboxTasks(tasks).length, [tasks]);
  const backlogCount = useMemo(() => backlogTasks(tasks).length, [tasks]);
  const openByProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of Object.values(tasks))
      if (isOpen(t) && t.projectId) m.set(t.projectId, (m.get(t.projectId) ?? 0) + 1);
    return m;
  }, [tasks]);

  const activeAreas = Object.values(areas)
    .filter((a) => !a.archivedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const activeProjects = Object.values(projects)
    .filter((p) => !p.archivedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const projectsIn = (areaId: string | null): Project[] =>
    activeProjects.filter((p) => p.areaId === areaId);

  return (
    <aside
      aria-label="Sidebar"
      className="flex w-[236px] shrink-0 flex-col border-r border-line bg-sidebar"
    >
      <div className="flex h-12 items-center gap-2 px-4">
        <img src="/keel.svg" alt="" className="h-6 w-6" />
        <span className="text-[15px] font-semibold tracking-tight">Keel</span>
      </div>

      <div className="flex gap-1.5 px-3 pb-2">
        <button
          type="button"
          onClick={() => ui.capture()}
          className="flex h-8 flex-1 items-center gap-2 rounded-lg bg-accent px-2.5 text-[13px] font-medium text-accent-fg shadow-sm transition-colors hover:bg-accent-hover"
        >
          <Plus size={15} /> Add task
          <span
            className="ml-auto rounded border border-white/30 px-1 text-[10.5px] leading-4 font-medium text-accent-fg/90"
            aria-hidden
          >
            Q
          </span>
        </button>
        <IconButton
          label={`Search and commands (${MOD_LABEL}+K)`}
          size="md"
          onClick={() => useUi.setState({ paletteOpen: true })}
        >
          <Search size={16} />
        </IconButton>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        <div className="flex flex-col gap-px">
          <NavItem icon={<Sun size={15} />} label="Today" view={{ name: 'today' }} />
          <NavItem icon={<CalendarRange size={15} />} label="Week" view={{ name: 'week' }} />
          <NavItem
            icon={<Inbox size={15} />}
            label="Inbox"
            view={{ name: 'inbox' }}
            count={inboxCount}
          />
          <NavItem
            icon={<Layers size={15} />}
            label="Backlog"
            view={{ name: 'backlog' }}
            count={backlogCount}
          />
          <NavItem
            icon={<CheckCircle2 size={15} />}
            label="Completed"
            view={{ name: 'completed' }}
          />
          <NavItem icon={<BarChart3 size={15} />} label="Review" view={{ name: 'review' }} />
        </div>

        <div className="mt-5 mb-1 flex items-center justify-between px-2.5">
          <span className="text-[11px] font-semibold tracking-wide text-subtle uppercase">
            Areas & projects
          </span>
          <DropdownMenu
            align="start"
            trigger={
              <IconButton label="Add area or project" size="xs">
                <Plus size={14} />
              </IconButton>
            }
            items={[
              { label: 'New area…', onSelect: () => setAdding({ kind: 'area' }) },
              {
                label: 'New project…',
                onSelect: () => setAdding({ kind: 'project', areaId: null }),
              },
            ]}
          />
        </div>

        {activeAreas.length === 0 && activeProjects.length === 0 && (
          <p className="px-2.5 py-1 text-[12px] text-subtle">
            Group tasks into areas (Work, Home) and projects.
          </p>
        )}

        <div className="flex flex-col gap-px">
          {activeAreas.map((area) => {
            const isCollapsed = collapsed[area.id];
            return (
              <div key={area.id}>
                <div className="group flex items-center">
                  <button
                    type="button"
                    aria-label={isCollapsed ? `Expand ${area.name}` : `Collapse ${area.name}`}
                    onClick={() => setCollapsed((c) => ({ ...c, [area.id]: !c[area.id] }))}
                    className="flex h-8 w-5 items-center justify-center text-subtle hover:text-fg"
                  >
                    {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <NavItem
                      label={area.name}
                      view={{ name: 'area', id: area.id }}
                      color={area.color}
                    />
                  </div>
                </div>
                {!isCollapsed &&
                  projectsIn(area.id).map((p) => (
                    <NavItem
                      key={p.id}
                      label={p.name}
                      view={{ name: 'project', id: p.id }}
                      color={p.color}
                      indent
                      count={openByProject.get(p.id)}
                    />
                  ))}
              </div>
            );
          })}
          {projectsIn(null).map((p) => (
            <NavItem
              key={p.id}
              label={p.name}
              view={{ name: 'project', id: p.id }}
              color={p.color}
              count={openByProject.get(p.id)}
            />
          ))}
        </div>
      </nav>

      <TimerDock />

      <Dialog
        open={adding !== null}
        onOpenChange={(o) => !o && setAdding(null)}
        title={adding?.kind === 'area' ? 'New area' : 'New project'}
        description={
          adding?.kind === 'area'
            ? 'Areas group related projects and tasks, like Work or Home.'
            : 'Projects collect the tasks for one outcome.'
        }
        width={400}
      >
        {adding && (
          <NewItemForm
            kind={adding.kind}
            areas={activeAreas.map((a) => ({ id: a.id, name: a.name }))}
            onSubmit={(name, areaId) => {
              if (adding.kind === 'area') run(createArea(name));
              else run(createProject({ name, areaId }));
              setAdding(null);
            }}
          />
        )}
      </Dialog>

      <div className="flex flex-col gap-px border-t border-line px-2 py-2">
        <NavItem icon={<CalendarDays size={15} />} label="Calendars" view={{ name: 'calendars' }} />
        <NavItem icon={<Plug size={15} />} label="Integrations" view={{ name: 'integrations' }} />
        <NavItem icon={<SettingsIcon size={15} />} label="Settings" view={{ name: 'settings' }} />
      </div>
    </aside>
  );
}
