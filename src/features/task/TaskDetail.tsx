import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Dialog as RDialog } from 'radix-ui';
import {
  CalendarClock,
  CalendarDays,
  Clock,
  ExternalLink,
  Flag,
  FolderOpen,
  Hourglass,
  Link2,
  Play,
  Plus,
  Repeat,
  Tag as TagIcon,
  Trash2,
  X,
} from 'lucide-react';
import { native } from '@/app/native';
import { ui, useUi } from '@/app/ui';
import {
  addLink,
  addManualTime,
  addSubtask,
  createTag,
  deleteBlock,
  deleteLink,
  deleteSession,
  deleteSubtask,
  deleteTasks,
  endSeries,
  makeTaskRecurring,
  moveTask,
  run,
  scheduleTask,
  setComplete,
  setTaskTags,
  skipOccurrence,
  updateSeries,
  updateSubtask,
  updateTask,
} from '@/data/actions';
import { useData } from '@/data/store';
import type { ISODate } from '@/domain/dates';
import {
  addMinutes,
  dateOfInstant,
  formatDateLong,
  formatDateShort,
  formatDuration,
  formatTimeRange,
  parseClock,
  parseDuration,
  relativeDateLabel,
  wallTimeToInstant,
} from '@/domain/dates';
import type { RepeatPreset } from '@/domain/recurrence';
import { describeRule, isValidRule, presetRule } from '@/domain/recurrence';
import type { Priority, Task } from '@/domain/types';
import { PALETTE, PRIORITY_LABELS } from '@/domain/types';
import { DatePickerPanel, EstimatePanel } from '@/ui/pickers';
import {
  AutoTextarea,
  Button,
  ColorDot,
  IconButton,
  Input,
  Popover,
  PopoverClose,
  Segmented,
  cn,
} from '@/ui/primitives';
import { TaskCheckbox, useNow } from './TaskCard';
import { startFocus } from './taskMenu';

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_1fr] items-start gap-2 py-1">
      <div className="flex h-7 items-center gap-2 text-[12.5px] text-muted">
        <span className="text-subtle">{icon}</span>
        {label}
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function ChipButton({
  children,
  onClick,
  muted,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  muted?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors hover:bg-sunken',
        muted ? 'text-subtle' : 'text-fg',
        className,
      )}
    >
      {children}
    </button>
  );
}

function DateField({
  value,
  onChange,
  emptyLabel,
  clearLabel,
  danger,
}: {
  value: ISODate | null;
  onChange: (d: ISODate | null) => void;
  emptyLabel: string;
  clearLabel: string;
  danger?: boolean;
}) {
  const today = useData((s) => s.today);
  const weekStartsOn = useData((s) => s.settings.weekStartsOn);
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <span>
          <ChipButton muted={!value} className={cn(danger && 'text-danger')}>
            {value
              ? `${relativeDateLabel(value, today)} · ${formatDateShort(value, today)}`
              : emptyLabel}
          </ChipButton>
        </span>
      }
    >
      <DatePickerPanel
        value={value}
        today={today}
        weekStartsOn={weekStartsOn}
        clearLabel={clearLabel}
        onChange={(d) => {
          setOpen(false);
          onChange(d);
        }}
      />
    </Popover>
  );
}

