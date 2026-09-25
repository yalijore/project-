// Windows counterparts of x11.mjs, backed by win32/winctl.cs (compiled on first use with the
// .NET Framework compiler that ships with Windows).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, 'win32', 'winctl.exe');

function build() {
  if (existsSync(exe)) return true;
  const csc = join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  );
  if (!existsSync(csc)) return false;
  const r = spawnSync(
    csc,
    [
      '/nologo',
      '/target:exe',
      `/out:${exe}`,
      '/r:System.Drawing.dll',
      join(here, 'win32', 'winctl.cs'),
    ],
    { stdio: 'inherit' },
  );
  return r.status === 0;
}

export function hasTools() {
  return process.platform === 'win32' && build();
}

function w(...args) {
  return execFileSync(exe, args.map(String), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function findWindow(name) {
  try {
    return w('find', name) || null;
  } catch {
    return null;
  }
}

export function geometry(id) {
  const [x, y, width, height] = w('rect', id).split(' ').map(Number);
  return { x, y, width, height };
}

/** The primary monitor's work area (excludes the taskbar). */
export function screenSize() {
  const [, , width, height] = w('workarea').split(' ').map(Number);
  return { width, height };
}

export function activeWindow() {
  try {
    return w('foreground');
  } catch {
    return null;
  }
}

export function activate(id) {
  w('activate', id);
}

export function isAlwaysOnTop(id) {
  return w('topmost', id) === '1';
}

/** Visible top-level windows from bottom to top. */
export function stacking() {
  return w('zorder').split(/\r?\n/).filter(Boolean).reverse();
}

export function click(px, py) {
  w('click', Math.round(px), Math.round(py));
}

export function drag(fromX, fromY, toX, toY) {
  w('drag', Math.round(fromX), Math.round(fromY), Math.round(toX), Math.round(toY));
}

export function moveWindow(id, px, py) {
  w('move', id, Math.round(px), Math.round(py));
}

export function key(combo) {
  w('keys', combo);
}

export function describe(id) {
  if (!id) return 'none';
  try {
    return `${id} “${w('title', id)}”`;
  } catch {
    return id;
  }
}

export function rootScreenshot(path) {
  try {
    w('screenshot', path);
  } catch {
    // diagnostics only
  }
}

/** Another application to work in while the bar floats above it. */
export function launchOtherApp() {
  return { proc: spawn('notepad.exe', [], { stdio: 'ignore' }), title: 'Notepad$' };
}
