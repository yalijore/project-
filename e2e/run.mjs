#!/usr/bin/env node
// Runs Keel's end-to-end suite against the real desktop binary through WebDriver.
//
//   npm run e2e              build (debug, no installer) and run
//   npm run e2e -- --no-build   reuse the existing binary
//   npm run e2e -- --offline    run inside a network namespace with only loopback (Linux, root)
//   npm run e2e -- --only=focusbar   core flow + one suite (integrations|focusbar|interactions)
//
// Linux: tauri-driver + WebKitWebDriver under Xvfb (with a window manager and compositor).
// Windows: msedgedriver (MSEDGEDRIVER=path, or on PATH) attached to WebView2's DevTools port;
// runs on the real desktop session. In CI (CI=true) the Windows time zone is set so it is
// mid-morning.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreFlow } from './core-flow.mjs';
import { focusBar } from './focusbar.mjs';
import { integrations } from './integrations.mjs';
import { interactions } from './interactions.mjs';
import { startMockProvider } from './mockProvider.mjs';
import { attachOnWindows, failureCount, startWithDevTools, stopApp } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith('--only='))?.slice(7);
const windows = process.platform === 'win32';
const root = fileURLToPath(new URL('..', import.meta.url));
const application = join(root, 'src-tauri', 'target', 'debug', windows ? 'keel.exe' : 'keel');