function TagsField({ task }: { task: Task }) {
  const tags = useData((s) => s.tags);
  const [query, setQuery] = useState('');
  const all = Object.values(tags).sort((a, b) => a.name.localeCompare(b.name));
  const matches = all.filter((t) => t.name.toLowerCase().includes(query.toLowerCase()));
  const toggle = (id: string) =>
    run(
      setTaskTags(
        task.id,
        task.tagIds.includes(id) ? task.tagIds.filter((x) => x !== id) : [...task.tagIds, id],
      ),
    );
  return (
    <>
      {task.tagIds.map((id) =>
        tags[id] ? (
          <span
            key={id}
            className="flex h-6 items-center gap-1 rounded-md pr-0.5 pl-2 text-[12px]"
            style={{
              background: `color-mix(in srgb, ${tags[id].color} 14%, transparent)`,
              color: tags[id].color,
            }}
          >
            @{tags[id].name}
            <button
              type="button"
              aria-label={`Remove tag ${tags[id].name}`}
              onClick={() => toggle(id)}
              className="rounded p-0.5 hover:bg-black/10"
            >
              <X size={11} />
            </button>
          </span>
        ) : null,
      )}
      <Popover
        trigger={
          <span>
            <ChipButton muted>
              <Plus size={13} /> Tag
            </ChipButton>
          </span>
        }
      >
        <div className="flex w-56 flex-col gap-1">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = query.trim().replace(/^@/, '');
              if (!name) return;
              const existing = all.find((t) => t.name.toLowerCase() === name.toLowerCase());
              if (existing) toggle(existing.id);
              else
                run(
                  createTag(name, PALETTE[all.length % PALETTE.length]).then((id) =>
                    setTaskTags(task.id, [...task.tagIds, id]),
                  ),
                );
              setQuery('');
            }}
          >
            <Input
              autoFocus
              placeholder="Find or create tag"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-7.5"
            />
          </form>
          <div className="max-h-52 overflow-y-auto">
            {matches.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => toggle(t.id)}
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-sunken"
              >
                <ColorDot color={t.color} />
                <span className="flex-1">{t.name}</span>
                {task.tagIds.includes(t.id) && <span className="text-accent-text">✓</span>}
              </button>
            ))}
            {query.trim() &&
              !all.some((t) => t.name.toLowerCase() === query.trim().toLowerCase()) && (
                <p className="px-2 py-1 text-[11.5px] text-subtle">
                  Press Enter to create “{query.trim()}”
                </p>
              )}
          </div>
        </div>
      </Popover>
    </>
  );
}

const REPEAT_PRESETS: { value: RepeatPreset; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly-day', label: 'Every month' },
  { value: 'monthly-last', label: 'Last day of month' },
  { value: 'yearly', label: 'Every year' },
];

function RepeatField({ task }: { task: Task }) {
  const series = useData((s) => (task.recurrenceId ? s.series[task.recurrenceId] : undefined));
  const today = useData((s) => s.today);
  const [custom, setCustom] = useState('');
  const anchor = task.recurrenceDate ?? task.planDate ?? today;
  if (series) {
    return (
      <>
        <span className="flex h-7 items-center gap-1.5 text-[12.5px]">
          <Repeat size={13} className="text-accent-text" />{' '}
          {describeRule(series.rrule, series.dtstart)}
        </span>
        <Popover
          trigger={
            <span>
              <ChipButton muted>Change</ChipButton>
            </span>
          }
        >
          <div className="flex w-60 flex-col gap-1">
            <p className="px-2 pb-1 text-[11.5px] text-subtle">
              Applies to this and future occurrences.
            </p>
            {REPEAT_PRESETS.map((p) => (
              <PopoverClose asChild key={p.value}>
                <button
                  type="button"
                  className="h-7 rounded-md px-2 text-left text-[12.5px] hover:bg-sunken"
                  onClick={() =>
                    run(updateSeries(series.id, { rrule: presetRule(p.value, anchor) }))
                  }
                >
                  {p.label}
                </button>
              </PopoverClose>
            ))}
          </div>
        </Popover>
        {task.recurrenceDate && !task.completedAt && (
          <ChipButton
            muted
            onClick={() => {
              run(skipOccurrence(series.id, task.recurrenceDate!));
              ui.openTask(null);
            }}
          >
            Skip this one
          </ChipButton>
        )}
        <ChipButton muted onClick={() => run(endSeries(series.id, task.recurrenceDate ?? today))}>
          Stop repeating
        </ChipButton>
      </>
    );
  }
  return (
    <Popover
      trigger={
        <span>
          <ChipButton muted>Doesn’t repeat</ChipButton>
        </span>
      }
    >
      <div className="flex w-60 flex-col gap-1">
        {REPEAT_PRESETS.map((p) => (
          <PopoverClose asChild key={p.value}>
            <button
              type="button"
              className="h-7 rounded-md px-2 text-left text-[12.5px] hover:bg-sunken"
              onClick={() => run(makeTaskRecurring(task.id, presetRule(p.value, anchor), anchor))}
            >
              {p.label}
            </button>
          </PopoverClose>
        ))}
        <form
          className="mt-1 flex gap-1 border-t border-line pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (isValidRule(custom))
              run(makeTaskRecurring(task.id, custom.replace(/^RRULE:/i, ''), anchor));
          }}
        >
          <Input
            placeholder="Custom RRULE"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="h-7"
            aria-label="Custom recurrence rule"
          />
          <Button type="submit" size="sm" disabled={!isValidRule(custom)}>
            Set
          </Button>
        </form>
      </div>
    </Popover>
  );
}

