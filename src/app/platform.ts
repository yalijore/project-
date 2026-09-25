/** Platform conventions for shortcut labels. Keel targets Windows first (Ctrl), macOS uses ⌘. */
export const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const MOD_LABEL = isMac ? '⌘' : 'Ctrl';

/** Formats a shortcut spec like "mod+shift+k" for display: "Ctrl+Shift+K" / "⌘⇧K". */
export function formatShortcut(spec: string): string {
  const parts = spec.split('+');
  const map: Record<string, string> = isMac
    ? {
        mod: '⌘',
        shift: '⇧',
        alt: '⌥',
        ctrl: '⌃',
        enter: '↩',
        escape: 'Esc',
        backspace: '⌫',
        delete: '⌦',
      }
    : {
        mod: 'Ctrl',
        shift: 'Shift',
        alt: 'Alt',
        ctrl: 'Ctrl',
        enter: 'Enter',
        escape: 'Esc',
        backspace: 'Backspace',
        delete: 'Del',
      };
  const labels = parts.map(
    (p) => map[p] ?? (p.length === 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1)),
  );
  return isMac ? labels.join('') : labels.join('+');
}
