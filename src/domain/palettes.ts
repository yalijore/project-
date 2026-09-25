/**
 * Color themes. Each one is a set of CSS variables in styles.css (accent color plus neutral
 * tints, for light and dark), applied with a `data-palette` attribute on the root element.
 */
export const PALETTES = [
  { id: 'teal', label: 'Keel', swatch: { light: '#22786e', dark: '#3aae9f' } },
  { id: 'ocean', label: 'Ocean', swatch: { light: '#2b62b0', dark: '#5b9bea' } },
  { id: 'iris', label: 'Iris', swatch: { light: '#6a4fc4', dark: '#9d87ee' } },
  { id: 'rose', label: 'Rose', swatch: { light: '#b03a6d', dark: '#e0719f' } },
  { id: 'graphite', label: 'Graphite', swatch: { light: '#3b4146', dark: '#c9d1d6' } },
] as const;

export type PaletteId = (typeof PALETTES)[number]['id'];

export function isPaletteId(v: unknown): v is PaletteId {
  return PALETTES.some((p) => p.id === v);
}
