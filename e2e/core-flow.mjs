// End-to-end: capture → plan → timebox → focus → complete → shutdown review → persistence.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, clickButton, launch, screenshot, sql, state, step, waitFor } from './lib.mjs';

async function taskByTitle(browser, title) {
  const rows = await sql(browser, 'SELECT * FROM tasks WHERE title = ?', [title]);
  return rows[0];
}

export async function coreFlow({ application, dataDir, dialogDir }) {
  let browser = await launch(application);
  try {
    await step('first launch shows onboarding and works without an account', async () => {
      await (
        await browser.$('//h2[normalize-space()="Welcome to Keel"]')
      ).waitForDisplayed({ timeout: 15000 });
      await screenshot(browser, '01-onboarding');
      await clickButton(browser, 'Continue');
      await clickButton(browser, 'Continue');
      await clickButton(browser, 'Continue');
      await clickButton(browser, 'Start planning');
      await waitFor(
        browser,
        () => state(browser, () => window.__keel.getData().settings.onboarded),
        10000,
        'onboarding saved',
      );
      const areas = await sql(browser, 'SELECT name FROM areas ORDER BY name');
      assert(
        areas.map((a) => a.name).join(',') === 'Personal,Work',
        `default areas created, got ${JSON.stringify(areas)}`,
      );
    });

    await step('quick capture parses a task into today', async () => {
      await (await browser.$('body')).click({ x: 5, y: 5 });
      await browser.keys(['q']);
      const input = await browser.$('input[aria-label="Task"]');
      await input.waitForDisplayed({ timeout: 5000 });
      await input.setValue('Write E2E report 30m #work !high');
      await screenshot(browser, '02-capture');
      await browser.keys(['Enter']);
      const t = await waitFor(
        browser,
        () => taskByTitle(browser, 'Write E2E report'),
        5000,
        'captured task',
      );
      const today = await state(browser, () => window.__keel.getData().today);
      const plan = await sql(
        browser,
        "SELECT plan_date FROM day_plan_entries WHERE task_id = ? AND status = 'active'",
        [t.id],
      );
      assert(t.estimate_min === 30, 'estimate parsed');
      assert(t.priority === 3, 'priority parsed');
      assert(t.area_id, 'area matched from #work');
      assert(plan[0]?.plan_date === today, 'planned for today');
      await (await browser.$('[data-task-card]')).waitForDisplayed({ timeout: 5000 });
    });

    await step('planning ritual: review, estimate, auto-timebox, workload, intention', async () => {
      await clickButton(browser, 'Plan your day');
      await (
        await browser.$('//h2[normalize-space()="Review unfinished work"]')
      ).waitForDisplayed({ timeout: 5000 });
      await clickButton(browser, 'Continue'); // → choose
      await clickButton(browser, 'Continue'); // → estimate
      await clickButton(browser, 'Continue'); // → timebox
      await screenshot(browser, '03-plan-timebox');
      await clickButton(browser, 'Auto-timebox');
      const t = await taskByTitle(browser, 'Write E2E report');
      const blocks = await waitFor(
        browser,
        async () => {
          const rows = await sql(browser, 'SELECT * FROM time_blocks WHERE task_id = ?', [t.id]);
          return rows.length ? rows : null;
        },
        5000,
        'time block created',
      );
      const minutes = (Date.parse(blocks[0].end_utc) - Date.parse(blocks[0].start_utc)) / 60000;
      assert(minutes === 30, `block uses the 30m estimate, got ${minutes}`);
      await clickButton(browser, 'Continue'); // → workload
      await screenshot(browser, '04-plan-workload');
      await clickButton(browser, 'Continue'); // → intention
      const intention = await browser.$('#intention');
      await intention.setValue('Ship the report.');
      await clickButton(browser, 'Start the day');
      const today = await state(browser, () => window.__keel.getData().today);
      const rituals = await waitFor(
        browser,
        async () => {
          const r = await sql(
            browser,
            "SELECT * FROM rituals WHERE kind = 'plan' AND period = ? AND completed_at IS NOT NULL",
            [today],
          );
          return r.length ? r : null;
        },
        5000,
        'plan ritual saved',
      );
      assert(JSON.parse(rituals[0].data).intention === 'Ship the report.', 'intention stored');
    });

    await step('focus mode tracks time and completing stops the timer', async () => {
      await (
        await browser.$('//div[@data-task-card]//*[normalize-space()="Write E2E report"]')
      ).click();
      await clickButton(browser, 'Start & focus');
      await (
        await browser.$('//*[contains(normalize-space(), "Focusing")]')
      ).waitForDisplayed({ timeout: 5000 });
      await browser.pause(2600);
      await screenshot(browser, '05-focus');
      const t = await taskByTitle(browser, 'Write E2E report');
      const running = await sql(
        browser,
        'SELECT * FROM time_sessions WHERE task_id = ? AND end_utc IS NULL',
        [t.id],
      );
      assert(running.length === 1, 'one running session');
      await clickButton(browser, 'Complete');
      await waitFor(
        browser,
        async () => (await taskByTitle(browser, 'Write E2E report')).completed_at,
        5000,
        'task completed',
      );
      const sessions = await sql(browser, 'SELECT * FROM time_sessions WHERE task_id = ?', [t.id]);
      assert(sessions.length === 1 && sessions[0].end_utc, 'timer stopped on completion');
      const secs = (Date.parse(sessions[0].end_utc) - Date.parse(sessions[0].start_utc)) / 1000;
      assert(secs >= 2, `tracked at least 2s, got ${secs}`);
      await clickButton(browser, 'All done for today — back to plan');
    });

    await step('shutdown ritual records the reflection and closes the day', async () => {
      await clickButton(browser, 'Shut down');
      await (
        await browser.$('//h2[normalize-space()="What you got done"]')
      ).waitForDisplayed({ timeout: 5000 });
      await screenshot(browser, '06-shutdown');
      await clickButton(browser, 'Continue');
      await clickButton(browser, 'Continue');
      await (await browser.$('#sd-wentWell')).setValue('Finished the E2E report.');
      await clickButton(browser, 'Continue');
      await clickButton(browser, 'Shut down for the day');
      const today = await state(browser, () => window.__keel.getData().today);
      const r = await waitFor(
        browser,
        async () => {
          const rows = await sql(
            browser,
            "SELECT * FROM rituals WHERE kind = 'shutdown' AND period = ? AND completed_at IS NOT NULL",
            [today],
          );
          return rows[0];
        },
        5000,
        'shutdown saved',
      );
      assert(r.reflection.includes('Finished the E2E report.'), 'reflection stored');
      assert(JSON.parse(r.data).completedCount === 1, 'completed count captured');
    });

    await step('review shows planned vs actual from local data', async () => {
      await clickButton(browser, 'Review');
      await (
        await browser.$('//h3[normalize-space()="Planned vs tracked"]')
      ).waitForDisplayed({ timeout: 5000 });
      await screenshot(browser, '07-review');
    });

    await step('undo restores a deleted task (Ctrl+Z)', async () => {
      await clickButton(browser, 'Today');
      await browser.keys(['q']);
      const input = await browser.$('input[aria-label="Task"]');
      await input.waitForDisplayed({ timeout: 5000 });
      await input.setValue('Temporary task');
      await browser.keys(['Enter']);
      const t = await waitFor(
        browser,
        () => taskByTitle(browser, 'Temporary task'),
        5000,
        'temp task',
      );
      await (
        await browser.$('//div[@data-task-card]//*[normalize-space()="Temporary task"]')
      ).click();
      await clickButton(browser, 'Delete');
      await waitFor(
        browser,
        async () => !(await taskByTitle(browser, 'Temporary task')),
        5000,
        'deleted',
      );
      await (await browser.$('body')).click({ x: 5, y: 5 });
      await browser.keys(['Control', 'z']);
      const back = await waitFor(
        browser,
        () => taskByTitle(browser, 'Temporary task'),
        5000,
        'undo restored task',
      );
      assert(back.id === t.id, 'same task restored');
    });

    await step('backup and exports write real files', async () => {
      await clickButton(browser, 'Settings');
      await clickButton(browser, 'Data & privacy');
      await clickButton(browser, 'Create backup');
      await waitFor(
        browser,
        async () =>
          existsSync(join(dataDir, 'backups')) &&
          readdirSync(join(dataDir, 'backups')).some((f) => f.includes('manual')),
        5000,
        'backup file',
      );
      await clickButton(browser, 'Export JSON');
      const jsonFile = await waitFor(
        browser,
        async () => readdirSync(dialogDir).find((f) => f.endsWith('.json')),
        5000,
        'json export',
      );
      const doc = JSON.parse(readFileSync(join(dialogDir, jsonFile), 'utf8'));
      assert(
        doc.format === 'keel-export' && doc.tasks.some((t) => t.title === 'Write E2E report'),
        'JSON export has tasks',
      );
      await clickButton(browser, 'Export CSV');
      const csvFile = await waitFor(
        browser,
        async () => readdirSync(dialogDir).find((f) => f.endsWith('.csv')),
        5000,
        'csv export',
      );
      assert(
        readFileSync(join(dialogDir, csvFile), 'utf8').includes('Write E2E report'),
        'CSV has task',
      );
      await clickButton(browser, 'Export .ics');
      const icsFile = await waitFor(
        browser,
        async () => readdirSync(dialogDir).find((f) => f.endsWith('.ics')),
        5000,
        'ics export',
      );
      assert(
        readFileSync(join(dialogDir, icsFile), 'utf8').includes('BEGIN:VCALENDAR'),
        'ICS export valid',
      );
      await screenshot(browser, '08-settings-data');
    });

    await step('a running timer survives an app restart', async () => {
      await clickButton(browser, 'Today');
      await browser.keys(['q']);
      const input = await browser.$('input[aria-label="Task"]');
      await input.waitForDisplayed({ timeout: 5000 });
      await input.setValue('Long running work');
      await browser.keys(['Enter']);
      await waitFor(browser, () => taskByTitle(browser, 'Long running work'), 5000, 'task');
      await (
        await browser.$('//div[@data-task-card]//*[normalize-space()="Long running work"]')
      ).click();
      await clickButton(browser, 'Start & focus');
      await (
        await browser.$('//*[contains(normalize-space(), "Focusing")]')
      ).waitForDisplayed({ timeout: 5000 });
    });
  } catch (e) {
    await screenshot(browser, 'failure').catch(() => undefined);
    await browser.deleteSession().catch(() => undefined);
    throw e;
  }
  await browser.deleteSession();

  // ---- Relaunch with the same data directory ----------------------------------------
  browser = await launch(application);
  try {
    await step('after restart: data, rituals and settings persisted; no onboarding', async () => {
      const onboarded = await state(browser, () => window.__keel.getData().settings.onboarded);
      assert(onboarded, 'still onboarded');
      const t = await taskByTitle(browser, 'Write E2E report');
      assert(t && t.completed_at, 'completed task persisted');
      const rituals = await sql(
        browser,
        'SELECT kind FROM rituals WHERE completed_at IS NOT NULL ORDER BY kind',
      );
      assert(rituals.map((r) => r.kind).join(',') === 'plan,shutdown', 'rituals persisted');
      await screenshot(browser, '09-after-restart');
    });

    await step('after restart: the timer is still running and keeps counting', async () => {
      const t = await taskByTitle(browser, 'Long running work');
      const running = await sql(
        browser,
        'SELECT * FROM time_sessions WHERE task_id = ? AND end_utc IS NULL',
        [t.id],
      );
      assert(running.length === 1, 'session still open after restart');
      const dock = await browser.$('[aria-label="Running timer"]');
      await dock.waitForDisplayed({ timeout: 5000 });
      const text = await browser.execute(
        () => document.querySelector('[aria-label="Running timer"]')?.textContent ?? '',
      );
      assert(text.includes('Long running work'), `timer dock shows task, got "${text}"`);
    });

    await step('sleep/wake: a stale heartbeat asks before counting the gap', async () => {
      const t = await taskByTitle(browser, 'Long running work');
      const hourAgo = new Date(Date.now() - 3600_000).toISOString();
      await sql(
        browser,
        'UPDATE time_sessions SET start_utc = ?, heartbeat_utc = ? WHERE task_id = ? AND end_utc IS NULL',
        [new Date(Date.now() - 2 * 3600_000).toISOString(), hourAgo, t.id],
      );
      await browser.executeAsync((done) => window.__keel.refresh().then(() => done(true)));
      await browser.execute(() => window.dispatchEvent(new Event('focus')));
      await (
        await browser.$('//*[normalize-space()="Were you working the whole time?"]')
      ).waitForDisplayed({ timeout: 10000 });
      await screenshot(browser, '10-gap');
      await clickButton(browser, 'Discard that time, keep timing from now');
      await waitFor(
        browser,
        async () =>
          (await sql(browser, 'SELECT * FROM time_sessions WHERE task_id = ?', [t.id])).length ===
          2,
        5000,
        'session split',
      );
      const sessions = await sql(
        browser,
        'SELECT * FROM time_sessions WHERE task_id = ? ORDER BY start_utc',
        [t.id],
      );
      assert(sessions[0].end_utc === hourAgo, 'first session ends at last heartbeat');
      assert(!sessions[1].end_utc, 'new session running');
    });
  } catch (e) {
    await screenshot(browser, 'failure-restart').catch(() => undefined);
    await browser.deleteSession().catch(() => undefined);
    throw e;
  }
  await browser.deleteSession();
}
