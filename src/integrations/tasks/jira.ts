/**
 * Jira Cloud. Auth: account email + API token (id.atlassian.com → Security → API tokens),
 * sent only to your own *.atlassian.net site. Reads unresolved issues assigned to you.
 * Completion (opt-in): Jira has no "done" flag, only workflow transitions, so Keel applies a
 * transition your workflow offers into a Done-category status. If that transition asks for
 * required fields (a resolution screen, say), Keel does not guess them and reports it.
 */
import type { Priority } from '@/domain/types';
import { getJson, qs, sendJson } from '../http';
import type { Http, RemoteTask, TaskAdapter } from '../types';
import { IntegrationError } from '../types';

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    duedate?: string | null;
    priority?: { name: string } | null;
    project?: { name: string } | null;
    updated?: string;
  };
}

const PRIORITY: Record<string, Priority> = { highest: 3, high: 3, medium: 2, low: 1, lowest: 1 };

export function mapJiraIssue(i: JiraIssue, site: string): RemoteTask {
  return {
    externalId: i.id,
    title: `${i.key}: ${i.fields.summary}`,
    notes: '',
    url: `https://${site}/browse/${i.key}`,
    dueDate: i.fields.duedate ?? null,
    completed: false,
    priority: PRIORITY[(i.fields.priority?.name ?? '').toLowerCase()] ?? 0,
    estimateMin: null,
    container: i.fields.project?.name ?? null,
    version: i.fields.updated ?? i.fields.summary,
  };
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string; statusCategory?: { key: string } };
  fields?: Record<string, { required?: boolean; hasDefaultValue?: boolean; name?: string }>;
}

/** The transition to apply: into the Done category to complete, else back to work. */
export function pickTransition(
  transitions: JiraTransition[],
  done: boolean,
): { transition: JiraTransition | null; blockedBy: string[] } {
  const wanted = done ? ['done'] : ['indeterminate', 'new'];
  const candidates = wanted.flatMap((k) =>
    transitions.filter((t) => t.to.statusCategory?.key === k),
  );
  const needs = (t: JiraTransition) =>
    Object.entries(t.fields ?? {})
      .filter(([, f]) => f.required && !f.hasDefaultValue)
      .map(([k, f]) => f.name ?? k);
  const free = candidates.find((t) => needs(t).length === 0);
  if (free) return { transition: free, blockedBy: [] };
  return { transition: null, blockedBy: candidates[0] ? needs(candidates[0]) : [] };
}

export const jira: TaskAdapter = {
  async fetchOpenTasks(http: Http, config) {
    const site = String(config.site ?? '');
    if (!site) throw new Error('Jira site is not configured');
    const out: RemoteTask[] = [];
    let nextPageToken: string | undefined;
    do {
      const page: { issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean } = await getJson(
        http,
        `https://${site}/rest/api/3/search/jql${qs({
          jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
          fields: 'summary,duedate,priority,project,updated',
          maxResults: 100,
          nextPageToken,
        })}`,
        'Search Jira issues',
      );
      out.push(...page.issues.map((i) => mapJiraIssue(i, site)));
      nextPageToken = page.isLast === false || page.nextPageToken ? page.nextPageToken : undefined;
    } while (nextPageToken);
    return out;
  },
  async setCompleted(http, config, externalId, done) {
    const site = String(config.site ?? '');
    const base = `https://${site}/rest/api/3/issue/${encodeURIComponent(externalId)}/transitions`;
    const { transitions } = await getJson<{ transitions: JiraTransition[] }>(
      http,
      `${base}${qs({ expand: 'transitions.fields' })}`,
      'Read Jira transitions',
    );
    const { transition, blockedBy } = pickTransition(transitions, done);
    if (!transition)
      throw new IntegrationError(
        blockedBy.length
          ? `Jira needs ${blockedBy.join(', ')} to ${done ? 'complete' : 'reopen'} this issue; do it in Jira.`
          : `This issue's Jira workflow has no transition to ${done ? 'a Done status' : 'an open status'} from where it is.`,
        'provider',
      );
    await sendJson(http, 'POST', base, { transition: { id: transition.id } }, 'Move Jira issue');
  },
};
