/**
 * Keel updates (Rust: src-tauri/src/updates.rs). Nothing here runs on its own: the update
 * wizard calls these only when the user asks. Checking contacts api.github.com with the
 * read-only token the user added (kept in the OS credential store, never returned here).
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@/data/runtime';

export interface UpdateStatus {
  current: string;
  hasToken: boolean;
  /** Keel can run the installer itself (Windows). */
  canInstall: boolean;
  repo: string;
}

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
}

export interface ReleaseInfo {
  current: string;
  version: string;
  newer: boolean;
  title: string;
  notes: string;
  publishedAt: string | null;
  pageUrl: string;
  installer: ReleaseAsset | null;
  checksums: ReleaseAsset | null;
}

/** The installer the wizard will run. */
export interface StagedInstaller {
  name: string;
  size: number;
  sha256: string;
  version: string | null;
  /** Matched the release's SHA256SUMS.txt. */
  verified: boolean;
}

export const RELEASES_URL = (repo: string) => `https://github.com/${repo}/releases`;
export const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

function desktop() {
  if (!isTauri()) throw new Error('Updates are part of the Keel desktop app.');
}

export const updates = {
  async status(): Promise<UpdateStatus> {
    desktop();
    return invoke('update_status');
  },
  async setToken(token: string): Promise<void> {
    desktop();
    await invoke('update_set_token', { token });
  },
  async forgetToken(): Promise<void> {
    desktop();
    await invoke('update_forget_token');
  },
  async check(): Promise<ReleaseInfo> {
    desktop();
    return invoke('update_check');
  },
  async download(
    release: ReleaseInfo,
    onProgress: (received: number, total: number) => void,
  ): Promise<StagedInstaller> {
    desktop();
    if (!release.installer) throw new Error('This release has no Windows installer.');
    if (!release.checksums)
      throw new Error('This release has no SHA256SUMS.txt, so its installer cannot be checked.');
    const unlisten = await listen<{ received: number; total: number }>('update:progress', (e) =>
      onProgress(e.payload.received, e.payload.total),
    );
    try {
      return await invoke('update_download', {
        installer: release.installer,
        checksums: release.checksums,
        version: release.version,
      });
    } finally {
      unlisten();
    }
  },
  async pickFile(): Promise<StagedInstaller | null> {
    desktop();
    return invoke('update_pick_file');
  },
  /** Starts the installer; Keel closes itself a moment later. */
  async install(): Promise<void> {
    desktop();
    await invoke('update_install');
  },
};

/** "0.2.0" > "0.1.9" (plain x.y.z; anything else compares as not newer). */
export function isNewerVersion(candidate: string | null, current: string): boolean {
  const parse = (v: string | null) => {
    const m = v ? /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim()) : null;
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
