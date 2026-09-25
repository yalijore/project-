/**
 * Natural-language quick capture:  "Draft report tomorrow 45m #Work @writing !high due fri"
 *
 *   #project / #area      @tag (new tags allowed)        !high !med !low  (!3 !2 !1)
 *   45m 1h 1h30m 1.5h     today tomorrow mon…sun "next week" "in 3 days" oct 3, 2026-10-03
 *   due <date> / by <date>     at 3pm / at 15:30      every day|weekday|week|month|year|monday…
 *   someday / backlog → explicitly unplanned.   "quoted text" is never parsed.
 *
 * Every recognized piece is reported as a token so the UI can show it and let the user
 * turn it back into plain title text.
 */
import type { ISODate } from './dates';
import { addDays, isoWeekday, parseDuration, startOfWeek } from './dates';
import type { RepeatPreset } from './recurrence';
import type { Priority } from './types';

export type TokenKind =
  | 'plan'
  | 'due'
  | 'estimate'
  | 'priority'
  | 'project'
  | 'area'
  | 'tag'
  | 'time'
  | 'repeat'
  | 'backlog';

export interface CaptureToken {
  kind: TokenKind;
  /** Stable key (source start index) used to disable a token. */
  key: string;
  text: string;
  label: string;
}

export interface NamedRef {
  id: string;
  name: string;
}

export interface CaptureContext {
  today: ISODate;
  weekStartsOn: number;
  projects: NamedRef[];
  areas: NamedRef[];
  tags: NamedRef[];
}

export interface CaptureResult {
  title: string;
  planDate: ISODate | null | undefined; // undefined = not specified, null = explicitly backlog
  dueDate: ISODate | null;
  estimateMin: number | null;
  priority: Priority | null;
  projectId: string | null;
  areaId: string | null;
  tagIds: string[];
  newTags: string[];
  /** Minutes after midnight to timebox at, on the planned day (or today). */
  startMin: number | null;
  repeat: RepeatPreset | { rrule: string } | null;
  tokens: CaptureToken[];
}

const WEEKDAYS: Record<string, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 7,
  sunday: 7,
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const RRULE_DAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

interface Word {
  text: string;
  lower: string;
  start: number;
  quoted: boolean;
}

function tokenize(input: string): Word[] {
  const words: Word[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    if (m[1] !== undefined) {
      words.push({ text: m[1], lower: m[1].toLowerCase(), start: m.index, quoted: true });
    } else {
      const text = m[2]!;
      words.push({
        text,
        lower: text.toLowerCase().replace(/[,.;]$/, ''),
        start: m.index,
        quoted: false,
      });
    }
  }
  return words;
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function matchRef(query: string, refs: NamedRef[]): NamedRef | null {
  const q = normalizeName(query);
  if (!q) return null;
  const exact = refs.find((r) => normalizeName(r.name) === q);
  if (exact) return exact;
  const prefix = refs.filter((r) => normalizeName(r.name).startsWith(q));
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) return null;
  // Otherwise match the start of any word: "#launch" → "Q4 Launch".
  const word = refs.filter((r) =>
    r.name.split(/[\s\-_/]+/).some((w) => normalizeName(w).startsWith(q)),
  );
  return word.length === 1 ? word[0]! : null;
}

function nextWeekday(today: ISODate, weekday: number, strictlyAfter = false): ISODate {
  let delta = (weekday - isoWeekday(today) + 7) % 7;
  if (delta === 0 && strictlyAfter) delta = 7;
  return addDays(today, delta);
}

