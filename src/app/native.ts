/** Typed wrappers around Keel's Rust commands. Only valid inside the desktop shell. */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/data/runtime';

export interface BackupInfo {
  fileName: string;
  path: string;
  createdMs: number;
  sizeBytes: number;
  reason: string;
}

export interface DbInfo {
  path: string;
  dataDir: string;
  sizeBytes: number;
  sqliteVersion: string;
}

export interface OpenedText {
  path: string;
  name: string;
  contents: string;
}

export interface AppEnvironment {
  os: string;
  arch: string;
  version: string;
  e2e: boolean;
  /** Linux Wayland session (no global shortcuts or always-on-top for apps). */
  wayland: boolean;
}

function requireDesktop() {
  if (!isTauri()) throw new Error('This action is only available in the Keel desktop app.');
}

export const native = {
  async createBackup(reason: string): Promise<BackupInfo> {
    requireDesktop();
    return invoke('backup_create', { reason });
  },
  async listBackups(): Promise<BackupInfo[]> {
    if (!isTauri()) return [];
    return invoke('backup_list');
  },
  async restoreBackup(fileName: string, maxSupportedVersion: number): Promise<BackupInfo> {
    requireDesktop();
    return invoke('backup_restore', { fileName, maxSupportedVersion });
  },
  async exportBackup(suggestedName: string): Promise<string | null> {
    requireDesktop();
    return invoke('backup_export', { suggestedName });
  },
  async importBackup(maxSupportedVersion: number): Promise<BackupInfo | null> {
    requireDesktop();
    return invoke('backup_import', { maxSupportedVersion });
  },
  async wipe(): Promise<void> {
    requireDesktop();
    return invoke('data_wipe', { confirmation: 'DELETE' });
  },
  async dbInfo(): Promise<DbInfo | null> {
    if (!isTauri()) return null;
    return invoke('db_info');
  },
  async saveText(
    suggestedName: string,
    filterName: string,
    extensions: string[],
    contents: string,
  ): Promise<string | null> {
    if (!isTauri()) return browserDownload(suggestedName, contents);
    return invoke('file_save_text', { suggestedName, filterName, extensions, contents });
  },
  /** `lossy` accepts non-UTF-8 bytes (legacy 8-bit email) instead of rejecting the file. */
  async openText(
    filterName: string,
    extensions: string[],
    lossy = false,
  ): Promise<OpenedText | null> {
    if (!isTauri()) return browserPick(extensions);
    return invoke('file_open_text', { filterName, extensions, lossy });
  },
  async environment(): Promise<AppEnvironment> {
    if (!isTauri()) return { os: 'browser', arch: '', version: 'dev', e2e: false, wayland: false };
    return invoke('app_environment');
  },
  async openUrl(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url))
      throw new Error('Only web and mail links can be opened');
    if (!isTauri()) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  },
};

// Dev-only browser preview fallbacks (the desktop app always uses native dialogs).
function browserDownload(name: string, contents: string): string {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

function browserPick(extensions: string[]): Promise<OpenedText | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.map((e) => `.${e}`).join(',');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ path: file.name, name: file.name, contents: await file.text() });
    };
    input.click();
  });
}
