import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { writeMsg } from '@/test/msgWriter';
import { emailToTask } from './email';
import { isMsgFile, parseMsg } from './msg';

const latin1 = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

describe('Outlook .msg import', () => {
  it('reads a Unicode message: subject, SMTP sender, sent time, Message-ID and a long body', () => {
    const body = `Please review the Q4 numbers before Friday.\r\n${'Detail line. '.repeat(600)}`;
    const bytes = writeMsg([
      { id: 0x0037, unicode: 'RE: Q4 budget — café offsite' },
      { id: 0x0c1a, unicode: 'Dana Lee' },
      {
        id: 0x0c1f,
        unicode: '/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=DANA',
      },
      { id: 0x5d01, unicode: 'dana@example.com' },
      { id: 0x1000, unicode: body }, // > 4 KiB: stored outside the mini stream
      { id: 0x1035, unicode: '<m-42@example.com>' },
      { id: 0x0039, time: '2026-09-22T08:15:00.000Z' },
    ]);
    expect(isMsgFile(bytes)).toBe(true);
    const e = parseMsg(bytes);
    expect(e).toMatchObject({
      subject: 'RE: Q4 budget — café offsite',
      from: 'Dana Lee <dana@example.com>', // SMTP address, not the Exchange DN
      date: '2026-09-22T08:15:00.000Z',
      messageId: '<m-42@example.com>',
    });
    expect(e.body.startsWith('Please review the Q4 numbers before Friday.\n')).toBe(true);
    expect(e.body.length).toBe(body.length - 1); // CRLF normalised
    expect(emailToTask(e, 'UTC').title).toBe('Q4 budget — café offsite');
  });

  it('reads 8-bit strings in the message code page and falls back to the HTML body', () => {
    const e = parseMsg(
      writeMsg([
        { id: 0x0037, ansi: latin1('Café menu') },
        { id: 0x0042, ansi: latin1('René') },
        { id: 0x0065, ansi: latin1('rene@example.com') },
        { id: 0x3ffd, long: 1252 },
        { id: 0x1013, binary: latin1('<p>Menü for <b>Friday</b></p><p>Thanks</p>') },
        {
          id: 0x007d,
          unicode:
            'Received: by mx\r\nDate: Tue, 22 Sep 2026 10:15:00 +0200\r\nMessage-ID: <h@example.com>\r\n',
        },
      ]),
    );
    expect(e).toMatchObject({
      subject: 'Café menu',
      from: 'René <rene@example.com>',
      date: '2026-09-22T08:15:00.000Z', // from the transport headers
      messageId: '<h@example.com>',
    });
    expect(e.body).toContain('Menü for Friday');
  });

  it('the end-to-end fixture is exactly what the test writer produces', () => {
    // e2e/fixtures/outlook-sample.msg: written by writeMsg (no real mailbox data).
    const fixture = new Uint8Array(
      readFileSync(new URL('../../e2e/fixtures/outlook-sample.msg', import.meta.url)),
    );
    const expected = writeMsg([
      { id: 0x0037, unicode: 'FW: Vendor contract renewal' },
      { id: 0x0c1a, unicode: 'Sam Ortiz' },
      { id: 0x5d01, unicode: 'sam@example.com' },
      { id: 0x1000, unicode: 'Please sign the renewal by the 30th.\r\nThanks, Sam' },
      { id: 0x1035, unicode: '<renewal-7@example.com>' },
      { id: 0x0039, time: '2026-09-23T13:30:00.000Z' },
    ]);
    expect(fixture).toEqual(expected);
    expect(parseMsg(fixture)).toMatchObject({
      subject: 'FW: Vendor contract renewal',
      from: 'Sam Ortiz <sam@example.com>',
      date: '2026-09-23T13:30:00.000Z',
      messageId: '<renewal-7@example.com>',
    });
  });

  it('rejects other files and fails cleanly on damaged ones', () => {
    expect(isMsgFile(new TextEncoder().encode('From: a@example.com\r\n\r\nhi'))).toBe(false);
    expect(() => parseMsg(new Uint8Array(600))).toThrow(/not an Outlook message/);
    const good = writeMsg([{ id: 0x0037, unicode: 'x' }]);
    expect(() => parseMsg(good.subarray(0, 700))).toThrow(/damaged/);
  });
});
