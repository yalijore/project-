/**
 * Outlook .msg files (classic Outlook's "Save as"), read locally. A .msg is an OLE compound
 * file ([MS-CFB]) whose streams hold MAPI properties ([MS-OXMSG]). Keel reads only what an
 * Inbox task needs: subject, sender, sent time, Message-ID and the plain-text (or HTML) body.
 * Attachments and embedded messages are ignored. No dependencies, no network.
 */
import { DateTime } from 'luxon';
import type { ParsedEmail } from './email';
import { htmlToText } from './email';

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const NO_STREAM = 0xffffffff;
const MAX_SECTORS = 1 << 20; // guards against loops in damaged files

export function isMsgFile(bytes: Uint8Array): boolean {
  return bytes.length >= 512 && SIGNATURE.every((b, i) => bytes[i] === b);
}

interface DirEntry {
  name: string;
  type: number; // 1 storage, 2 stream, 5 root
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

const damaged = (why: string) => new Error(`This .msg file is damaged (${why}).`);

/** A minimal, read-only compound-file reader. */
export class CompoundFile {
  private view: DataView;
  private sectorSize: number;
  private miniSectorSize: number;
  private miniCutoff: number;
  private fat: number[] = [];
  private miniFat: number[] = [];
  private entries: DirEntry[] = [];
  private miniStream: Uint8Array = new Uint8Array();

  constructor(private bytes: Uint8Array) {
    if (!isMsgFile(bytes)) throw new Error('This file is not an Outlook message (.msg).');
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.sectorSize = 1 << this.u16(0x1e);
    this.miniSectorSize = 1 << this.u16(0x20);
    this.miniCutoff = this.u32(0x38);
    if (this.sectorSize !== 512 && this.sectorSize !== 4096) throw damaged('sector size');
    this.readFat();
    const dir = this.concat(this.chain(this.u32(0x30), this.fat).map((s) => this.sector(s)));
    for (let off = 0; off + 128 <= dir.length; off += 128) this.entries.push(this.entry(dir, off));
    const root = this.entries[0];
    if (!root || root.type !== 5) throw damaged('no root entry');
    this.miniStream = this.readRegular(root.start, root.size);
    const miniFatStart = this.u32(0x3c);
    if (miniFatStart !== END_OF_CHAIN && miniFatStart !== FREE)
      this.miniFat = this.words(
        this.concat(this.chain(miniFatStart, this.fat).map((s) => this.sector(s))),
      );
  }

  private u16(off: number) {
    return this.view.getUint16(off, true);
  }
  private u32(off: number) {
    return this.view.getUint32(off, true);
  }

  private sector(n: number): Uint8Array {
    const start = (n + 1) * this.sectorSize;
    if (start >= this.bytes.length) throw damaged('sector out of range');
    return this.bytes.subarray(start, Math.min(start + this.sectorSize, this.bytes.length));
  }

  private words(raw: Uint8Array): number[] {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const out: number[] = [];
    for (let i = 0; i + 4 <= raw.length; i += 4) out.push(dv.getUint32(i, true));
    return out;
  }

  private concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /** Sector numbers of a chain, following `table` until END_OF_CHAIN. */
  private chain(start: number, table: number[]): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let s = start; s !== END_OF_CHAIN; s = table[s] ?? END_OF_CHAIN) {
      if (s === FREE || s >= table.length || seen.has(s) || out.length > MAX_SECTORS)
        throw damaged('broken sector chain');
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  private readFat() {
    // DIFAT: the first 109 FAT sector numbers are in the header, the rest in DIFAT sectors.
    const fatSectors: number[] = [];
    for (let i = 0; i < 109; i++) {
      const s = this.u32(0x4c + i * 4);
      if (s !== FREE && s !== END_OF_CHAIN) fatSectors.push(s);
    }
    const perSector = this.sectorSize / 4 - 1;
    let difat = this.u32(0x44);
    for (let n = 0; difat !== END_OF_CHAIN && difat !== FREE; n++) {
      if (n > MAX_SECTORS) throw damaged('DIFAT loop');
      const words = this.words(this.sector(difat));
      for (let i = 0; i < perSector; i++) {
        const s = words[i]!;
        if (s !== FREE && s !== END_OF_CHAIN) fatSectors.push(s);
      }
      difat = words[perSector]!;
    }
    for (const s of fatSectors) this.fat.push(...this.words(this.sector(s)));
  }

  private entry(dir: Uint8Array, off: number): DirEntry {
    const dv = new DataView(dir.buffer, dir.byteOffset + off, 128);
    const nameLen = Math.min(64, dv.getUint16(0x40, true));
    const name = new TextDecoder('utf-16le').decode(
      dir.subarray(off, off + Math.max(0, nameLen - 2)),
    );
    return {
      name,
      type: dv.getUint8(0x42),
      left: dv.getUint32(0x44, true),
      right: dv.getUint32(0x48, true),
      child: dv.getUint32(0x4c, true),
      start: dv.getUint32(0x74, true),
      size: dv.getUint32(0x78, true), // high 32 bits are zero for files this size
    };
  }

  private readRegular(start: number, size: number): Uint8Array {
    if (size === 0) return new Uint8Array();
    return this.concat(this.chain(start, this.fat).map((s) => this.sector(s))).subarray(0, size);
  }

  private readMini(start: number, size: number): Uint8Array {
    if (size === 0) return new Uint8Array();
    const u = this.miniSectorSize;
    const parts = this.chain(start, this.miniFat).map((s) => {
      if ((s + 1) * u > this.miniStream.length) throw damaged('mini sector out of range');
      return this.miniStream.subarray(s * u, (s + 1) * u);
    });
    return this.concat(parts).subarray(0, size);
  }

  /** Streams directly inside the root storage, keyed by lower-case name. */
  rootStreams(): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    const stack = [this.entries[0]!.child];
    const visited = new Set<number>();
    while (stack.length) {
      const i = stack.pop()!;
      if (i === NO_STREAM || visited.has(i) || !this.entries[i]) continue;
      visited.add(i);
      const e = this.entries[i]!;
      if (e.type === 2) {
        const data =
          e.size < this.miniCutoff
            ? this.readMini(e.start, e.size)
            : this.readRegular(e.start, e.size);
        out.set(e.name.toLowerCase(), data);
      }
      stack.push(e.left, e.right); // siblings in the same storage; children are not followed
    }
    return out;
  }
}

