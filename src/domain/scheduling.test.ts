import { describe, expect, it } from 'vitest';
import {
  MINUTE,
  findConflicts,
  findSlot,
  freeSlots,
  layoutOverlapping,
  mergeIntervals,
  packIntoSlots,
  subtractIntervals,
  totalMinutes,
  workingInterval,
} from './scheduling';

const T0 = Date.parse('2026-09-25T13:00:00Z'); // 09:00 New York
const at = (min: number) => T0 + min * MINUTE;
const iv = (a: number, b: number) => ({ start: at(a), end: at(b) });

describe('interval math', () => {
  it('merges overlapping and touching intervals', () => {
    expect(mergeIntervals([iv(0, 30), iv(30, 60), iv(90, 120), iv(100, 110)])).toEqual([
      iv(0, 60),
      iv(90, 120),
    ]);
  });

  it('subtracts busy time', () => {
    expect(subtractIntervals([iv(0, 480)], [iv(60, 120), iv(100, 180), iv(400, 600)])).toEqual([
      iv(0, 60),
      iv(180, 400),
    ]);
  });

  it('counts overlapping time once', () => {
    expect(totalMinutes([iv(0, 60), iv(30, 90)])).toBe(90);
  });
});

describe('free slots and auto-scheduling', () => {
  const window = iv(0, 8 * 60);

  it('pads meetings with the buffer and respects "from"', () => {
    const slots = freeSlots(window, [iv(60, 120)], 10, at(15));
    expect(slots).toEqual([iv(15, 50), iv(130, 480)]);
  });

  it('finds the first slot that fits, aligned to the step', () => {
    const slots = [iv(3, 20), iv(40, 200)];
    expect(findSlot(slots, 30, 15)).toEqual(iv(45, 75));
    expect(findSlot(slots, 500, 15)).toBeNull();
  });

  it('packs items in order and reports the ones that do not fit', () => {
    const r = packIntoSlots(
      [
        { id: 'a', durationMin: 60 },
        { id: 'b', durationMin: 400 },
        { id: 'c', durationMin: 30 },
      ],
      window,
      [iv(60, 120)],
      0,
    );
    expect(r.placed).toEqual([
      { id: 'a', interval: iv(0, 60) },
      { id: 'c', interval: iv(120, 150) },
    ]);
    expect(r.unplaced).toEqual(['b']);
  });

  it('computes working hours on working days only', () => {
    const wh = { days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 };
    const fri = workingInterval('2026-09-25', 5, wh, 'America/New_York');
    expect(fri).toEqual({ start: at(0), end: at(8 * 60) });
    expect(workingInterval('2026-09-26', 6, wh, 'America/New_York')).toBeNull();
  });
});

describe('calendar layout and conflicts', () => {
  it('assigns columns to overlapping items and resets between clusters', () => {
    const layout = layoutOverlapping([
      { id: 'a', start: at(0), end: at(60) },
      { id: 'b', start: at(30), end: at(90) },
      { id: 'c', start: at(60), end: at(120) },
      { id: 'd', start: at(200), end: at(230) },
    ]);
    expect(layout.get('a')).toEqual({ column: 0, columns: 2 });
    expect(layout.get('b')).toEqual({ column: 1, columns: 2 });
    expect(layout.get('c')).toEqual({ column: 0, columns: 2 });
    expect(layout.get('d')).toEqual({ column: 0, columns: 1 });
  });

  it('reports block conflicts with busy events and other blocks, not free events', () => {
    const conflicts = findConflicts([
      { id: 'block1', kind: 'block', interval: iv(0, 60), busy: true },
      { id: 'meeting', kind: 'event', interval: iv(30, 90), busy: true },
      { id: 'free-event', kind: 'event', interval: iv(0, 60), busy: false },
      { id: 'block2', kind: 'block', interval: iv(50, 70), busy: true },
      { id: 'ev2', kind: 'event', interval: iv(300, 330), busy: true },
      { id: 'ev3', kind: 'event', interval: iv(300, 330), busy: true },
    ]);
    expect(conflicts).toEqual([
      ['block1', 'meeting'],
      ['block1', 'block2'],
      ['meeting', 'block2'],
    ]);
  });
});