function validDate(y: number, m: number, d: number): ISODate | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Tries to read a date expression at words[i]. Returns the date and how many words it used. */
function readDate(
  words: Word[],
  i: number,
  ctx: CaptureContext,
): { date: ISODate; used: number } | null {
  const w = words[i];
  if (!w || w.quoted) return null;
  const a = w.lower;
  const b = words[i + 1]?.quoted ? undefined : words[i + 1]?.lower;
  const c = words[i + 2]?.quoted ? undefined : words[i + 2]?.lower;
  if (a === 'today' || a === 'tod' || a === 'tonight') return { date: ctx.today, used: 1 };
  if (a === 'tomorrow' || a === 'tmrw' || a === 'tmr' || a === 'tom')
    return { date: addDays(ctx.today, 1), used: 1 };
  if (a in WEEKDAYS) return { date: nextWeekday(ctx.today, WEEKDAYS[a]!), used: 1 };
  if (a === 'next' && b) {
    if (b === 'week')
      return { date: addDays(startOfWeek(ctx.today, ctx.weekStartsOn), 7), used: 2 };
    if (b in WEEKDAYS) return { date: nextWeekday(ctx.today, WEEKDAYS[b]!, true), used: 2 };
  }
  if (a === 'in' && b && c && /^\d+$/.test(b)) {
    const n = Number(b);
    if (/^days?$/.test(c)) return { date: addDays(ctx.today, n), used: 3 };
    if (/^weeks?$/.test(c)) return { date: addDays(ctx.today, n * 7), used: 3 };
  }
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a))) {
    const d = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) return { date: d, used: 1 };
  }
  // "oct 3" / "3 oct" — the next such date on or after today.
  const monthDay = (month: number, day: number, used: number) => {
    const year = Number(ctx.today.slice(0, 4));
    let d = validDate(year, month, day);
    if (d && d < ctx.today) d = validDate(year + 1, month, day);
    return d ? { date: d, used } : null;
  };
  if (a in MONTHS && b && /^\d{1,2}(st|nd|rd|th)?$/.test(b))
    return monthDay(MONTHS[a]!, parseInt(b, 10), 2);
  if (/^\d{1,2}(st|nd|rd|th)?$/.test(a) && b && b in MONTHS)
    return monthDay(MONTHS[b]!, parseInt(a, 10), 2);
  return null;
}

function readTime(text: string): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3];
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm.startsWith('p') && h !== 12) h += 12;
    if (ampm.startsWith('a') && h === 12) h = 0;
  } else if (h > 23 || (!m[2] && h < 7)) {
    // A bare small number like "at 3" is too ambiguous without am/pm; 7–23 read as 24h.
    return null;
  }
  return h * 60 + min;
}

const ESTIMATE_RE = /^~?(\d+(?:\.\d+)?(?:h|hr|hrs|m|min|mins)|\d+h\d+m?)$/;

