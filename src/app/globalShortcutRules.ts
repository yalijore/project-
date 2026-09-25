/**
 * Rules for system-wide shortcuts (Tauri accelerator syntax, e.g. "CommandOrControl+Alt+Shift+F").
 * Pure functions so conflict detection is unit-tested; registration lives in globalShortcuts.ts.
 */
import type { Platform } from './platform';

export type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta';

export interface Chord {
  mods: Set<Modifier>;
  /** Lower-case key name, e.g. "f", "1", "space", "arrowup", "f5". */
  key: string;
}

const KEY_ALIASES: Record<string, string> = {
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  esc: 'escape',
  return: 'enter',
};

function normKey(raw: string): string {
  const k = raw.trim().toLowerCase();
  if (/^key[a-z]$/.test(k)) return k.slice(3);
  if (/^digit[0-9]$/.test(k)) return k.slice(5);
  return KEY_ALIASES[k] ?? k;
}

/** Parses an accelerator; null if it is malformed (no key, or more than one key). */
export function parseAccelerator(acc: string, platform: Platform): Chord | null {
  const mods = new Set<Modifier>();
  let key: string | null = null;
  for (const raw of acc.split('+')) {
    const t = raw.trim().toLowerCase();
    if (!t) return null;
    if (['commandorcontrol', 'commandorctrl', 'cmdorctrl', 'cmdorcontrol'].includes(t))
      mods.add(platform === 'mac' ? 'meta' : 'ctrl');
    else if (t === 'control' || t === 'ctrl') mods.add('ctrl');
    else if (t === 'alt' || t === 'option') mods.add('alt');
    else if (t === 'shift') mods.add('shift');
    else if (['super', 'command', 'cmd', 'meta'].includes(t)) mods.add('meta');
    else if (key) return null;
    else key = normKey(t);
  }
  return key ? { mods, key } : null;
}

/** Parses an in-app spec ("mod+shift+p"); null for sequences ("g t") and bare keys. */
export function parseInAppSpec(spec: string, platform: Platform): Chord | null {
  if (spec.includes(' ')) return null;
  const mods = new Set<Modifier>();
  let key: string | null = null;
  for (const t of spec.toLowerCase().split('+')) {
    if (t === 'mod') mods.add(platform === 'mac' ? 'meta' : 'ctrl');
    else if (t === 'ctrl' || t === 'alt' || t === 'shift') mods.add(t);
    else if (t === 'meta') mods.add('meta');
    else key = normKey(t);
  }
  return key && mods.size ? { mods, key } : null;
}

export function sameChord(a: Chord, b: Chord): boolean {
  return a.key === b.key && a.mods.size === b.mods.size && [...a.mods].every((m) => b.mods.has(m));
}

const CODE_KEYS =
  /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|Escape|Backquote|Backslash|BracketLeft|BracketRight|Comma|Period|Quote|Semicolon|Slash|Equal|Minus|Numpad[0-9])$/;

/** Builds an accelerator from a key press (physical key, so it works on any layout). */
export function acceleratorFromEvent(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'code'>,
  platform: Platform,
): string | null {
  if (!CODE_KEYS.test(e.code)) return null;
  const parts: string[] = [];
  if (platform === 'mac') {
    if (e.metaKey) parts.push('CommandOrControl');
    if (e.ctrlKey) parts.push('Control');
  } else {
    if (e.ctrlKey) parts.push('CommandOrControl');
    if (e.metaKey) parts.push('Super');
  }
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = /^Key[A-Z]$/.test(e.code)
    ? e.code.slice(3)
    : /^Digit[0-9]$/.test(e.code)
      ? e.code.slice(5)
      : e.code;
  return [...parts, key].join('+');
}

const LABELS: Record<Platform, Record<Modifier, string>> = {
  mac: { meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' },
  windows: { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' },
  linux: { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Super' },
};

export function formatAccelerator(acc: string, platform: Platform): string {
  const chord = parseAccelerator(acc, platform);
  if (!chord) return acc;
  const order: Modifier[] =
    platform === 'mac' ? ['ctrl', 'alt', 'shift', 'meta'] : ['ctrl', 'meta', 'alt', 'shift'];
  const mods = order.filter((m) => chord.mods.has(m)).map((m) => LABELS[platform][m]);
  const key =
    chord.key.length === 1
      ? chord.key.toUpperCase()
      : chord.key.startsWith('arrow')
        ? { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }[chord.key]!
        : chord.key[0]!.toUpperCase() + chord.key.slice(1);
  return platform === 'mac' ? [...mods, key].join('') : [...mods, key].join('+');
}

/** Combinations the OS keeps for itself (registering them fails or breaks the system). */
const RESERVED: Record<Platform, string[]> = {
  windows: [
    'ctrl+alt+delete',
    'ctrl+shift+escape',
    'ctrl+escape',
    'alt+tab',
    'alt+shift+tab',
    'alt+f4',
    'alt+escape',
    'alt+space',
  ],
  linux: [
    'ctrl+alt+delete',
    'ctrl+alt+t',
    'ctrl+alt+l',
    'alt+tab',
    'alt+shift+tab',
    'alt+f4',
    'alt+f2',
    'alt+space',
  ],
  mac: [
    'meta+q',
    'meta+tab',
    'meta+shift+tab',
    'meta+space',
    'ctrl+space',
    'meta+h',
    'meta+m',
    'meta+alt+escape',
    'ctrl+meta+q',
    'meta+shift+3',
    'meta+shift+4',
    'meta+shift+5',
    'ctrl+meta+f',
  ],
};

export interface ShortcutContext {
  platform: Platform;
  /** Other global shortcut that is enabled (to detect duplicates). */
  other?: { label: string; accelerator: string };
  /** Keel's in-app shortcuts, as specs with labels. */
  inApp: { label: string; spec: string }[];
}

/** Returns why an accelerator can't be used, or null if it is fine. */
export function shortcutProblem(acc: string, ctx: ShortcutContext): string | null {
  const chord = parseAccelerator(acc, ctx.platform);
  if (!chord) return 'Not a valid key combination.';
  const strong = [...chord.mods].filter((m) => m !== 'shift');
  if (!strong.length)
    return 'Add Ctrl, Alt or ⌘ — a system-wide shortcut without them would block normal typing.';
  if (ctx.platform === 'windows' && chord.mods.has('meta'))
    return 'Windows reserves Windows-key shortcuts for itself.';
  const reserved = RESERVED[ctx.platform].map((r) => parseInAppSpec(r, ctx.platform)!);
  if (reserved.some((r) => sameChord(r, chord)))
    return 'The operating system already uses this combination.';
  if (ctx.other) {
    const other = parseAccelerator(ctx.other.accelerator, ctx.platform);
    if (other && sameChord(other, chord)) return `Already used for “${ctx.other.label}”.`;
  }
  const clash = ctx.inApp.find((s) => {
    const c = parseInAppSpec(s.spec, ctx.platform);
    return c && sameChord(c, chord);
  });
  if (clash) return `Keel already uses this for “${clash.label}”.`;
  return null;
}
