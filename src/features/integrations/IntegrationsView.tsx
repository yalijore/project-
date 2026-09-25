import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  Globe,
  ListChecks,
  Loader2,
  Lock,
  Mail,
  RefreshCw,
  Settings2,
  Unplug,
} from 'lucide-react';
import { native } from '@/app/native';
import { errorMessage, run } from '@/data/actions';
import { getDb, isTauri } from '@/data/runtime';
import { useData } from '@/data/store';
import type { IntegrationAccount } from '@/domain/types';
import type { CredentialValues } from '@/integrations/manager';
import {
  DEFAULT_INTERVAL_MIN,
  connectOAuth,
  connectWithCredentials,
  disconnectAccount,
  importEmailAsTask,
  reconnectOAuth,
  renameAccount,
  saveAccountConfig,
  syncNow,
  useSyncState,
} from '@/integrations/manager';
import type { ProviderInfo } from '@/integrations/registry';
import { PROVIDERS, hasWriteScope, providerInfo } from '@/integrations/registry';
import type { AccountConfig } from '@/integrations/sync';
import { describeReport } from '@/integrations/sync';
import { Button, Dialog, Input, Label, Switch, cn } from '@/ui/primitives';
import { ViewHeader } from '../common/ViewHeader';

function useCredentialStoreName(): string {
  const [name, setName] = useState('your system’s credential store');
  useEffect(() => {
    void native.environment().then((env) => {
      if (env.os === 'windows') setName('Windows Credential Manager');
      else if (env.os === 'macos') setName('the macOS Keychain');
      else if (env.os === 'linux') setName('your desktop keyring (Secret Service)');
    });
  }, []);
  return name;
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString();
}

const INTERVALS = [
  { value: 0, label: 'Only when I press Sync now' },
  { value: 5, label: 'Every 5 minutes' },
  { value: 15, label: 'Every 15 minutes' },
  { value: 30, label: 'Every 30 minutes' },
  { value: 60, label: 'Every hour' },
];

const selectClass = 'h-8 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg';

function NetworkBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-fg">
      <Globe size={11} aria-hidden /> Networked
    </span>
  );
}

function LocalBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-[11px] font-medium text-fg">
      <Lock size={11} aria-hidden /> Local only
    </span>
  );
}

function FlowRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2">
      <dt className="text-[12px] font-medium text-muted">{label}</dt>
      <dd>
        {items.length ? (
          <ul className="flex flex-col gap-0.5">
            {items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        ) : (
          <span className="text-muted">Nothing — read-only</span>
        )}
      </dd>
    </div>
  );
}

/** The complete data-flow disclosure, shown before connecting and on every account. */
function DataFlow({ p }: { p: ProviderInfo }) {
  return (
    <dl className="flex flex-col gap-2 text-[12.5px] text-fg">
      <FlowRow label="Contacts" items={p.hosts} />
      <FlowRow label="Downloads" items={p.receives} />
      <FlowRow label="Sends" items={p.sends} />
      <FlowRow label={`Can change in ${p.name}`} items={p.writes} />
      {p.scopes.length > 0 && (
        <FlowRow
          label="Permissions"
          items={p.scopes.map(
            (s) => `${s.scope} — ${s.why}${s.optional ? ' (only if enabled)' : ''}`,
          )}
        />
      )}
      <FlowRow label="Sync" items={[p.syncDirection]} />
      <FlowRow label="Conflicts" items={[p.conflicts]} />
      <FlowRow label="Rate limits" items={[p.rateLimits]} />
      <FlowRow label="Offline" items={[p.offline]} />
      <FlowRow label="Disconnect" items={[p.revoke]} />
    </dl>
  );
}

// ---------------------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------------------

