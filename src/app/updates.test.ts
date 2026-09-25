import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => undefined }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));

const { formatBytes, isNewerVersion } = await import('./updates');

describe('update helpers', () => {
  it('compares x.y.z versions numerically', () => {
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('v1.0.0', '0.2.0')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(false);
    expect(isNewerVersion(null, '0.2.0')).toBe(false);
    expect(isNewerVersion('setup', '0.2.0')).toBe(false);
  });

  it('formats download sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(10.4 * 1024 * 1024)).toBe('10.4 MB');
  });
});
