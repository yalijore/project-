/**
 * Todoist (unified API v1). Auth: personal API token (Settings → Integrations → Developer).
 * Reads open tasks; optionally closes/reopens tasks when completed in Keel.
 * Mapping: Todoist `deadline` (or `due` when there is no deadline) → Keel deadline;
 * priority 4/3/2/1 → High/Medium/Low/None; `duration` in minutes → estimate.
 */
import type { Priority } from '@/domain/types';
import { expectOk, getJson, qs } from '../http';
import type { Http, RemoteTask, TaskAdapter } from '../types';

const API = 'https://api.todoist.com/api/v1';

export interface TodoistTask {
  id: string;
  content: string;
  description?: string;
  priority?: number;
  due?: { date: string; datetime?: string | null; is_recurring?: boolean } | null;
  deadline?: { date: string } | null;
  duration?: { amount: number; unit: 'minute' | 'day' } | null;
  project_id?: string;
  checked?: boolean;
  updated_at?: string;
  added_at?: string;
}

export function mapTodoistTask(t: TodoistTask, projects: Map<string, string>): RemoteTask {
  const prio = ({ 4: 3, 3: 2, 2: 1 } as Record<number, Priority>)[t.priority ?? 1] ?? 0;
  const due = t.deadline?.date ?? t.due?.date ?? null;
  return {
    externalId: t.id,
    title: t.content,
    notes: t.description ?? '',
    url: `https://app.todoist.com/app/task/${t.id}`,
    dueDate: due ? due.slice(0, 10) : null,
    completed: !!t.checked,
    priority: prio,
    estimateMin: t.duration ? (t.duration.unit === 'minute' ? t.duration.amount : null) : null,
    container: t.project_id ? (projects.get(t.project_id) ?? null) : null,
    version: t.updated_at ?? `${t.content}|${t.description}|${due}|${t.priority}`,
  };
}

async function paged<T>(http: Http, path: string, what: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const page: { results: T[]; next_cursor: string | null } = await getJson(
      http,
      `${API}${path}${qs({ limit: 200, cursor })}`,
      what,
    );
    out.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor);
  return out;
}

export const todoist: TaskAdapter = {
  async fetchOpenTasks(http) {
    const projects = new Map(
      (await paged<{ id: string; name: string }>(http, '/projects', 'List Todoist projects')).map(
        (p) => [p.id, p.name],
      ),
    );
    const tasks = await paged<TodoistTask>(http, '/tasks', 'List Todoist tasks');
    return tasks.filter((t) => !t.checked).map((t) => mapTodoistTask(t, projects));
  },
  async setCompleted(http, _config, externalId, done) {
    expectOk(
      await http({
        method: 'POST',
        url: `${API}/tasks/${encodeURIComponent(externalId)}/${done ? 'close' : 'reopen'}`,
      }),
      'Update Todoist task',
    );
  },
};
