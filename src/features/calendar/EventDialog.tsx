import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Lock, MapPin, Repeat, Trash2 } from 'lucide-react';
import { native } from '@/app/native';
import { useUi } from '@/app/ui';
import { createEvent, deleteEvent, excludeOccurrence, run, updateEvent } from '@/data/actions';
import type { EventInput } from '@/data/repo';
import { useData } from '@/data/store';
import type { ISODate } from '@/domain/dates';
import {
  addDays,
  dateOfInstant,
  formatClock,
  formatDateLong,
  formatTimeRange,
  minutesIntoDay,
  parseClock,
  wallTimeToInstant,
} from '@/domain/dates';
import type { RepeatPreset } from '@/domain/recurrence';
import { describeRule, isValidRule, presetRule } from '@/domain/recurrence';
import { AutoTextarea, Button, ColorDot, Dialog, Input, Label, Switch } from '@/ui/primitives';

interface Form {
  title: string;
  calendarId: string;
  allDay: boolean;
  date: ISODate;
  endDate: ISODate;
  start: string;
  end: string;
  repeat: 'none' | RepeatPreset | 'custom';
  customRule: string;
  location: string;
  url: string;
  description: string;
  busy: boolean;
}

const REPEAT_OPTIONS: { value: Form['repeat']; label: string }[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly-day', label: 'Every month (same day)' },
  { value: 'yearly', label: 'Every year' },
  { value: 'custom', label: 'Custom (RRULE)…' },
];

const selectClass =
  'h-8.5 w-full rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg outline-none focus:border-accent';

