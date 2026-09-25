/**
 * Contract tests: adapters against recorded-shape fixtures (no network), and the sync
 * engine against a real SQLite database. These verify Keel's side of each integration;
 * live verification against the providers requires user credentials.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@/db/driver';
import * as repo from '@/data/repo';
import { createTestDb } from '@/test/testDb';
import googleCalendarList from './__fixtures__/google-calendarList.json';
import googleFull from './__fixtures__/google-events-full.json';
import googleIncremental from './__fixtures__/google-events-incremental.json';
import graphCalendars from './__fixtures__/graph-calendars.json';
import graphDelta1 from './__fixtures__/graph-delta-1.json';
import graphDelta2 from './__fixtures__/graph-delta-2.json';
import todoistProjects from './__fixtures__/todoist-projects.json';
import todoistTasks1 from './__fixtures__/todoist-tasks-1.json';
import todoistTasks2 from './__fixtures__/todoist-tasks-2.json';
import asanaMe from './__fixtures__/asana-me.json';
import asanaTasks1 from './__fixtures__/asana-tasks-1.json';
import asanaTasks2 from './__fixtures__/asana-tasks-2.json';
import trelloBoards from './__fixtures__/trello-boards.json';
import trelloCards from './__fixtures__/trello-cards.json';
import jiraSearch from './__fixtures__/jira-search.json';
import notionQuery from './__fixtures__/notion-query.json';
import { googleCalendar } from './google';
import { withRetry } from './http';
import { microsoftCalendar } from './microsoft';
import type { AccountConfig } from './sync';
import {
  createAccount,
  getAccount,
  removeAccount,
  syncCalendarAccount,
  syncIcsAccount,
  syncTaskAccount,
  updateAccount,
} from './sync';
import { asana } from './tasks/asana';
import { jira } from './tasks/jira';
import { notion } from './tasks/notion';
import { todoist } from './tasks/todoist';
import { trello } from './tasks/trello';
import type { Http, HttpRequest, HttpResponse } from './types';
import { IntegrationError } from './types';

type Route = [
  method: string,
  match: RegExp,
  respond: (req: HttpRequest) => Partial<HttpResponse> | unknown,
];

/** A fake provider: routes requests to fixtures and records every call. */
function fakeHttp(routes: Route[]) {
  const calls: HttpRequest[] = [];
  const http: Http = async (req) => {
    calls.push(req);
    const route = routes.find(([m, re]) => m === req.method && re.test(req.url));
    if (!route) return { status: 404, headers: {}, body: `no route for ${req.method} ${req.url}` };
    const out = route[2](req);
    if (out && typeof out === 'object' && 'status' in (out as object)) {
      const r = out as Partial<HttpResponse>;
      return { status: r.status ?? 200, headers: r.headers ?? {}, body: r.body ?? '' };
    }
    return { status: 200, headers: {}, body: JSON.stringify(out) };
  };
  return { http, calls };
}

const ZONE = 'America/New_York';
const NOW = new Date('2026-09-25T14:00:00Z');
let db: Database;

async function ctxDo<T>(fn: (ctx: repo.Ctx) => Promise<T>) {
  return db.transaction((tx) =>
    fn({
      tx,
      now: NOW.toISOString(),
      today: '2026-09-25',
      zone: ZONE,
      changes: new repo.ChangeSet(),
    }),
  );
}

beforeEach(async () => {
  db = await createTestDb();
});

