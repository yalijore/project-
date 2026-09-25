#!/usr/bin/env node
// Runs Keel's end-to-end suite against the real desktop binary via tauri-driver.
//
//   npm run e2e              build (debug, no installer) and run
//   npm run e2e -- --no-build   reuse the existing binary
//   npm run e2e -- --offline    run inside a network namespace with only loopback (Linux, root)
//
// Linux only (WebKitWebDriver). On Windows, run tauri-driver with msedgedriver instead —
// see README "End-to-end tests".
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreFlow } from './core-flow.mjs';
import { integrations } from './integrations.mjs';
import { interactions } from './interactions.mjs';
import { startMockProvider } from './mockProvider.mjs';
import { failureCount } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const root = new URL('..', import.meta.url).pathname;
const application = join(root, 'src-tauri/target/debug/keel');

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
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(dialogDir, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
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

if (!process.env.DISPLAY) {
  const xvfb = spawn('Xvfb', [':97', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
  });
  children.push(xvfb);
  env.DISPLAY = ':97';
  await new Promise((r) => setTimeout(r, 800));
}

const driverBin =
  process.env.TAURI_DRIVER ?? join(process.env.HOME ?? '', '.cargo/bin/tauri-driver');
const driver = spawn(driverBin, [], { env, stdio: ['ignore', 'ignore', 'inherit'] });
children.push(driver);
await new Promise((r) => setTimeout(r, 1200));

console.log(`Keel E2E — data dir ${dataDir}, TZ ${tz}`);
let ok = true;
try {
  await coreFlow({ application, dataDir, dialogDir });
  await integrations({ application, dialogDir, secretDir, mock });
  await interactions({ application, dataDir, dialogDir, secretDir });
} catch {
  ok = false;
}
console.log(
  ok && failureCount() === 0
    ? '\nAll end-to-end steps passed.'
    : `\nEnd-to-end suite failed (${failureCount()} step(s)). Screenshots: e2e/.artifacts/`,
);
process.exit(ok && failureCount() === 0 ? 0 : 1);
