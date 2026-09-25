/** Data portability: iCalendar import/export, JSON export of everything, CSV export of tasks. */
import type { ISODate } from '@/domain/dates';
import { dateOfInstant } from '@/domain/dates';
import type { ExportEvent, ParsedCalendar } from '@/domain/ics';
import { generateIcs } from '@/domain/ics';
import { LATEST_SCHEMA_VERSION } from '@/db/migrate';
import { perform } from './actions';
import * as repo from './repo';
import { getDb } from './runtime';
import { getData } from './store';

export async function importParsedIcs(
  parsed: ParsedCalendar,
  target: { calendarId: string } | { newName: string; color: string },
): Promise<{ calendarId: string; created: number; updated: number }> {
  return perform({ label: 'Import calendar' }, async (ctx) => {
    const calendarId =
      'calendarId' in target
        ? target.calendarId
        : await repo.createCalendar(ctx, {
            name: target.newName,
            color: target.color,
            source: 'ics-import',
          });
    const result = await repo.upsertEvents(
      ctx,
      calendarId,
      parsed.events.map((e) => ({
        uid: e.uid,
        recurrenceId: e.recurrenceId,
        title: e.title,
        description: e.description,
        location: e.location,
        url: e.url,
        allDay: e.allDay,
        startUtc: e.startUtc,
        endUtc: e.endUtc,
        startDate: e.startDate,
        endDate: e.endDate,
        tz: e.tz,
        rrule: e.rrule,
        exdates: e.exdates,
        rdates: e.rdates,
        status: e.status,
        busy: e.busy,
      })),
    );
    return { calendarId, created: result.created, updated: result.updated };
  });
}

/** Builds an .ics for the given calendars, optionally including Keel's time blocks. */
export function buildCalendarIcs(
  calendarIds: string[],
  includeBlocks: boolean,
  name: string,
): string {
  const { events, blocks, tasks } = getData();
  const out: ExportEvent[] = [];
  for (const e of Object.values(events)) {
    if (!calendarIds.includes(e.calendarId)) continue;
    out.push({
      uid: e.uid ?? `${e.id}@keel.local`,
      title: e.title,
      description: e.description,
      location: e.location,
      url: e.url,
      allDay: e.allDay,
      startUtc: e.startUtc,
      endUtc: e.endUtc,
      startDate: e.startDate,
      endDate: e.endDate,
      tz: e.tz,
      rrule: e.rrule,
      exdates: e.exdates,
      rdates: e.rdates,
      recurrenceId: e.recurrenceId,
      status: e.status,
      busy: e.busy,
    });
  }
  if (includeBlocks) {
    for (const b of Object.values(blocks)) {
      const t = tasks[b.taskId];
      if (!t) continue;
      out.push({
        uid: `${b.id}@keel.timeblock`,
        title: t.title,
        description: t.notes,
        allDay: false,
        startUtc: b.startUtc,
        endUtc: b.endUtc,
        tz: b.tz,
        categories: ['Keel time block'],
      });
    }
  }
  return generateIcs(name, out);
}

/** A complete, versioned JSON document of everything Keel stores (secrets are never stored in the DB). */
export async function buildJsonExport(): Promise<string> {
  const snap = await repo.loadSnapshot(getDb());
  const doc = {
    format: 'keel-export',
    formatVersion: 1,
    schemaVersion: LATEST_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    timeZone: getData().zone,
    ...snap,
  };
  return JSON.stringify(doc, null, 2);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Guard against spreadsheet formula injection when the CSV is opened in Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function buildTasksCsv(): string {
  const { tasks, projects, areas, tags, sessions, zone } = getData();
  const tracked = new Map<string, number>();
  for (const s of Object.values(sessions)) {
    const end = s.endUtc ? Date.parse(s.endUtc) : Date.now();
    tracked.set(s.taskId, (tracked.get(s.taskId) ?? 0) + (end - Date.parse(s.startUtc)) / 60_000);
  }
  const header = [
    'id',
    'title',
    'status',
    'planned_date',
    'due_date',
    'estimate_minutes',
    'tracked_minutes',
    'priority',
    'project',
    'area',
    'tags',
    'subtasks_done',
    'subtasks_total',
    'carried_forward',
    'repeats',
    'created',
    'completed',
    'notes',
  ];
  const rows = Object.values(tasks)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((t) => [
      t.id,
      t.title,
      t.completedAt ? 'done' : t.archivedAt ? 'archived' : 'open',
      t.planDate,
      t.dueDate,
      t.estimateMin,
      Math.round(tracked.get(t.id) ?? 0),
      t.priority,
      t.projectId ? projects[t.projectId]?.name : '',
      (t.areaId ? areas[t.areaId]?.name : '') ?? '',
      t.tagIds
        .map((id) => tags[id]?.name)
        .filter(Boolean)
        .join('; '),
      t.subtasks.filter((s) => s.completedAt).length,
      t.subtasks.length,
      t.rolloverCount,
      t.recurrenceId ? 'yes' : 'no',
      dateOfInstant(t.createdAt, zone),
      t.completedAt ? dateOfInstant(t.completedAt, zone) : '',
      t.notes,
    ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function exportFileName(kind: string, ext: string, date: ISODate = getData().today): string {
  return `keel-${kind}-${date}.${ext}`;
}
