/**
 * Email → task, entirely local. Keel parses saved email messages (.eml, RFC 5322 + MIME) and
 * turns each into an Inbox task. Nothing is fetched or sent, and no mail account is involved.
 * Classic Outlook's .msg files are read by msg.ts into the same shape.
 *
 * Supported: headers with RFC 2047 encoded words, multipart messages (text/plain preferred,
 * text/html converted to text), base64 and quoted-printable bodies, any charset the web view's
 * TextDecoder knows.
 */
import { DateTime } from 'luxon';

export interface ParsedEmail {
  subject: string;
  from: string;
  date: string | null;
  messageId: string | null;
  body: string;
}

type Headers = Map<string, string>;

const MAX_DEPTH = 8;

function splitMessage(raw: string): { headers: Headers; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : '';
  const headers: Headers = new Map();
  let current: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, `${headers.get(current)} ${line.trim()}`);
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    current = line.slice(0, idx).trim().toLowerCase();
    // First occurrence wins (Received: etc. repeat; the ones we read do not).
    if (!headers.has(current)) headers.set(current, line.slice(idx + 1).trim());
    else current = null;
  }
  return { headers, body };
}

/** Splits `type/sub; a=b; c="d"` into the value and its lower-cased parameters. */
export function headerParams(value: string): { value: string; params: Record<string, string> } {
  const [first, ...rest] = value.split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    let key = p.slice(0, idx).trim().toLowerCase();
    let v = p.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    // RFC 2231: name*=charset'lang'percent-encoded
    if (key.endsWith('*')) {
      key = key.slice(0, -1);
      const m = /^([^']*)'[^']*'(.*)$/.exec(v);
      if (m) v = decodeBytes(percentBytes(m[2]!), m[1]!);
    }
    params[key] = v;
  }
  return { value: (first ?? '').trim().toLowerCase(), params };
}

function utf8(s: string): number[] {
  return [...new TextEncoder().encode(s)];
}

function percentBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(...utf8(s[i]!));
  }
  return new Uint8Array(out);
}

export function decodeQuotedPrintable(s: string, header = false): Uint8Array {
  const out: number[] = [];
  const text = header ? s.replace(/_/g, ' ') : s.replace(/=\r?\n/g, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '=' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(...utf8(ch));
  }
  return new Uint8Array(out);
}

export function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
}

function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset || 'utf-8').trim().toLowerCase();
  try {
    return new TextDecoder(label === 'us-ascii' || label === 'ascii' ? 'utf-8' : label).decode(
      bytes,
    );
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Decodes RFC 2047 encoded words (`=?utf-8?B?...?=`), joining adjacent ones. */
export function decodeWords(s: string): string {
  return s
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?)/g, '$1')
    .replace(
      /=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g,
      (_, charset: string, enc: string, text: string) =>
        decodeBytes(
          enc.toUpperCase() === 'B' ? decodeBase64(text) : decodeQuotedPrintable(text, true),
          charset,
        ),
    );
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, code: string) => {
      const c = code.toLowerCase();
      if (c.startsWith('#x')) return String.fromCodePoint(parseInt(c.slice(2), 16));
      if (c.startsWith('#') && c !== '#39') return String.fromCodePoint(parseInt(c.slice(1), 10));
      return ENTITIES[c] ?? m;
    })
    .replace(/[ \t]+\n/g, '\n');
}

function decodePart(headers: Headers, body: string): string {
  const { params } = headerParams(headers.get('content-type') ?? 'text/plain');
  const encoding = (headers.get('content-transfer-encoding') ?? '7bit').trim().toLowerCase();
  if (encoding === 'base64') return decodeBytes(decodeBase64(body), params.charset);
  if (encoding === 'quoted-printable')
    return decodeBytes(decodeQuotedPrintable(body), params.charset);
  return body; // 7bit / 8bit / binary: already text
}

/** Returns the best readable text of a MIME entity: plain text first, then HTML. */
function extractText(
  headers: Headers,
  body: string,
  depth: number,
): { text: string; html: boolean } | null {
  const ct = headerParams(headers.get('content-type') ?? 'text/plain');
  const disposition = headerParams(headers.get('content-disposition') ?? '').value;
  if (disposition === 'attachment') return null;
  if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < MAX_DEPTH) {
    const parts = splitMultipart(body, ct.params.boundary).map((p) => splitMessage(p));
    const results = parts
      .map((p) => extractText(p.headers, p.body, depth + 1))
      .filter((r): r is { text: string; html: boolean } => !!r && !!r.text.trim());
    return results.find((r) => !r.html) ?? results[0] ?? null;
  }
  if (ct.value === 'text/plain' || ct.value === '')
    return { text: decodePart(headers, body), html: false };
  if (ct.value === 'text/html') return { text: htmlToText(decodePart(headers, body)), html: true };
  return null;
}

function splitMultipart(body: string, boundary: string): string[] {
  const parts: string[] = [];
  const lines = body.split(/\r?\n/);
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith(`--${boundary}`)) {
      if (current) parts.push(current.join('\n'));
      current = line.startsWith(`--${boundary}--`) ? null : [];
      if (!current) break;
      continue;
    }
    current?.push(line);
  }
  if (current?.length) parts.push(current.join('\n'));
  return parts;
}

export function parseEml(raw: string): ParsedEmail {
  const { headers, body } = splitMessage(raw.replace(/^\uFEFF/, ''));
  if (!headers.has('from') && !headers.has('subject') && !headers.has('date'))
    throw new Error('This file does not look like an email message (.eml)');
  const dateHeader = headers.get('date');
  const date = dateHeader ? DateTime.fromRFC2822(dateHeader.replace(/\s*\([^)]*\)\s*$/, '')) : null;
  const text = extractText(headers, body, 0)?.text ?? '';
  return {
    subject: decodeWords(headers.get('subject') ?? '').trim(),
    from: decodeWords(headers.get('from') ?? '').trim(),
    date: date?.isValid ? date.toUTC().toISO() : null,
    messageId: headers.get('message-id')?.trim() ?? null,
    body: text.replace(/\r\n/g, '\n'),
  };
}

/** Drops quoted history (reply chains) and signatures' excess whitespace. */
function trimBody(body: string, max: number): string {
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^On .{4,200} wrote:\s*$/.test(line)) break;
    if (/^From: .+/.test(line) && lines.length && /^_{8,}\s*$/.test(lines[lines.length - 1] ?? ''))
      break;
    if (line.startsWith('>')) continue;
    lines.push(line.trimEnd());
  }
  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^_{8,}\s*$/gm, '')
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** The task Keel creates for a message: subject as title, sender/date/body as notes. */
export function emailToTask(
  e: ParsedEmail,
  zone: string,
  maxBody = 4000,
): { title: string; notes: string } {
  const subject = e.subject.replace(/^((re|fwd?|fw|aw|wg|sv|vs)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
  const sender = e.from.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '') || e.from;
  const title = subject || (sender ? `Email from ${sender}` : 'Email');
  const meta = [
    e.from && `From: ${e.from}`,
    e.date && `Sent: ${DateTime.fromISO(e.date).setZone(zone).toFormat('ccc d LLL yyyy, HH:mm')}`,
    e.messageId && `Message-ID: ${e.messageId}`,
  ].filter(Boolean);
  const body = trimBody(e.body, maxBody);
  return { title, notes: [meta.join('\n'), body].filter(Boolean).join('\n\n') };
}
