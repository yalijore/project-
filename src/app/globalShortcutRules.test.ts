import { describe, expect, it } from 'vitest';
import {
  acceleratorFromEvent,
  formatAccelerator,
  parseAccelerator,
  shortcutProblem,
} from './globalShortcutRules';

const inApp = [
  { label: 'Command palette', spec: 'mod+k' },
  { label: 'Plan the day', spec: 'shift+p' },
  { label: 'Go to Today', spec: 'g t' },
];

describe('global shortcut rules', () => {
  it('parses Tauri accelerators per platform', () => {
    const win = parseAccelerator('CommandOrControl+Alt+Shift+F', 'windows')!;
    expect([...win.mods].sort()).toEqual(['alt', 'ctrl', 'shift']);
    expect(win.key).toBe('f');
    expect([...parseAccelerator('CmdOrCtrl+Space', 'mac')!.mods]).toEqual(['meta']);
    expect(parseAccelerator('Ctrl+Up', 'linux')!.key).toBe('arrowup');
    expect(parseAccelerator('Ctrl+A+B', 'linux')).toBeNull();
    expect(parseAccelerator('Ctrl+Alt', 'linux')).toBeNull();
    expect(parseAccelerator('Ctrl++', 'linux')).toBeNull();
  });

  it('records physical keys, independent of keyboard layout', () => {
    const e = { ctrlKey: true, altKey: true, shiftKey: true, metaKey: false, code: 'KeyF' };
    expect(acceleratorFromEvent(e, 'windows')).toBe('CommandOrControl+Alt+Shift+F');
    expect(acceleratorFromEvent({ ...e, ctrlKey: false, metaKey: true }, 'mac')).toBe(
      'CommandOrControl+Alt+Shift+F',
    );
    expect(acceleratorFromEvent({ ...e, code: 'Digit7' }, 'linux')).toBe(
      'CommandOrControl+Alt+Shift+7',
    );
    expect(acceleratorFromEvent({ ...e, code: 'ShiftLeft' }, 'linux')).toBeNull();
  });

  it('formats for display', () => {
    expect(formatAccelerator('CommandOrControl+Alt+Shift+Space', 'windows')).toBe(
      'Ctrl+Alt+Shift+Space',
    );
    expect(formatAccelerator('CommandOrControl+Alt+Shift+F', 'mac')).toBe('⌥⇧⌘F');
  });

  it('detects conflicts and unsafe combinations', () => {
    const ctx = { platform: 'windows' as const, inApp };
    expect(shortcutProblem('CommandOrControl+Alt+Shift+F', ctx)).toBeNull();
    expect(shortcutProblem('Shift+F', ctx)).toMatch(/block normal typing/);
    expect(shortcutProblem('F', ctx)).toMatch(/block normal typing/);
    expect(shortcutProblem('Alt+F4', ctx)).toMatch(/operating system/);
    expect(shortcutProblem('Super+K', ctx)).toMatch(/Windows reserves/);
    expect(shortcutProblem('CommandOrControl+K', ctx)).toMatch(/Command palette/);
    expect(
      shortcutProblem('Ctrl+Alt+Shift+F', {
        ...ctx,
        other: { label: 'Start/pause timer', accelerator: 'CommandOrControl+Alt+Shift+F' },
      }),
    ).toMatch(/Start\/pause timer/);
    expect(shortcutProblem('CommandOrControl+Space', { platform: 'mac', inApp })).toMatch(
      /operating system/, // Spotlight
    );
    expect(
      shortcutProblem('CommandOrControl+Alt+Shift+Space', { platform: 'mac', inApp }),
    ).toBeNull();
    expect(shortcutProblem('Control+Space', { platform: 'mac', inApp })).toMatch(
      /operating system/,
    );
    expect(shortcutProblem('nonsense+', ctx)).toMatch(/valid/);
  });
});
