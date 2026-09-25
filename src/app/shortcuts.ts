/**
 * Global keyboard shortcuts. Specs look like "mod+k", "shift+p", "g t" (a two-key sequence)
 * or "?"; "mod" is Ctrl on Windows/Linux and ⌘ on macOS. Users can rebind any command in
 * Settings → Shortcuts (stored in settings.shortcuts).
 */
import { isMac } from './platform';

export interface CommandDef {
  id: string;
  label: string;
  group: 'General' | 'Navigation' | 'Planning' | 'Tasks';
  defaultKeys: string;
}

export const COMMANDS: CommandDef[] = [
  { id: 'capture', label: 'Quick add task', group: 'General', defaultKeys: 'q' },
  { id: 'palette', label: 'Command palette', group: 'General', defaultKeys: 'mod+k' },
  { id: 'search', label: 'Search tasks', group: 'General', defaultKeys: '/' },
  { id: 'undo', label: 'Undo', group: 'General', defaultKeys: 'mod+z' },
  { id: 'shortcuts', label: 'Show keyboard shortcuts', group: 'General', defaultKeys: '?' },
  { id: 'toggleCalendar', label: 'Toggle calendar panel', group: 'General', defaultKeys: 'mod+j' },
  { id: 'toggleSidebar', label: 'Toggle sidebar', group: 'General', defaultKeys: 'mod+b' },
  { id: 'go.today', label: 'Go to Today', group: 'Navigation', defaultKeys: 'g t' },
  { id: 'go.week', label: 'Go to Week', group: 'Navigation', defaultKeys: 'g w' },
  { id: 'go.inbox', label: 'Go to Inbox', group: 'Navigation', defaultKeys: 'g i' },
  { id: 'go.backlog', label: 'Go to Backlog', group: 'Navigation', defaultKeys: 'g b' },
  { id: 'go.completed', label: 'Go to Completed', group: 'Navigation', defaultKeys: 'g c' },
  { id: 'go.review', label: 'Go to Review', group: 'Navigation', defaultKeys: 'g r' },
  { id: 'go.settings', label: 'Open Settings', group: 'Navigation', defaultKeys: 'mod+,' },
  { id: 'day.prev', label: 'Previous day', group: 'Navigation', defaultKeys: '[' },
  { id: 'day.next', label: 'Next day', group: 'Navigation', defaultKeys: ']' },
  { id: 'day.today', label: 'Jump to today', group: 'Navigation', defaultKeys: 't' },
  { id: 'back', label: 'Go back', group: 'Navigation', defaultKeys: 'alt+arrowleft' },
  { id: 'plan', label: 'Plan the day', group: 'Planning', defaultKeys: 'shift+p' },
  { id: 'shutdown', label: 'Shut down the day', group: 'Planning', defaultKeys: 'shift+s' },
  { id: 'weekly', label: 'Weekly review', group: 'Planning', defaultKeys: 'shift+w' },
  { id: 'focus', label: 'Focus on running task', group: 'Planning', defaultKeys: 'shift+f' },
  { id: 'timer.stop', label: 'Pause timer', group: 'Planning', defaultKeys: 'shift+space' },
];

/** Shortcuts that act on the focused task card (not rebindable; listed for reference). */
export const TASK_KEYS: [string, string][] = [
  ['↑ / ↓', 'Move between tasks'],
  ['Enter', 'Open task'],
  ['Space or X', 'Complete / reopen'],
  ['F', 'Start timer and focus'],
  ['E', 'Set estimate'],
  ['S', 'Timebox in next free slot'],
  ['T', 'Move to today'],
  ['M', 'Move to next day'],
  ['B', 'Move to backlog'],
  ['1 / 2 / 3 / 0', 'Set priority'],
  ['Alt+↑ / Alt+↓', 'Reorder'],
  [`${isMac ? '⌘' : 'Ctrl'}+Click`, 'Select multiple'],
  ['Delete', 'Delete (undoable)'],
];

export function keysFor(id: string, overrides: Record<string, string>): string {
  return overrides[id] ?? COMMANDS.find((c) => c.id === id)?.defaultKeys ?? '';
}

/** Normalizes a key event to a spec chord like "mod+shift+k". */
export function eventToChord(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  if (['control', 'meta', 'shift', 'alt', 'os'].includes(key)) return null;
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push('mod');
  if (e.altKey) parts.push('alt');
  // Shift is implied by printable symbols like "?" — only record it for letters/named keys.
  const printableSymbol = key.length === 1 && !/[a-z0-9]/.test(key);
  if (e.shiftKey && !printableSymbol) parts.push('shift');
  parts.push(key === ' ' ? 'space' : key);
  return parts.join('+');
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Matches chords against bindings, supporting two-step sequences ("g t").
 * Returns a handler to call from a keydown listener.
 */
export function createMatcher(
  getBindings: () => Record<string, string>,
  run: (commandId: string) => boolean,
) {
  let pending: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const clearPending = () => {
    pending = null;
    if (pendingTimer) clearTimeout(pendingTimer);
  };

  return (e: KeyboardEvent) => {
    const chord = eventToChord(e);
    if (!chord) return;
    const typing = isTypingTarget(e.target);
    if (typing && !chord.startsWith('mod+')) return;
    const bindings = getBindings();
    const entries = Object.entries(bindings);

    if (pending) {
      const seq = `${pending} ${chord}`;
      clearPending();
      const hit = entries.find(([, keys]) => keys === seq);
      if (hit && run(hit[0])) {
        e.preventDefault();
        return;
      }
    }
    const direct = entries.find(([, keys]) => keys === chord);
    if (direct) {
      if (typing && direct[0] === 'undo') return; // let text fields undo their own edits
      if (run(direct[0])) {
        e.preventDefault();
        return;
      }
    }
    if (!typing && entries.some(([, keys]) => keys.startsWith(`${chord} `))) {
      pending = chord;
      pendingTimer = setTimeout(clearPending, 1200);
      e.preventDefault();
    }
  };
}