describe('HTTP retry policy', () => {
  it('honours Retry-After on 429 and backs off on 5xx', async () => {
    const waits: number[] = [];
    let n = 0;
    const http: Http = async (): Promise<HttpResponse> => {
      n++;
      if (n === 1) return { status: 429, headers: { 'retry-after': '7' }, body: '' };
      if (n === 2) return { status: 503, headers: {}, body: '' };
      return { status: 200, headers: {}, body: 'ok' };
    };
    const res = await withRetry(http, { sleep: async (ms) => void waits.push(ms) })({
      method: 'GET',
      url: 'x',
    });
    expect(res.body).toBe('ok');
    expect(waits).toEqual([7000, 2000]);
  });

  it('maps credential and network failures from Rust', async () => {
    const auth = withRetry(async () => Promise.reject(new Error('REAUTH: token refresh failed')), {
      sleep: async () => undefined,
    });
    await expect(auth({ method: 'GET', url: 'x' })).rejects.toMatchObject({ kind: 'auth' });
    const net = withRetry(async () => Promise.reject(new Error('NETWORK: dns error')), {
      retries: 1,
      sleep: async () => undefined,
    });
    await expect(net({ method: 'GET', url: 'x' })).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('Google Calendar adapter', () => {
  it('lists calendars with write access and colors', async () => {
    const { http } = fakeHttp([['GET', /calendarList/, () => googleCalendarList]]);
    const cals = await googleCalendar.listCalendars(http);
    expect(cals).toEqual([
      {
        externalId: 'me@example.com',
        name: 'me@example.com',
        color: '#9fe1e7',
        writable: true,
        primary: true,
        timezone: 'America/New_York',
      },
      {
        externalId: 'team@group.calendar.google.com',
        name: 'Team (shared)',
        color: '#f691b2',
        writable: false,
        primary: false,
        timezone: 'Europe/Berlin',
      },
    ]);
  });

  it('maps singles, recurring masters with EXDATE, overrides, all-day and Keel-owned events', async () => {
    const { http, calls } = fakeHttp([['GET', /\/events\?/, () => googleFull]]);
    const r = await googleCalendar.syncEvents(http, 'me@example.com', null, {
      from: '2026-07-27T00:00:00.000Z',
      to: '2027-09-25T00:00:00.000Z',
    });
    expect(calls[0]!.url).toContain('timeMin=2026-07-27T00%3A00%3A00.000Z');
    expect(r.cursor).toBe('sync-1');
    const byId = Object.fromEntries(r.upserts.map((e) => [e.externalId, e]));
    expect(byId.single1).toMatchObject({
      startUtc: '2026-09-28T15:00:00.000Z',
      endUtc: '2026-09-28T16:00:00.000Z',
      location: 'Room 4',
      busy: true,
    });
    expect(byId.weekly1).toMatchObject({
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
      exdates: ['2026-09-30T13:00:00.000Z'],
      tz: 'America/New_York',
    });
    expect(byId['weekly1_20261005T130000Z']).toMatchObject({
      seriesExternalId: 'weekly1',
      recurrenceId: '2026-10-05T13:00:00.000Z',
    });
    expect(byId.allday1).toMatchObject({
      allDay: true,
      startDate: '2026-10-01',
      endDate: '2026-10-03',
      busy: false,
    });
    expect(byId.keelblock1!.keelOwned).toBe(true);
  });

  it('restarts with a full sync when the sync token expired (410)', async () => {
    const { http, calls } = fakeHttp([
      ['GET', /syncToken=stale/, () => ({ status: 410, body: '{"error":{"code":410}}' })],
      ['GET', /timeMin=/, () => googleFull],
    ]);
    const r = await googleCalendar.syncEvents(http, 'me@example.com', 'stale', {
      from: '2026-07-27T00:00:00.000Z',
      to: '2027-01-01T00:00:00.000Z',
    });
    expect(r.fullResync).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('never recreates a time block the user deleted remotely', async () => {
    const { http } = fakeHttp([['PUT', /events\/gone-id/, () => ({ status: 404, body: '' })]]);
    const res = await googleCalendar.upsertBlock!(http, 'me@example.com', 'gone-id', {
      title: 'x',
      notes: '',
      startUtc: '2026-09-25T14:00:00.000Z',
      endUtc: '2026-09-25T15:00:00.000Z',
      tz: ZONE,
    });
    expect(res).toBeNull();
  });
});

describe('Microsoft Graph adapter', () => {
  it('follows nextLink to the deltaLink and maps removals, all-day, free and Keel-owned events', async () => {
    const { http, calls } = fakeHttp([
      ['GET', /skiptoken=page2/, () => graphDelta2],
      ['GET', /calendarView\/delta\?startDateTime/, () => graphDelta1],
    ]);
    const r = await microsoftCalendar.syncEvents(http, 'AAMk-cal-1', null, {
      from: '2026-07-27T00:00:00.000Z',
      to: '2027-09-25T00:00:00.000Z',
    });
    expect(calls[0]!.headers).toContainEqual(['Prefer', 'outlook.timezone="UTC"']);
    expect(r.cursor).toContain('deltatoken=d1');
    expect(r.deletedIds).toEqual(['ev-gone']);
    const byId = Object.fromEntries(r.upserts.map((e) => [e.externalId, e]));
    expect(byId['ev-1']).toMatchObject({
      startUtc: '2026-09-28T14:00:00.000Z',
      location: 'Teams',
      busy: true,
    });
    expect(byId['ev-2']).toMatchObject({
      allDay: true,
      startDate: '2026-10-12',
      endDate: '2026-10-13',
      busy: false,
    });
    expect(byId['ev-keel']!.keelOwned).toBe(true);
  });

  it('lists calendars', async () => {
    const { http } = fakeHttp([['GET', /me\/calendars/, () => graphCalendars]]);
    const cals = await microsoftCalendar.listCalendars(http);
    expect(cals.map((c) => [c.name, c.writable, c.primary, c.color])).toEqual([
      ['Calendar', true, true, '#0078d4'],
      ['Holidays', false, false, null],
    ]);
  });
});

describe('task adapters', () => {
  it('Todoist: paginates, skips checked tasks, maps priority/deadline/duration, closes tasks', async () => {
    const { http, calls } = fakeHttp([
      ['GET', /\/projects/, () => todoistProjects],
      ['GET', /\/tasks\?limit=200&cursor=c2/, () => todoistTasks2],
      ['GET', /\/tasks\?limit=200$/, () => todoistTasks1],
      ['POST', /\/tasks\/t1\/close$/, () => ({ status: 204, body: '' })],
    ]);
    const tasks = await todoist.fetchOpenTasks(http, {});
    expect(tasks.map((t) => t.externalId)).toEqual(['t1', 't2', 't4']);
    expect(tasks[0]).toMatchObject({
      title: 'Write quarterly report',
      priority: 3,
      dueDate: '2026-10-01',
      estimateMin: 90,
      container: 'Work',
    });
    expect(tasks[1]).toMatchObject({ dueDate: '2026-09-27', priority: 0 });
    await todoist.setCompleted!(http, {}, 't1', true);
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      url: 'https://api.todoist.com/api/v1/tasks/t1/close',
    });
  });

  it('Asana: iterates workspaces and pages, completes via PUT', async () => {
    const { http, calls } = fakeHttp([
      ['GET', /users\/me/, () => asanaMe],
      ['GET', /offset=o2/, () => asanaTasks2],
      ['GET', /\/tasks\?assignee=me/, () => asanaTasks1],
      ['PUT', /\/tasks\/a1$/, () => ({ data: {} })],
    ]);
    const tasks = await asana.fetchOpenTasks(http, {});
    expect(tasks.map((t) => [t.title, t.dueDate, t.container])).toEqual([
      ['Review contract', '2026-10-02', 'Legal'],
      ['Ship v2', '2026-10-05', null],
    ]);
    await asana.setCompleted!(http, {}, 'a1', true);
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ data: { completed: true } });
  });

  it('Trello: open cards, board names, dueComplete write-back', async () => {
    const { http, calls } = fakeHttp([
      ['GET', /members\/me\/boards/, () => trelloBoards],
      ['GET', /members\/me\/cards/, () => trelloCards],
      ['PUT', /cards\/c1\?dueComplete=true/, () => ({})],
    ]);
    const tasks = await trello.fetchOpenTasks(http, {});
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: 'Design onboarding',
      dueDate: '2026-10-03',
      container: 'Roadmap',
    });
    await trello.setCompleted!(http, {}, 'c1', true);
    expect(calls.at(-1)!.method).toBe('PUT');
  });

  it('Jira: searches the user’s site and links issues', async () => {
    const { http, calls } = fakeHttp([
      ['GET', /acme\.atlassian\.net\/rest\/api\/3\/search\/jql/, () => jiraSearch],
    ]);
    const tasks = await jira.fetchOpenTasks(http, { site: 'acme.atlassian.net' });
    expect(decodeURIComponent(calls[0]!.url)).toContain(
      'assignee = currentUser() AND statusCategory != Done',
    );
    expect(tasks.map((t) => [t.title, t.priority, t.url])).toEqual([
      ['APP-12: Fix login redirect', 3, 'https://acme.atlassian.net/browse/APP-12'],
      ['APP-15: Update docs', 1, 'https://acme.atlassian.net/browse/APP-15'],
    ]);
    expect(jira.setCompleted).toBeUndefined();
  });

  it('Notion: detects title/checkbox/date properties and filters done pages', async () => {
    const { http, calls } = fakeHttp([
      ['POST', /databases\/[0-9a-f]{32}\/query/, () => notionQuery],
    ]);
    const tasks = await notion.fetchOpenTasks(http, {
      databaseId: '0123456789abcdef0123456789abcdef',
    });
    expect(calls[0]!.headers).toContainEqual(['Notion-Version', '2022-06-28']);
    expect(tasks).toEqual([
      expect.objectContaining({ title: 'Write blog post', dueDate: '2026-10-06' }),
    ]);
    await expect(notion.fetchOpenTasks(http, { databaseId: 'nope' })).rejects.toThrow(
      /database ID/,
    );
  });
});