if (args.has('--offline') && !process.env.KEEL_E2E_NETNS) {
  // Re-run this script in a fresh network namespace where only loopback exists.
  const inner = [
    '-n',
    'sh',
    '-c',
    `ip link set lo up && KEEL_E2E_NETNS=1 node ${JSON.stringify(process.argv[1])} ${[...args].filter((a) => a !== '--offline').join(' ')} --no-build --offline`,
  ];
  if (!args.has('--no-build')) build();
  const r = spawnSync('unshare', inner, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function build() {
  console.log('Building debug binary…');
  const r = spawnSync('npx', ['tauri', 'build', '--debug', '--no-bundle'], {
    cwd: root,
    stdio: 'inherit',
    shell: windows,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!args.has('--no-build')) build();
if (!existsSync(application)) {
  console.error(`Binary not found at ${application}. Run without --no-build.`);
  process.exit(1);
}

if (process.env.KEEL_E2E_NETNS) {
  const probe = spawnSync('sh', ['-c', 'getent hosts registry.npmjs.org || true'], {
    encoding: 'utf8',
  });
  console.log(
    `Offline mode: network namespace with loopback only (DNS probe: ${probe.stdout.trim() ? 'resolved!' : 'no network'})`,
  );
}

// Pick a fixed-offset zone where it is currently mid-morning, so timeboxing "today"
// always has free working hours regardless of when the suite runs.
const utcHour = new Date().getUTCHours();
const offset = ((10 - utcHour + 36) % 24) - 12; // local ≈ 10:00, offset in [-12, 11]
const tz = offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
// WebView2 ignores TZ; on a CI machine set the system zone (fixed-offset zones, no DST).
const WINDOWS_ZONES = {
  '-12': 'Dateline Standard Time',
  '-11': 'UTC-11',
  '-10': 'Hawaiian Standard Time',
  '-9': 'UTC-09',
  '-8': 'UTC-08',
  '-7': 'US Mountain Standard Time',
  '-6': 'Central America Standard Time',
  '-5': 'SA Pacific Standard Time',
  '-4': 'SA Western Standard Time',
  '-3': 'SA Eastern Standard Time',
  '-2': 'UTC-02',
  '-1': 'Cape Verde Standard Time',
  0: 'UTC',
  1: 'W. Central Africa Standard Time',
  2: 'South Africa Standard Time',
  3: 'Arab Standard Time',
  4: 'Arabian Standard Time',
  5: 'West Asia Standard Time',
  6: 'Bangladesh Standard Time',
  7: 'SE Asia Standard Time',
  8: 'China Standard Time',
  9: 'Tokyo Standard Time',
  10: 'E. Australia Standard Time',
  11: 'Central Pacific Standard Time',
};
if (windows && process.env.CI)
  spawnSync('tzutil', ['/s', WINDOWS_ZONES[offset]], { stdio: 'inherit' });

const dataDir = mkdtempSync(join(tmpdir(), 'keel-e2e-data-'));
const dialogDir = mkdtempSync(join(tmpdir(), 'keel-e2e-files-'));
// Stands in for the OS credential store (the E2E machine may have no unlocked keyring).
const secretDir = mkdtempSync(join(tmpdir(), 'keel-e2e-secrets-'));
const mock = await startMockProvider();
const children = [];
const cleanup = () => {
  for (const c of children) c.kill('SIGTERM');
  mock.close();
  if (!args.has('--keep')) {
    for (const dir of [dataDir, dialogDir, secretDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        console.error(`(could not remove ${dir}: ${e instanceof Error ? e.message : e})`);
      }
    }
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const env = {
  ...process.env,
  TZ: tz,
  KEEL_DATA_DIR: dataDir,
  KEEL_E2E: '1',
  KEEL_E2E_DIALOG_DIR: dialogDir,
  KEEL_E2E_OPEN_FILE: 'import.ics',
  KEEL_E2E_SECRET_DIR: secretDir,
  KEEL_E2E_PROVIDER_BASE: mock.base,
  WEBKIT_DISABLE_COMPOSITING_MODE: '1',
  WEBKIT_DISABLE_DMABUF_RENDERER: '1',
  NO_AT_BRIDGE: '1',
};

if (!windows && !process.env.DISPLAY) {
  const xvfb = spawn('Xvfb', [':97', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
  });
  children.push(xvfb);
  env.DISPLAY = ':97';
  await new Promise((r) => setTimeout(r, 800));
  // A real window manager, so stacking, focus and always-on-top behave as on a desktop.
  if (spawnSync('sh', ['-c', 'command -v openbox']).status === 0) {
    children.push(spawn('openbox', [], { env, stdio: 'ignore' }));
    await new Promise((r) => setTimeout(r, 500));
  }
  // …and a compositor, as on standard desktops (GNOME, KDE, Xfce).
  if (spawnSync('sh', ['-c', 'command -v xcompmgr']).status === 0) {
    children.push(spawn('xcompmgr', [], { env, stdio: 'ignore' }));
    await new Promise((r) => setTimeout(r, 300));
  }
}
if (!windows) process.env.DISPLAY = env.DISPLAY; // for the X11 test helpers

let driver;
if (windows) {
  // Probe first: start Keel on its own with WebView2's DevTools port open. A startup failure
  // or an ignored port shows here with the app's own output, instead of as a WebDriver error.
  const smokeDir = mkdtempSync(join(tmpdir(), 'keel-e2e-smoke-'));
  try {
    const probe = await startWithDevTools(application, { ...env, KEEL_DATA_DIR: smokeDir });
    console.log(`Startup check: Keel is up and WebView2 DevTools answer on port ${probe.port}.`);
    await stopApp(probe.app);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  try {
    rmSync(smokeDir, { recursive: true, force: true });
  } catch {
    // A file still held by an exiting WebView2 process; it is only a temp folder.
  }
  // msedgedriver attaches to each Keel the suite starts (see attachOnWindows in lib.mjs).
  attachOnWindows(env);
  driver = spawn(process.env.MSEDGEDRIVER ?? 'msedgedriver.exe', ['--port=4444'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
} else {
  const driverBin =
    process.env.TAURI_DRIVER ?? join(process.env.HOME ?? '', '.cargo', 'bin', 'tauri-driver');
  driver = spawn(driverBin, [], { env, stdio: ['ignore', 'ignore', 'inherit'] });
}
children.push(driver);
await new Promise((r) => setTimeout(r, 1200));

console.log(`Keel E2E — data dir ${dataDir}, TZ ${tz}`);
let ok = true;
try {
  // --only=<suite> runs the core flow (which onboards) and that one suite.
  await coreFlow({ application, dataDir, dialogDir });
  if (!only || only === 'integrations')
    await integrations({ application, dialogDir, secretDir, mock });
  if (!only || only === 'focusbar') await focusBar({ application });
  if (!only || only === 'interactions')
    await interactions({ application, dataDir, dialogDir, secretDir });
} catch (e) {
  ok = false;
  // Failed steps report themselves; anything else (such as a failed launch) is reported here.
  if (failureCount() === 0) console.error(e instanceof Error ? (e.stack ?? e.message) : e);
}
console.log(
  ok && failureCount() === 0
    ? '\nAll end-to-end steps passed.'
    : `\nEnd-to-end suite failed (${failureCount()} step(s)). Screenshots: e2e/.artifacts/`,
);
process.exit(ok && failureCount() === 0 ? 0 : 1);
