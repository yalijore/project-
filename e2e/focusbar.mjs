// End-to-end: the floating focus bar as a real, separate, always-on-top desktop window.
// Uses real X11 input (xdotool) so clicks and shortcuts go through the window manager, with
// another application in front (xcalc on Linux, Notepad on Windows), as a user would work.
import { join } from 'node:path';
import { ARTIFACTS, assert, clickButton, launch, sql, state, step, waitFor } from './lib.mjs';
import {
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
} from './desktop.mjs';

const TITLE = 'Mini bar acceptance';
const BAR = '^Keel focus bar$';

async function barHandle(browser, mainHandle) {
  return waitFor(
    browser,
    async () => (await browser.getWindowHandles()).find((h) => h !== mainHandle),
    10000,
    'focus bar web view',
  );
}

/** Runs `fn` inside the bar's web view (read-only inspection), then returns to the planner. */
async function inBar(browser, mainHandle, fn, ...args) {
  await browser.switchToWindow(await barHandle(browser, mainHandle));
  try {
    return await browser.execute(fn, ...args);
  } finally {
    await browser.switchToWindow(mainHandle);
  }
}

/** Clicks a bar control with a real mouse click at its on-screen position. */
async function clickBar(browser, mainHandle, label) {
  const win = await waitFor(browser, async () => findWindow(BAR), 10000, 'focus bar window');
  const rect = await waitFor(
    browser,
    () =>
      inBar(
        browser,
        mainHandle,
        (l) => {
          const el = [...document.querySelectorAll('button')].find(
            (b) => b.getAttribute('aria-label') === l && !b.disabled,
          );
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        },
        label,
      ),
    10000,
    `bar control “${label}”`,
  );
  const g = geometry(win);
  click(g.x + rect.x, g.y + rect.y);
}

async function paletteCommand(browser, text) {
  await (await browser.$('body')).click({ x: 5, y: 5 });
  await browser.keys(['Control', 'k']);
  const search = await browser.$('[cmdk-input]');
  await search.waitForDisplayed({ timeout: 5000 });
  await search.setValue(text);
  await browser.pause(150);
  await browser.keys(['Enter']);
}

async function sessions(browser, taskId) {
  return sql(browser, 'SELECT * FROM time_sessions WHERE task_id = ? ORDER BY start_utc', [taskId]);
}

async function running(browser, taskId) {
  return (await sessions(browser, taskId)).filter((s) => !s.end_utc).length;
}

