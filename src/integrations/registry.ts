/**
 * What each optional integration is, what it exchanges with whom, and how to set it up.
 * The Integrations screen shows this verbatim before anything is connected, and the README
 * mirrors it. Every entry here is networked; none of it is needed to use Keel.
 */
import type { CalendarAdapter, TaskAdapter } from './types';
import { googleCalendar } from './google';
import { microsoftCalendar } from './microsoft';
import { asana } from './tasks/asana';
import { jira } from './tasks/jira';
import { notion } from './tasks/notion';
import { todoist } from './tasks/todoist';
import { trello } from './tasks/trello';

export type ProviderId =
  'google' | 'microsoft' | 'ics-subscription' | 'todoist' | 'asana' | 'trello' | 'jira' | 'notion';

export type CredentialKey =
  | 'clientId'
  | 'clientSecret'
  | 'tenant'
  | 'apiToken'
  | 'apiKey'
  | 'email'
  | 'site'
  | 'url'
  | 'databaseId';

export interface CredentialField {
  key: CredentialKey;
  label: string;
  placeholder?: string;
  /** Masked input; the value goes to the OS credential store, never to SQLite. */
  secret?: boolean;
  optional?: boolean;
  help?: string;
}

export interface ScopeInfo {
  scope: string;
  why: string;
  /** Requested only when the user enables the feature that needs it. */
  optional?: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  kind: 'calendar' | 'tasks';
  auth: 'oauth' | 'token' | 'url';
  summary: string;
  /** Hosts Keel contacts for this integration. */
  hosts: string[];
  receives: string[];
  sends: string[];
  /** Changes Keel can make in the provider (each is opt-in). Empty = read-only. */
  writes: string[];
  scopes: ScopeInfo[];
  setup: string[];
  fields: CredentialField[];
  revoke: string;
  revokeUrl?: string;
  syncDirection: string;
  conflicts: string;
  rateLimits: string;
  offline: string;
  /** None of these could be exercised against the live service while building Keel. */
  verification: 'requires credentials for live verification';
}

const OFFLINE =
  'Sync is skipped while offline and retried on the next run. Everything already synced stays available locally.';
const RATE =
  'Keel syncs on a timer (every 15 minutes by default) and when you press Sync now. HTTP 429 answers are retried after the server’s Retry-After (at most 60 s); server errors and dropped connections are retried up to 3 times (after 1, 2 and 4 s), then reported.';
