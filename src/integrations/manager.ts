/**
 * Runs the optional integrations inside the desktop app: connecting accounts (credentials go
 * straight to the OS credential store via Rust), syncing on a timer, disconnecting, and the
 * local email → task import. Nothing here runs unless the user connects an account.
 */
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { create } from 'zustand';
import { native } from '@/app/native';
import type { Executor } from '@/db/driver';
import { ui } from '@/app/ui';
import { addTask, clearUndoHistory, errorMessage, perform, refreshAll } from '@/data/actions';
import { newId } from '@/data/repo';
import * as repo from '@/data/repo';
import { getDb, isTauri } from '@/data/runtime';
import { getData } from '@/data/store';
import { todayIn } from '@/domain/dates';
import type { IntegrationAccount } from '@/domain/types';
import { emailToTask, parseEml } from './email';
import type { RetryOptions } from './http';
import { getJson, withRetry } from './http';
import type { CredentialKey, ProviderId } from './registry';
import { calendarAdapter, oauthScopes, providerInfo, taskAdapter } from './registry';
import type { AccountConfig, SyncDeps, SyncReport } from './sync';
import {
  createAccount,
  describeReport,
  getAccount,
  removeAccount,
  syncCalendarAccount,
  syncIcsAccount,
  syncTaskAccount,
  updateAccount,
} from './sync';
import type { Http, HttpResponse } from './types';
import { IntegrationError } from './types';

export const DEFAULT_INTERVAL_MIN = 15;

/** Live sync status for the UI (not persisted). */
export const useSyncState = create<{ syncing: Record<string, boolean> }>(() => ({ syncing: {} }));

function setSyncing(id: string, on: boolean) {
  useSyncState.setState((s) => ({ syncing: { ...s.syncing, [id]: on } }));
}

function requireDesktop() {
  if (!isTauri())
    throw new Error(
      'Integrations run in the Keel desktop app (they need the OS credential store).',
    );
}

/** Retry behaviour for provider calls (tests replace `sleep`). */
export const retryOptions: RetryOptions = {};

/** An Http bound to one account. Rust attaches that account's credentials; the UI never sees them. */
export function accountHttp(accountId: string): Http {
  return withRetry(
    (request) =>
      invoke<HttpResponse>('integration_fetch', {
        accountId,
        request: {
          method: request.method,
          url: request.url,
          headers: request.headers ?? [],
          body: request.body ?? null,
        },
      }),
    retryOptions,
  );
}

function depsFor(accountId: string): SyncDeps {
  return {
    http: accountHttp(accountId),
    now: () => new Date(),
    zone: getData().zone,
    fetchIcs: (account) => invoke<string>('ics_fetch_account', { accountId: account.id }),
  };
}

function ctxFor(tx: Executor) {
  const zone = getData().zone;
  const now = new Date();
  return {
    tx,
    now: now.toISOString(),
    today: todayIn(zone, now),
    zone,
    changes: new repo.ChangeSet(),
  };
}

