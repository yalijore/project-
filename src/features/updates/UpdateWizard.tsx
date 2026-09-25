/**
 * The update wizard: find a newer Keel on GitHub (with a read-only token) or use an installer
 * the user downloaded, check it, back up the data, and start the installer. Every network
 * request happens only after a click here.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  ExternalLink,
  FileDown,
  KeyRound,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { native } from '@/app/native';
import { useUi } from '@/app/ui';
import type { ReleaseInfo, StagedInstaller, UpdateStatus } from '@/app/updates';
import { NEW_TOKEN_URL, RELEASES_URL, formatBytes, isNewerVersion, updates } from '@/app/updates';
import { errorMessage } from '@/data/actions';
import { Button, Dialog, Input, Label, cn } from '@/ui/primitives';

type Step =
  | { kind: 'start' }
  | { kind: 'token' }
  | { kind: 'busy'; label: string }
  | { kind: 'result'; release: ReleaseInfo }
  | { kind: 'downloading'; release: ReleaseInfo; received: number; total: number }
  | { kind: 'ready'; staged: StagedInstaller; release: ReleaseInfo | null }
  | { kind: 'installing' }
  | { kind: 'error'; message: string; back: Step };

export function UpdateWizard() {
  const open = useUi((s) => s.updatesOpen);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const close = () => useUi.setState({ updatesOpen: false });

  useEffect(() => {
    if (!open) return;
    setStep({ kind: 'start' });
    updates
      .status()
      .then(setStatus)
      .catch((e) => setStep({ kind: 'error', message: errorMessage(e), back: { kind: 'start' } }));
  }, [open]);

  const fail = (e: unknown, back: Step) =>
    setStep({ kind: 'error', message: errorMessage(e), back });

  const check = async () => {
    setStep({ kind: 'busy', label: 'Asking GitHub for the latest release…' });
    try {
      setStep({ kind: 'result', release: await updates.check() });
    } catch (e) {
      fail(e, { kind: 'start' });
    }
  };

  const download = async (release: ReleaseInfo) => {
    setStep({ kind: 'downloading', release, received: 0, total: release.installer?.size ?? 0 });
    try {
      const staged = await updates.download(release, (received, total) =>
        setStep({ kind: 'downloading', release, received, total }),
      );
      setStep({ kind: 'ready', staged, release });
    } catch (e) {
      fail(e, { kind: 'result', release });
    }
  };

  const pickFile = async () => {
    try {
      const staged = await updates.pickFile();
      if (staged) setStep({ kind: 'ready', staged, release: null });
    } catch (e) {
      fail(e, { kind: 'start' });
    }
  };

  const install = async (staged: StagedInstaller) => {
    setStep({ kind: 'installing' });
    try {
      await native.createBackup(`before update to ${staged.version ?? staged.name}`);
      await updates.install();
    } catch (e) {
      fail(e, { kind: 'ready', staged, release: null });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Update Keel" width={560}>
      <div className="flex flex-col gap-4 px-5 pt-1 pb-5 text-[13px]">
        {!status && step.kind !== 'error' ? (
          <Busy label="Loading…" />
        ) : step.kind === 'start' && status ? (
          <Start
            status={status}
            onCheck={() => (status.hasToken ? check() : setStep({ kind: 'token' }))}
            onPickFile={pickFile}
          />
        ) : step.kind === 'token' && status ? (
          <TokenStep
            repo={status.repo}
            onBack={() => setStep({ kind: 'start' })}
            onSaved={() => {
              setStatus({ ...status, hasToken: true });
              void check();
            }}
          />
        ) : step.kind === 'busy' ? (
          <Busy label={step.label} />
        ) : step.kind === 'result' ? (
          <ResultStep
            release={step.release}
            onDownload={() => download(step.release)}
            onBack={() => setStep({ kind: 'start' })}
          />
        ) : step.kind === 'downloading' ? (
          <DownloadStep received={step.received} total={step.total} />
        ) : step.kind === 'ready' && status ? (
          <ReadyStep
            staged={step.staged}
            status={status}
            onInstall={() => install(step.staged)}
            onBack={() => setStep({ kind: 'start' })}
          />
        ) : step.kind === 'installing' ? (
          <Busy label="Backing up your data and starting the installer. Keel will close…" />
        ) : step.kind === 'error' ? (
          <div className="flex flex-col gap-3">
            <p className="flex gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-fg" role="alert">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
              {step.message}
            </p>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setStep(step.back)}>
                <ArrowLeft size={14} /> Back
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function Busy({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 py-6 text-muted" role="status">
      <Loader2 size={16} className="animate-spin" /> {label}
    </p>
  );
}

function Choice({
  icon,
  title,
  detail,
  onClick,
  primary,
}: {
  icon: ReactNode;
  title: string;
  detail: ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full gap-3 rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent',
        primary
          ? 'border-accent/40 bg-accent-soft hover:bg-accent-soft/70'
          : 'border-line hover:bg-surface-hover',
      )}
    >
      <span className="mt-0.5 text-accent-text">{icon}</span>
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-fg">{title}</span>
        <span className="text-[12.5px] text-muted">{detail}</span>
      </span>
    </button>
  );
}

function Start({
  status,
  onCheck,
  onPickFile,
}: {
  status: UpdateStatus;
  onCheck: () => void;
  onPickFile: () => void;
}) {
  return (
    <>
      <p className="text-muted">
        You have Keel <strong className="text-fg">{status.current}</strong>. New versions are
        published on the{' '}
        <a
          href={RELEASES_URL(status.repo)}
          onClick={(e) => {
            e.preventDefault();
            void native.openUrl(RELEASES_URL(status.repo));
          }}
          className="text-accent-text underline"
        >
          Releases page
        </a>{' '}
        of Keel's repository. Your data is backed up before anything is installed, and it stays in
        place.
      </p>
      <Choice
        primary
        icon={<Download size={18} />}
        title="Check for a newer version"
        detail={
          status.hasToken
            ? 'Asks GitHub for the latest release, using your saved read-only token.'
            : 'Needs a read-only GitHub token once, because the repository is private.'
        }
        onClick={onCheck}
      />
      <Choice
        icon={<FileDown size={18} />}
        title="Use an installer I downloaded"
        detail="Pick Keel_…_x64-setup.exe from the Releases page. Nothing is sent anywhere."
        onClick={onPickFile}
      />
      <p className="text-[12px] text-subtle">
        Checking contacts api.github.com only when you click; it sends your token and nothing about
        you or your data. Keel never checks by itself.
      </p>
    </>
  );
}

function TokenStep({
  repo,
  onBack,
  onSaved,
}: {
  repo: string;
  onBack: () => void;
  onSaved: () => void;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [owner, name] = repo.split('/');
  return (
    <>
      <p className="flex items-center gap-2 font-medium text-fg">
        <KeyRound size={16} className="text-accent-text" /> Add a read-only GitHub token
      </p>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-muted">
        <li>
          Open{' '}
          <a
            href={NEW_TOKEN_URL}
            onClick={(e) => {
              e.preventDefault();
              void native.openUrl(NEW_TOKEN_URL);
            }}
            className="inline-flex items-center gap-1 text-accent-text underline"
          >
            GitHub → new fine-grained token <ExternalLink size={12} />
          </a>
          .
        </li>
        <li>
          Resource owner: <strong className="text-fg">{owner}</strong>. Repository access:{' '}
          <strong className="text-fg">Only select repositories → {name}</strong>.
        </li>
        <li>
          Permissions → Repository → <strong className="text-fg">Contents: Read-only</strong>{' '}
          (nothing else). Pick an expiry you like.
        </li>
        <li>Generate the token and paste it here.</li>
      </ol>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="upd-token">Token</Label>
        <Input
          id="upd-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="github_pat_…"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setError(null);
          }}
        />
        <p className="text-[12px] text-subtle">
          Kept in your system's credential store (Windows Credential Manager), not in Keel's
          database, and sent only to api.github.com. Remove it any time in Settings → About.
        </p>
        {error && (
          <p className="text-[12.5px] text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </Button>
        <Button
          variant="primary"
          disabled={!token.trim() || saving}
          onClick={async () => {
            setSaving(true);
            try {
              await updates.setToken(token);
              onSaved();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          Save and check
        </Button>
      </div>
    </>
  );
}

function ResultStep({
  release,
  onDownload,
  onBack,
}: {
  release: ReleaseInfo;
  onDownload: () => void;
  onBack: () => void;
}) {
  if (!release.newer) {
    return (
      <>
        <p className="flex items-center gap-2 text-fg">
          <CheckCircle2 size={18} className="text-ok" /> You have the latest version (Keel{' '}
          {release.current}).
        </p>
        <p className="text-muted">
          The newest release is {release.title}
          {release.publishedAt ? `, published ${release.publishedAt.slice(0, 10)}` : ''}.
        </p>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onBack}>
            Done
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      <p className="text-[15px] font-semibold text-fg">
        {release.title} is available{' '}
        <span className="text-[12.5px] font-normal text-muted">
          (you have {release.current}
          {release.publishedAt ? ` · published ${release.publishedAt.slice(0, 10)}` : ''})
        </span>
      </p>
      {release.notes.trim() && (
        <div
          className="max-h-56 overflow-y-auto rounded-lg border border-line bg-sunken px-3 py-2 text-[12.5px] whitespace-pre-wrap text-muted"
          aria-label="What's new"
        >
          {release.notes.trim()}
        </div>
      )}
      {release.installer ? (
        <p className="text-muted">
          Keel will download <strong className="text-fg">{release.installer.name}</strong> (
          {formatBytes(release.installer.size)}) and check it against the release's checksums.
        </p>
      ) : (
        <p className="text-warn">This release has no Windows installer.</p>
      )}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </Button>
        <Button variant="primary" disabled={!release.installer} onClick={onDownload}>
          <Download size={14} /> Download and check
        </Button>
      </div>
    </>
  );
}

function DownloadStep({ received, total }: { received: number; total: number }) {
  const pct = total ? Math.min(100, (received / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-2 py-2" role="status">
      <p className="text-muted">
        Downloading… {formatBytes(received)}
        {total ? ` of ${formatBytes(total)}` : ''}
      </p>
      <div className="h-1.5 overflow-hidden rounded-full bg-line/70">
        <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ReadyStep({
  staged,
  status,
  onInstall,
  onBack,
}: {
  staged: StagedInstaller;
  status: UpdateStatus;
  onInstall: () => void;
  onBack: () => void;
}) {
  const newer = isNewerVersion(staged.version, status.current);
  return (
    <>
      <p className="font-medium text-fg">
        Ready to install {staged.version ? `Keel ${staged.version}` : staged.name}
      </p>
      <div className="flex flex-col gap-1 rounded-lg border border-line bg-sunken px-3 py-2 text-[12.5px]">
        <span className="text-muted">
          {staged.name} · {formatBytes(staged.size)}
        </span>
        {staged.verified ? (
          <span className="flex items-center gap-1.5 text-ok">
            <ShieldCheck size={14} /> Checksum matches the release's SHA256SUMS.txt.
          </span>
        ) : (
          <span className="text-muted">
            Not checked against a release. To check it yourself, compare this SHA-256 with the line
            for this file in the release's SHA256SUMS.txt:
            <code className="mt-1 block text-[11.5px] break-all text-fg">{staged.sha256}</code>
          </span>
        )}
      </div>
      {!newer && (
        <p className="flex gap-2 text-warn">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          {staged.version
            ? `This is not newer than the Keel you have (${status.current}).`
            : 'The file name does not show a Keel version.'}{' '}
          Installing it anyway replaces your current version.
        </p>
      )}
      {status.canInstall ? (
        <p className="text-muted">
          Keel will back up your data, start the installer, and close. Follow the installer; your
          data stays where it is.
        </p>
      ) : (
        <p className="text-warn">
          Keel can start installers on Windows only. On this system, install the new version from
          the Releases page.
        </p>
      )}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={14} /> Start over
        </Button>
        <Button variant="primary" disabled={!status.canInstall} onClick={onInstall}>
          Back up and install
        </Button>
      </div>
    </>
  );
}
