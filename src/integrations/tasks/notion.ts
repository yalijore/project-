/**
 * Notion. Auth: internal integration token; the user shares one task database with the
 * integration. Keel reads its pages: the title property, the property that says "done", and a
 * date property for the deadline (detected by name). The "done" property is, in order of
 * preference: a checkbox named like Done, a Status property, a Select named like Status, or
 * any checkbox. With write-back enabled, completing in Keel sets it in Notion: ticks the
 * checkbox, or picks the first option in the Status "Complete" group / a done-like Select option.
 */
import { expectOk, getJson, sendJson } from '../http';
import type { Http, RemoteTask, TaskAdapter } from '../types';
import { IntegrationError } from '../types';

const API = 'https://api.notion.com/v1';
const VERSION: [string, string] = ['Notion-Version', '2022-06-28'];

type Prop =
  | { type: 'title'; title: { plain_text: string }[] }
  | { type: 'checkbox'; checkbox: boolean }
  | { type: 'date'; date: { start: string } | null }
  | { type: 'status'; status: { name: string } | null }
  | { type: 'select'; select: { name: string } | null }
  | { type: string; [k: string]: unknown };

export interface NotionPage {
  id: string;
  parent?: { type: string; database_id?: string };
  url?: string;
  last_edited_time?: string;
  archived?: boolean;
  properties: Record<string, Prop>;
}

const DONE_NAME = /^(done|complete|completed|finished)$/i;
const DONE_STATUS = /^(done|complete|completed|finished|closed|archived)$/i;

export type DoneProp = { kind: 'checkbox' | 'status' | 'select'; name: string };

/** Which properties hold the title, done flag and deadline. */
export function detectSchema(page: NotionPage) {
  const entries = Object.entries(page.properties);
  const title = entries.find(([, p]) => p.type === 'title')?.[0] ?? null;
  const namedCheckbox = entries.find(([n, p]) => p.type === 'checkbox' && DONE_NAME.test(n))?.[0];
  const status = entries.find(([, p]) => p.type === 'status')?.[0];
  const select = entries.find(
    ([n, p]) => p.type === 'select' && /^(status|state|stage|progress)$/i.test(n.trim()),
  )?.[0];
  const anyCheckbox = entries.find(([, p]) => p.type === 'checkbox')?.[0];
  const done: DoneProp | null = namedCheckbox
    ? { kind: 'checkbox', name: namedCheckbox }
    : status
      ? { kind: 'status', name: status }
      : select
        ? { kind: 'select', name: select }
        : anyCheckbox
          ? { kind: 'checkbox', name: anyCheckbox }
          : null;
  const date =
    entries.find(([n, p]) => p.type === 'date' && /due|deadline|date/i.test(n))?.[0] ??
    entries.find(([, p]) => p.type === 'date')?.[0] ??
    null;
  return { title, done, date };
}

function isDone(page: NotionPage, done: DoneProp | null): boolean {
  if (!done) return false;
  const p = page.properties[done.name] as Record<string, unknown>;
  if (done.kind === 'checkbox') return !!p.checkbox;
  const value = (p[done.kind] as { name: string } | null)?.name ?? '';
  return DONE_STATUS.test(value);
}

interface DatabaseSchema {
  properties: Record<
    string,
    {
      type: string;
      status?: {
        options: { id: string; name: string }[];
        groups: { name: string; option_ids: string[] }[];
      };
      select?: { options: { id: string; name: string }[] };
    }
  >;
}

/** The option to set for done / not done on a Status or Select property. */
export function optionFor(schema: DatabaseSchema, prop: DoneProp, done: boolean): string | null {
  const def = schema.properties[prop.name];
  if (prop.kind === 'status' && def?.status) {
    const group = def.status.groups.find((g) =>
      done ? /^complete/i.test(g.name) : /^(to-?do|not started)/i.test(g.name),
    );
    const id = group?.option_ids[0];
    return def.status.options.find((o) => o.id === id)?.name ?? null;
  }
  if (prop.kind === 'select' && def?.select) {
    const options = def.select.options;
    return (
      (done
        ? options.find((o) => DONE_STATUS.test(o.name))
        : options.find((o) => /^(to-?do|not started|open|backlog)$/i.test(o.name))
      )?.name ?? null
    );
  }
  return null;
}

export function mapNotionPage(page: NotionPage): RemoteTask {
  const s = detectSchema(page);
  const p = page.properties;
  const titleProp = s.title ? (p[s.title] as { title: { plain_text: string }[] }) : null;
  const done = isDone(page, s.done);
  const date = s.date
    ? ((p[s.date] as { date: { start: string } | null }).date?.start ?? null)
    : null;
  return {
    externalId: page.id,
    title:
      titleProp?.title
        .map((t) => t.plain_text)
        .join('')
        .trim() || 'Untitled',
    notes: '',
    url: page.url ?? null,
    dueDate: date ? date.slice(0, 10) : null,
    completed: done || !!page.archived,
    priority: 0,
    estimateMin: null,
    container: 'Notion',
    version: page.last_edited_time ?? page.id,
  };
}

export const notion: TaskAdapter = {
  async fetchOpenTasks(http: Http, config) {
    const db = String(config.databaseId ?? '').replace(/-/g, '');
    if (!/^[0-9a-f]{32}$/i.test(db))
      throw new Error('Set the Notion database ID (32 hex characters from its URL)');
    const out: RemoteTask[] = [];
    let cursor: string | undefined;
    do {
      const page = await sendJson<{
        results: NotionPage[];
        has_more: boolean;
        next_cursor: string | null;
      }>(
        http,
        'POST',
        `${API}/databases/${db}/query`,
        { page_size: 100, start_cursor: cursor },
        'Query Notion database',
        [VERSION],
      );
      if (!page) break;
      out.push(...page.results.map(mapNotionPage).filter((t) => !t.completed));
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return out;
  },
  async setCompleted(http, config, externalId, done) {
    const page = JSON.parse(
      expectOk(
        await http({
          method: 'GET',
          url: `${API}/pages/${encodeURIComponent(externalId)}`,
          headers: [VERSION],
        }),
        'Read Notion page',
      ).body,
    ) as NotionPage;
    const prop = detectSchema(page).done;
    if (!prop)
      throw new IntegrationError(
        'This Notion database has no checkbox, Status or Status-like Select property to mark done.',
        'config',
      );
    let value: unknown;
    if (prop.kind === 'checkbox') value = { checkbox: done };
    else {
      const db = (page.parent?.database_id ?? String(config.databaseId ?? '')).replace(/-/g, '');
      const schema = await getJson<DatabaseSchema>(
        http,
        `${API}/databases/${db}`,
        'Read Notion database',
        [VERSION],
      );
      const option = optionFor(schema, prop, done);
      if (!option)
        throw new IntegrationError(
          `The “${prop.name}” property has no ${done ? 'Complete/Done' : 'To-do'} option to set.`,
          'config',
        );
      value = { [prop.kind]: { name: option } };
    }
    await sendJson(
      http,
      'PATCH',
      `${API}/pages/${encodeURIComponent(externalId)}`,
      { properties: { [prop.name]: value } },
      'Update Notion page',
      [VERSION],
    );
  },
};