async function deleteSecret(accountId: string) {
  await invoke('integration_delete_secret', { accountId }).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------------------

export type CredentialValues = Partial<Record<CredentialKey, string>>;

/** Creates the local account row, runs the first sync, and rolls everything back on failure. */
async function finishConnect(
  id: string,
  provider: ProviderId,
  label: string,
  config: AccountConfig,
): Promise<SyncReport> {
  await perform({ label: null, quiet: true }, (ctx) =>
    createAccount(ctx, provider, label, config, id),
  );
  try {
    return (await syncAccount(id, { throwOnError: true }))!;
  } catch (e) {
    await perform({ label: null, quiet: true }, (ctx) => removeAccount(ctx, id, true));
    await deleteSecret(id);
    throw e;
  }
}

/**
 * Signs in with Google or Microsoft in the system browser (loopback redirect + PKCE), then
 * lists the account's calendars. The primary calendar is selected; nothing is written until
 * the user picks a calendar for time blocks.
 */
export async function connectOAuth(
  provider: 'google' | 'microsoft',
  creds: CredentialValues,
  allowWrite: boolean,
): Promise<{ id: string; report: SyncReport }> {
  requireDesktop();
  const id = newId();
  const { scope } = await invoke<{ scope: string | null }>('oauth_connect', {
    accountId: id,
    provider,
    clientId: creds.clientId?.trim() ?? '',
    clientSecret: creds.clientSecret?.trim() || null,
    tenant: creds.tenant?.trim() || null,
    scopes: oauthScopes(provider, allowWrite),
  });
  try {
    const http = accountHttp(id);
    const calendars = await calendarAdapter(provider)!.listCalendars(http);
    let label = calendars.find((c) => c.primary)?.externalId ?? '';
    if (provider === 'microsoft') {
      const me = await getJson<{ mail?: string | null; userPrincipalName?: string }>(
        http,
        'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',
        'Read Microsoft account',
      );
      label = me.mail ?? me.userPrincipalName ?? '';
    }
    const config: AccountConfig = {
      calendars: calendars.map((c) => ({ ...c, selected: c.primary })),
      pushCalendarId: null,
      grantedScope: scope,
      intervalMin: DEFAULT_INTERVAL_MIN,
    };
    const report = await finishConnect(id, provider, label || providerInfo(provider)!.name, config);
    return { id, report };
  } catch (e) {
    await deleteSecret(id);
    throw e;
  }
}

/** Signs in again (expired sign-in, or to grant the write permission) with the stored client. */
export async function reconnectOAuth(account: IntegrationAccount, allowWrite: boolean) {
  requireDesktop();
  const provider = account.provider as 'google' | 'microsoft';
  const { scope } = await invoke<{ scope: string | null }>('oauth_connect', {
    accountId: account.id,
    provider,
    clientId: '',
    clientSecret: null,
    tenant: null,
    scopes: oauthScopes(provider, allowWrite),
  });
  await perform({ label: null, quiet: true }, (ctx) =>
    updateAccount(ctx, account.id, {
      status: 'connected',
      lastError: null,
      config: { ...(account.config as AccountConfig), grantedScope: scope },
    }),
  );
  return syncAccount(account.id);
}

/** Connects a token- or URL-based integration after validating it with a first sync. */
export async function connectWithCredentials(
  provider: Exclude<ProviderId, 'google' | 'microsoft'>,
  values: CredentialValues,
  label?: string,
): Promise<{ id: string; report: SyncReport }> {
  requireDesktop();
  const info = providerInfo(provider)!;
  for (const f of info.fields)
    if (!f.optional && !values[f.key]?.trim()) throw new Error(`${f.label} is required`);
  const id = newId();
  const v = (k: CredentialKey) => values[k]?.trim() || null;
  await invoke('integration_store_secret', {
    accountId: id,
    secret: {
      provider: provider === 'ics-subscription' ? 'ics' : provider,
      api_token: v('apiToken'),
      api_key: v('apiKey'),
      email: v('email'),
      site:
        v('site')
          ?.replace(/^https?:\/\//i, '')
          .replace(/\/.*$/, '') ?? null,
      url: v('url'),
    },
  });
  let config: AccountConfig = { intervalMin: DEFAULT_INTERVAL_MIN };
  let name = label?.trim() || info.name;
  if (provider === 'ics-subscription') {
    const host = (() => {
      try {
        return new URL(v('url')!.replace(/^webcal:/i, 'https:')).host;
      } catch {
        return '';
      }
    })();
    config = { ...config, feedHost: host };
    name = label?.trim() || host || info.name;
  } else {
    config = { ...config, syncCompletion: false };
    if (provider === 'jira') {
      config.site = v('site')!
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '')
        .toLowerCase();
      name = label?.trim() || `Jira · ${config.site}`;
    }
    if (provider === 'notion') config.databaseId = v('databaseId')!;
  }
  const report = await finishConnect(id, provider, name, config);
  return { id, report };
}

// ---------------------------------------------------------------------------------------
// Syncing
// ---------------------------------------------------------------------------------------

const inFlight = new Map<string, Promise<SyncReport | null>>();

async function runSync(account: IntegrationAccount): Promise<SyncReport> {
  const db = getDb();
  const deps = depsFor(account.id);
  const cal = calendarAdapter(account.provider);
  if (cal) return syncCalendarAccount(db, account, cal, deps);
  if (account.provider === 'ics-subscription') return syncIcsAccount(db, account, deps);
  const tasks = taskAdapter(account.provider);
  if (tasks)
    return syncTaskAccount(
      db,
      account,
      tasks,
      providerInfo(account.provider)?.name ?? account.provider,
      deps,
    );
  throw new IntegrationError(`Unknown integration “${account.provider}”`, 'config');
}

/**
 * Syncs one account. Errors are recorded on the account (and shown unless `quiet`); an auth
 * error marks it as needing a reconnect, which pauses automatic sync for it.
 */
export async function syncAccount(
  id: string,
  opts: { quiet?: boolean; throwOnError?: boolean } = {},
): Promise<SyncReport | null> {
  requireDesktop();
  const pending = inFlight.get(id);
  if (pending) return pending;
  const job = (async () => {
    const db = getDb();
    const account = await getAccount(db, id);
    if (!account) throw new Error('This integration no longer exists');
    setSyncing(id, true);
    try {
      const report = await runSync(account);
      await db.transaction(async (tx) => {
        const ctx = ctxFor(tx);
        await updateAccount(ctx, id, {
          status: 'connected',
          lastSyncAt: ctx.now,
          lastError: report.warnings.length ? report.warnings.slice(0, 3).join(' ') : null,
        });
        // Imported/updated tasks can invalidate older undo steps (see actions.clearUndoHistory).
        if (report.tasksCreated || report.tasksUpdated || report.tasksClosed)
          await clearUndoHistory(tx);
      });
      await refreshAll();
      return report;
    } catch (e) {
      const err =
        e instanceof IntegrationError ? e : new IntegrationError(errorMessage(e), 'provider');
      const offline = err.kind === 'network';
      await db.transaction(async (tx) => {
        const ctx = ctxFor(tx);
        await updateAccount(ctx, id, {
          status: err.kind === 'auth' ? 'needs_reauth' : offline ? account.status : 'error',
          lastError: offline
            ? `Offline or unreachable — will retry. (${err.message})`
            : err.message,
        });
      });
      await refreshAll();
      if (opts.throwOnError) throw err;
      if (!opts.quiet) toast.error(`${account.label}: ${err.message}`);
      return null;
    } finally {
      setSyncing(id, false);
    }
  })();
  inFlight.set(id, job);
  try {
    return await job;
  } finally {
    inFlight.delete(id);
  }
}

/** Sync with a toast summary, for the "Sync now" button. */
export async function syncNow(account: IntegrationAccount) {
  const report = await syncAccount(account.id);
  if (report) toast.success(`${account.label}: ${describeReport(report)}`);
}

export function isDue(a: IntegrationAccount, now: number): boolean {
  if (a.status === 'needs_reauth' || a.status === 'disconnected') return false;
  const interval = (a.config as AccountConfig).intervalMin ?? DEFAULT_INTERVAL_MIN;
  if (!interval) return false;
  const last = a.lastSyncAt ? Date.parse(a.lastSyncAt) : 0;
  // After an error, wait at least 5 minutes before trying again.
  const wait = a.status === 'error' ? Math.max(interval, 5) : interval;
  return now - last >= wait * 60_000;
}

/**
 * Background sync while the app runs: checks every minute, when the network comes back, and
 * shortly after start. Offline (navigator.onLine false) skips the run entirely.
 */
export function startIntegrationScheduler(): () => void {
  if (!isTauri()) return () => undefined;
  let stopped = false;
  const tick = async () => {
    if (stopped || !navigator.onLine) return;
    const now = Date.now();
    for (const a of Object.values(getData().accounts)) {
      if (stopped) return;
      if (isDue(a, now)) await syncAccount(a.id, { quiet: true }).catch(() => undefined);
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  const first = setTimeout(() => void tick(), 5_000);
  const online = () => void tick();
  window.addEventListener('online', online);
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(first);
    window.removeEventListener('online', online);
  };
}

// ---------------------------------------------------------------------------------------
// Settings & disconnecting
// ---------------------------------------------------------------------------------------

export async function saveAccountConfig(
  account: IntegrationAccount,
  patch: Partial<AccountConfig>,
) {
  await perform({ label: null }, (ctx) =>
    updateAccount(ctx, account.id, { config: { ...(account.config as AccountConfig), ...patch } }),
  );
}

export async function renameAccount(account: IntegrationAccount, label: string) {
  if (!label.trim()) return;
  await perform({ label: null }, (ctx) => updateAccount(ctx, account.id, { label: label.trim() }));
}

export interface DisconnectOptions {
  /** Delete tasks this account imported (otherwise they stay as ordinary local tasks). */
  removeImportedTasks: boolean;
  /** Delete the events Keel created for time blocks in the provider's calendar. */
  removeMirroredBlocks: boolean;
}

/**
 * Removes an account: optionally deletes the time-block events Keel created remotely, revokes
 * the token where the provider supports it (Google), deletes the credentials from the OS
 * store, and removes local copies. Events Keel did not create are never touched.
 */
export async function disconnectAccount(
  account: IntegrationAccount,
  opts: DisconnectOptions,
): Promise<{ remoteCleanupFailed: boolean }> {
  requireDesktop();
  const db = getDb();
  let remoteCleanupFailed = false;
  const config = account.config as AccountConfig;
  const cal = calendarAdapter(account.provider);
  if (opts.removeMirroredBlocks && cal?.deleteBlock && config.pushCalendarId) {
    const http = accountHttp(account.id);
    const mirrored = await db.all<{ external_id: string; external_version: string | null }>(
      "SELECT external_id, external_version FROM integration_mappings WHERE account_id = ? AND entity_type = 'time_block'",
      [account.id],
    );
    for (const m of mirrored) {
      if (m.external_version === 'remote-deleted') continue;
      try {
        await cal.deleteBlock(http, config.pushCalendarId, m.external_id);
      } catch {
        remoteCleanupFailed = true;
      }
    }
  }
  if (account.provider === 'google')
    await invoke('oauth_revoke', { accountId: account.id }).catch(() => undefined);
  await invoke('integration_delete_secret', { accountId: account.id });
  await db.transaction(async (tx) => {
    const ctx = ctxFor(tx);
    await removeAccount(ctx, account.id, opts.removeImportedTasks);
    if (opts.removeImportedTasks) await clearUndoHistory(tx);
  });
  await refreshAll();
  return { remoteCleanupFailed };
}

/** Used by "Delete all data": removes every integration credential from the OS store. */
export async function deleteAllIntegrationSecrets(): Promise<void> {
  if (!isTauri()) return;
  const rows = await getDb().all<{ id: string }>('SELECT id FROM integration_accounts');
  if (rows.length)
    await invoke('integration_delete_secrets', { accountIds: rows.map((r) => r.id) });
}

// ---------------------------------------------------------------------------------------
// Email → task (local)
// ---------------------------------------------------------------------------------------

/** Opens a saved email (.eml) and adds it to the Inbox as a task. Entirely local. */
export async function importEmailAsTask(): Promise<void> {
  try {
    const file = await native.openText('Email message', ['eml'], true);
    if (!file) return;
    const task = emailToTask(parseEml(file.contents), getData().zone);
    const id = await addTask({ ...task, source: 'email', backlogPosition: 'top' });
    toast.success(`Added “${task.title}” to the Inbox`, {
      action: { label: 'Open', onClick: () => ui.openTask(id) },
    });
  } catch (e) {
    toast.error(errorMessage(e));
  }
}
