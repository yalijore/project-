import { describe, expect, it } from 'vitest';
import {
  buildCustomRule,
  describeRule,
  endRuleOn,
  expandAllDayEvent,
  expandTimedEvent,
  isValidRule,
  nextOccurrence,
  occurrencesBetween,
  presetRule,
  previousOccurrence,
} from './recurrence';

describe('task recurrence (floating dates)', () => {
  it('generates weekday occurrences', () => {
    expect(
      occurrencesBetween(
        'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
        '2026-09-21',
        '2026-09-24',
        '2026-09-29',
      ),
    ).toEqual(['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29']);
  });

  it('is unaffected by DST transitions', () => {
    expect(occurrencesBetween('FREQ=DAILY', '2026-03-06', '2026-03-07', '2026-03-09')).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
    ]);
  });

  it('skips months without the day and supports last-day rules', () => {
    expect(
      occurrencesBetween('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-31', '2026-01-01', '2026-05-31'),
    ).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
    expect(
      occurrencesBetween('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-01-31', '2026-02-01', '2026-03-31'),
    ).toEqual(['2026-02-28', '2026-03-31']);
  });

  it('honours UNTIL and COUNT', () => {
    const until = endRuleOn('FREQ=DAILY', '2026-09-27');
    expect(occurrencesBetween(until, '2026-09-25', '2026-09-25', '2026-10-05')).toEqual([
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
    ]);
    expect(
      occurrencesBetween('FREQ=DAILY;COUNT=2', '2026-09-25', '2026-09-20', '2026-10-05'),
    ).toHaveLength(2);
  });

  it('finds next and previous occurrences', () => {
    expect(nextOccurrence('FREQ=WEEKLY;BYDAY=MO', '2026-09-21', '2026-09-23')).toBe('2026-09-28');
    expect(nextOccurrence('FREQ=WEEKLY;BYDAY=MO', '2026-09-21', '2026-09-28')).toBe('2026-09-28');
    expect(previousOccurrence('FREQ=WEEKLY;BYDAY=MO', '2026-09-21', '2026-09-27')).toBe(
      '2026-09-21',
    );
    expect(nextOccurrence('FREQ=DAILY;COUNT=1', '2026-09-21', '2026-09-22')).toBeNull();
  });

  it('builds presets and custom rules', () => {
    expect(presetRule('weekly', '2026-09-25')).toBe('FREQ=WEEKLY;BYDAY=FR');
    expect(presetRule('monthly-nth', '2026-09-25')).toBe('FREQ=MONTHLY;BYDAY=+4FR');
    expect(
      buildCustomRule({
        freq: 'WEEKLY',
        interval: 2,
        weekdays: [3, 1],
        end: { kind: 'count', count: 5 },
      }),
    ).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5');
    expect(isValidRule('FREQ=DAILY')).toBe(true);
    expect(isValidRule('nonsense')).toBe(false);
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,WE')).toMatch(/every week on Monday, Wednesday/i);
  });
});

describe('event recurrence (zoned)', () => {
  it('keeps a 09:00 New York meeting at 09:00 local across DST', () => {
    const occ = expandTimedEvent(
      {
        startUtc: '2026-10-26T13:00:00.000Z', // Mon 09:00 EDT
        endUtc: '2026-10-26T13:30:00.000Z',
        tz: 'America/New_York',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        exdates: [],
      },
      Date.parse('2026-10-25T00:00:00Z'),
      Date.parse('2026-11-10T00:00:00Z'),
    );
    expect(occ.map((o) => new Date(o.start).toISOString())).toEqual([
      '2026-10-26T13:00:00.000Z',
      '2026-11-02T14:00:00.000Z', // 09:00 EST after fall-back
      '2026-11-09T14:00:00.000Z',
    ]);
    expect(occ.every((o) => o.end - o.start === 30 * 60_000)).toBe(true);
  });

  it('applies EXDATEs and range clipping', () => {
    const occ = expandTimedEvent(
      {
        startUtc: '2026-09-21T08:00:00.000Z',
        endUtc: '2026-09-21T09:00:00.000Z',
        tz: 'Europe/Berlin',
        rrule: 'FREQ=DAILY;COUNT=5',
        exdates: ['2026-09-23T08:00:00.000Z'],
      },
      Date.parse('2026-09-22T00:00:00Z'),
      Date.parse('2026-09-25T00:00:00Z'),
    );
    expect(occ.map((o) => o.key)).toEqual(['2026-09-22T08:00:00.000Z', '2026-09-24T08:00:00.000Z']);
  });

  it('expands multi-day all-day events', () => {
    const occ = expandAllDayEvent(
      {
        startDate: '2026-09-07',
        endDate: '2026-09-09',
        rrule: 'FREQ=WEEKLY',
        exdates: ['2026-09-14'],
      },
      '2026-09-15',
      '2026-09-30',
    );
    // The 09-14 instance (spanning 14–15) is excluded; 21 and 28 remain.
    expect(occ).toEqual([
      { startDate: '2026-09-21', endDate: '2026-09-23', key: '2026-09-21' },
      { startDate: '2026-09-28', endDate: '2026-09-30', key: '2026-09-28' },
    ]);
  });
});