// MAPI property ids ([MS-OXPROPS]) and types.
const PR = {
  subject: 0x0037,
  sentRepresentingName: 0x0042,
  sentRepresentingEmail: 0x0065,
  transportHeaders: 0x007d,
  senderName: 0x0c1a,
  senderEmail: 0x0c1f,
  senderSmtp: 0x5d01,
  body: 0x1000,
  html: 0x1013,
  messageId: 0x1035,
  clientSubmitTime: 0x0039,
  deliveryTime: 0x0e06,
  codepage: 0x3ffd,
  internetCodepage: 0x3fde,
};
const PT_STRING8 = 0x001e;
const PT_UNICODE = 0x001f;
const PT_BINARY = 0x0102;
const PT_LONG = 0x0003;
const PT_SYSTIME = 0x0040;

const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');

/** Windows code page number → a TextDecoder label. */
function codepageLabel(cp: number | undefined): string {
  if (!cp) return 'windows-1252';
  if (cp === 65001) return 'utf-8';
  if (cp === 20127) return 'us-ascii';
  if (cp === 28591) return 'iso-8859-1';
  if (cp === 932) return 'shift_jis';
  if (cp === 936) return 'gbk';
  if (cp === 949) return 'euc-kr';
  if (cp === 950) return 'big5';
  return `windows-${cp}`;
}

function decodeText(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

const trimNul = (s: string) => s.replace(/\0+$/, '');

export function parseMsg(bytes: Uint8Array): ParsedEmail {
  const cfb = new CompoundFile(bytes);
  const streams = cfb.rootStreams();

  // Fixed-size properties: 32-byte header for a top-level message, then 16-byte entries.
  const fixed = new Map<number, DataView>();
  const props = streams.get('__properties_version1.0');
  if (props) {
    for (let off = 32; off + 16 <= props.length; off += 16) {
      const dv = new DataView(props.buffer, props.byteOffset + off, 16);
      const tag = dv.getUint32(0, true);
      fixed.set(tag, dv);
    }
  }
  const long = (id: number) => fixed.get(((id << 16) | PT_LONG) >>> 0)?.getUint32(8, true);
  const time = (id: number): string | null => {
    const dv = fixed.get(((id << 16) | PT_SYSTIME) >>> 0);
    if (!dv) return null;
    const ticks = dv.getBigUint64(8, true); // 100 ns since 1601-01-01
    if (ticks === 0n) return null;
    const ms = Number(ticks / 10_000n) - 11_644_473_600_000;
    return new Date(ms).toISOString();
  };
  const label = codepageLabel(long(PR.internetCodepage) ?? long(PR.codepage));
  const text = (id: number): string => {
    const uni = streams.get(`__substg1.0_${hex(id, 4)}${hex(PT_UNICODE, 4)}`.toLowerCase());
    if (uni) return trimNul(new TextDecoder('utf-16le').decode(uni));
    const ansi = streams.get(`__substg1.0_${hex(id, 4)}${hex(PT_STRING8, 4)}`.toLowerCase());
    return ansi ? trimNul(decodeText(ansi, label)) : '';
  };
  const binary = (id: number) =>
    streams.get(`__substg1.0_${hex(id, 4)}${hex(PT_BINARY, 4)}`.toLowerCase());

  const headers = text(PR.transportHeaders);
  const header = (name: string) => {
    const m = new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, 'im').exec(headers);
    return m ? m[1]!.replace(/\r?\n[ \t]+/g, ' ').trim() : null;
  };

  const name = text(PR.senderName) || text(PR.sentRepresentingName);
  const smtp = text(PR.senderSmtp);
  const email =
    smtp ||
    [text(PR.senderEmail), text(PR.sentRepresentingEmail)].find((e) => e.includes('@')) ||
    '';
  const from =
    name && email && name !== email ? `${name} <${email}>` : name || email || header('From') || '';

  let body = text(PR.body);
  if (!body.trim()) {
    const html = binary(PR.html);
    if (html) body = htmlToText(decodeText(html, label));
  }

  const headerDate = header('Date');
  const parsedHeaderDate = headerDate
    ? DateTime.fromRFC2822(headerDate.replace(/\s*\([^)]*\)\s*$/, ''))
    : null;
  return {
    subject: text(PR.subject).trim(),
    from,
    date:
      time(PR.clientSubmitTime) ??
      (parsedHeaderDate?.isValid ? parsedHeaderDate.toUTC().toISO() : null) ??
      time(PR.deliveryTime),
    messageId: text(PR.messageId) || header('Message-ID'),
    body: body.replace(/\r\n/g, '\n'),
  };
}
