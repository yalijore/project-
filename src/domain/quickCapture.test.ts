import { describe, expect, it } from 'vitest';
import type { CaptureContext } from './quickCapture';
import { parseCapture } from './quickCapture';

const ctx: CaptureContext = {
  today: '2026-09-25', // Friday
  weekStartsOn: 1,
  projects: [
    { id: 'p1', name: 'Website Redesign' },
    { id: 'p2', name: 'Taxes' },
  ],
  areas: [{ id: 'a1', name: 'Health' }],
  tags: [{ id: 't1', name: 'writing' }],
};

describe('quick capture parsing', () => {
  it('extracts every kind of token and leaves a clean title', () => {
    const r = parseCapture(
      'Draft homepage copy tomorrow 45m #website @writing @urgent !high due oct 3',
      ctx,
    );
    expect(r.title).toBe('Draft homepage copy');
    expect(r.planDate).toBe('2026-09-26');
    expect(r.estimateMin).toBe(45);
    expect(r.projectId).toBe('p1');
    expect(r.tagIds).toEqual(['t1']);
    expect(r.newTags).toEqual(['urgent']);
    expect(r.priority).toBe(3);
    expect(r.dueDate).toBe('2026-10-03');
  });

  it('resolves weekdays, next week, relative days and ISO dates', () => {
    expect(parseCapture('Call mon', ctx).planDate).toBe('2026-09-28');
    expect(parseCapture('Call fri', ctx).planDate).toBe('2026-09-25');
    expect(parseCapture('Call next fri', ctx).planDate).toBe('2026-10-02');
    expect(parseCapture('Call next week', ctx).planDate).toBe('2026-09-28');
    expect(parseCapture('Call in 3 days', ctx).planDate).toBe('2026-09-28');
    expect(parseCapture('Call 2026-12-01', ctx).planDate).toBe('2026-12-01');
    expect(parseCapture('Renew passport jan 5', ctx).planDate).toBe('2027-01-05');
  });

  it('distinguishes planned date from deadline', () => {
    const r = parseCapture('File taxes #taxes today due:2026-10-15', ctx);
    expect(r.planDate).toBe('2026-09-25');
    expect(r.dueDate).toBe('2026-10-15');
    expect(r.projectId).toBe('p2');
  });

  it('parses times, recurrence and backlog', () => {
    const r = parseCapture('Standup notes every weekday at 9:30am 15m', ctx);
    expect(r.repeat).toBe('weekdays');
    expect(r.startMin).toBe(9 * 60 + 30);
    expect(r.estimateMin).toBe(15);
    expect(r.title).toBe('Standup notes');
    expect(parseCapture('Learn piano someday', ctx).planDate).toBeNull();
    expect(parseCapture('Water plants every mon', ctx).repeat).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
    });
  });

  it('does not parse quoted text or bare numbers', () => {
    const r = parseCapture('"Monday notes" buy 2 apples', ctx);
    expect(r.title).toBe('Monday notes buy 2 apples');
    expect(r.planDate).toBeUndefined();
    expect(r.estimateMin).toBeNull();
  });

  it('lets the user turn a recognized token back into text', () => {
    const first = parseCapture('Read Monday notes', ctx);
    expect(first.title).toBe('Read notes');
    const token = first.tokens.find((t) => t.kind === 'plan')!;
    const second = parseCapture('Read Monday notes', ctx, new Set([token.key]));
    expect(second.title).toBe('Read Monday notes');
    expect(second.planDate).toBeUndefined();
  });

  it('ignores unknown projects and ambiguous bare times', () => {
    const r = parseCapture('Ship #nonexistent at 3', ctx);
    expect(r.projectId).toBeNull();
    expect(r.startMin).toBeNull();
    expect(r.title).toBe('Ship #nonexistent at 3');
  });

  it('matches a word inside a project name when unambiguous', () => {
    expect(parseCapture('Ship it #redesign', ctx).projectId).toBe('p1');
    expect(parseCapture('Ship it #website', ctx).projectId).toBe('p1');
  });

  it('matches areas when no project matches', () => {
    expect(parseCapture('Run 5k #health', ctx).areaId).toBe('a1');
  });
});
