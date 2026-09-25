import { useState } from 'react';
import { toast } from 'sonner';
import { Download, Lock, Plus, Trash2, Upload } from 'lucide-react';
import { native } from '@/app/native';
import {
  createCalendar,
  errorMessage,
  run,
  updateCalendar,
  deleteCalendar,
  saveSettings,
} from '@/data/actions';
import { buildCalendarIcs, exportFileName, importParsedIcs } from '@/data/importExport';
import { useData } from '@/data/store';
import type { ParsedCalendar } from '@/domain/ics';
import { parseIcs } from '@/domain/ics';
import { PALETTE } from '@/domain/types';
import {
  Button,
  ColorDot,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Label,
  Popover,
  Switch,
  Tooltip,
  cn,
} from '@/ui/primitives';
import { ViewHeader } from '../common/ViewHeader';

const SOURCE_LABEL: Record<string, string> = {
  local: 'On this computer',
  'ics-import': 'Imported .ics file (editable copy)',
  'ics-subscription': 'Subscribed URL (read-only, syncs over the network)',
  google: 'Google Calendar (read-only, syncs over the network)',
  microsoft: 'Outlook (read-only, syncs over the network)',
};

function ImportDialog({
  parsed,
  fileName,
  onClose,
}: {
  parsed: ParsedCalendar;
  fileName: string;
  onClose: () => void;
}) {
  const calendars = useData((s) => s.calendars);
  const local = Object.values(calendars).filter(
    (c) => c.isWritable && (c.source === 'local' || c.source === 'ics-import'),
  );
  const [target, setTarget] = useState<string>('new');
  const [name, setName] = useState(parsed.name ?? fileName.replace(/\.ics$/i, ''));
  const [busy, setBusy] = useState(false);
  const recurring = parsed.events.filter((e) => e.rrule).length;
  const allDay = parsed.events.filter((e) => e.allDay).length;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Import calendar file"
      description={fileName}
      width={480}
    >
      <div className="flex flex-col gap-3 px-5 pt-2 pb-5 text-[13px]">
        <p>
          Found <strong>{parsed.events.length}</strong> event{parsed.events.length === 1 ? '' : 's'}{' '}
          ({recurring} repeating, {allDay} all-day). Keel keeps a local copy; the file itself is not
          modified. Importing the same file again updates events instead of duplicating them.
        </p>
        {parsed.warnings.map((w) => (
          <p key={w} className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-fg">
            {w}
          </p>
        ))}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="imp-target">Import into</Label>
          <select
            id="imp-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="h-8.5 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg"
          >
            <option value="new">A new calendar</option>
            {local.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {target === 'new' && (
          <Input
            aria-label="New calendar name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || parsed.events.length === 0 || (target === 'new' && !name.trim())}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await importParsedIcs(
                  parsed,
                  target === 'new'
                    ? {
                        newName: name.trim(),
                        color: PALETTE[Object.keys(calendars).length % PALETTE.length]!,
                      }
                    : { calendarId: target },
                );
                toast.success(
                  `Imported ${r.created} new and updated ${r.updated} event${r.updated === 1 ? '' : 's'}`,
                );
                onClose();
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Import
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function CalendarsView() {
  const calendars = useData((s) => s.calendars);
  const events = useData((s) => s.events);
  const zone = useData((s) => s.zone);
  const defaultCalendarId = useData((s) => s.settings.defaultCalendarId);
  const [importing, setImporting] = useState<{ parsed: ParsedCalendar; name: string } | null>(null);
  const [newName, setNewName] = useState('');
  const list = Object.values(calendars).sort((a, b) => a.sortOrder - b.sortOrder);
  const counts = new Map<string, number>();
  for (const e of Object.values(events))
    counts.set(e.calendarId, (counts.get(e.calendarId) ?? 0) + 1);

  const doImport = async () => {
    try {
      const file = await native.openText('iCalendar', ['ics', 'ical', 'ifb', 'icalendar']);
      if (!file) return;
      setImporting({ parsed: parseIcs(file.contents, zone), name: file.name });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const doExport = async (ids: string[], includeBlocks: boolean, label: string) => {
    try {
      const ics = buildCalendarIcs(ids, includeBlocks, label);
      const path = await native.saveText(
        exportFileName(label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), 'ics'),
        'iCalendar',
        ['ics'],
        ics,
      );
      if (path) toast.success(`Exported to ${path}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title="Calendars"
        subtitle="Local calendars work offline; nothing is uploaded"
        right={
          <>
            <Button size="sm" variant="secondary" onClick={() => void doImport()}>
              <Upload size={14} /> Import .ics
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void doExport(
                  list.map((c) => c.id),
                  true,
                  'Keel',
                )
              }
            >
              <Download size={14} /> Export all
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3">
          {list.length === 0 && (
            <EmptyState title="No calendars">Create one below to add events.</EmptyState>
          )}
          {list.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-sm"
            >
              <Popover
                trigger={
                  <button
                    type="button"
                    aria-label={`Color of ${c.name}`}
                    className="rounded-full p-1 hover:bg-sunken"
                  >
                    <ColorDot color={c.color} size={14} />
                  </button>
                }
              >
                <div className="grid grid-cols-5 gap-1.5 p-1">
                  {PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={color}
                      onClick={() => run(updateCalendar(c.id, { color }))}
                      className={cn(
                        'h-7 w-7 rounded-full border-2',
                        color === c.color ? 'border-fg' : 'border-transparent',
                      )}
                      style={{ background: color }}
                    />
                  ))}
                </div>
              </Popover>
              <div className="min-w-0 flex-1">
                <input
                  aria-label="Calendar name"
                  defaultValue={c.name}
                  onBlur={(e) =>
                    e.target.value.trim() &&
                    e.target.value !== c.name &&
                    run(updateCalendar(c.id, { name: e.target.value }))
                  }
                  className="w-full rounded bg-transparent px-1 text-[13.5px] font-medium outline-none hover:bg-sunken focus:bg-sunken"
                />
                <div className="flex items-center gap-2 px-1 text-[11.5px] text-muted">
                  {!c.isWritable && <Lock size={11} />}
                  {SOURCE_LABEL[c.source] ?? c.source} · {counts.get(c.id) ?? 0} event
                  {counts.get(c.id) === 1 ? '' : 's'}
                  {c.id === defaultCalendarId && (
                    <span className="rounded bg-accent-soft px-1 text-accent-text">default</span>
                  )}
                </div>
              </div>
              <Tooltip content="Show this calendar in Keel">
                <label className="flex items-center gap-1.5 text-[12px] text-muted">
                  <Switch
                    checked={c.isVisible}
                    onCheckedChange={(v) => run(updateCalendar(c.id, { isVisible: v }))}
                    label={`Show ${c.name}`}
                  />{' '}
                  Show
                </label>
              </Tooltip>
              <Tooltip content="Events on this calendar block time for workload and auto-timeboxing">
                <label className="flex items-center gap-1.5 text-[12px] text-muted">
                  <Switch
                    checked={c.countsForAvailability}
                    onCheckedChange={(v) => run(updateCalendar(c.id, { countsForAvailability: v }))}
                    label={`${c.name} counts as busy`}
                  />{' '}
                  Busy
                </label>
              </Tooltip>
              {c.isWritable && c.id !== defaultCalendarId && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => run(saveSettings({ defaultCalendarId: c.id }))}
                >
                  Make default
                </Button>
              )}
              <IconButton
                label={`Export ${c.name}`}
                onClick={() => void doExport([c.id], false, c.name)}
              >
                <Download size={14} />
              </IconButton>
              {!c.accountId && (
                <IconButton label={`Delete ${c.name}`} onClick={() => run(deleteCalendar(c.id))}>
                  <Trash2 size={14} />
                </IconButton>
              )}
            </div>
          ))}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim())
                run(createCalendar(newName.trim(), PALETTE[list.length % PALETTE.length]!));
              setNewName('');
            }}
          >
            <Input
              aria-label="New calendar name"
              placeholder="New local calendar name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={!newName.trim()}>
              <Plus size={14} /> Add calendar
            </Button>
          </form>
          <p className="text-[12px] text-subtle">
            To see Google or Outlook events, connect them under Integrations, or import an .ics
            export. Keel never modifies events it did not create. “Export all” includes your time
            blocks so you can view your plan in another calendar app.
          </p>
        </div>
      </div>
      {importing && (
        <ImportDialog
          parsed={importing.parsed}
          fileName={importing.name}
          onClose={() => setImporting(null)}
        />
      )}
    </div>
  );
}
