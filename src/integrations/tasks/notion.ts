/**
 * Notion. Auth: internal integration token; the user shares one task database with the
 * integration. Keel reads its pages: the title property, a checkbox or status property for
 * "done", and a date property for the deadline (detected by name). With write-back enabled
 * and a checkbox "done" property, completing in Keel ticks it in Notion.
 */
import { expectOk, sendJson } from '../http';
import type { Http, RemoteTask, TaskAdapter } from '../types';

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
  url?: string;
  last_edited_time?: string;
  archived?: boolean;
  properties: Record<string, Prop>;
}

const DONE_NAME = /^(done|complete|completed|finished)$/i;
const DONE_STATUS = /^(done|complete|completed|finished|closed|archived)$/i;

/** Which properties hold the title, done flag and deadline. */
export function detectSchema(page: NotionPage) {
  const entries = Object.entries(page.properties);
  const title = entries.find(([, p]) => p.type === 'title')?.[0] ?? null;
  const checkbox =
    entries.find(([n, p]) => p.type === 'checkbox' && DONE_NAME.test(n))?.[0] ??
    entries.find(([, p]) => p.type === 'checkbox')?.[0] ??
    null;
  const status = entries.find(([, p]) => p.type === 'status')?.[0] ?? null;
  const date =
    entries.find(([n, p]) => p.type === 'date' && /due|deadline|date/i.test(n))?.[0] ??
    entries.find(([, p]) => p.type === 'date')?.[0] ??
    null;
  return { title, checkbox, status, date };
}

export function mapNotionPage(page: NotionPage): RemoteTask {
  const s = detectSchema(page);
  const p = page.properties;
  const titleProp = s.title ? (p[s.title] as { title: { plain_text: string }[] }) : null;
  const done =
    (s.checkbox ? !!(p[s.checkbox] as { checkbox: boolean }).checkbox : false) ||
    (s.status
      ? DONE_STATUS.test((p[s.status] as { status: { name: string } | null }).status?.name ?? '')
      : false);
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
  async setCompleted(http, _config, externalId, done) {
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
    const s = detectSchema(page);
    if (!s.checkbox) return; // status-based databases are read-only in Keel
    await sendJson(
      http,
      'PATCH',
      `${API}/pages/${encodeURIComponent(externalId)}`,
      { properties: { [s.checkbox]: { checkbox: done } } },
      'Update Notion page',
      [VERSION],
    );
  },
};
