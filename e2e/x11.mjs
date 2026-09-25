// X11 helpers for testing real desktop-window behaviour (stacking, focus, global shortcuts,
// real mouse clicks) under Xvfb with a window manager. Linux only.
import { execFileSync, spawn, spawnSync } from 'node:child_process';

export function hasTools() {
  return ['xdotool', 'xprop', 'xwininfo', 'xcalc'].every(
    (t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0,
  );
}

function x(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** First visible window whose title matches the regex, or null. */
export function findWindow(name) {
  try {
    return x('xdotool', ['search', '--onlyvisible', '--name', name]).split('\n')[0] || null;
  } catch {
    return null;
  }
}

export function geometry(id) {
  const info = x('xwininfo', ['-id', id]);
  const num = (label) => Number(new RegExp(`${label}:\\s+(-?\\d+)`).exec(info)[1]);
  return {
    x: num('Absolute upper-left X'),
    y: num('Absolute upper-left Y'),
    width: num('Width'),
    height: num('Height'),
  };
}

export function screenSize() {
  const root = x('xwininfo', ['-root']);
  return {
    width: Number(/Width:\s+(\d+)/.exec(root)[1]),
    height: Number(/Height:\s+(\d+)/.exec(root)[1]),
  };
}

export function activeWindow() {
  try {
    return x('xdotool', ['getactivewindow']);
  } catch {
    return null;
  }
}

export function activate(id) {
  try {
    x('xdotool', ['windowactivate', '--sync', id]);
  } catch {
    // Some window managers refuse _NET_ACTIVE_WINDOW for a moment after mapping; fall back.
    x('xdotool', ['windowraise', id]);
    x('xdotool', ['windowfocus', '--sync', id]);
  }
}

export function describe(id) {
  if (!id) return 'none';
  try {
    return `${id} “${x('xdotool', ['getwindowname', id])}”`;
  } catch {
    return id;
  }
}

export function wmState(id) {
  return x('xprop', ['-id', id, '_NET_WM_STATE']);
}

/** Top-level windows from bottom to top, as the window manager stacks them. */
export function stacking() {
  const out = x('xprop', ['-root', '_NET_CLIENT_LIST_STACKING']);
  return (out.split('#')[1] ?? '')
    .split(',')
    .map((s) => String(parseInt(s.trim(), 16)))
    .filter((s) => s !== 'NaN');
}

export function click(px, py) {
  x('xdotool', [
    'mousemove',
    '--sync',
    String(Math.round(px)),
    String(Math.round(py)),
    'click',
    '1',
  ]);
}

export function drag(fromX, fromY, toX, toY) {
  x('xdotool', ['mousemove', '--sync', String(fromX), String(fromY), 'mousedown', '1']);
  for (let i = 1; i <= 10; i++) {
    const px = Math.round(fromX + ((toX - fromX) * i) / 10);
    const py = Math.round(fromY + ((toY - fromY) * i) / 10);
    x('xdotool', ['mousemove', '--sync', String(px), String(py), 'sleep', '0.03']);
  }
  x('xdotool', ['mouseup', '1']);
}

export function moveWindow(id, px, py) {
  x('xdotool', ['windowmove', '--sync', id, String(px), String(py)]);
}

export function key(combo) {
  x('xdotool', ['key', combo]);
}

/**
 * Full-screen screenshot for diagnostics. Windows listed in `overlay` are drawn from their own
 * buffers on top (xwd of the root does not reliably include a runtime-created WebKitGTK window
 * under Xvfb), so the artifact shows what each window rendered.
 */
export function rootScreenshot(path, overlay = []) {
  try {
    execFileSync('sh', ['-c', `xwd -root -silent | convert xwd:- png:${JSON.stringify(path)}`]);
    for (const id of overlay.filter(Boolean)) {
      const g = geometry(id);
      execFileSync('sh', [
        '-c',
        `xwd -id ${id} -silent | convert ${JSON.stringify(path)} xwd:- -geometry +${g.x}+${g.y} -composite ${JSON.stringify(path)}`,
      ]);
    }
  } catch {
    // ImageMagick is optional; screenshots are diagnostics only.
  }
}

export function isAlwaysOnTop(id) {
  return wmState(id).includes('_NET_WM_STATE_ABOVE');
}

/** Another application (one that accepts keyboard focus) to work in. */
export function launchOtherApp() {
  return {
    proc: spawn('xcalc', ['-geometry', '+360+420'], { stdio: 'ignore' }),
    title: '^Calculator$',
  };
}
