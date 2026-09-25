// Helpers for driving the real Keel desktop binary through tauri-driver (WebDriver).
import { remote } from 'webdriverio';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARTIFACTS = fileURLToPath(new URL('./.artifacts/', import.meta.url));
mkdirSync(ARTIFACTS, { recursive: true });

let lastBrowser = null;

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
  lastBrowser = browser;
  return browser;
}

/** On a failed step: what each window shows, plus screenshots, so CI failures explain themselves. */
async function diagnose(name) {
  const slug = name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
  const { rootScreenshot, hasTools } = await import('./desktop.mjs');
  if (hasTools()) rootScreenshot(join(ARTIFACTS, `failed-${slug}-screen.png`));
  const browser = lastBrowser;
  if (!browser) return;
  try {
    const current = await browser.getWindowHandle();
    const handles = await browser.getWindowHandles();
    console.error(`    windows: ${handles.length}`);
    for (const h of handles) {
      await browser.switchToWindow(h);
      const info = await browser.execute(() => {
        const squash = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
        const k = window.__keel;
        const u = k?.ui?.();
        return {
          title: document.title,
          text: squash(document.body?.innerText).slice(0, 300),
          dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map((d) =>
            squash(d.textContent).slice(0, 160),
          ),
          toasts: [...document.querySelectorAll('[data-sonner-toast]')].map((t) =>
            squash(t.textContent),
          ),
          ui: u && {
            view: u.view,
            openTaskId: u.openTaskId,
            focusTaskId: u.focusTaskId,
            barTaskId: u.barTaskId,
            barVisible: u.barVisible,
            ritual: u.ritual,
          },
          running: k
            ? Object.values(k.getData().sessions ?? {}).filter((s) => !s.endUtc).length
            : undefined,
          errors: k?.errors?.slice(-5),
        };
      });
      const tag = h === current ? 'current' : 'other';
      console.error(`    [${tag}] ${info.title}: ${info.text}`);
      for (const d of info.dialogs) console.error(`      dialog: ${d}`);
      for (const t of info.toasts) console.error(`      toast: ${t}`);
      if (info.ui) console.error(`      ui: ${JSON.stringify(info.ui)} running=${info.running}`);
      for (const e of info.errors ?? []) console.error(`      error: ${e}`);
    }
    await browser.switchToWindow(current);
    await browser.saveScreenshot(join(ARTIFACTS, `failed-${slug}.png`));
  } catch (e) {
    console.error(`    (diagnostics unavailable: ${e instanceof Error ? e.message : e})`);
  }
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
    await diagnose(name);
    throw e;
  }
}

export function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

export function failureCount() {
  return failures;
}
