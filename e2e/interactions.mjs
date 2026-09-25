// End-to-end: direct manipulation and data-management flows on the real binary.
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, clickButton, launch, screenshot, sql, state, step, waitFor } from './lib.mjs';

const IMPORT_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:Team calendar',
  'BEGIN:VEVENT',
  'UID:e2e-weekly@example.com',
  'SUMMARY:Imported weekly sync',
  'DTSTART;TZID=W. Europe Standard Time:20260928T100000',
  'DTEND;TZID=W. Europe Standard Time:20260928T103000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:e2e-allday@example.com',
  'SUMMARY:Imported holiday',
  'DTSTART;VALUE=DATE:20261001',
  'DTEND;VALUE=DATE:20261002',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

async function capture(browser, text) {
  await browser.execute(() => document.activeElement?.blur());
  await browser.keys(['q']);
  const input = await browser.$('input[aria-label="Task"]');
  await input.waitForDisplayed({ timeout: 5000 });
  await input.setValue(text);
  await browser.keys(['Enter']);
}

async function task(browser, title) {
  return (await sql(browser, 'SELECT * FROM tasks WHERE title = ?', [title]))[0];
}

async function planDate(browser, id) {
  const r = await sql(
    browser,
    "SELECT plan_date FROM day_plan_entries WHERE task_id = ? AND status IN ('active','done')",
    [id],
  );
  return r[0]?.plan_date ?? null;
}

async function card(browser, title) {
  const el = await browser.$(
    `//div[@data-task-card][.//*[normalize-space()=${JSON.stringify(title)}]]`,
  );
  await el.waitForDisplayed({ timeout: 5000 });
  return el;
}

async function rectOf(browser, el) {
  return browser.execute((node) => {
    node.scrollIntoView({ block: 'nearest' });
    const r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, el);
}

async function drag(browser, from, toX, toY) {
  const r = await rectOf(browser, from);
  const sx = Math.round(r.x + r.width / 2);
  const sy = Math.round(r.y + 14);
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: sx, y: sy })
    .down()
    .pause(80)
    .move({ x: sx + 4, y: sy + 8, duration: 80 })
    .move({ x: Math.round((sx + toX) / 2), y: Math.round((sy + toY) / 2), duration: 150 })
    .move({ x: toX, y: toY, duration: 200 })
    .pause(200)
    .up()
    .perform();
  await browser.pause(300);
}

