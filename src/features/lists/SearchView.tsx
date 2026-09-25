import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { ui, useUi } from '@/app/ui';
import { isOpen, useClosedMinutes } from '@/data/selectors';
import { useData } from '@/data/store';
import type { Priority, Task } from '@/domain/types';
import { PRIORITY_LABELS } from '@/domain/types';
import { Button, EmptyState, Input, Segmented } from '@/ui/primitives';
import { ViewHeader } from '../common/ViewHeader';
import { TaskCard } from '../task/TaskCard';
import { ListLayout } from './ListViews';

type Status = 'open' | 'done' | 'all';
type When = 'any' | 'planned' | 'unplanned' | 'overdue' | 'deadline' | 'late';

const selectClass = 'h-7.5 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-fg';

export interface TaskFilter {
  query: string;
  status: Status;
  when: When;
  scope: string; // '' | 'p:id' | 'a:id'
  tagId: string;
  priority: '' | Priority;
}

export function filterTasks(tasks: Task[], f: TaskFilter, today: string): Task[] {
  const terms = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return tasks.filter((t) => {
    if (t.archivedAt) return false;
    if (f.status === 'open' && !isOpen(t)) return false;
    if (f.status === 'done' && !t.completedAt) return false;
    if (f.when === 'planned' && !t.planDate) return false;
    if (f.when === 'unplanned' && t.planDate) return false;
    if (f.when === 'overdue' && !(t.planDate && t.planDate < today && !t.completedAt)) return false;
    if (f.when === 'deadline' && !t.dueDate) return false;
    if (f.when === 'late' && !(t.dueDate && t.dueDate < today && !t.completedAt)) return false;
    if (f.scope.startsWith('p:') && t.projectId !== f.scope.slice(2)) return false;
    if (f.scope.startsWith('a:') && t.areaId !== f.scope.slice(2)) return false;
    if (f.tagId && !t.tagIds.includes(f.tagId)) return false;
    if (f.priority !== '' && t.priority !== f.priority) return false;
    if (terms.length) {
      const hay =
        `${t.title} ${t.notes} ${t.subtasks.map((s) => s.title).join(' ')} ${t.links.map((l) => `${l.title} ${l.url}`).join(' ')}`.toLowerCase();
      if (!terms.every((term) => hay.includes(term))) return false;
    }
    return true;
  });
}

export function SearchView({ initialQuery }: { initialQuery?: string }) {
  const tasks = useData((s) => s.tasks);
  const projects = useData((s) => s.projects);
  const areas = useData((s) => s.areas);
  const tags = useData((s) => s.tags);
  const today = useData((s) => s.today);
  const selection = useUi((s) => s.selection);
  const closed = useClosedMinutes();
  const [f, setF] = useState<TaskFilter>({
    query: initialQuery ?? '',
    status: 'open',
    when: 'any',
    scope: '',
    tagId: '',
    priority: '',
  });
  const results = useMemo(
    () =>
      filterTasks(Object.values(tasks), f, today).sort(
        (a, b) =>
          Number(!!a.completedAt) - Number(!!b.completedAt) ||
          (a.planDate ?? '9999').localeCompare(b.planDate ?? '9999') ||
          b.updatedAt.localeCompare(a.updatedAt),
      ),
    [tasks, f, today],
  );
  const upd = (patch: Partial<TaskFilter>) => setF({ ...f, ...patch });
  const allSelected = results.length > 0 && results.every((t) => selection.includes(t.id));

  return (
    <ListLayout
      containers={{}}
      onMove={() => undefined}
      header={
        <ViewHeader
          title="Search"
          subtitle={`${results.length} result${results.length === 1 ? '' : 's'}`}
          calendarToggle
        />
      }
    >
      <div className="flex flex-col gap-2.5">
        <div className="relative">
          <Search
            size={15}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle"
          />
          <Input
            autoFocus
            aria-label="Search tasks"
            placeholder="Search titles, notes, subtasks and links"
            value={f.query}
            onChange={(e) => upd({ query: e.target.value })}
            className="h-10 pl-9 text-[14px]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Status>
            label="Status"
            size="xs"
            value={f.status}
            onChange={(status) => upd({ status })}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'done', label: 'Completed' },
              { value: 'all', label: 'All' },
            ]}
          />
          <select
            aria-label="When"
            className={selectClass}
            value={f.when}
            onChange={(e) => upd({ when: e.target.value as When })}
          >
            <option value="any">Any day</option>
            <option value="planned">Planned for a day</option>
            <option value="unplanned">Not planned</option>
            <option value="overdue">Planned in the past, unfinished</option>
            <option value="deadline">Has a deadline</option>
            <option value="late">Past its deadline</option>
          </select>
          <select
            aria-label="Project or area"
            className={selectClass}
            value={f.scope}
            onChange={(e) => upd({ scope: e.target.value })}
          >
            <option value="">All projects & areas</option>
            {Object.values(areas).map((a) => (
              <option key={a.id} value={`a:${a.id}`}>
                Area: {a.name}
              </option>
            ))}
            {Object.values(projects).map((p) => (
              <option key={p.id} value={`p:${p.id}`}>
                {p.name}
              </option>
            ))}
          </select>
          {Object.keys(tags).length > 0 && (
            <select
              aria-label="Tag"
              className={selectClass}
              value={f.tagId}
              onChange={(e) => upd({ tagId: e.target.value })}
            >
              <option value="">Any tag</option>
              {Object.values(tags).map((t) => (
                <option key={t.id} value={t.id}>
                  @{t.name}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Priority"
            className={selectClass}
            value={String(f.priority)}
            onChange={(e) =>
              upd({ priority: e.target.value === '' ? '' : (Number(e.target.value) as Priority) })
            }
          >
            <option value="">Any priority</option>
            {([3, 2, 1, 0] as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          {results.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto"
              onClick={() => ui.select(allSelected ? [] : results.map((t) => t.id))}
            >
              {allSelected ? 'Clear selection' : `Select all ${results.length}`}
            </Button>
          )}
        </div>
      </div>
      {results.length === 0 ? (
        <EmptyState icon={<Search size={26} />} title="No matching tasks">
          Try fewer words or loosen a filter.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-1.5" data-task-list="search">
          {results.slice(0, 300).map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              trackedMin={closed.get(t.id) ?? 0}
              runningSince={null}
              blocks={[]}
              showPlanDate
              selected={selection.includes(t.id)}
            />
          ))}
          {results.length > 300 && (
            <p className="text-center text-[12px] text-subtle">
              Showing the first 300 of {results.length}. Narrow the search to see more.
            </p>
          )}
        </div>
      )}
    </ListLayout>
  );
}
