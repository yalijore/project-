import { describe, expect, it } from 'vitest';
import { decodeWords, emailToTask, htmlToText, parseEml } from './email';

const crlf = (lines: string[]) => lines.join('\r\n');

describe('email parsing', () => {
  it('decodes encoded-word headers, quoted-printable bodies and RFC 2822 dates', () => {
    const e = parseEml(
      crlf([
        'Received: from mx.example.com',
        'From: =?UTF-8?B?SsO8cmdlbiBNw7xsbGVy?= <jm@example.com>',
        'To: me@example.com',
        'Subject: =?utf-8?Q?Caf=C3=A9_budget?=',
        ' =?utf-8?Q?_for_Q4?=',
        'Date: Tue, 22 Sep 2026 10:15:00 +0200 (CEST)',
        'Message-ID: <abc123@example.com>',
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Hi, can you review the caf=C3=A9 numbers before Friday? This line is so=',
        'ft-wrapped.',
      ]),
    );
    expect(e.from).toBe('Jürgen Müller <jm@example.com>');
    expect(e.subject).toBe('Café budget for Q4');
    expect(e.date).toBe('2026-09-22T08:15:00.000Z');
    expect(e.messageId).toBe('<abc123@example.com>');
    expect(e.body).toContain('café numbers before Friday? This line is soft-wrapped.');
  });

  it('prefers the plain-text alternative and skips attachments', () => {
    const e = parseEml(
      crlf([
        'From: a@example.com',
        'Subject: Report',
        'Content-Type: multipart/mixed; boundary="outer"',
        '',
        'preamble',
        '--outer',
        'Content-Type: multipart/alternative; boundary=inner',
        '',
        '--inner',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>HTML version</p>',
        '--inner',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        'UGxhaW4gdmVyc2lvbg==',
        '--inner--',
        '--outer',
        'Content-Type: text/plain; name="notes.txt"',
        'Content-Disposition: attachment; filename="notes.txt"',
        '',
        'attachment text',
        '--outer--',
      ]),
    );
    expect(e.body.trim()).toBe('Plain version');
  });

  it('converts HTML-only mail in legacy charsets to text', () => {
    const html =
      '<html><head><style>p{}</style></head><body><p>Pr&eacute;&nbsp;check &amp; <b>sign</b></p><ul><li>One</li><li>Two</li></ul></body></html>';
    // "é" in ISO-8859-1 is 0xE9.
    const latin1 = btoa(html.replace('&eacute;', 'é'));
    const e = parseEml(
      crlf([
        'From: b@example.com',
        'Subject: Checklist',
        'Content-Type: text/html; charset=ISO-8859-1',
        'Content-Transfer-Encoding: base64',
        '',
        latin1,
      ]),
    );
    expect(e.body).toContain('Pré check & sign');
    expect(e.body).toContain('• One');
    expect(e.body).not.toContain('p{}');
  });

  it('handles RFC 2231 parameters and bare LF line endings', () => {
    const e = parseEml(
      [
        'From: c@example.com',
        'Subject: Plain',
        "Content-Type: text/plain; charset*=utf-8''utf-8",
        '',
        'Body',
      ].join('\n'),
    );
    expect(e.body).toBe('Body');
    expect(decodeWords('=?iso-8859-1?q?M=FCnchen?=')).toBe('München');
    expect(htmlToText('a&#x2014;b&#8212;c')).toBe('a—b—c');
  });

  it('rejects files that are not email messages', () => {
    expect(() => parseEml('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toThrow(
      /does not look like an email/,
    );
  });
});

describe('email → task', () => {
  it('uses the subject without reply prefixes and keeps sender, date and body (without quoted history)', () => {
    const task = emailToTask(
      {
        subject: 'RE: Fwd: Contract renewal',
        from: '"Dana Lee" <dana@example.com>',
        date: '2026-09-22T08:15:00.000Z',
        messageId: '<m1@example.com>',
        body: 'Please sign by Oct 1.\n\n\n\nThanks\n\nOn Mon, 21 Sep 2026 Sam wrote:\n> old stuff',
      },
      'America/New_York',
    );
    expect(task.title).toBe('Contract renewal');
    expect(task.notes).toBe(
      'From: "Dana Lee" <dana@example.com>\nSent: Tue 22 Sep 2026, 04:15\nMessage-ID: <m1@example.com>\n\nPlease sign by Oct 1.\n\nThanks',
    );
  });

  it('falls back to the sender when there is no subject and truncates long bodies', () => {
    const task = emailToTask(
      {
        subject: '',
        from: 'Ops <ops@example.com>',
        date: null,
        messageId: null,
        body: 'x'.repeat(50),
      },
      'UTC',
      10,
    );
    expect(task.title).toBe('Email from Ops');
    expect(task.notes.endsWith('xxxxxxxxxx…')).toBe(true);
  });
});