const VERIFY = 'requires credentials for live verification' as const;
const TASK_CONFLICTS =
  'Imported tasks become ordinary Keel tasks you can plan and timebox. Remote changes update them unless you edited the task in Keel since the last sync — then your local edits win and Keel warns you. Tasks completed or deleted remotely are completed in Keel; tasks you delete in Keel are not re-imported.';

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'google',
    name: 'Google Calendar',
    kind: 'calendar',
    auth: 'oauth',
    summary:
      'See your Google calendars next to your plan, and optionally show your time blocks in one of them.',
    hosts: [
      'accounts.google.com (sign-in, in your browser)',
      'oauth2.googleapis.com',
      'www.googleapis.com',
    ],
    receives: [
      'Your calendar list (names, colors, access level)',
      'Events in the calendars you select, from 60 days ago to a year ahead: title, time, location, description, busy/free, recurrence',
    ],
    sends: [
      'Your sign-in token with every request',
      'If you enable time-block mirroring: the title, notes and times of your Keel time blocks',
    ],
    writes: [
      'Create, update and delete events for your Keel time blocks in the one calendar you choose (opt-in). Keel never edits or deletes events it did not create.',
    ],
    scopes: [
      {
        scope: 'https://www.googleapis.com/auth/calendar.readonly',
        why: 'Read calendars and events',
      },
      {
        scope: 'https://www.googleapis.com/auth/calendar.events',
        why: 'Write your time blocks as events',
        optional: true,
      },
    ],
    setup: [
      'Google does not allow a shared client for an open-source desktop app, so you create your own (free, about 5 minutes).',
      'In console.cloud.google.com create a project and enable the “Google Calendar API”.',
      'Under “OAuth consent screen”, choose External and add your own Google address as a test user.',
      'Under Credentials → Create credentials → OAuth client ID, choose “Desktop app”. Copy the client ID and client secret here.',
      'Note: while the consent screen is in “Testing”, Google expires the sign-in after 7 days; publish it (no review is needed for your own use of these scopes in most cases) or reconnect weekly.',
    ],
    fields: [
      { key: 'clientId', label: 'OAuth client ID', placeholder: '….apps.googleusercontent.com' },
      {
        key: 'clientSecret',
        label: 'Client secret',
        secret: true,
        help: 'Google issues a secret for desktop clients too; it is stored in your OS credential store.',
      },
    ],
    revoke:
      'Disconnecting asks Google to revoke Keel’s token and deletes it from this computer. You can also remove access at myaccount.google.com/permissions.',
    revokeUrl: 'https://myaccount.google.com/permissions',
    syncDirection:
      'Events: Google → Keel (read-only copies). Time blocks (opt-in): Keel → Google, into one calendar.',
    conflicts:
      'Google is the source of truth for its events; local copies are replaced on each sync. For mirrored time blocks Keel is the source of truth; if you delete a mirrored event in Google, Keel stops mirroring that block instead of recreating it.',
    rateLimits: `${RATE} Incremental sync uses Google sync tokens; an expired token (HTTP 410) triggers one full resync.`,
    offline: OFFLINE,
    verification: VERIFY,
  },
  {
    id: 'microsoft',
    name: 'Outlook / Microsoft 365',
    kind: 'calendar',
    auth: 'oauth',
    summary:
      'See your Outlook.com or Microsoft 365 calendars next to your plan, and optionally show your time blocks in one of them.',
    hosts: ['login.microsoftonline.com (sign-in, in your browser)', 'graph.microsoft.com'],
    receives: [
      'Your calendar list and your account’s email address',
      'Events in the calendars you select, from 60 days ago to a year ahead (recurring series arrive as individual occurrences)',
    ],
    sends: [
      'Your sign-in token with every request',
      'If you enable time-block mirroring: the title, notes and times of your Keel time blocks',
    ],
    writes: [
      'Create, update and delete events tagged with the category “Keel” for your time blocks, in the one calendar you choose (opt-in). Keel never edits or deletes events it did not create.',
    ],
    scopes: [
      { scope: 'User.Read', why: 'Show which account is connected' },
      { scope: 'Calendars.Read', why: 'Read calendars and events' },
      { scope: 'offline_access', why: 'Stay connected without signing in every hour' },
      { scope: 'Calendars.ReadWrite', why: 'Write your time blocks as events', optional: true },
    ],
    setup: [
      'Register a free app for Keel in your Microsoft account (about 5 minutes).',
      'In entra.microsoft.com → App registrations → New registration. For personal Outlook.com accounts choose “Accounts in any organizational directory and personal Microsoft accounts”.',
      'Under Authentication → Add a platform → “Mobile and desktop applications”, add the redirect URI http://localhost',
      'Under API permissions, add Microsoft Graph delegated permissions Calendars.Read, User.Read and offline_access (and Calendars.ReadWrite if you want time blocks in Outlook).',
      'Copy the Application (client) ID here. No client secret is needed. Work accounts may need an administrator to approve the app.',
    ],
    fields: [
      {
        key: 'clientId',
        label: 'Application (client) ID',
        placeholder: '00000000-0000-0000-0000-000000000000',
      },
      {
        key: 'tenant',
        label: 'Tenant',
        optional: true,
        placeholder: 'common',
        help: 'Leave empty for “common”. Use your directory (tenant) ID if the app is registered for your organization only.',
      },
    ],
    revoke:
      'Disconnecting deletes the token from this computer. To revoke Keel’s access at Microsoft, remove the app at account.live.com/consent/Manage (personal) or myapps.microsoft.com (work).',
    revokeUrl: 'https://account.live.com/consent/Manage',
    syncDirection:
      'Events: Microsoft → Keel (read-only copies). Time blocks (opt-in): Keel → Microsoft, into one calendar.',
    conflicts:
      'Microsoft is the source of truth for its events. For mirrored time blocks Keel is; if you delete a mirrored event in Outlook, Keel stops mirroring that block instead of recreating it.',
    rateLimits: `${RATE} Incremental sync uses Graph delta links; an expired link triggers one full resync.`,
    offline: OFFLINE,
    verification: VERIFY,
  },
  {
    id: 'ics-subscription',
    name: 'Calendar feed (iCal URL)',
    kind: 'calendar',
    auth: 'url',
    summary:
      'Subscribe to any calendar published as an .ics / webcal address: holidays, sports, a colleague’s shared calendar.',
    hosts: ['The host in the address you enter'],
    receives: ['Every event in the feed'],
    sends: ['An HTTPS request to the address (including anything embedded in it)'],
    writes: [],
    scopes: [],
    setup: [
      'Copy the calendar’s iCal / webcal address (in Google Calendar: Settings → the calendar → “Secret address in iCal format”; in Outlook: Settings → Calendar → Shared calendars → Publish a calendar → ICS link).',
      'Private addresses work like passwords, so Keel keeps the address in your OS credential store.',
    ],
    fields: [
      {
        key: 'url',
        label: 'Calendar address',
        placeholder: 'https://… or webcal://…',
        secret: true,
      },
    ],
    revoke:
      'Removing the subscription deletes the address and the local copy of its events. To invalidate a leaked private address, reset it at the provider.',
    syncDirection: 'Feed → Keel (read-only copy).',
    conflicts:
      'The feed is the source of truth; events that disappear from it are removed locally.',
    rateLimits: RATE,
    offline: OFFLINE,
    verification: VERIFY,
  },
  {
    id: 'todoist',
    name: 'Todoist',
    kind: 'tasks',
    auth: 'token',
    summary: 'Bring your open Todoist tasks into Keel to plan and timebox them.',
    hosts: ['api.todoist.com'],
    receives: ['Open tasks: content, description, deadline or due date, priority, duration, link'],
    sends: [
      'Your API token with every request',
      'If write-back is on: which tasks you completed or reopened',
    ],
    writes: ['Close (and reopen) tasks you complete in Keel (opt-in)'],
    scopes: [
      {
        scope: 'Personal API token',
        why: 'Todoist tokens grant full access to your account; Keel only calls the task endpoints listed here',
      },
    ],
    setup: ['In Todoist open Settings → Integrations → Developer and copy your API token.'],
    fields: [{ key: 'apiToken', label: 'API token', secret: true }],
    revoke:
      'Disconnecting deletes the token from this computer. To invalidate it, issue a new API token in Todoist’s Developer settings.',
    syncDirection: 'Tasks: Todoist → Keel. Completion (opt-in): Keel → Todoist.',
    conflicts: TASK_CONFLICTS,
    rateLimits: RATE,
    offline: OFFLINE,
    verification: VERIFY,
  },
  {
    id: 'asana',
    name: 'Asana',
    kind: 'tasks',
    auth: 'token',
    summary: 'Bring the incomplete Asana tasks assigned to you (in every workspace) into Keel.',
    hosts: ['app.asana.com'],
    receives: [
      'Your workspaces and user id',
      'Incomplete tasks assigned to you: name, notes, due date, link, project',
    ],
    sends: [
      'Your personal access token with every request',
      'If write-back is on: which tasks you completed or reopened',
    ],
    writes: ['Mark tasks complete / incomplete when you complete them in Keel (opt-in)'],
    scopes: [
      {
        scope: 'Personal access token',
        why: 'Grants the access your Asana user has; Keel only calls the task endpoints listed here',
      },
    ],
    setup: [
      'In Asana open My settings → Apps → Manage developer apps (app.asana.com/0/my-apps) and create a personal access token.',
    ],
    fields: [{ key: 'apiToken', label: 'Personal access token', secret: true }],
    revoke:
      'Disconnecting deletes the token from this computer. Delete the token in Asana’s developer console to invalidate it.',
    revokeUrl: 'https://app.asana.com/0/my-apps',
    syncDirection: 'Tasks: Asana → Keel. Completion (opt-in): Keel → Asana.',
    conflicts: TASK_CONFLICTS,
    rateLimits: RATE,
    offline: OFFLINE,
    verification: VERIFY,
  },
  {
    id: 'trello',
    name: 'Trello',
    kind: 'tasks',
    auth: 'token',
    summary: 'Bring open Trello cards assigned to you into Keel.',
    hosts: ['api.trello.com'],
    receives: ['Open cards you are a member of: name, description, due date, board, link'],
    sends: [
      'Your API key and token with every request',
      'If write-back is on: the due-date “complete” flag of cards you complete',
    ],
    writes: [
      'Mark the card’s due date complete when you complete it in Keel (opt-in). Trello cards have no other “done” state.',
    ],
    scopes: [{ scope: 'read (+ write for write-back)', why: 'Chosen when you generate the token' }],
    setup: [
      'At trello.com/power-ups/admin create a Power-Up (any name) to get an API key.',
      'Next to the key, follow the “Token” link, allow access, and copy the token.',
    ],
    fields: [
      { key: 'apiKey', label: 'API key' },
      { key: 'apiToken', label: 'Token', secret: true },
    ],
    revoke:
      'Disconnecting deletes the key and token from this computer. Revoke the token in Trello under your account settings → Applications.',
    syncDirection: 'Cards: Trello → Keel. Completion (opt-in): Keel → Trello.',
    conflicts: TASK_CONFLICTS,
    rateLimits: RATE,
    offline: OFFLINE,
    verification: VERIFY,
  },
  {
    id: 'jira',
    name: 'Jira Cloud',
    kind: 'tasks',
    auth: 'token',
    summary: 'Bring unresolved Jira issues assigned to you into Keel. Read-only.',
    hosts: ['your-site.atlassian.net (only the site you enter)'],
    receives: ['Unresolved issues assigned to you: key, summary, due date, priority, link'],
    sends: ['Your email and API token with every request'],
    writes: [],
    scopes: [
      {
        scope: 'API token',
        why: 'Grants the access your Jira user has; Keel only runs a JQL search',
      },
    ],
    setup: [
      'Create an API token at id.atlassian.com/manage-profile/security/api-tokens.',
      'Enter your site (for example acme.atlassian.net), the email you sign in with, and the token.',
      'Keel does not complete Jira issues (Jira workflows differ per project); resolve them in Jira and they leave Keel on the next sync.',
    ],
    fields: [
      { key: 'site', label: 'Site', placeholder: 'your-team.atlassian.net' },
      { key: 'email', label: 'Account email' },
      { key: 'apiToken', label: 'API token', secret: true },
    ],
    revoke:
      'Disconnecting deletes the credentials from this computer. Revoke the token at id.atlassian.com to invalidate it.',
    revokeUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    syncDirection: 'Issues: Jira → Keel (read-only).',
    conflicts: TASK_CONFLICTS,
    rateLimits: RATE,
    offline: OFFLINE,
    verification: VERIFY,
  },
  {
    id: 'notion',
    name: 'Notion',
    kind: 'tasks',
    auth: 'token',
    summary: 'Bring the open items of one Notion task database into Keel.',
    hosts: ['api.notion.com'],
    receives: ['Pages in the database you share: title, a done checkbox/status, a date, link'],
    sends: [
      'Your integration secret with every request',
      'If write-back is on: ticks the database’s checkbox for pages you complete',
    ],
    writes: [
      'Tick the “done” checkbox of pages you complete in Keel (opt-in; only for checkbox properties)',
    ],
    scopes: [
      {
        scope: 'Internal integration',
        why: 'Sees only pages and databases you explicitly connect to it',
      },
    ],
    setup: [
      'At notion.so/profile/integrations create an internal integration and copy its secret.',
      'Open your task database → ••• → Connections → add the integration.',
      'Copy the database ID (the 32-character part of the database link) here.',
    ],
    fields: [
      { key: 'apiToken', label: 'Integration secret', secret: true },
      { key: 'databaseId', label: 'Database ID', placeholder: '32 hexadecimal characters' },
    ],
    revoke:
      'Disconnecting deletes the secret from this computer. Remove the integration’s connection or delete the integration in Notion to revoke it.',
    revokeUrl: 'https://www.notion.so/profile/integrations',
    syncDirection: 'Pages: Notion → Keel. Completion (opt-in): Keel → Notion.',
    conflicts: TASK_CONFLICTS,
    rateLimits: `${RATE} Notion allows about 3 requests per second on average.`,
    offline: OFFLINE,
    verification: VERIFY,
  },
];

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function calendarAdapter(id: string): CalendarAdapter | null {
  if (id === 'google') return googleCalendar;
  if (id === 'microsoft') return microsoftCalendar;
  return null;
}

export function taskAdapter(id: string): TaskAdapter | null {
  switch (id) {
    case 'todoist':
      return todoist;
    case 'asana':
      return asana;
    case 'trello':
      return trello;
    case 'jira':
      return jira;
    case 'notion':
      return notion;
  }
  return null;
}

/** OAuth scopes to request. The write scope is added only when the user wants time blocks mirrored. */
export function oauthScopes(id: 'google' | 'microsoft', write: boolean): string[] {
  const p = providerInfo(id)!;
  return p.scopes.filter((s) => !s.optional || write).map((s) => s.scope);
}

export function hasWriteScope(id: string, granted: string | null | undefined): boolean {
  const s = granted ?? '';
  if (id === 'google') return s.includes('auth/calendar.events') || /auth\/calendar(\s|$)/.test(s);
  if (id === 'microsoft') return /calendars\.readwrite/i.test(s);
  return false;
}