describe('calendar sync engine', () => {
  async function googleAccount(config: AccountConfig) {
    const id = await ctxDo((ctx) => createAccount(ctx, 'google', 'me@example.com', config));
    return (await getAccount(db, id))!;
  }

  it('creates read-only local calendars, events and mappings; skips Keel-owned events', async () => {
    const account = await googleAccount({
      calendars: [
        {
          externalId: 'me@example.com',
          name: 'Me',
          color: '#123456',
          writable: true,
          primary: true,
          timezone: ZONE,
          selected: true,
        },
      ],
    });
    const { http } = fakeHttp([['GET', /\/events\?/, () => googleFull]]);
    const report = await syncCalendarAccount(db, account, googleCalendar, {
      http,
      now: () => NOW,
      zone: ZONE,
    });
    expect(report.eventsUpserted).toBe(4);
    const cals = await repo.loadCalendars(db);
    expect(cals).toEqual([
      expect.objectContaining({
        name: 'Me',
        source: 'google',
        isWritable: false,
        accountId: account.id,
      }),
    ]);
    const events = await repo.loadEvents(db);
    expect(events.map((e) => e.title).sort()).toEqual([
      'Design review',
      'Offsite',
      'Standup',
      'Standup (moved)',
    ]);
    const override = events.find((e) => e.title === 'Standup (moved)')!;
    const master = events.find((e) => e.title === 'Standup')!;
    expect(override.uid).toBe(master.uid);
    expect(override.recurrenceId).toBe('2026-10-05T13:00:00.000Z');
    const state = (await getAccount(db, account.id))!.syncState as {
      cursors: Record<string, string>;
    };
    expect(state.cursors['me@example.com']).toBe('sync-1');
  });

  it('applies incremental changes and deletions idempotently', async () => {
    const account = await googleAccount({
      calendars: [
        {
          externalId: 'me@example.com',
          name: 'Me',
          color: null,
          writable: true,
          primary: true,
          timezone: ZONE,
          selected: true,
        },
      ],
    });
    const first = fakeHttp([['GET', /\/events\?/, () => googleFull]]);
    await syncCalendarAccount(db, account, googleCalendar, {
      http: first.http,
      now: () => NOW,
      zone: ZONE,
    });
    const second = fakeHttp([['GET', /syncToken=sync-1/, () => googleIncremental]]);
    const report = await syncCalendarAccount(
      db,
      (await getAccount(db, account.id))!,
      googleCalendar,
      { http: second.http, now: () => NOW, zone: ZONE },
    );
    expect(report.eventsDeleted).toBe(1);
    const events = await repo.loadEvents(db);
    expect(events.find((e) => e.title === 'Design review')).toBeUndefined();
    expect(events.find((e) => e.title === 'Offsite (updated)')?.endDate).toBe('2026-10-04');
    expect(events.filter((e) => e.status === 'cancelled')).toHaveLength(1); // cancelled occurrence hides one standup
    const mappings = await db.all("SELECT * FROM integration_mappings WHERE entity_type = 'event'");
    expect(mappings).toHaveLength(events.length);
  });

  it('mirrors time blocks as events Keel owns: create, update, delete, and respects remote deletion', async () => {
    const account = await googleAccount({ calendars: [], pushCalendarId: 'me@example.com' });
    const taskId = await ctxDo((ctx) =>
      repo.createTask(ctx, { title: 'Deep work', planDate: '2026-09-25' }),
    );
    const blockId = await ctxDo((ctx) =>
      repo.createBlock(ctx, taskId, '2026-09-25T18:00:00.000Z', '2026-09-25T19:00:00.000Z'),
    );
    const remote = new Map<string, unknown>();
    let counter = 0;
    const { http, calls } = fakeHttp([
      [
        'POST',
        /\/events$/,
        (req) => {
          const id = `g${++counter}`;
          remote.set(id, JSON.parse(req.body!));
          return { id, etag: '"1"' };
        },
      ],
      [
        'PUT',
        /\/events\/g1$/,
        (req) => {
          remote.set('g1', JSON.parse(req.body!));
          return { id: 'g1', etag: '"2"' };
        },
      ],
      [
        'DELETE',
        /\/events\/g1$/,
        () => {
          remote.delete('g1');
          return { status: 204, body: '' };
        },
      ],
    ]);
    const deps = { http, now: () => NOW, zone: ZONE };
    let r = await syncCalendarAccount(db, account, googleCalendar, deps);
    expect(r.blocksPushed).toBe(1);
    expect(remote.get('g1')).toMatchObject({
      summary: 'Deep work',
      extendedProperties: { private: { keel: 'time-block' } },
    });
    r = await syncCalendarAccount(db, account, googleCalendar, {
      ...deps,
      now: () => new Date(NOW.getTime() + 60_000),
    });
    expect(r.blocksPushed).toBe(0); // unchanged → no request
    await db.transaction((tx) =>
      repo.updateBlock(
        {
          tx,
          now: '2026-09-25T14:05:00.000Z',
          today: '2026-09-25',
          zone: ZONE,
          changes: new repo.ChangeSet(),
        },
        blockId,
        '2026-09-25T19:00:00.000Z',
        '2026-09-25T20:00:00.000Z',
      ),
    );
    await syncCalendarAccount(db, account, googleCalendar, {
      ...deps,
      now: () => new Date(NOW.getTime() + 120_000),
    });
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    await ctxDo((ctx) => repo.deleteBlock(ctx, blockId));
    r = await syncCalendarAccount(db, account, googleCalendar, {
      ...deps,
      now: () => new Date(NOW.getTime() + 180_000),
    });
    expect(r.blocksRemoved).toBe(1);
    expect(remote.has('g1')).toBe(false);
  });

  it('deselecting a calendar removes its local copy; removing the account keeps nothing remote-owned', async () => {
    const cal = {
      externalId: 'me@example.com',
      name: 'Me',
      color: null,
      writable: true,
      primary: true,
      timezone: ZONE,
      selected: true,
    };
    const account = await googleAccount({ calendars: [cal] });
    const { http } = fakeHttp([['GET', /\/events\?/, () => googleFull]]);
    await syncCalendarAccount(db, account, googleCalendar, { http, now: () => NOW, zone: ZONE });
    await ctxDo((ctx) =>
      updateAccount(ctx, account.id, { config: { calendars: [{ ...cal, selected: false }] } }),
    );
    await syncCalendarAccount(db, (await getAccount(db, account.id))!, googleCalendar, {
      http,
      now: () => NOW,
      zone: ZONE,
    });
    expect(await repo.loadCalendars(db)).toEqual([]);
    expect(await repo.loadEvents(db)).toEqual([]);
    await ctxDo((ctx) => removeAccount(ctx, account.id, false));
    expect(await db.all('SELECT * FROM integration_mappings')).toEqual([]);
  });
});

