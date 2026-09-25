/**
 * Jira Cloud. Auth: account email + API token (id.atlassian.com → Security → API tokens),
 * sent only to your own *.atlassian.net site. Reads unresolved issues assigned to you.
 * Read-only: Jira completion goes through project-specific workflow transitions, which Keel
 * does not attempt; complete the issue in Jira and it disappears from Keel on the next sync.
 */
import type { Priority } from '@/domain/types';
import { getJson, qs } from '../http';
import type { Http, RemoteTask, TaskAdapter } from '../types';

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
};
