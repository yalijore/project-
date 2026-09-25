// Helpers for driving the real Keel desktop binary through tauri-driver (WebDriver).
import { remote } from 'webdriverio';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARTIFACTS = fileURLToPath(new URL('./.artifacts/', import.meta.url));
mkdirSync(ARTIFACTS, { recursive: true });

export async function launch(application) {
  const browser = await remote({
    hostname: '127.0.0.1',
    port: 4444,
    logLevel: 'error',
    connectionRetryCount: 2,
    capabilities: { 'tauri:options': { application } },
  });
  await waitFor(
    browser,
    async () =>
      await browser.execute(() => !!window.__keel && window.__keel.getData().status === 'ready'),
    30000,
    'app to finish loading',
  );
  return browser;
}

export async function waitFor(browser, fn, timeout = 10000, what = 'condition') {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await browser.pause(150);
  }
  throw new Error(
    `Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`,
  );
}

/** Runs SQL in the app's own database connection (test handle exposed only when KEEL_E2E=1). */
export async function sql(browser, query, params = []) {
  return browser
    .executeAsync(
      (q, p, done) => {
        window.__keel.db
          .all(q, p)
          .then((rows) => done({ rows }))
          .catch((e) => done({ error: String(e) }));
      },
      query,
      params,
    )
    .then((r) => {
      if (r.error) throw new Error(r.error);
      return r.rows;
    });
}

export async function state(browser, fn) {
  return browser.execute(fn);
}

export async function clickButton(browser, text, { exact = true } = {}) {
  const xpath = exact
    ? `//button[normalize-space()=${JSON.stringify(text)}]`
    : `//button[contains(normalize-space(), ${JSON.stringify(text)})]`;
  const el = await browser.$(xpath);
  await el.waitForExist({ timeout: 10000 });
  await el.scrollIntoView({ block: 'center' });
  await el.waitForClickable({ timeout: 10000 });
  await el.click();
  return el;
}

export async function screenshot(browser, name) {
  await browser.saveScreenshot(join(ARTIFACTS, `${name}.png`));
}

let failures = 0;
export async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    throw e;
  }
}

export function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

export function failureCount() {
  return failures;
}