function ConnectDialog({ p, onClose }: { p: ProviderInfo; onClose: () => void }) {
  const storeName = useCredentialStoreName();
  const [values, setValues] = useState<CredentialValues>({});
  const [label, setLabel] = useState('');
  const [allowWrite, setAllowWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showFlow, setShowFlow] = useState(true);
  const desktop = isTauri();
  const missing = p.fields.some((f) => !f.optional && !values[f.key]?.trim());

  const connect = async () => {
    setBusy(true);
    try {
      const { report } =
        p.id === 'google' || p.id === 'microsoft'
          ? await connectOAuth(p.id, values, allowWrite)
          : await connectWithCredentials(p.id, values, label);
      toast.success(`${p.name} connected · ${describeReport(report)}`);
      onClose();
    } catch (e) {
      toast.error(`Couldn’t connect ${p.name}: ${errorMessage(e)}`);
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && (!busy || p.auth === 'oauth') && onClose()}
      title={`Connect ${p.name}`}
      description={p.summary}
      width={620}
    >
      <form
        className="flex flex-col gap-4 px-5 pt-2 pb-5 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (!missing && !busy && desktop) void connect();
        }}
      >
        <div className="rounded-xl border border-line bg-sunken/60 px-4 py-3">
          <button
            type="button"
            className="mb-2 flex w-full items-center gap-2 text-left text-[12.5px] font-semibold text-fg"
            onClick={() => setShowFlow((v) => !v)}
            aria-expanded={showFlow}
          >
            <Globe size={14} aria-hidden /> What this integration exchanges over the network
            <span className="ml-auto text-[11.5px] font-normal text-muted">
              {showFlow ? 'Hide' : 'Show'}
            </span>
          </button>
          {showFlow && <DataFlow p={p} />}
        </div>

        <div>
          <h3 className="mb-1.5 text-[12.5px] font-semibold text-fg">Setup</h3>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-[12.5px] text-fg">
            {p.setup.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>

        <div className="flex flex-col gap-3">
          {p.id === 'ics-subscription' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="int-label">Name (optional)</Label>
              <Input
                id="int-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Public holidays"
              />
            </div>
          )}
          {p.fields.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`int-${f.key}`}>
                {f.label}
                {f.optional ? ' (optional)' : ''}
              </Label>
              <Input
                id={`int-${f.key}`}
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                placeholder={f.placeholder}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
              {f.help && <p className="text-[11.5px] text-muted">{f.help}</p>}
            </div>
          ))}
          {p.auth === 'oauth' && (
            <label className="flex items-start gap-2.5 text-[12.5px]">
              <Switch
                checked={allowWrite}
                onCheckedChange={setAllowWrite}
                label="Also allow writing my time blocks to a calendar"
              />
              <span>
                Also allow Keel to write my time blocks to a calendar I choose.
                <span className="block text-muted">
                  Adds the write permission. You can connect read-only now and add it later.
                </span>
              </span>
            </label>
          )}
        </div>

        <p className="flex items-start gap-2 text-[12px] text-muted">
          <Lock size={13} className="mt-0.5 shrink-0" aria-hidden />
          {p.auth === 'oauth'
            ? `Sign-in happens in your web browser. The tokens it returns are kept in ${storeName}, never in Keel’s database, and are only ever sent to ${p.name}.`
            : `Stored in ${storeName}, never in Keel’s database, and only ever sent to ${p.auth === 'url' ? 'that address' : p.name}.`}
        </p>
        <p className="text-[11.5px] text-subtle">
          Status: {p.verification}. Keel’s adapter is tested against recorded {p.name} responses,
          not against a live account.
        </p>

        {!desktop && (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px]">
            Integrations run in the Keel desktop app, which keeps credentials in the OS credential
            store. This browser preview cannot connect accounts.
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          {busy && p.auth === 'oauth' && (
            <span
              className="mr-auto flex items-center gap-2 text-[12.5px] text-muted"
              role="status"
            >
              <Loader2 size={14} className="animate-spin" aria-hidden />
              Finish signing in in your browser… (you can close this; it waits 5 minutes)
            </span>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy && p.auth !== 'oauth'}>
            {busy ? 'Close' : 'Cancel'}
          </Button>
          <Button type="submit" variant="primary" disabled={missing || busy || !desktop}>
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            {p.auth === 'oauth' ? 'Sign in with browser' : 'Connect'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ProviderCard({ p, onConnect }: { p: ProviderInfo; onConnect: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] font-semibold text-fg">{p.name}</span>
        <NetworkBadge />
      </div>
      <p className="flex-1 text-[12.5px] text-muted">{p.summary}</p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-subtle">
          {p.writes.length ? 'Reads; writes only if you enable it' : 'Read-only'}
        </span>
        <Button size="sm" variant="secondary" onClick={onConnect}>
          Connect…
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------------------

function StatusPill({ account, syncing }: { account: IntegrationAccount; syncing: boolean }) {
  if (syncing)
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] text-muted" role="status">
        <Loader2 size={12} className="animate-spin" aria-hidden /> Syncing…
      </span>
    );
  const map = {
    connected: { icon: <CheckCircle2 size={12} />, text: 'Connected', cls: 'bg-ok-soft' },
    needs_reauth: {
      icon: <AlertTriangle size={12} />,
      text: 'Needs reconnect',
      cls: 'bg-warn-soft',
    },
    error: { icon: <AlertTriangle size={12} />, text: 'Sync error', cls: 'bg-danger-soft' },
    disconnected: { icon: <Unplug size={12} />, text: 'Disconnected', cls: 'bg-sunken' },
  }[account.status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-fg',
        map.cls,
      )}
    >
      <span aria-hidden>{map.icon}</span>
      {map.text}
    </span>
  );
}

