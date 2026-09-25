/**
 * Asana. Auth: personal access token. Reads incomplete tasks assigned to you in every
 * workspace; optionally marks tasks complete when completed in Keel.
 */
import { expectOk, getJson, qs } from '../http';
import type { Http, RemoteTask, TaskAdapter } from '../types';

const API = 'https://app.asana.com/api/1.0';

export interface AsanaTask {
  gid: string;
  name: string;
  notes?: string;
  due_on?: string | null;
  due_at?: string | null;
  completed?: boolean;
  permalink_url?: string;
  modified_at?: string;
  projects?: { name: string }[];
}

export function mapAsanaTask(t: AsanaTask): RemoteTask {
  return {
    externalId: t.gid,
    title: t.name,
    notes: t.notes ?? '',
    url: t.permalink_url ?? null,
    dueDate: t.due_on ?? (t.due_at ? t.due_at.slice(0, 10) : null),
    completed: !!t.completed,
    priority: 0,
    estimateMin: null,
    container: t.projects?.[0]?.name ?? null,
    version: t.modified_at ?? `${t.name}|${t.due_on}`,
  };
}

export const asana: TaskAdapter = {
  async fetchOpenTasks(http: Http) {
    const me: { data: { workspaces: { gid: string; name: string }[] } } = await getJson(
      http,
      `${API}/users/me${qs({ opt_fields: 'workspaces.name' })}`,
      'Read Asana profile',
    );
    const out: RemoteTask[] = [];
    for (const ws of me.data.workspaces) {
      let offset: string | undefined;
      do {
        const page: { data: AsanaTask[]; next_page: { offset: string } | null } = await getJson(
          http,
          `${API}/tasks${qs({
            assignee: 'me',
            workspace: ws.gid,
            completed_since: 'now',
            limit: 100,
            offset,
            opt_fields:
              'name,notes,due_on,due_at,completed,permalink_url,modified_at,projects.name',
          })}`,
          'List Asana tasks',
        );
        out.push(...page.data.filter((t) => !t.completed).map(mapAsanaTask));
        offset = page.next_page?.offset;
      } while (offset);
    }
    return out;
  },
  async setCompleted(http, _config, externalId, done) {
    expectOk(
      await http({
        method: 'PUT',
        url: `${API}/tasks/${encodeURIComponent(externalId)}`,
        headers: [['Content-Type', 'application/json']],
        body: JSON.stringify({ data: { completed: done } }),
      }),
      'Update Asana task',
    );
  },
};