describe('ICS subscription sync', () => {
  it('mirrors the feed, removing events that disappear from it', async () => {
    const id = await ctxDo((ctx) =>
      createAccount(ctx, 'ics-subscription', 'Holidays', { feedHost: 'example.com' }),
    );
    const feed = (titles: string[]) =>
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        ...titles.flatMap((t, i) => [
          'BEGIN:VEVENT',
          `UID:${t}`,
          `SUMMARY:${t}`,
          `DTSTART;VALUE=DATE:2026120${i + 1}`,
          `DTEND;VALUE=DATE:2026120${i + 2}`,
          'END:VEVENT',
        ]),
        'END:VCALENDAR',
      ].join('\r\n');
    let body = feed(['A', 'B']);
    const deps = {
      http: fakeHttp([]).http,
      now: () => NOW,
      zone: ZONE,
      fetchIcs: async () => body,
    };
    await syncIcsAccount(db, (await getAccount(db, id))!, deps);
    expect((await repo.loadEvents(db)).map((e) => e.title).sort()).toEqual(['A', 'B']);
    body = feed(['B', 'C']);
    const r = await syncIcsAccount(db, (await getAccount(db, id))!, deps);
    expect((await repo.loadEvents(db)).map((e) => e.title).sort()).toEqual(['B', 'C']);
    expect(r.eventsDeleted).toBe(1);
    const cals = await repo.loadCalendars(db);
    expect(cals).toHaveLength(1);
    expect(cals[0]!.isWritable).toBe(false);
  });
});