function TimeboxField({ task }: { task: Task }) {
  const blocks = useData((s) => s.blocks);
  const zone = useData((s) => s.zone);
  const today = useData((s) => s.today);
  const hour12 = useData((s) => s.settings.hour12);
  const defaultEstimate = useData((s) => s.settings.defaultEstimateMin);
  const mine = Object.values(blocks)
    .filter((b) => b.taskId === task.id)
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  const [date, setDate] = useState<ISODate>(
    task.planDate && task.planDate >= today ? task.planDate : today,
  );
  const [start, setStart] = useState('09:00');
  const [duration, setDuration] = useState(formatDuration(task.estimateMin ?? defaultEstimate));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex w-full flex-col gap-1">
      {mine.map((b) => (
        <div key={b.id} className="group flex h-7 items-center gap-2 text-[12.5px]">
          <CalendarClock size={13} className="text-accent-text" />
          <span className="tabular">
            {relativeDateLabel(dateOfInstant(b.startUtc, zone), today)} ·{' '}
            {formatTimeRange(b.startUtc, b.endUtc, zone, hour12)}
          </span>
          <IconButton
            label="Remove time block"
            size="xs"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => run(deleteBlock(b.id))}
          >
            <X size={12} />
          </IconButton>
        </div>
      ))}
      <Popover
        trigger={
          <span className="self-start">
            <ChipButton muted>
              <Plus size={13} /> Add time block
            </ChipButton>
          </span>
        }
      >
        <form
          className="flex w-64 flex-col gap-2 p-1"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const minutes = parseDuration(duration);
              if (!minutes || minutes <= 0) throw new Error('Enter a duration like 45m or 1h');
              const s = wallTimeToInstant(date, parseClock(start), zone);
              run(scheduleTask(task.id, s, addMinutes(s, minutes)));
              setError(null);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          <div className="grid grid-cols-2 gap-1.5">
            <Input
              type="date"
              aria-label="Date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="col-span-2 h-7.5"
            />
            <Input
              type="time"
              aria-label="Start time"
              step={300}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="h-7.5"
            />
            <Input
              aria-label="Duration"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="h-7.5"
            />
          </div>
          {error && <p className="text-[11.5px] text-danger">{error}</p>}
          <Button type="submit" size="sm" variant="primary">
            Timebox
          </Button>
          <p className="text-[11px] text-subtle">Or drag the task onto the calendar.</p>
        </form>
      </Popover>
    </div>
  );
}