function CalendarSettings({ account }: { account: IntegrationAccount }) {
  const config = account.config as AccountConfig;
  const info = providerInfo(account.provider)!;
  const calendars = config.calendars ?? [];
  const writable = calendars.filter((c) => c.writable);
  const canWrite = hasWriteScope(account.provider, config.grantedScope);
  const [busy, setBusy] = useState(false);

  const toggle = (externalId: string, selected: boolean) =>
    run(
      saveAccountConfig(account, {
        calendars: calendars.map((c) => (c.externalId === externalId ? { ...c, selected } : c)),
      }).then(() => syncNow(account)),
    );

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h4 className="mb-1 text-[12px] font-semibold text-muted">Calendars to show in Keel</h4>
        <div className="flex flex-col gap-1">
          {calendars.map((c) => (
            <label key={c.externalId} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={c.selected}
                onChange={(e) => toggle(c.externalId, e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              {c.color && (
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: c.color }}
                />
              )}
              {c.name}
              {c.primary && <span className="text-[11px] text-muted">primary</span>}
            </label>
          ))}
          {calendars.length === 0 && (
            <p className="text-[12.5px] text-muted">No calendars found.</p>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`push-${account.id}`}>Show my time blocks in {info.name}</Label>
        <select
          id={`push-${account.id}`}
          className={selectClass}
          value={config.pushCalendarId ?? ''}
          onChange={(e) =>
            run(saveAccountConfig(account, { pushCalendarId: e.target.value || null }))
          }
        >
          <option value="">Don’t write anything (read-only)</option>
          {writable.map((c) => (
            <option key={c.externalId} value={c.externalId}>
              {c.name}
            </option>
          ))}
        </select>
        <p className="text-[11.5px] text-muted">
          Keel creates, moves and deletes only the events it made for your time blocks, from
          yesterday on. It never edits or deletes other events.
        </p>
        {config.pushCalendarId && !canWrite && (
          <div className="flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[12.5px]">
            <AlertTriangle size={14} aria-hidden />
            <span className="flex-1">
              This account was connected read-only. Reconnect to grant the write permission.
            </span>
            <Button
              size="xs"
              variant="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await reconnectOAuth(account, true);
                  toast.success('Write permission granted');
                } catch (e) {
                  toast.error(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Reconnect
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function TaskSettings({ account }: { account: IntegrationAccount }) {
  const config = account.config as AccountConfig;
  const info = providerInfo(account.provider)!;
  const project = useData((s) =>
    config.localProjectId ? s.projects[config.localProjectId] : undefined,
  );
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <p className="text-[12.5px] text-muted">
        Imported into the project <strong className="text-fg">{project?.name ?? info.name}</strong>.
        Plan them like any other task.
      </p>
      {account.provider === 'trello' && (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`trello-done-${account.id}`}>When I complete a card</Label>
          <select
            id={`trello-done-${account.id}`}
            className={selectClass}
            value={config.trelloDone ?? 'due'}
            onChange={(e) =>
              run(
                saveAccountConfig(account, {
                  trelloDone: e.target.value as NonNullable<AccountConfig['trelloDone']>,
                }),
              )
            }
          >
            <option value="due">Tick its due date</option>
            <option value="list">Move it to a list named…</option>
            <option value="archive">Archive it</option>
          </select>
          {config.trelloDone === 'list' && (
            <Input
              aria-label="Name of the done list"
              className="w-40"
              defaultValue={config.trelloDoneList ?? 'Done'}
              onBlur={(e) => run(saveAccountConfig(account, { trelloDoneList: e.target.value }))}
            />
          )}
          <span className="basis-full text-[11.5px] text-muted">
            Cards already in that list, or with a ticked due date, count as done.
          </span>
        </div>
      )}
      {info.writes.length > 0 ? (
        <label className="flex items-start gap-2.5">
          <Switch
            checked={!!config.syncCompletion}
            onCheckedChange={(v) => run(saveAccountConfig(account, { syncCompletion: v }))}
            label={`Complete tasks in ${info.name} too`}
          />
          <span>
            When I complete an imported task in Keel, complete it in {info.name} too.
            <span className="block text-[11.5px] text-muted">{info.writes[0]}</span>
          </span>
        </label>
      ) : (
        <p className="text-[12.5px] text-muted">
          Read-only: complete items in {info.name}; they leave Keel on the next sync.
        </p>
      )}
    </div>
  );
}

function DisconnectDialog({
  account,
  onClose,
}: {
  account: IntegrationAccount;
  onClose: () => void;
}) {
  const info = providerInfo(account.provider);
  const config = account.config as AccountConfig;
  const [imported, setImported] = useState(0);
  const [mirrored, setMirrored] = useState(0);
  const [removeTasks, setRemoveTasks] = useState(false);
  const [removeBlocks, setRemoveBlocks] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getDb()
      .all<{ entity_type: string; n: number }>(
        `SELECT m.entity_type, count(*) AS n FROM integration_mappings m
         LEFT JOIN tasks t ON m.entity_type = 'task' AND t.id = m.local_id
         WHERE m.account_id = ? AND (m.entity_type = 'time_block' OR (m.entity_type = 'task' AND t.id IS NOT NULL))
         GROUP BY m.entity_type`,
        [account.id],
      )
      .then((rows) => {
        setImported(rows.find((r) => r.entity_type === 'task')?.n ?? 0);
        setMirrored(rows.find((r) => r.entity_type === 'time_block')?.n ?? 0);
      });
  }, [account.id]);
  const pushName = config.calendars?.find((c) => c.externalId === config.pushCalendarId)?.name;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`Disconnect ${account.label}?`}
      width={480}
    >
      <div className="flex flex-col gap-3 px-5 pt-2 pb-5 text-[13px]">
        <p>
          Keel deletes this account’s credentials from this computer and removes its local copies of
          calendars and events.{' '}
          {account.provider === 'google'
            ? 'It also asks Google to revoke Keel’s access.'
            : info?.revokeUrl
              ? 'To also revoke access at the provider, use the link below.'
              : ''}
        </p>
        {imported > 0 && (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={removeTasks}
              onChange={(e) => setRemoveTasks(e.target.checked)}
              className="mt-0.5 accent-[var(--color-accent)]"
            />
            <span>
              Also delete the {imported} task{imported === 1 ? '' : 's'} imported from this account
              <span className="block text-[11.5px] text-muted">
                Otherwise they stay in Keel as ordinary local tasks, with their history.
              </span>
            </span>
          </label>
        )}
        {mirrored > 0 && (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={removeBlocks}
              onChange={(e) => setRemoveBlocks(e.target.checked)}
              className="mt-0.5 accent-[var(--color-accent)]"
            />
            <span>
              Delete the {mirrored} time-block event{mirrored === 1 ? '' : 's'} Keel created in{' '}
              {pushName ?? 'your calendar'}
              <span className="block text-[11.5px] text-muted">
                Only events Keel created. Needs a connection now.
              </span>
            </span>
          </label>
        )}
        {info?.revokeUrl && (
          <button
            type="button"
            className="flex w-fit items-center gap-1 text-[12.5px] text-accent-text hover:underline"
            onClick={() => run(native.openUrl(info.revokeUrl!))}
          >
            Manage access at the provider <ExternalLink size={12} aria-hidden />
          </button>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await disconnectAccount(account, {
                  removeImportedTasks: removeTasks,
                  removeMirroredBlocks: removeBlocks && mirrored > 0,
                });
                if (r.remoteCleanupFailed)
                  toast.warning(
                    'Disconnected, but some time-block events could not be deleted remotely. Remove them in the calendar app.',
                  );
                else toast.success(`${account.label} disconnected`);
                onClose();
              } catch (e) {
                toast.error(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            Disconnect
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function AccountCard({ account }: { account: IntegrationAccount }) {
  const info = providerInfo(account.provider);
  const syncing = useSyncState((s) => !!s.syncing[account.id]);
  const [open, setOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const config = account.config as AccountConfig;
  const interval = config.intervalMin ?? DEFAULT_INTERVAL_MIN;
  const Icon = info?.kind === 'tasks' ? ListChecks : CalendarDays;

  return (
    <section
      aria-label={`${info?.name ?? account.provider} · ${account.label}`}
      className="rounded-xl border border-line bg-surface shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Icon size={16} className="text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-fg">{account.label}</span>
            <StatusPill account={account} syncing={syncing} />
          </div>
          <div className="truncate text-[12px] text-muted">
            {info?.name ?? account.provider} · last synced {ago(account.lastSyncAt)}
            {interval === 0 ? ' · manual sync' : ''}
          </div>
        </div>
        {account.status === 'needs_reauth' && info?.auth === 'oauth' && (
          <Button
            size="sm"
            variant="primary"
            disabled={reconnecting}
            onClick={async () => {
              setReconnecting(true);
              try {
                await reconnectOAuth(account, hasWriteScope(account.provider, config.grantedScope));
                toast.success(`${account.label} reconnected`);
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setReconnecting(false);
              }
            }}
          >
            Reconnect
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={syncing || !isTauri()}
          onClick={() => run(syncNow(account))}
        >
          <RefreshCw size={13} aria-hidden className={cn(syncing && 'animate-spin')} /> Sync now
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Settings2 size={13} aria-hidden /> Settings
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDisconnecting(true)}>
          <Unplug size={13} aria-hidden /> Disconnect
        </Button>
      </div>
      {account.lastError && (
        <p
          className={cn(
            'mx-4 mb-3 rounded-lg px-3 py-2 text-[12.5px] text-fg',
            account.status === 'connected' ? 'bg-sunken' : 'bg-danger-soft',
          )}
        >
          {account.lastError}
        </p>
      )}
      {open && info && (
        <div className="flex flex-col gap-4 border-t border-line px-4 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`label-${account.id}`}>Name</Label>
              <Input
                id={`label-${account.id}`}
                defaultValue={account.label}
                onBlur={(e) =>
                  e.target.value !== account.label && run(renameAccount(account, e.target.value))
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`interval-${account.id}`}>Automatic sync</Label>
              <select
                id={`interval-${account.id}`}
                className={selectClass}
                value={interval}
                onChange={(e) =>
                  run(saveAccountConfig(account, { intervalMin: Number(e.target.value) }))
                }
              >
                {INTERVALS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {info.kind === 'calendar' && info.auth === 'oauth' && (
            <CalendarSettings account={account} />
          )}
          {info.kind === 'tasks' && <TaskSettings account={account} />}
          <details className="rounded-lg bg-sunken/60 px-3 py-2">
            <summary className="cursor-pointer text-[12.5px] font-medium text-fg">
              What this integration exchanges
            </summary>
            <div className="pt-2">
              <DataFlow p={info} />
            </div>
          </details>
        </div>
      )}
      {disconnecting && (
        <DisconnectDialog account={account} onClose={() => setDisconnecting(false)} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-semibold tracking-wide text-muted uppercase">{title}</h2>
      {children}
    </section>
  );
}

export function IntegrationsView() {
  const accounts = useData((s) => s.accounts);
  const storeName = useCredentialStoreName();
  const [connecting, setConnecting] = useState<ProviderInfo | null>(null);
  const list = Object.values(accounts).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const calendars = PROVIDERS.filter((p) => p.kind === 'calendar');
  const tasks = PROVIDERS.filter((p) => p.kind === 'tasks');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Integrations" subtitle="Optional — Keel works fully without them" />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10">
        <div className="mx-auto flex max-w-[860px] flex-col gap-6">
          <div className="flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-[12.5px] shadow-sm">
            <Globe size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
            <p className="text-fg">
              Everything you plan in Keel stays on this computer. The integrations below are the
              only parts of Keel that use the network: when you connect one, this computer talks
              directly to that provider — there is no Keel server in between. Credentials are kept
              in {storeName}, not in Keel’s database. Nothing is connected unless you connect it.
            </p>
          </div>

          {!isTauri() && (
            <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px]">
              You are using the browser preview. Integrations need the Keel desktop app.
            </p>
          )}

          {list.length > 0 && (
            <Section title="Connected">
              {list.map((a) => (
                <AccountCard key={a.id} account={a} />
              ))}
            </Section>
          )}

          <Section title="Calendars">
            <div className="grid gap-3 sm:grid-cols-3">
              {calendars.map((p) => (
                <ProviderCard key={p.id} p={p} onConnect={() => setConnecting(p)} />
              ))}
            </div>
          </Section>

          <Section title="Tasks">
            <div className="grid gap-3 sm:grid-cols-3">
              {tasks.map((p) => (
                <ProviderCard key={p.id} p={p} onConnect={() => setConnecting(p)} />
              ))}
            </div>
          </Section>

          <Section title="Email">
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-4 py-3 shadow-sm">
              <div className="flex items-center gap-2">
                <Mail size={15} className="text-muted" aria-hidden />
                <span className="text-[13.5px] font-semibold text-fg">Email → task</span>
                <LocalBadge />
              </div>
              <p className="text-[12.5px] text-muted">
                Turn a saved email into an Inbox task: the subject becomes the title; the sender,
                date and message text become notes. The file is read on this computer; Keel does not
                connect to your mailbox. Most mail apps can save a message as .eml (for example
                Thunderbird, Apple Mail, Gmail’s “Download message”, and Outlook on the web’s
                “Download”). Classic Outlook for Windows saves .msg files, which Keel cannot read.
              </p>
              <div>
                <Button size="sm" variant="secondary" onClick={() => void importEmailAsTask()}>
                  <Mail size={13} aria-hidden /> Import .eml…
                </Button>
              </div>
            </div>
          </Section>

          <p className="text-[12px] text-subtle">
            Every provider adapter is covered by contract tests against recorded API responses. None
            has been verified against a live account by Keel’s developers: each is marked “requires
            credentials for live verification”.
          </p>
        </div>
      </div>
      {connecting && <ConnectDialog p={connecting} onClose={() => setConnecting(null)} />}
    </div>
  );
}
