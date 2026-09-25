// End-to-end: the opt-in integration path on the real binary, against a local mock host,
// plus the local email → task import.
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { icsFeed } from './mockProvider.mjs';
import { assert, clickButton, launch, screenshot, sql, step, waitFor } from './lib.mjs';

const SECRET_PATH = 'private-token-7f3a';

async function connectFeed(browser, mock, name) {
  await clickButton(browser, 'Integrations');
  const connect = await browser.$(
    '//span[normalize-space()="Calendar feed (iCal URL)"]/ancestor::div[.//button[normalize-space()="Connect…"]][1]//button[normalize-space()="Connect…"]',
  );
  await connect.waitForClickable({ timeout: 5000 });
  await connect.click();
  await (await browser.$('#int-label')).addValue(name);
  await (await browser.$('#int-url')).addValue(`${mock.base}/${SECRET_PATH}/${name}.ics`);
  await screenshot(browser, `29-connect-${name}`);
  await clickButton(browser, 'Connect');
  return waitFor(
    browser,
    async () =>
      (
        await sql(
          browser,
          "SELECT * FROM integration_accounts WHERE label = ? AND status = 'connected' AND last_sync_at IS NOT NULL",
          [name],
        )
      )[0],
    15000,
    `${name} connected`,
  );
}

async function feedEvents(browser, accountId) {
  return sql(
    browser,
    'SELECT e.title FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id WHERE c.account_id = ? ORDER BY e.title',
    [accountId],
  );
}

async function dumpDatabase(browser) {
  const tables = await sql(browser, "SELECT name FROM sqlite_master WHERE type = 'table'");
  let text = '';
  for (const { name } of tables)
    text += JSON.stringify(await sql(browser, `SELECT * FROM "${name}"`));
  return text;
}

export async function integrations({ application, dialogDir, secretDir, mock }) {
  const browser = await launch(application);
  try {
    let account;
    await step(
      'integrations: subscribe to a calendar feed; its address stays out of the database',
      async () => {
        mock.setFeed(
          icsFeed([{ uid: 'f1', title: 'Feed holiday', date: '20261225', end: '20261226' }]),
        );
        account = await connectFeed(browser, mock, 'Holidays');
        const titles = (await feedEvents(browser, account.id)).map((e) => e.title);
        assert(titles.join() === 'Feed holiday', `feed events imported, got ${titles}`);
        assert(
          mock.requests.some((r) => r.url.includes(SECRET_PATH)),
          'the app fetched the feed from the mock host',
        );
        const secretFile = join(secretDir, `integration_${account.id}`);
        assert(existsSync(secretFile), 'address stored by the credential store');
        assert(readFileSync(secretFile, 'utf8').includes(SECRET_PATH), 'secret holds the address');
        assert(!(await dumpDatabase(browser)).includes(SECRET_PATH), 'address not in SQLite');
        await (
          await browser.$(
            '//section[contains(@aria-label, "Holidays")]//*[normalize-space()="Connected"]',
          )
        ).waitForDisplayed({ timeout: 5000 });
        await screenshot(browser, '30-integrations');
      },
    );

    await step(
      'integrations: Sync now picks up feed changes; disconnect removes the copy and the credential',
      async () => {
        mock.setFeed(
          icsFeed([
            { uid: 'f1', title: 'Feed holiday', date: '20261225', end: '20261226' },
            { uid: 'f2', title: 'Feed new year', date: '20270101', end: '20270102' },
          ]),
        );
        const section = '//section[contains(@aria-label, "Holidays")]';
        await (await browser.$(`${section}//button[normalize-space()="Sync now"]`)).click();
        await waitFor(
          browser,
          async () => (await feedEvents(browser, account.id)).length === 2,
          10000,
          'second feed event',
        );
        await (await browser.$(`${section}//button[normalize-space()="Disconnect"]`)).click();
        await (
          await browser.$('//*[@role="dialog"]//button[normalize-space()="Disconnect"]')
        ).click();
        await waitFor(
          browser,
          async () =>
            (await sql(browser, 'SELECT id FROM integration_accounts WHERE id = ?', [account.id]))
              .length === 0,
          10000,
          'account removed',
        );
        assert((await feedEvents(browser, account.id)).length === 0, 'local copy removed');
        assert(
          !existsSync(join(secretDir, `integration_${account.id}`)),
          'credential deleted from the store',
        );
      },
    );

    await step(
      'email → task: import a saved .eml (legacy 8-bit charset) into the Inbox',
      async () => {
        const eml = Buffer.concat([
          Buffer.from(
            [
              'From: Dana Lee <dana@example.com>',
              'Subject: Fwd: Quarterly numbers',
              'Date: Tue, 22 Sep 2026 10:15:00 +0000',
              'Message-ID: <e2e-1@example.com>',
              'Content-Type: text/plain; charset=ISO-8859-1',
              'Content-Transfer-Encoding: 8bit',
              '',
              'Please check the caf',
            ].join('\r\n'),
          ),
          Buffer.from([0xe9]),
          Buffer.from(' budget before Friday.\r\n'),
        ]);
        writeFileSync(join(dialogDir, 'import.ics'), eml); // the E2E "picked" file
        await clickButton(browser, 'Integrations');
        await clickButton(browser, 'Import email…');
        const task = await waitFor(
          browser,
          async () =>
            (await sql(browser, "SELECT * FROM tasks WHERE title = 'Quarterly numbers'"))[0],
          10000,
          'email task',
        );
        assert(task.source === 'email', 'source recorded');
        assert(task.notes.includes('From: Dana Lee <dana@example.com>'), 'sender in notes');
        assert(task.notes.includes('budget before Friday.'), `body in notes: ${task.notes}`);
        assert(!task.project_id && !task.area_id, 'lands in the Inbox');
      },
    );

    await step('email → task: import a classic Outlook .msg into the Inbox', async () => {
      copyFileSync(
        new URL('./fixtures/outlook-sample.msg', import.meta.url),
        join(dialogDir, 'import.ics'),
      );
      await clickButton(browser, 'Integrations');
      await clickButton(browser, 'Import email…');
      const task = await waitFor(
        browser,
        async () =>
          (await sql(browser, "SELECT * FROM tasks WHERE title = 'Vendor contract renewal'"))[0],
        10000,
        '.msg task',
      );
      assert(task.source === 'email', 'source recorded');
      assert(task.notes.includes('From: Sam Ortiz <sam@example.com>'), `sender: ${task.notes}`);
      assert(task.notes.includes('Please sign the renewal by the 30th.'), 'body');
      assert(task.notes.includes('<renewal-7@example.com>'), 'message id');
    });

    await step(
      'integrations: an account left connected for the “Delete all data” check',
      async () => {
        mock.setFeed(
          icsFeed([{ uid: 'k1', title: 'Kept event', date: '20261201', end: '20261202' }]),
        );
        await connectFeed(browser, mock, 'Kept');
        assert(readdirSync(secretDir).length === 1, 'one credential stored');
      },
    );
  } catch (e) {
    await screenshot(browser, 'failure-integrations').catch(() => undefined);
    await browser.deleteSession().catch(() => undefined);
    throw e;
  }
  await browser.deleteSession();
}