function TrackedField({ task }: { task: Task }) {
  const sessions = useData((s) => s.sessions);
  const zone = useData((s) => s.zone);
  const today = useData((s) => s.today);
  const hour12 = useData((s) => s.settings.hour12);
  const mine = Object.values(sessions)
    .filter((s) => s.taskId === task.id)
    .sort((a, b) => b.startUtc.localeCompare(a.startUtc));
  const running = mine.some((s) => !s.endUtc);
  const now = useNow(1000, running);
  const total = mine.reduce(
    (sum, s) => sum + ((s.endUtc ? Date.parse(s.endUtc) : now) - Date.parse(s.startUtc)) / 60_000,
    0,
  );
  const [manual, setManual] = useState('');
  const [showAll, setShowAll] = useState(false);
  const over = task.estimateMin && total > task.estimateMin;
  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className={cn('text-[12.5px] font-medium tabular', over && 'text-warn')}>
          {formatDuration(total)}
          {task.estimateMin ? ` of ${formatDuration(task.estimateMin)} estimated` : ''}
        </span>
        {mine.length > 0 && (
          <ChipButton muted onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Hide' : `${mine.length} session${mine.length === 1 ? '' : 's'}`}
          </ChipButton>
        )}
        <Popover
          trigger={
            <span>
              <ChipButton muted>
                <Plus size={13} /> Add time
              </ChipButton>
            </span>
          }
        >
          <form
            className="flex w-52 gap-1.5 p-1"
            onSubmit={(e) => {
              e.preventDefault();
              const m = parseDuration(manual);
              if (m && m > 0) {
                run(addManualTime(task.id, m));
                setManual('');
              }
            }}
          >
            <Input
              autoFocus
              aria-label="Time spent"
              placeholder="e.g. 25m"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              className="h-7.5"
            />
            <Button type="submit" size="sm" variant="primary" disabled={!parseDuration(manual)}>
              Add
            </Button>
          </form>
        </Popover>
      </div>
      {showAll &&
        mine.map((s) => (
          <div key={s.id} className="group flex h-6 items-center gap-2 text-[12px] text-muted">
            <span className="tabular">
              {relativeDateLabel(dateOfInstant(s.startUtc, zone), today)} ·{' '}
              {s.endUtc ? formatTimeRange(s.startUtc, s.endUtc, zone, hour12) : 'running'}
            </span>
            <span className="tabular text-subtle">
              {formatDuration(
                ((s.endUtc ? Date.parse(s.endUtc) : now) - Date.parse(s.startUtc)) / 60_000,
              )}
            </span>
            {s.source === 'manual' && <span className="text-subtle">manual</span>}
            {s.endUtc && (
              <IconButton
                label="Delete session"
                size="xs"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => run(deleteSession(s.id))}
              >
                <Trash2 size={11} />
              </IconButton>
            )}
          </div>
        ))}
    </div>
  );
}

function Subtasks({ task }: { task: Task }) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const sorted = [...task.subtasks].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <div className="flex flex-col gap-0.5">
      {sorted.map((st, i) => (
        <div
          key={st.id}
          className="group flex min-h-7 items-center gap-2 rounded-md px-1 hover:bg-sunken"
          onKeyDown={(e) => {
            if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
            e.preventDefault();
            const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
            const other = sorted[j];
            if (!other) return;
            run(
              updateSubtask(st.id, { sortOrder: other.sortOrder }).then(() =>
                updateSubtask(other.id, { sortOrder: st.sortOrder }),
              ),
            );
          }}
        >
          <TaskCheckbox
            size={15}
            done={!!st.completedAt}
            label={st.title}
            onToggle={() => run(updateSubtask(st.id, { done: !st.completedAt }))}
          />
          {editing === st.id ? (
            <input
              autoFocus
              className="flex-1 bg-transparent text-[13px] outline-none"
              value={draft}
              aria-label="Subtask title"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (draft.trim() && draft !== st.title) run(updateSubtask(st.id, { title: draft }));
                setEditing(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditing(null);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className={cn(
                'flex-1 text-left text-[13px]',
                st.completedAt && 'text-subtle line-through',
              )}
              onClick={() => {
                setEditing(st.id);
                setDraft(st.title);
              }}
            >
              {st.title}
            </button>
          )}
          <IconButton
            label="Delete subtask"
            size="xs"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => run(deleteSubtask(st.id))}
          >
            <X size={12} />
          </IconButton>
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) run(addSubtask(task.id, text));
          setText('');
        }}
        className="flex items-center gap-2 px-1"
      >
        <Plus size={15} className="text-subtle" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add subtask"
          aria-label="Add subtask"
          className="h-7 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
        />
      </form>
    </div>
  );
}

