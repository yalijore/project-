/** Turns stored calendar events (including recurring series and overrides) into occurrences. */
import type { ISODate } from './dates';
import { addDays, dayBounds } from './dates';
import { expandAllDayEvent, expandTimedEvent } from './recurrence';
import type { Calendar, CalendarEvent, EventOccurrence } from './types';

export function expandEvents(
  events: CalendarEvent[],
  calendars: Record<string, Calendar>,
  from: ISODate,
  to: ISODate,
  zone: string,
  opts: { includeHidden?: boolean } = {},
): EventOccurrence[] {
  const rangeStart = Date.parse(dayBounds(from, zone).start);
  const rangeEnd = Date.parse(dayBounds(to, zone).end);
  const out: EventOccurrence[] = [];

  // Overrides (RECURRENCE-ID) replace the generated instance with the same original start.
  const overridden = new Set<string>();
  for (const e of events) {
    if (e.recurrenceId && e.uid) overridden.add(`${e.calendarId}|${e.uid}|${e.recurrenceId}`);
  }

  for (const e of events) {
    const cal = calendars[e.calendarId];
    if (!cal || (!cal.isVisible && !opts.includeHidden)) continue;
    if (e.status === 'cancelled') continue;

    if (e.rrule && !e.recurrenceId) {
      if (e.allDay && e.startDate && e.endDate) {
        for (const o of expandAllDayEvent(
          { startDate: e.startDate, endDate: e.endDate, rrule: e.rrule, exdates: e.exdates },
          from,
          to,
        )) {
          if (overridden.has(`${e.calendarId}|${e.uid}|${o.key}`)) continue;
          out.push({
            key: `${e.id}@${o.key}`,
            event: e,
            allDay: true,
            start: Date.parse(dayBounds(o.startDate, zone).start),
            end: Date.parse(dayBounds(addDays(o.endDate, -1), zone).end),
            startDate: o.startDate,
            endDate: o.endDate,
          });
        }
      } else if (e.startUtc && e.endUtc) {
        for (const o of expandTimedEvent(
          {
            startUtc: e.startUtc,
            endUtc: e.endUtc,
            tz: e.tz ?? zone,
            rrule: e.rrule,
            exdates: e.exdates,
          },
          rangeStart,
          rangeEnd,
        )) {
          if (overridden.has(`${e.calendarId}|${e.uid}|${o.key}`)) continue;
          out.push({
            key: `${e.id}@${o.key}`,
            event: e,
            allDay: false,
            start: o.start,
            end: o.end,
            startDate: null,
            endDate: null,
          });
        }
      }
      continue;
    }

    if (e.allDay && e.startDate && e.endDate) {
      if (e.startDate <= to && e.endDate > from) {
        out.push({
          key: e.id,
          event: e,
          allDay: true,
          start: Date.parse(dayBounds(e.startDate, zone).start),
          end: Date.parse(dayBounds(addDays(e.endDate, -1), zone).end),
          startDate: e.startDate,
          endDate: e.endDate,
        });
      }
    } else if (e.startUtc && e.endUtc) {
      const start = Date.parse(e.startUtc);
      const end = Date.parse(e.endUtc);
      if (start < rangeEnd && (end > rangeStart || (end === start && start >= rangeStart))) {
        out.push({
          key: e.id,
          event: e,
          allDay: false,
          start,
          end,
          startDate: null,
          endDate: null,
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** All-day occurrence covers `date`? (end date exclusive) */
export function coversDate(o: EventOccurrence, date: ISODate): boolean {
  return !!o.startDate && !!o.endDate && o.startDate <= date && o.endDate > date;
}
