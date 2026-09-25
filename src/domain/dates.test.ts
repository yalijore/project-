import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayBounds,
  diffDays,
  formatDuration,
  formatElapsed,
  formatTime,
  minutesIntoDay,
  parseClock,
  parseDuration,
  relativeDateLabel,
  startOfWeek,
  todayIn,
  wallTimeToInstant,
} from './dates';

describe('floating dates', () => {
  it('adds days across DST and month/year boundaries without drifting', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(diffDays('2026-10-20', '2026-11-03')).toBe(14);
  });

  it('computes week starts for Monday, Sunday and Saturday weeks', () => {
    // 2026-09-25 is a Friday
    expect(startOfWeek('2026-09-25', 1)).toBe('2026-09-21');
    expect(startOfWeek('2026-09-25', 7)).toBe('2026-09-20');
    expect(startOfWeek('2026-09-25', 6)).toBe('2026-09-19');
    expect(startOfWeek('2026-09-21', 1)).toBe('2026-09-21');
  });

  it('determines "today" in the requested zone', () => {
    const instant = new Date('2026-09-25T02:30:00Z');
    expect(todayIn('America/New_York', instant)).toBe('2026-09-24');
    expect(todayIn('Europe/Berlin', instant)).toBe('2026-09-25');
    expect(todayIn('Pacific/Kiritimati', instant)).toBe('2026-09-25');
  });

  it('labels relative dates', () => {
    expect(relativeDateLabel('2026-09-25', '2026-09-25')).toBe('Today');
    expect(relativeDateLabel('2026-09-26', '2026-09-25')).toBe('Tomorrow');
    expect(relativeDateLabel('2026-09-24', '2026-09-25')).toBe('Yesterday');
    expect(relativeDateLabel('2026-09-29', '2026-09-25')).toBe('Tuesday');
  });
});

describe('zoned wall-clock times', () => {
  it('has 23- and 25-hour days at DST transitions', () => {
    const spring = dayBounds('2026-03-08', 'America/New_York');
    expect((Date.parse(spring.end) - Date.parse(spring.start)) / 3.6e6).toBe(23);
    const fall = dayBounds('2026-11-01', 'America/New_York');
    expect((Date.parse(fall.end) - Date.parse(fall.start)) / 3.6e6).toBe(25);
  });

  it('keeps 09:00 local across the DST change', () => {
    expect(wallTimeToInstant('2026-03-07', 9 * 60, 'America/New_York')).toBe(
      '2026-03-07T14:00:00.000Z',
    );
    expect(wallTimeToInstant('2026-03-09', 9 * 60, 'America/New_York')).toBe(
      '2026-03-09T13:00:00.000Z',
    );
  });

  it('moves non-existent spring-forward times past the gap', () => {
    // 02:30 does not exist on 2026-03-08 in New York.
    const t = wallTimeToInstant('2026-03-08', 2 * 60 + 30, 'America/New_York');
    expect(formatTime(t, 'America/New_York', false)).toBe('03:30');
  });

  it('treats 24:00 as the start of the next day', () => {
    expect(wallTimeToInstant('2026-09-25', 24 * 60, 'UTC')).toBe('2026-09-26T00:00:00.000Z');
  });

  it('measures minutes into a day from local midnight', () => {
    expect(minutesIntoDay('2026-09-25T13:30:00.000Z', '2026-09-25', 'America/New_York')).toBe(
      9 * 60 + 30,
    );
  });

  it('formats times in 12h and 24h', () => {
    expect(formatTime('2026-09-25T13:00:00.000Z', 'America/New_York', true)).toBe('9am');
    expect(formatTime('2026-09-25T17:45:00.000Z', 'America/New_York', true)).toBe('1:45pm');
    expect(formatTime('2026-09-25T17:45:00.000Z', 'Europe/Berlin', false)).toBe('19:45');
  });
});

describe('durations', () => {
  it('parses many human formats', () => {
    expect(parseDuration('45')).toBe(45);
    expect(parseDuration('45m')).toBe(45);
    expect(parseDuration('1h')).toBe(60);
    expect(parseDuration('1.5h')).toBe(90);
    expect(parseDuration('1h30')).toBe(90);
    expect(parseDuration('1h 30m')).toBe(90);
    expect(parseDuration('1:15')).toBe(75);
    expect(parseDuration('90 min')).toBe(90);
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });

  it('formats durations and elapsed timers', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(120)).toBe('2h');
    expect(formatDuration(95)).toBe('1h 35m');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
  });

  it('parses clock strings', () => {
    expect(parseClock('09:30')).toBe(570);
    expect(() => parseClock('25:00')).toThrow();
  });
});
