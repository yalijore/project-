import { describe, expect, it } from 'vitest';
import {
  buildVTimezone,
  foldLine,
  generateIcs,
  parseIcs,
  resolveTzid,
  zoneTransitions,
} from './ics';
import { expandTimedEvent } from './recurrence';

const OUTLOOK = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN',
  'VERSION:2.0',
  'X-WR-CALNAME:Work',
  'BEGIN:VTIMEZONE',
  'TZID:Pacific Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16011104T020000',
  'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11',
  'TZOFFSETFROM:-0700',
  'TZOFFSETTO:-0800',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010311T020000',
  'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3',
  'TZOFFSETFROM:-0800',
  'TZOFFSETTO:-0700',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:040000008200E00074C5B7101A82E008',
  'SUMMARY:Weekly sync',
  'DTSTART;TZID=Pacific Standard Time:20260928T100000',
  'DTEND;TZID=Pacific Standard Time:20260928T103000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'EXDATE;TZID=Pacific Standard Time:20261005T100000',
  'LOCATION:Teams',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:040000008200E00074C5B7101A82E008',
  'RECURRENCE-ID;TZID=Pacific Standard Time:20261012T100000',
  'SUMMARY:Weekly sync (moved)',
  'DTSTART;TZID=Pacific Standard Time:20261013T110000',
  'DTEND;TZID=Pacific Standard Time:20261013T113000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('ICS import', () => {
  it('maps Windows time zone names and keeps recurrence, exceptions and overrides', () => {
    const cal = parseIcs(OUTLOOK, 'Europe/Berlin');
    expect(cal.name).toBe('Work');
    expect(cal.warnings).toEqual([]);
    const [series, override] = cal.events;
    expect(series).toMatchObject({
      title: 'Weekly sync',
      tz: 'America/Los_Angeles',
      startUtc: '2026-09-28T17:00:00.000Z',
      endUtc: '2026-09-28T17:30:00.000Z',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      exdates: ['2026-10-05T17:00:00.000Z'],
      location: 'Teams',
      allDay: false,
    });
    expect(override).toMatchObject({
      recurrenceId: '2026-10-12T17:00:00.000Z',
      startUtc: '2026-10-13T18:00:00.000Z',
    });
  });

  it('parses all-day, UTC, tentative/free events, escaped text and folded lines', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:a',
      'SUMMARY:Offsite\\, day 1\\; bring laptop',
      'DTSTART;VALUE=DATE:20261001',
      'DTEND;VALUE=DATE:20261003',
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:b',
      'SUMMARY:Call',
      'DESCRIPTION:Line one\\nLine two that is quite long and needs to be folded because it',
      '  goes past seventy five octets',
      'DTSTART:20261001T150000Z',
      'DURATION:PT45M',
      'STATUS:TENTATIVE',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const [allDay, call] = parseIcs(text, 'America/New_York').events;
    expect(allDay).toMatchObject({
      allDay: true,
      startDate: '2026-10-01',
      endDate: '2026-10-03',
      busy: false,
      title: 'Offsite, day 1; bring laptop',
    });
    expect(call).toMatchObject({
      startUtc: '2026-10-01T15:00:00.000Z',
      endUtc: '2026-10-01T15:45:00.000Z',
      status: 'tentative',
    });
    expect(call!.description).toBe(
      'Line one\nLine two that is quite long and needs to be folded because it goes past seventy five octets',
    );
  });

  it('treats floating times as local and rejects non-calendar text', () => {
    const text =
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:f\r\nSUMMARY:Floating\r\nDTSTART:20261001T090000\r\nDTEND:20261001T100000\r\nEND:VEVENT\r\nEND:VCALENDAR';
    expect(parseIcs(text, 'Asia/Tokyo').events[0]!.startUtc).toBe('2026-10-01T00:00:00.000Z');
    expect(() => parseIcs('hello', 'UTC')).toThrow(/not a valid iCalendar/);
  });

  it('resolves IANA, Windows and Mozilla-style TZIDs', () => {
    expect(resolveTzid('Europe/Paris')).toBe('Europe/Paris');
    expect(resolveTzid('W. Europe Standard Time')).toBe('Europe/Berlin');
    expect(resolveTzid('/mozilla.org/20050126_1/America/Chicago')).toBe('America/Chicago');
    expect(resolveTzid('Mars Standard Time')).toBeNull();
  });
});

describe('ICS export', () => {
  it('folds long lines at 75 octets without splitting characters', () => {
    const folded = foldLine(`SUMMARY:${'é'.repeat(60)}`);
    for (const part of folded.split('\r\n'))
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'é'.repeat(60)}`);
  });

  it('computes DST transitions for VTIMEZONE', () => {
    const tr = zoneTransitions('America/New_York', Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1));
    expect(tr.map((t) => new Date(t.at).toISOString())).toEqual([
      '2026-03-08T07:00:00.000Z',
      '2026-11-01T06:00:00.000Z',
    ]);
    const vtz = buildVTimezone('America/New_York', 2026, 2026).join('\n');
    expect(vtz).toContain(
      'BEGIN:DAYLIGHT\nDTSTART:20260308T020000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400',
    );
    expect(vtz).toContain(
      'BEGIN:STANDARD\nDTSTART:20261101T020000\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500',
    );
  });

  it('round-trips a recurring local-time event across DST', () => {
    const ics = generateIcs('Mine', [
      {
        uid: 'x@keel',
        title: 'Standup, daily',
        allDay: false,
        startUtc: '2026-10-26T13:00:00.000Z',
        endUtc: '2026-10-26T13:15:00.000Z',
        tz: 'America/New_York',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        exdates: ['2026-11-09T14:00:00.000Z'],
      },
      {
        uid: 'y@keel',
        title: 'Holiday',
        allDay: true,
        startDate: '2026-12-25',
        endDate: '2026-12-26',
        busy: false,
      },
    ]);
    expect(ics).toContain('DTSTART;TZID=America/New_York:20261026T090000');
    expect(ics).toContain('SUMMARY:Standup\\, daily');
    const parsed = parseIcs(ics, 'Europe/London');
    const e = parsed.events[0]!;
    expect(e.tz).toBe('America/New_York');
    const occ = expandTimedEvent(
      { startUtc: e.startUtc!, endUtc: e.endUtc!, tz: e.tz, rrule: e.rrule!, exdates: e.exdates },
      Date.parse('2026-10-25T00:00:00Z'),
      Date.parse('2026-11-17T00:00:00Z'),
    );
    expect(occ.map((o) => o.key)).toEqual([
      '2026-10-26T13:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
      '2026-11-16T14:00:00.000Z',
    ]);
    expect(parsed.events[1]).toMatchObject({
      allDay: true,
      startDate: '2026-12-25',
      endDate: '2026-12-26',
      busy: false,
    });
  });
});