function Links({ task }: { task: Task }) {
  const [url, setUrl] = useState('');
  const valid = /^(https?:\/\/|mailto:)\S+$/i.test(url.trim());
  return (
    <div className="flex flex-col gap-0.5">
      {task.links.map((l) => (
        <div
          key={l.id}
          className="group flex h-7 items-center gap-2 rounded-md px-1 hover:bg-sunken"
        >
          <Link2 size={13} className="text-subtle" />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-[12.5px] text-accent-text hover:underline"
            onClick={() => run(native.openUrl(l.url))}
            title={l.url}
          >
            {l.title || l.url}
          </button>
          <ExternalLink size={12} className="text-subtle" />
          <IconButton
            label="Remove link"
            size="xs"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => run(deleteLink(l.id))}
          >
            <X size={12} />
          </IconButton>
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) run(addLink(task.id, url.trim()));
          setUrl('');
        }}
        className="flex items-center gap-2 px-1"
      >
        <Plus size={15} className="text-subtle" />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a link (https://…)"
          aria-label="Add link"
          className="h-7 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
        />
      </form>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold tracking-wide text-subtle uppercase">{title}</h3>
      {children}
    </section>
  );
}

function TaskDetailBody({ task }: { task: Task }) {
  const projects = useData((s) => s.projects);
  const areas = useData((s) => s.areas);
  const today = useData((s) => s.today);
  const zone = useData((s) => s.zone);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setNotes(task.notes), [task.notes]);
  const done = !!task.completedAt;

  const saveTitle = () => {
    if (title.trim() && title !== task.title) run(updateTask(task.id, { title }, 'Rename task'));
    else setTitle(task.title);
  };
  const saveNotes = () => {
    if (notes !== task.notes) run(updateTask(task.id, { notes }, 'Edit notes'));
  };

  const projectOptions = useMemo(
    () => Object.values(projects).filter((p) => !p.archivedAt || p.id === task.projectId),
    [projects, task.projectId],
  );
  const areaOptions = useMemo(
    () => Object.values(areas).filter((a) => !a.archivedAt || a.id === task.areaId),
    [areas, task.areaId],
  );
  const selectValue = task.projectId
    ? `p:${task.projectId}`
    : task.areaId
      ? `a:${task.areaId}`
      : '';

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3 px-5 pt-5 pb-2">
        <div className="pt-1.5">
          <TaskCheckbox
            size={20}
            done={done}
            priority={task.priority}
            label={task.title}
            onToggle={() => run(setComplete(task.id, !done))}
          />
        </div>
        <AutoTextarea
          aria-label="Task title"
          minRows={1}
          value={title}
          onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
          className={cn(
            'border-transparent bg-transparent px-1 py-1 text-[18px] font-semibold hover:border-line focus:ring-0',
            done && 'text-subtle line-through',
          )}
        />
        <RDialog.Close asChild>
          <IconButton label="Close" className="mt-1">
            <X size={16} />
          </IconButton>
        </RDialog.Close>
      </div>

      <div className="flex gap-2 px-5 pb-3 pl-[52px]">
        {!done && (
          <Button size="sm" variant="primary" onClick={() => startFocus(task.id)}>
            <Play size={13} /> Start & focus
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => run(setComplete(task.id, !done))}>
          {done ? 'Mark incomplete' : 'Complete'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-danger hover:bg-danger-soft hover:text-danger"
          onClick={() => {
            ui.openTask(null);
            run(deleteTasks([task.id]));
          }}
        >
          <Trash2 size={13} /> Delete
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-x-6 border-t border-line px-5 py-3">
        <Row icon={<CalendarDays size={14} />} label="Planned for">
          <DateField
            value={task.planDate}
            emptyLabel="Backlog (not planned)"
            clearLabel="Backlog"
            onChange={(d) => run(moveTask(task.id, d))}
          />
        </Row>
        <Row icon={<Flag size={14} />} label="Deadline">
          <DateField
            value={task.dueDate}
            emptyLabel="No deadline"
            clearLabel="No deadline"
            danger={!!task.dueDate && !done && task.dueDate < today}
            onChange={(d) => run(updateTask(task.id, { dueDate: d }, 'Set deadline'))}
          />
        </Row>
        <Row icon={<CalendarClock size={14} />} label="Timebox">
          <TimeboxField task={task} />
        </Row>
        <Row icon={<Hourglass size={14} />} label="Estimate">
          <Popover
            trigger={
              <span>
                <ChipButton muted={!task.estimateMin}>
                  {task.estimateMin ? formatDuration(task.estimateMin) : 'No estimate'}
                </ChipButton>
              </span>
            }
          >
            <EstimatePanel
              value={task.estimateMin}
              onChange={(m) => run(updateTask(task.id, { estimateMin: m }, 'Set estimate'))}
            />
          </Popover>
        </Row>
        <Row icon={<Clock size={14} />} label="Tracked">
          <TrackedField task={task} />
        </Row>
        <Row icon={<Flag size={14} />} label="Priority">
          <Segmented<Priority>
            label="Priority"
            size="xs"
            value={task.priority}
            onChange={(p) => run(updateTask(task.id, { priority: p }, 'Change priority'))}
            options={([0, 1, 2, 3] as Priority[]).map((p) => ({
              value: p,
              label: PRIORITY_LABELS[p],
            }))}
          />
        </Row>
        <Row icon={<FolderOpen size={14} />} label="Project / area">
          <select
            aria-label="Project or area"
            value={selectValue}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) run(updateTask(task.id, { projectId: null, areaId: null }, 'Change project'));
              else if (v.startsWith('p:'))
                run(updateTask(task.id, { projectId: v.slice(2) }, 'Change project'));
              else run(updateTask(task.id, { areaId: v.slice(2), projectId: null }, 'Change area'));
            }}
            className="h-7 rounded-md border border-line bg-surface px-2 text-[12.5px] text-fg"
          >
            <option value="">None</option>
            {areaOptions.length > 0 && (
              <optgroup label="Areas">
                {areaOptions.map((a) => (
                  <option key={a.id} value={`a:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
            )}
            {projectOptions.length > 0 && (
              <optgroup label="Projects">
                {projectOptions.map((p) => (
                  <option key={p.id} value={`p:${p.id}`}>
                    {p.name}
                    {p.areaId && areas[p.areaId] ? ` (${areas[p.areaId]!.name})` : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Row>
        <Row icon={<TagIcon size={14} />} label="Tags">
          <TagsField task={task} />
        </Row>
        <Row icon={<Repeat size={14} />} label="Repeat">
          <RepeatField task={task} />
        </Row>
      </div>

      <div className="flex flex-col gap-5 border-t border-line px-5 py-4">
        <Section title="Notes">
          <AutoTextarea
            aria-label="Notes"
            placeholder="Add notes, context, or a checklist…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={saveNotes}
            minRows={3}
          />
        </Section>
        <Section title="Subtasks">
          <Subtasks task={task} />
        </Section>
        <Section title="Links">
          <Links task={task} />
        </Section>
      </div>

      <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-5 py-3 text-[11.5px] text-subtle">
        <span>Created {formatDateLong(dateOfInstant(task.createdAt, zone))}</span>
        {task.completedAt && (
          <span>Completed {formatDateLong(dateOfInstant(task.completedAt, zone))}</span>
        )}
        {task.rolloverCount > 0 && <span>Carried forward {task.rolloverCount}×</span>}
        {task.source !== 'local' && <span>From {task.source}</span>}
        {task.planDate && task.planDate < today && !done && (
          <span className="text-warn">
            Planned for a past day ({formatDateShort(task.planDate, today)})
          </span>
        )}
        {task.dueDate && task.planDate && task.planDate > task.dueDate && !done && (
          <span className="text-warn">Planned after its deadline</span>
        )}
      </footer>
    </div>
  );
}

export function TaskDetailDialog() {
  const id = useUi((s) => s.openTaskId);
  const task = useData((s) => (id ? s.tasks[id] : undefined));
  const open = !!id && !!task;
  return (
    <RDialog.Root open={open} onOpenChange={(o) => !o && ui.openTask(null)}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-fade-in fixed inset-0 z-40 bg-[var(--overlay)]" />
        <RDialog.Content
          aria-describedby={undefined}
          className="animate-pop-in fixed top-[6vh] left-1/2 z-50 max-h-[88vh] w-[calc(100vw-48px)] max-w-[680px] -translate-x-1/2 overflow-y-auto rounded-2xl border border-line bg-surface shadow-lg outline-none"
        >
          <RDialog.Title className="sr-only">{task?.title ?? 'Task'}</RDialog.Title>
          {task && <TaskDetailBody key={task.id} task={task} />}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