export function parseCapture(
  input: string,
  ctx: CaptureContext,
  disabled: Set<string> = new Set(),
): CaptureResult {
  const words = tokenize(input);
  const used = new Set<number>();
  const tokens: CaptureToken[] = [];
  const result: CaptureResult = {
    title: '',
    planDate: undefined,
    dueDate: null,
    estimateMin: null,
    priority: null,
    projectId: null,
    areaId: null,
    tagIds: [],
    newTags: [],
    startMin: null,
    repeat: null,
    tokens,
  };

  const take = (i: number, n: number, kind: TokenKind, label: string): boolean => {
    const key = `${kind}:${words[i]!.start}`;
    if (disabled.has(key)) return false;
    for (let k = i; k < i + n; k++) used.add(k);
    const text = words
      .slice(i, i + n)
      .map((w) => w.text)
      .join(' ');
    tokens.push({ kind, key, text, label });
    return true;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.quoted || used.has(i)) continue;
    const lower = w.lower;
    const next = words[i + 1];

    // Due date: "due fri", "by oct 3", "due:2026-10-01"
    if (lower === 'due' || lower === 'by' || lower.startsWith('due:')) {
      if (lower.startsWith('due:') && lower.length > 4) {
        const d = readDate([{ ...w, lower: lower.slice(4), text: w.text.slice(4) }], 0, ctx);
        if (d && result.dueDate === null && take(i, 1, 'due', `Due ${d.date}`)) {
          result.dueDate = d.date;
          continue;
        }
      }
      const d = readDate(words, i + 1, ctx);
      if (d && result.dueDate === null && take(i, 1 + d.used, 'due', `Due ${d.date}`)) {
        result.dueDate = d.date;
        i += d.used;
        continue;
      }
    }

    // Repeat: "every weekday", "every mon", "daily"
    if (result.repeat === null) {
      const simple: Record<string, RepeatPreset> = {
        daily: 'daily',
        weekly: 'weekly',
        monthly: 'monthly-day',
        yearly: 'yearly',
      };
      if (lower in simple && take(i, 1, 'repeat', `Repeats ${lower}`)) {
        result.repeat = simple[lower]!;
        continue;
      }
      if (lower === 'every' && next && !next.quoted) {
        const n = next.lower;
        const map: Record<string, RepeatPreset> = {
          day: 'daily',
          weekday: 'weekdays',
          weekdays: 'weekdays',
          week: 'weekly',
          month: 'monthly-day',
          year: 'yearly',
        };
        if (n in map && take(i, 2, 'repeat', `Repeats every ${n}`)) {
          result.repeat = map[n]!;
          i += 1;
          continue;
        }
        if (n in WEEKDAYS && take(i, 2, 'repeat', `Repeats every ${next.text}`)) {
          result.repeat = { rrule: `FREQ=WEEKLY;BYDAY=${RRULE_DAY[WEEKDAYS[n]! - 1]}` };
          if (result.planDate === undefined) result.planDate = nextWeekday(ctx.today, WEEKDAYS[n]!);
          i += 1;
          continue;
        }
      }
    }

    // Time: "at 3pm", "at 15:30"
    if (lower === 'at' && next && !next.quoted && result.startMin === null) {
      const t = readTime(next.lower);
      if (t !== null && take(i, 2, 'time', `At ${next.text}`)) {
        result.startMin = t;
        i += 1;
        continue;
      }
    }

    if ((lower === 'someday' || lower === 'backlog') && result.planDate === undefined) {
      if (take(i, 1, 'backlog', 'Backlog')) {
        result.planDate = null;
        continue;
      }
    }

    const d = result.planDate === undefined ? readDate(words, i, ctx) : null;
    if (d && take(i, d.used, 'plan', `Plan ${d.date}`)) {
      result.planDate = d.date;
      i += d.used - 1;
      continue;
    }

    if (ESTIMATE_RE.test(lower) && result.estimateMin === null) {
      const minutes = parseDuration(lower.replace(/^~/, ''));
      if (
        minutes &&
        minutes > 0 &&
        minutes <= 24 * 60 &&
        take(i, 1, 'estimate', `${minutes} min`)
      ) {
        result.estimateMin = minutes;
        continue;
      }
    }

    const prio: Record<string, Priority> = {
      '!high': 3,
      '!3': 3,
      '!!!': 3,
      '!med': 2,
      '!medium': 2,
      '!2': 2,
      '!!': 2,
      '!low': 1,
      '!1': 1,
    };
    if (
      lower in prio &&
      result.priority === null &&
      take(i, 1, 'priority', `Priority ${lower.slice(1)}`)
    ) {
      result.priority = prio[lower]!;
      continue;
    }

    if (
      lower.startsWith('#') &&
      lower.length > 1 &&
      result.projectId === null &&
      result.areaId === null
    ) {
      const name = w.text.slice(1);
      const project = matchRef(name, ctx.projects);
      if (project && take(i, 1, 'project', project.name)) {
        result.projectId = project.id;
        continue;
      }
      const area = matchRef(name, ctx.areas);
      if (area && take(i, 1, 'area', area.name)) {
        result.areaId = area.id;
        continue;
      }
    }

    if (lower.startsWith('@') && lower.length > 1 && /^@[\p{L}\p{N}_-]+$/u.test(lower)) {
      const name = w.text.slice(1);
      const tag = matchRef(name, ctx.tags);
      if (tag) {
        if (!result.tagIds.includes(tag.id) && take(i, 1, 'tag', tag.name))
          result.tagIds.push(tag.id);
        continue;
      }
      if (
        !result.newTags.some((t) => t.toLowerCase() === name.toLowerCase()) &&
        take(i, 1, 'tag', `${name} (new)`)
      ) {
        result.newTags.push(name);
      }
      continue;
    }
  }

  result.title = words
    .filter((_, i) => !used.has(i))
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return result;
}