describe('task sync engine', () => {
  async function todoistAccount(config: AccountConfig = {}) {
    const id = await ctxDo((ctx) => createAccount(ctx, 'todoist', 'Todoist', config));
    return id;
  }

  function server(tasks: { id: string; content: string; checked?: boolean; updated_at: string }[]) {
    const closed: string[] = [];
    const f = fakeHttp([
      ['GET', /\/projects/, () => ({ results: [], next_cursor: null })],
      [
        'GET',
        /\/tasks\?/,
        () => ({ results: tasks.filter((t) => !closed.includes(t.id)), next_cursor: null }),
      ],
      [
        'POST',
        /\/tasks\/[^/]+\/close$/,
        (req) => {
          closed.push(req.url.split('/').at(-2)!);
          return { status: 204, body: '' };
        },
      ],
    ]);
    return { ...f, closed };
  }

  it('imports into a provider project, updates unedited tasks, keeps local edits, closes vanished ones', async () => {
    const id = await todoistAccount();
    let remote = [
      { id: 'r1', content: 'Pay invoice', updated_at: 'v1' },
      { id: 'r2', content: 'Book flights', updated_at: 'v1' },
    ];
    const deps = () => ({ http: server(remote).http, now: () => NOW, zone: ZONE });
    let r = await syncTaskAccount(db, (await getAccount(db, id))!, todoist, 'Todoist', deps());
    expect(r.tasksCreated).toBe(2);
    const project = (await repo.loadProjects(db))[0]!;
    expect(project.name).toBe('Todoist');
    let tasks = await repo.loadTasks(db);
    expect(tasks.every((t) => t.projectId === project.id && t.source === 'todoist')).toBe(true);
    expect(tasks[0]!.links[0]!.url).toMatch(/app\.todoist\.com\/app\/task\//);

    // Idempotent.
    r = await syncTaskAccount(db, (await getAccount(db, id))!, todoist, 'Todoist', deps());
    expect(r.tasksCreated + r.tasksUpdated).toBe(0);

    // Edit r2 locally, change both remotely, drop r1 remotely.
    const r2 = tasks.find((t) => t.title === 'Book flights')!;
    await db.transaction((tx) =>
      repo.updateTasks(
        {
          tx,
          now: '2026-09-25T15:00:00.000Z',
          today: '2026-09-25',
          zone: ZONE,
          changes: new repo.ChangeSet(),
        },
        [r2.id],
        { title: 'Book flights to Lisbon' },
      ),
    );
    remote = [{ id: 'r2', content: 'Book flights (remote)', updated_at: 'v2' }];
    r = await syncTaskAccount(db, (await getAccount(db, id))!, todoist, 'Todoist', {
      ...deps(),
      now: () => new Date('2026-09-25T16:00:00Z'),
    });
    tasks = await repo.loadTasks(db);
    expect(tasks.find((t) => t.id === r2.id)!.title).toBe('Book flights to Lisbon');
    expect(r.warnings[0]).toMatch(/kept your local edits/);
    expect(tasks.find((t) => t.title === 'Pay invoice')!.completedAt).not.toBeNull();
    expect(r.tasksClosed).toBe(1);
  });

  it('pushes local completion back when enabled, before pulling', async () => {
    const id = await todoistAccount({ syncCompletion: true });
    const remote = [{ id: 'r1', content: 'Pay invoice', updated_at: 'v1' }];
    const s = server(remote);
    await syncTaskAccount(db, (await getAccount(db, id))!, todoist, 'Todoist', {
      http: s.http,
      now: () => NOW,
      zone: ZONE,
    });
    const [t] = await repo.loadTasks(db);
    await db.transaction((tx) =>
      repo.completeTask(
        {
          tx,
          now: '2026-09-25T15:00:00.000Z',
          today: '2026-09-25',
          zone: ZONE,
          changes: new repo.ChangeSet(),
        },
        t!.id,
      ),
    );
    const r = await syncTaskAccount(db, (await getAccount(db, id))!, todoist, 'Todoist', {
      http: s.http,
      now: () => new Date('2026-09-25T16:00:00Z'),
      zone: ZONE,
    });
    expect(s.closed).toEqual(['r1']);
    expect(r.completionsPushed).toBe(1);
    expect((await repo.loadTasks(db))[0]!.completedAt).not.toBeNull();
  });

  it('removing an account can keep or delete imported tasks', async () => {
    const id = await todoistAccount();
    await syncTaskAccount(db, (await getAccount(db, id))!, todoist, 'Todoist', {
      http: server([{ id: 'r1', content: 'Keep me', updated_at: 'v' }]).http,
      now: () => NOW,
      zone: ZONE,
    });
    await ctxDo((ctx) => removeAccount(ctx, id, false));
    expect(await repo.loadTasks(db)).toHaveLength(1);
    const id2 = await todoistAccount();
    await syncTaskAccount(db, (await getAccount(db, id2))!, todoist, 'Todoist', {
      http: server([{ id: 'r9', content: 'Remove me', updated_at: 'v' }]).http,
      now: () => NOW,
      zone: ZONE,
    });
    await ctxDo((ctx) => removeAccount(ctx, id2, true));
    expect((await repo.loadTasks(db)).map((t) => t.title)).toEqual(['Keep me']);
  });

  it('surfaces auth failures as IntegrationError', async () => {
    const id = await todoistAccount();
    const http: Http = async () => ({ status: 401, headers: {}, body: '' });
    await expect(
      syncTaskAccount(db, (await getAccount(db, id))!, todoist, 'Todoist', {
        http,
        now: () => NOW,
        zone: ZONE,
      }),
    ).rejects.toBeInstanceOf(IntegrationError);
  });
});
