// Real desktop-window control for the focus bar tests: X11 (Linux) or Win32 (Windows).
import * as win32 from './win32.mjs';
import * as x11 from './x11.mjs';

const impl = process.platform === 'win32' ? win32 : x11;

export const {
  activate,
  activeWindow,
  click,
  describe,
  drag,
  findWindow,
  geometry,
  hasTools,
  isAlwaysOnTop,
  key,
  launchOtherApp,
  moveWindow,
  rootScreenshot,
  screenSize,
  stacking,
} = impl;