export async function focusBar({ application }) {
  if (!hasTools()) {
    console.log('  - focus bar: skipped (needs xdotool, xprop, xwininfo and xcalc, or Windows)');
    return;
  }
  let browser = await launch(application);
  let mainHandle = await browser.getWindowHandle();
  let mainWin = findWindow('^Keel$');
  let other = null;
  let otherTitle = '^Calculator$';
  let taskId;
  let savedPos;
  try {
    await step(
      'focus bar: starting a timer opens an always-on-top bar without taking focus',
      async () => {
        // An earlier suite leaves a timer that ran "while asleep": answer the prompt as a user.
        // The prompt appears on the first clock tick after launch, so give it a moment.
        const gap = await browser.$(
          '//button[normalize-space()="Discard that time and stop the timer"]',
        );
        if (await gap.waitForExist({ timeout: 4000 }).catch(() => false)) {
          await gap.click();
          await gap.waitForExist({ reverse: true, timeout: 5000 });
        }
        // The bar may have been restored with that timer; start from a hidden bar.
        if (findWindow(BAR)) {
          await paletteCommand(browser, 'Show or hide the focus bar');
          await waitFor(browser, async () => !findWindow(BAR), 5000, 'bar hidden');
        }
        await (await browser.$('body')).click({ x: 5, y: 5 });
        await browser.keys(['q']);
        const input = await browser.$('input[aria-label="Task"]');
        await input.waitForDisplayed({ timeout: 5000 });
        await input.setValue(`${TITLE} 20m`);
        await browser.keys(['Enter']);
        const task = await waitFor(
          browser,
          async () => (await sql(browser, 'SELECT * FROM tasks WHERE title = ?', [TITLE]))[0],
          5000,
          'task',
        );
        taskId = task.id;
        const card = await browser.$(`//*[@data-task-card][.//*[normalize-space()="${TITLE}"]]`);
        await card.scrollIntoView({ block: 'center' });
        await card.click();
        await clickButton(browser, 'Start & focus');
        await clickButton(browser, 'Exit focus', { exact: false }); // work elsewhere instead
        const bar = await waitFor(browser, async () => findWindow(BAR), 10000, 'focus bar window');
        await browser.pause(700);
        rootScreenshot(join(ARTIFACTS, '39-focus-bar-opened.png'), [findWindow(BAR)]);
        assert((await running(browser, taskId)) === 1, 'timer running');
        assert(isAlwaysOnTop(bar), 'bar is kept above other windows');
        assert(activeWindow() === mainWin, 'showing the bar did not take keyboard focus');
        const g = geometry(bar);
        const screen = screenSize();
        assert(g.width === 440 && g.height === 52, `compact size, got ${g.width}×${g.height}`);
        assert(
          Math.abs(g.x + g.width / 2 - screen.width / 2) <= 2 &&
            g.y + g.height <= screen.height - 20,
          `default position is bottom-centre, got ${g.x},${g.y}`,
        );
        const text = await inBar(browser, mainHandle, () => document.body.innerText);
        assert(text.includes(TITLE), `bar shows the task: ${text}`);
        assert(
          /0:0\d/.test(text) && text.includes('left of 20m'),
          `elapsed and remaining: ${text}`,
        );
      },
    );

    await step('focus bar: stays above another app; pause and resume from the bar', async () => {
      const app = launchOtherApp();
      other = app.proc;
      otherTitle = app.title;
      const clock = await waitFor(browser, async () => findWindow(otherTitle), 10000, 'other app');
      activate(clock);
      await waitFor(browser, async () => activeWindow() === clock, 5000, 'other app active').catch(
        () => {
          throw new Error(
            `another app should be in front; active: ${describe(activeWindow())}, other app: ${describe(clock)}`,
          );
        },
      );
      const bar = findWindow(BAR);
      const order = stacking();
      assert(order.indexOf(bar) > order.indexOf(clock), 'bar stacked above the active app');
      rootScreenshot(join(ARTIFACTS, '40-focus-bar-over-other-app.png'), [findWindow(BAR)]);

      await clickBar(browser, mainHandle, 'Pause timer');
      await waitFor(browser, async () => (await running(browser, taskId)) === 0, 5000, 'paused');
      assert((await sessions(browser, taskId)).length === 1, 'one finished session');

      activate(clock);
      await clickBar(browser, mainHandle, 'Resume timer');
      await waitFor(browser, async () => (await running(browser, taskId)) === 1, 5000, 'resumed');
      assert((await sessions(browser, taskId)).length === 2, 'resuming starts one new session');
    });

    await step(
      'focus bar: hiding keeps the timer; global shortcuts reopen it and start/pause',
      async () => {
        const clock = findWindow(otherTitle);
        activate(clock);
        await clickBar(browser, mainHandle, 'Hide focus bar (the timer keeps running)');
        await waitFor(browser, async () => !findWindow(BAR), 5000, 'bar hidden');
        assert((await running(browser, taskId)) === 1, 'timer still running while hidden');

        activate(clock);
        const pressed = Date.now();
        key('ctrl+alt+shift+f');
        // The bar is a new window each time it opens (a fresh web view): allow for a slow CI
        // machine, and report how long it took.
        await waitFor(browser, async () => findWindow(BAR), 15000, 'bar reopened by shortcut');
        console.log(`    (bar reopened ${Date.now() - pressed} ms after the shortcut)`);
        assert(activeWindow() === clock, 'reopening did not steal focus from the other app');

        key('ctrl+alt+shift+space');
        await waitFor(
          browser,
          async () => (await running(browser, taskId)) === 0,
          5000,
          'paused by shortcut',
        );
        key('ctrl+alt+shift+space');
        await waitFor(
          browser,
          async () => (await running(browser, taskId)) === 1,
          5000,
          'resumed by shortcut',
        );
        assert((await sessions(browser, taskId)).length === 3, 'three sessions so far');
      },
    );

    await step('focus bar: remembers its position across restart and stays on screen', async () => {
      const bar = findWindow(BAR);
      const before = geometry(bar);
      const grip = await inBar(browser, mainHandle, () => {
        const r = document.querySelector('[data-grip]').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      const fromX = Math.round(before.x + grip.x);
      const fromY = Math.round(before.y + grip.y);
      drag(fromX, fromY, fromX - 320, fromY - 480);
      savedPos = await waitFor(
        browser,
        async () => {
          const g = geometry(findWindow(BAR));
          return Math.abs(g.y - before.y) > 300 ? g : null;
        },
        5000,
        'bar dragged',
      );
      await browser.pause(1200); // let the position settle and be saved

      // Restart Keel with the timer running: the bar comes back where it was.
      await browser.deleteSession();
      browser = await launch(application);
      mainHandle = await browser.getWindowHandle();
      mainWin = await waitFor(browser, async () => findWindow('^Keel$'), 10000, 'main window');
      const again = await waitFor(browser, async () => findWindow(BAR), 15000, 'bar restored');
      const g = geometry(again);
      assert(
        Math.abs(g.x - savedPos.x) <= 2 && Math.abs(g.y - savedPos.y) <= 2,
        `restored at ${g.x},${g.y}, expected ${savedPos.x},${savedPos.y}`,
      );
      assert((await running(browser, taskId)) === 1, 'timer survived the restart');

      // Pushed half off-screen (as when a monitor goes away), it comes back fully visible.
      const screen = screenSize();
      moveWindow(again, screen.width - 150, screen.height - 20);
      await waitFor(
        browser,
        async () => {
          const p = geometry(findWindow(BAR));
          return (
            p.x + p.width <= screen.width && p.y + p.height <= screen.height && p.x >= 0 && p.y >= 0
          );
        },
        8000,
        'bar pulled back on screen',
      );

      // Reset position from the command palette.
      await paletteCommand(browser, 'Reset focus bar position');
      await waitFor(
        browser,
        async () => {
          const p = geometry(findWindow(BAR));
          return (
            Math.abs(p.x + p.width / 2 - screen.width / 2) <= 2 &&
            p.y + p.height <= screen.height - 20
          );
        },
        5000,
        'bar back at the default position',
      );
    });

    await step(
      'focus bar: title brings Keel forward; completing updates the planner exactly once',
      async () => {
        const clock = findWindow(otherTitle);
        activate(clock);
        const heading = await (await browser.$('h1')).getText();
        await clickBar(browser, mainHandle, `${TITLE} — open Keel`);
        await waitFor(
          browser,
          async () => activeWindow() === mainWin,
          5000,
          'Keel brought forward',
        );
        assert((await (await browser.$('h1')).getText()) === heading, 'the current view is kept');

        // Let at least a minute accumulate so the planner shows a non-zero actual time.
        await waitFor(
          browser,
          async () => {
            const rows = await sessions(browser, taskId);
            const ms = rows.reduce(
              (sum, s) =>
                sum + (s.end_utc ? Date.parse(s.end_utc) : Date.now()) - Date.parse(s.start_utc),
              0,
            );
            return ms >= 61_000;
          },
          90_000,
          'a minute of tracked time',
        );

        const completionsBefore = (
          await sql(browser, "SELECT count(*) AS n FROM undo_groups WHERE label = 'Complete task'")
        )[0].n;
        const expectedNext = await state(
          browser,
          (id) => {
            const { tasks, today } = window.__keel.getData();
            const day = Object.values(tasks)
              .filter((t) => t.planDate === today && !t.archivedAt)
              .sort((a, b) => a.planOrder - b.planOrder);
            const i = day.findIndex((t) => t.id === id);
            const rest = [...day.slice(i + 1), ...day.slice(0, i)];
            return rest.find((t) => !t.completedAt && t.id !== id)?.title ?? null;
          },
          taskId,
        );

        activate(clock);
        await clickBar(browser, mainHandle, 'Complete task');
        await waitFor(
          browser,
          async () =>
            (await sql(browser, 'SELECT completed_at FROM tasks WHERE id = ?', [taskId]))[0]
              .completed_at,
          5000,
          'task completed',
        );
        await browser.pause(800);
        const rows = await sessions(browser, taskId);
        assert(rows.length === 3, `no duplicate session: ${rows.length}`);
        assert(
          rows.every((s) => s.end_utc),
          'no session left running',
        );
        const completionsAfter = (
          await sql(browser, "SELECT count(*) AS n FROM undo_groups WHERE label = 'Complete task'")
        )[0].n;
        assert(completionsAfter === completionsBefore + 1, 'completed exactly once');

        // The planner shows it: completed card, and the actual time from the same sessions.
        const minutes = Math.round(
          rows.reduce((sum, s) => sum + Date.parse(s.end_utc) - Date.parse(s.start_utc), 0) /
            60_000,
        );
        const box = await browser.$(`[role="checkbox"][aria-label="Mark “${TITLE}” incomplete"]`);
        await box.waitForExist({ timeout: 5000 });
        assert((await box.getAttribute('aria-checked')) === 'true', 'card shows completed');
        const card = await browser.$(`//*[@data-task-card][.//*[normalize-space()="${TITLE}"]]`);
        await card.click();
        const tracked = await browser.$(`//*[normalize-space()="${minutes}m of 20m estimated"]`);
        await tracked.waitForDisplayed({ timeout: 5000 });
        await (
          await browser.$('//*[normalize-space()="3 sessions"]')
        ).waitForDisplayed({ timeout: 5000 });
        await browser.keys(['Escape']);

        // The bar moved on to the next planned task, or says the plan is done.
        const barText = await waitFor(
          browser,
          async () => {
            const t = await inBar(browser, mainHandle, () => document.body.innerText);
            return t.includes(TITLE) ? null : t;
          },
          5000,
          'bar advanced',
        );
        if (expectedNext) assert(barText.includes(expectedNext), `next task shown: ${barText}`);
        else
          assert(
            /All planned tasks are done|No task in focus/.test(barText),
            `done state: ${barText}`,
          );
        rootScreenshot(join(ARTIFACTS, '41-focus-bar-after-complete.png'), [findWindow(BAR)]);

        await clickBar(browser, mainHandle, 'Hide focus bar (the timer keeps running)');
        await waitFor(browser, async () => !findWindow(BAR), 5000, 'bar hidden');
      },
    );
  } catch (e) {
    rootScreenshot(join(ARTIFACTS, 'failure-focusbar.png'));
    await browser.deleteSession().catch(() => undefined);
    other?.kill('SIGTERM');
    throw e;
  }
  other?.kill('SIGTERM');
  await browser.deleteSession();
}
