/**
 * Every color theme, in light and dark, keeps text and controls readable (WCAG contrast),
 * checked against the variables actually in styles.css.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTES } from './palettes';

const css = new TextDecoder().decode(readFileSync(new URL('../styles.css', import.meta.url)));

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return {};
  const body = css.slice(start, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]!] = m[2]!;
  return out;
}

function tokens(id: string, dark: boolean): Record<string, string> {
  const t = { ...block(':root') };
  if (dark) Object.assign(t, block("[data-theme='dark']"));
  if (id !== 'teal') {
    Object.assign(t, block(`[data-palette='${id}']`));
    if (dark) Object.assign(t, block(`[data-theme='dark'][data-palette='${id}']`));
  }
  return t;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('color themes', () => {
  for (const p of PALETTES) {
    for (const dark of [false, true]) {
      it(`${p.label} (${dark ? 'dark' : 'light'}) is readable`, () => {
        const t = tokens(p.id, dark);
        const pairs: [string, string, number][] = [
          ['accent-fg', 'accent', 4.5],
          ['accent-fg', 'accent-hover', 4.5],
          ['accent-text', 'bg', 4.5],
          ['accent-text', 'surface', 4.5],
          ['accent-text', 'accent-soft', 4.5],
          ['accent', 'bg', 3],
          ['fg', 'bg', 7],
          ['fg-muted', 'bg', 4.5],
          ['fg-muted', 'bg-sidebar', 4.5],
          ['fg-subtle', 'surface', 3],
        ];
        for (const [fg, bg, min] of pairs) {
          expect(t[fg], `--${fg}`).toBeDefined();
          expect(t[bg], `--${bg}`).toBeDefined();
          expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
        }
        // The settings swatch shows the theme's real accent color.
        expect(t.accent!.toLowerCase()).toBe(dark ? p.swatch.dark : p.swatch.light);
      });
    }
  }
});