export function EventDialog() {
  const editEvent = useUi((s) => s.editEvent);
  const draft = useUi((s) => s.eventDraft);
  const events = useData((s) => s.events);
  const calendars = useData((s) => s.calendars);
  const zone = useData((s) => s.zone);
  const hour12 = useData((s) => s.settings.hour12);
  const defaultCalendarId = useData((s) => s.settings.defaultCalendarId);
  const today = useData((s) => s.today);
  const event = editEvent ? events[editEvent.id] : null;
  const open = !!event || !!draft;
  const writable = useMemo(
    () => Object.values(calendars).filter((c) => c.isWritable && c.source === 'local'),
    [calendars],
  );
  const readOnly =
    !!event &&
    !(calendars[event.calendarId]?.isWritable && calendars[event.calendarId]?.source === 'local');

  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (event) {
      const date = event.allDay ? event.startDate! : dateOfInstant(event.startUtc!, zone);
      const presets: RepeatPreset[] = [
        'daily',
        'weekdays',
        'weekly',
        'biweekly',
        'monthly-day',
        'yearly',
      ];
      const preset = event.rrule
        ? presets.find((p) => presetRule(p, date) === event.rrule)
        : undefined;
      setForm({
        title: event.title,
        calendarId: event.calendarId,
        allDay: event.allDay,
        date,
        endDate: event.allDay ? addDays(event.endDate!, -1) : date,
        start: event.allDay
          ? '09:00'
          : formatClock(Math.round(minutesIntoDay(event.startUtc!, date, zone))),
        end: event.allDay
          ? '10:00'
          : formatClock(
              Math.min(24 * 60 - 1, Math.round(minutesIntoDay(event.endUtc!, date, zone))),
            ),
        repeat: event.rrule ? (preset ?? 'custom') : 'none',
        customRule: event.rrule ?? '',
        location: event.location,
        url: event.url ?? '',
        description: event.description,
        busy: event.busy,
      });
    } else if (draft) {
      setForm({
        title: '',
        calendarId:
          defaultCalendarId && calendars[defaultCalendarId]?.isWritable
            ? defaultCalendarId
            : (writable[0]?.id ?? ''),
        allDay: !!draft.allDay,
        date: draft.date,
        endDate: draft.date,
        start: formatClock(draft.startMin),
        end: formatClock(Math.min(draft.endMin, 24 * 60 - 1)),
        repeat: 'none',
        customRule: '',
        location: '',
        url: '',
        description: '',
        busy: true,
      });
    } else {
      setForm(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editEvent?.id, draft]);

  const close = () => useUi.setState({ editEvent: null, eventDraft: null });

  const toInput = (f: Form): EventInput => {
    const rrule =
      f.repeat === 'none'
        ? null
        : f.repeat === 'custom'
          ? f.customRule.trim().replace(/^RRULE:/i, '')
          : presetRule(f.repeat, f.date);
    if (rrule && !isValidRule(rrule))
      throw new Error('That repeat rule is not valid (expected e.g. FREQ=WEEKLY;BYDAY=MO)');
    if (f.allDay) {
      if (f.endDate < f.date) throw new Error('The end date is before the start date');
      return {
        calendarId: f.calendarId,
        title: f.title,
        allDay: true,
        startDate: f.date,
        endDate: addDays(f.endDate, 1),
        rrule,
        exdates: event?.exdates ?? [],
        location: f.location,
        url: f.url || null,
        description: f.description,
        busy: f.busy,
        tz: zone,
      };
    }
    const startMin = parseClock(f.start);
    const endMin = parseClock(f.end);
    if (endMin <= startMin) throw new Error('The event must end after it starts');
    return {
      calendarId: f.calendarId,
      title: f.title,
      allDay: false,
      startUtc: wallTimeToInstant(f.date, startMin, zone),
      endUtc: wallTimeToInstant(f.date, endMin, zone),
      rrule,
      exdates: event?.exdates ?? [],
      location: f.location,
      url: f.url || null,
      description: f.description,
      busy: f.busy,
      tz: zone,
    };
  };

  const save = () => {
    if (!form) return;
    try {
      if (!form.title.trim()) throw new Error('Give the event a title');
      if (!form.calendarId) throw new Error('Create a calendar first (Calendars in the sidebar)');
      const input = toInput(form);
      run(event ? updateEvent(event.id, input) : createEvent(input));
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!open || !form) return null;
  const upd = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const cal = event ? calendars[event.calendarId] : null;

  if (readOnly && event) {
    const when = event.allDay
      ? `${formatDateLong(event.startDate!)}${addDays(event.endDate!, -1) !== event.startDate ? ` – ${formatDateLong(addDays(event.endDate!, -1))}` : ''} · all day`
      : `${formatDateLong(dateOfInstant(event.startUtc!, zone))} · ${formatTimeRange(event.startUtc!, event.endUtc!, zone, hour12)}`;
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && close()}
        title={event.title}
        description={when}
        width={460}
      >
        <div className="flex flex-col gap-3 px-5 pt-2 pb-5 text-[13px]">
          <div className="flex items-center gap-2 text-muted">
            <ColorDot color={cal?.color ?? '#888'} /> {cal?.name ?? 'Calendar'}
            <span className="ml-auto flex items-center gap-1 text-[11.5px]">
              <Lock size={12} /> Read-only in Keel
            </span>
          </div>
          {event.rrule && (
            <div className="flex items-center gap-2 text-muted">
              <Repeat size={13} /> {describeRule(event.rrule)}
            </div>
          )}
          {event.location && (
            <div className="flex items-center gap-2 text-muted">
              <MapPin size={13} /> <span className="selectable">{event.location}</span>
            </div>
          )}
          {event.description && (
            <p className="selectable whitespace-pre-wrap text-fg">{event.description}</p>
          )}
          {event.url && (
            <Button
              size="sm"
              variant="secondary"
              className="self-start"
              onClick={() => run(native.openUrl(event.url!))}
            >
              <ExternalLink size={13} /> Open link
            </Button>
          )}
          <p className="text-[12px] text-subtle">
            This event comes from “{cal?.name}”. Keel never changes events it did not create; edit
            it in its source.
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={event ? 'Edit event' : 'New event'}
      width={500}
    >
      <form
        className="flex flex-col gap-3 px-5 pt-2 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input
          autoFocus
          aria-label="Event title"
          placeholder="Event title"
          value={form.title}
          onChange={(e) => upd({ title: e.target.value })}
          className="h-10 text-[15px] font-medium"
        />
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ev-cal">Calendar</Label>
            <select
              id="ev-cal"
              className={selectClass}
              value={form.calendarId}
              onChange={(e) => upd({ calendarId: e.target.value })}
            >
              {writable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <label className="flex h-8.5 items-center gap-2 text-[13px] text-muted">
            <Switch
              checked={form.allDay}
              onCheckedChange={(v) => upd({ allDay: v })}
              label="All day"
            />{' '}
            All day
          </label>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ev-date">{form.allDay ? 'Starts' : 'Date'}</Label>
            <Input
              id="ev-date"
              type="date"
              value={form.date}
              onChange={(e) =>
                e.target.value &&
                upd({
                  date: e.target.value,
                  endDate: e.target.value > form.endDate ? e.target.value : form.endDate,
                })
              }
            />
          </div>
          {form.allDay ? (
            <div className="col-span-2 flex flex-col gap-1">
              <Label htmlFor="ev-end-date">Ends</Label>
              <Input
                id="ev-end-date"
                type="date"
                value={form.endDate}
                min={form.date}
                onChange={(e) => e.target.value && upd({ endDate: e.target.value })}
              />
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="ev-start">Start</Label>
                <Input
                  id="ev-start"
                  type="time"
                  step={300}
                  value={form.start}
                  onChange={(e) => upd({ start: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="ev-end">End</Label>
                <Input
                  id="ev-end"
                  type="time"
                  step={300}
                  value={form.end}
                  onChange={(e) => upd({ end: e.target.value })}
                />
              </div>
            </>
          )}
        </div>
        <p className="-mt-1 text-[11.5px] text-subtle">Times are in {zone}.</p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ev-repeat">Repeat</Label>
          <select
            id="ev-repeat"
            className={selectClass}
            value={form.repeat}
            onChange={(e) => upd({ repeat: e.target.value as Form['repeat'] })}
          >
            {REPEAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {form.repeat === 'custom' && (
            <Input
              aria-label="Custom recurrence rule"
              placeholder="FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH"
              value={form.customRule}
              onChange={(e) => upd({ customRule: e.target.value })}
            />
          )}
          {form.repeat !== 'none' && (
            <span className="text-[11.5px] text-subtle">
              {(() => {
                try {
                  return describeRule(
                    form.repeat === 'custom' ? form.customRule : presetRule(form.repeat, form.date),
                    form.date,
                  );
                } catch {
                  return '';
                }
              })()}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input
            aria-label="Location"
            placeholder="Location"
            value={form.location}
            onChange={(e) => upd({ location: e.target.value })}
          />
          <Input
            aria-label="Link"
            placeholder="Link (https://…)"
            value={form.url}
            onChange={(e) => upd({ url: e.target.value })}
          />
        </div>
        <AutoTextarea
          aria-label="Description"
          placeholder="Notes"
          value={form.description}
          onChange={(e) => upd({ description: e.target.value })}
        />
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <Switch
            checked={form.busy}
            onCheckedChange={(v) => upd({ busy: v })}
            label="Show as busy"
          />{' '}
          Show as busy (counts against your free time)
        </label>
        {error && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{error}</p>
        )}
        <div className="mt-1 flex items-center gap-2">
          {event && (
            <>
              <Button
                variant="ghost"
                className="text-danger hover:bg-danger-soft hover:text-danger"
                onClick={() => {
                  run(deleteEvent(event.id));
                  close();
                }}
              >
                <Trash2 size={14} /> {event.rrule ? 'Delete series' : 'Delete'}
              </Button>
              {event.rrule && editEvent?.occurrenceKey?.includes('@') && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    run(excludeOccurrence(event.id, editEvent.occurrenceKey!.split('@')[1]!));
                    close();
                  }}
                >
                  Delete this one
                </Button>
              )}
            </>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              {event ? 'Save' : 'Add event'}
            </Button>
          </div>
        </div>
        {event?.rrule && (
          <p className="text-[11.5px] text-subtle">
            Changes apply to every occurrence. Today is {formatDateLong(today)}.
          </p>
        )}
      </form>
    </Dialog>
  );
}