export async function interactions({ application, dataDir, dialogDir }) {
  const browser = await launch(application);
  const today = await state(browser, () => window.__keel.getData().today);
  const tomorrow = await state(browser, () => {
    const d = new Date(`${window.__keel.getData().today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  });
  try {
    await step('keyboard: move, reorder, prioritize and estimate a focused task', async () => {
      await clickButton(browser, 'Today');
      for (const t of ['Key A', 'Key B']) {
        await capture(browser, t);
        await waitFor(browser, () => task(browser, t), 5000, t);
      }
      const a = await task(browser, 'Key A');
      await card(browser, 'Key A');
      await browser.execute(() =>
        document
          .querySelectorAll('[data-task-card]')
          .forEach((c) => c.textContent?.includes('Key A') && c.focus()),
      );
      await browser.keys(['3']);
      await waitFor(
        browser,
        async () => (await task(browser, 'Key A')).priority === 3,
        5000,
        'priority via key',
      );
      await browser.keys(['m']);
      await waitFor(
        browser,
        async () => (await planDate(browser, a.id)) === tomorrow,
        5000,
        'moved to next day via M',
      );
      await browser.execute(() =>
        document
          .querySelectorAll('[data-task-card]')
          .forEach((c) => c.textContent?.includes('Key B') && c.focus()),
      );
      await browser.keys(['e']);
      await clickButton(browser, '45m');
      await waitFor(
        browser,
        async () => (await task(browser, 'Key B')).estimate_min === 45,
        5000,
        'estimate via E',
      );
    });

    await step('drag and drop: move a card to another day', async () => {
      const b = await task(browser, 'Key B');
      const target = await rectOf(browser, await browser.$('section[aria-label="Tomorrow"]'));
      await drag(
        browser,
        await card(browser, 'Key B'),
        Math.round(target.x + target.width / 2),
        Math.round(target.y + 260),
      );
      await waitFor(
        browser,
        async () => (await planDate(browser, b.id)) === tomorrow,
        5000,
        'drop onto Tomorrow column',
      );
      await screenshot(browser, '20-dnd-day');
    });

    await step('drag and drop: timebox a card by dropping it on the calendar', async () => {
      await capture(browser, 'Drop me 30m');
      const t = await waitFor(browser, () => task(browser, 'Drop me'), 5000, 'task');
      // Scroll the calendar so 14:00 is visible, then aim at it.
      await browser.execute((d) => {
        const el = document.querySelector(`[data-timeline-day="${d}"]`);
        const scroller = el?.closest('.overflow-y-auto');
        if (scroller && el) scroller.scrollTop = (el.getBoundingClientRect().height / 24) * 12;
      }, today);
      await browser.pause(200);
      const y = await browser.execute((d) => {
        const r = document.querySelector(`[data-timeline-day="${d}"]`).getBoundingClientRect();
        return Math.round(r.top + (r.height / 24) * 14 + 10);
      }, today);
      const c = await browser.execute((d) => {
        const r = document.querySelector(`[data-timeline-day="${d}"]`).getBoundingClientRect();
        return { x: r.left, width: r.width };
      }, today);
      await drag(browser, await card(browser, 'Drop me'), Math.round(c.x + c.width / 2), y);
      const blocks = await waitFor(
        browser,
        async () => {
          const rows = await sql(browser, 'SELECT * FROM time_blocks WHERE task_id = ?', [t.id]);
          return rows.length ? rows : null;
        },
        5000,
        'block from drop',
      );
      const local = await browser.execute(
        (iso) => new Date(iso).getHours() * 60 + new Date(iso).getMinutes(),
        blocks[0].start_utc,
      );
      assert(
        Math.abs(local - 14 * 60) <= 30,
        `block starts near 14:00, got ${Math.floor(local / 60)}:${local % 60}`,
      );
      assert(
        (Date.parse(blocks[0].end_utc) - Date.parse(blocks[0].start_utc)) / 60000 === 30,
        'uses estimate',
      );
      await screenshot(browser, '21-dnd-calendar');
    });

    await step('calendar: drag on empty time to create a local event', async () => {
      const y1 = await browser.execute((d) => {
        const r = document.querySelector(`[data-timeline-day="${d}"]`).getBoundingClientRect();
        return Math.round(r.top + (r.height / 24) * 16 + 2);
      }, today);
      const x = await browser.execute(
        (d) =>
          Math.round(
            document.querySelector(`[data-timeline-day="${d}"]`).getBoundingClientRect().left + 40,
          ),
        today,
      );
      await browser
        .action('pointer')
        .move({ x, y: y1 })
        .down()
        .move({ x, y: y1 + 50, duration: 200 })
        .up()
        .perform();
      const title = await browser.$('input[aria-label="Event title"]');
      await title.waitForDisplayed({ timeout: 5000 });
      await title.setValue('Dentist');
      await clickButton(browser, 'Add event');
      const ev = await waitFor(
        browser,
        async () =>
          (await sql(browser, "SELECT * FROM calendar_events WHERE title = 'Dentist'"))[0],
        5000,
        'event row',
      );
      const local = await browser.execute((iso) => new Date(iso).getHours(), ev.start_utc);
      assert(local === 16, `event at 16:00, got ${local}`);
    });

    await step('recurring task: capture, virtual occurrence, materialize on click', async () => {
      await capture(browser, 'Water plants every day 5m');
      const t = await waitFor(
        browser,
        () => task(browser, 'Water plants'),
        5000,
        'recurring instance',
      );
      assert(t.recurrence_id, 'linked to a series');
      const series = await sql(browser, 'SELECT * FROM recurrence_series WHERE id = ?', [
        t.recurrence_id,
      ]);
      assert(series[0].rrule === 'FREQ=DAILY', 'daily rule');
      const virtual = await browser.$(
        `//*[@role="button"][contains(@aria-label, "Water plants, repeats")]`,
      );
      await virtual.waitForDisplayed({ timeout: 5000 });
      await virtual.click();
      await waitFor(
        browser,
        async () =>
          (
            await sql(browser, 'SELECT count(*) AS n FROM tasks WHERE recurrence_id = ?', [
              t.recurrence_id,
            ])
          )[0].n === 2,
        5000,
        'materialized',
      );
      await (
        await browser.$('textarea[aria-label="Task title"]')
      ).waitForDisplayed({ timeout: 5000 });
      await screenshot(browser, '22-recurring');
      await browser.keys(['Escape']);
    });

    await step('bulk edit in the backlog with Ctrl+click', async () => {
      for (const t of ['Bulk one', 'Bulk two']) {
        await capture(browser, `${t} someday`);
        await waitFor(browser, () => task(browser, t), 5000, t);
      }
      await clickButton(browser, 'Backlog', { exact: false });
      await browser.execute(() => {
        for (const c of document.querySelectorAll('[data-task-card]')) {
          if (c.textContent?.includes('Bulk '))
            c.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        }
      });
      const bar = await browser.$('[role="toolbar"][aria-label="2 tasks selected"]');
      await bar.waitForDisplayed({ timeout: 5000 });
      await screenshot(browser, '23-bulk');
      await clickButton(browser, 'Priority');
      await (await browser.$('//*[@role="menuitem"][normalize-space()="High"]')).click();
      await waitFor(
        browser,
        async () =>
          (
            await sql(
              browser,
              "SELECT count(*) AS n FROM tasks WHERE title LIKE 'Bulk %' AND priority = 3",
            )
          )[0].n === 2,
        5000,
        'bulk priority',
      );
    });

    await step('ICS import (Outlook zone names) into a new calendar, idempotently', async () => {
      writeFileSync(join(dialogDir, 'import.ics'), IMPORT_ICS);
      await clickButton(browser, 'Calendars');
      for (let i = 0; i < 2; i++) {
        await clickButton(browser, 'Import .ics');
        await (
          await browser.$(
            '//*[contains(normalize-space(), "Found") and contains(normalize-space(), "2")]',
          )
        ).waitForDisplayed({ timeout: 5000 });
        if (i === 1) {
          const select = await browser.$('#imp-target');
          const value = await browser.execute(
            () =>
              [...document.querySelectorAll('#imp-target option')].find(
                (o) => o.textContent === 'Team calendar',
              )?.value,
          );
          await select.selectByAttribute('value', value);
        }
        await clickButton(browser, 'Import');
        await browser.pause(400);
      }
      const events = await sql(
        browser,
        "SELECT * FROM calendar_events WHERE title LIKE 'Imported %' ORDER BY title",
      );
      assert(events.length === 2, `imported without duplicates, got ${events.length}`);
      const weekly = events.find((e) => e.title === 'Imported weekly sync');
      assert(
        weekly.tz === 'Europe/Berlin' && weekly.start_utc === '2026-09-28T08:00:00.000Z',
        `Windows zone mapped, got ${weekly.tz} ${weekly.start_utc}`,
      );
      await screenshot(browser, '24-calendars');
    });

    await step('restore from an automatic backup brings back the earlier state', async () => {
      await clickButton(browser, 'Settings');
      await clickButton(browser, 'Data & privacy');
      await clickButton(browser, 'Create backup');
      await browser.pause(500);
      await capture(browser, 'Made after backup');
      await waitFor(browser, () => task(browser, 'Made after backup'), 5000, 'post-backup task');
      await clickButton(browser, 'Settings');
      await clickButton(browser, 'Data & privacy');
      const restore = await browser.$('(//button[normalize-space()="Restore"])[1]');
      await restore.waitForClickable({ timeout: 5000 });
      await restore.click();
      await (await browser.$('//*[@role="dialog"]//button[normalize-space()="Restore"]')).click();
      await browser.pause(1500);
      await waitFor(
        browser,
        () => browser.execute(() => !!window.__keel && window.__keel.getData().status === 'ready'),
        15000,
        'reloaded',
      );
      assert(!(await task(browser, 'Made after backup')), 'post-backup task gone after restore');
      assert(await task(browser, 'Bulk one'), 'pre-backup data present');
      const safety = readdirSync(join(dataDir, 'backups')).filter((f) => f.includes('pre-restore'));
      assert(safety.length >= 1, 'safety backup written before restore');
    });

    await step('delete all data wipes everything and returns to onboarding', async () => {
      await clickButton(browser, 'Settings');
      await clickButton(browser, 'Data & privacy');
      await clickButton(browser, 'Delete all data…');
      await (await browser.$('#del-confirm')).setValue('DELETE');
      await clickButton(browser, 'Delete everything');
      await browser.pause(1500);
      await waitFor(
        browser,
        () => browser.execute(() => !!window.__keel && window.__keel.getData().status === 'ready'),
        15000,
        'reloaded',
      );
      await (
        await browser.$('//h2[normalize-space()="Welcome to Keel"]')
      ).waitForDisplayed({ timeout: 10000 });
      const n = await sql(browser, 'SELECT count(*) AS n FROM tasks');
      assert(n[0].n === 0, 'no tasks remain');
      const backups = readdirSync(dataDir).includes('backups')
        ? readdirSync(join(dataDir, 'backups'))
        : [];
      assert(backups.length === 0, `backups removed, found ${backups.length}`);
    });
  } catch (e) {
    await screenshot(browser, 'failure-interactions').catch(() => undefined);
    await browser.deleteSession().catch(() => undefined);
    throw e;
  }
  await browser.deleteSession();
}
