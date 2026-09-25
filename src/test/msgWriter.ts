/**
 * Test-only writer for minimal Outlook .msg files ([MS-CFB] v3, 512-byte sectors), so the
 * .msg reader can be tested on messages with known contents. Its output was checked with an
 * independent reader (Python's olefile) when it was written.
 */
const FREE = 0xffffffff;
const END = 0xfffffffe;
const FAT_SECT = 0xfffffffd;
const NONE = 0xffffffff;
const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;

export type MsgProp =
  | { id: number; unicode: string }
  | { id: number; ansi: Uint8Array }
  | { id: number; binary: Uint8Array }
  | { id: number; long: number }
  | { id: number; time: string };

const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');

function utf16(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    out[i * 2] = s.charCodeAt(i) & 0xff;
    out[i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  return out;
}

/** Top-level streams of a .msg for the given properties. */
export function msgStreams(props: MsgProp[]): { name: string; data: Uint8Array }[] {
  const streams: { name: string; data: Uint8Array }[] = [];
  const fixed: Uint8Array[] = [];
  for (const p of props) {
    if ('unicode' in p)
      streams.push({ name: `__substg1.0_${hex(p.id, 4)}001F`, data: utf16(`${p.unicode}\0`) });
    else if ('ansi' in p) streams.push({ name: `__substg1.0_${hex(p.id, 4)}001E`, data: p.ansi });
    else if ('binary' in p)
      streams.push({ name: `__substg1.0_${hex(p.id, 4)}0102`, data: p.binary });
    else {
      const e = new Uint8Array(16);
      const dv = new DataView(e.buffer);
      if ('long' in p) {
        dv.setUint32(0, ((p.id << 16) | 0x0003) >>> 0, true);
        dv.setUint32(8, p.long, true);
      } else {
        dv.setUint32(0, ((p.id << 16) | 0x0040) >>> 0, true);
        const ticks = BigInt(Date.parse(p.time) + 11_644_473_600_000) * 10_000n;
        dv.setBigUint64(8, ticks, true);
      }
      dv.setUint32(4, 0x6, true); // readable, writable
      fixed.push(e);
    }
  }
  const header = new Uint8Array(32);
  const propStream = new Uint8Array(32 + fixed.length * 16);
  propStream.set(header, 0);
  fixed.forEach((e, i) => propStream.set(e, 32 + i * 16));
  streams.push({ name: '__properties_version1.0', data: propStream });
  return streams;
}

/** CFB sibling order: shorter names first, then case-insensitive comparison. */
function cfbCompare(a: string, b: string) {
  return a.length - b.length || (a.toUpperCase() < b.toUpperCase() ? -1 : 1);
}

export function writeCompoundFile(streams: { name: string; data: Uint8Array }[]): Uint8Array {
  const sorted = [...streams].sort((a, b) => cfbCompare(a.name, b.name));
  const small = sorted.filter((s) => s.data.length < CUTOFF);
  const large = sorted.filter((s) => s.data.length >= CUTOFF);

  // Mini stream: small streams packed in 64-byte mini sectors.
  const miniStarts = new Map<string, number>();
  const miniFat: number[] = [];
  let miniCount = 0;
  for (const s of small) {
    const n = Math.max(1, Math.ceil(s.data.length / MINI));
    miniStarts.set(s.name, s.data.length ? miniCount : END);
    for (let i = 0; i < n; i++) miniFat.push(i === n - 1 ? END : miniCount + i + 1);
    miniCount += n;
  }
  const miniStreamBytes = miniCount * MINI;

  const sectorsFor = (bytes: number) => Math.ceil(bytes / SECTOR);
  const dirSectors = sectorsFor((sorted.length + 1) * 128);
  const miniFatSectors = sectorsFor(miniFat.length * 4);
  const miniStreamSectors = sectorsFor(miniStreamBytes);
  const largeSectors = large.map((s) => sectorsFor(s.data.length));
  const dataSectors =
    dirSectors + miniFatSectors + miniStreamSectors + largeSectors.reduce((a, b) => a + b, 0);
  let fatSectors = 1;
  while (fatSectors * (SECTOR / 4) < dataSectors + fatSectors) fatSectors++;
  if (fatSectors > 109) throw new Error('test writer: file too large');

  const fat = new Array<number>(fatSectors * (SECTOR / 4)).fill(FREE);
  let next = 0;
  const alloc = (count: number): number => {
    if (count === 0) return END;
    const start = next;
    for (let i = 0; i < count; i++) fat[start + i] = i === count - 1 ? END : start + i + 1;
    next += count;
    return start;
  };
  for (let i = 0; i < fatSectors; i++) fat[next++] = FAT_SECT;
  const dirStart = alloc(dirSectors);
  const miniFatStart = alloc(miniFatSectors);
  const miniStreamStart = alloc(miniStreamSectors);
  const largeStarts = largeSectors.map((n) => alloc(n));

  const out = new Uint8Array((1 + next) * SECTOR);
  const dv = new DataView(out.buffer);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  dv.setUint16(0x18, 0x003e, true);
  dv.setUint16(0x1a, 3, true);
  dv.setUint16(0x1c, 0xfffe, true);
  dv.setUint16(0x1e, 9, true);
  dv.setUint16(0x20, 6, true);
  dv.setUint32(0x2c, fatSectors, true);
  dv.setUint32(0x30, dirStart, true);
  dv.setUint32(0x38, CUTOFF, true);
  dv.setUint32(0x3c, miniFatSectors ? miniFatStart : END, true);
  dv.setUint32(0x40, miniFatSectors, true);
  dv.setUint32(0x44, END, true);
  for (let i = 0; i < 109; i++) dv.setUint32(0x4c + i * 4, i < fatSectors ? i : FREE, true);

  const sectorOffset = (n: number) => (n + 1) * SECTOR;
  fat.forEach((v, i) => dv.setUint32(sectorOffset(0) + i * 4, v, true));

  // Directory: root, then the streams as a right-leaning chain of siblings.
  const dirOff = sectorOffset(dirStart);
  const entry = (
    i: number,
    name: string,
    type: number,
    child: number,
    right: number,
    start: number,
    size: number,
  ) => {
    const o = dirOff + i * 128;
    out.set(utf16(`${name}\0`).subarray(0, 64), o);
    dv.setUint16(o + 0x40, (name.length + 1) * 2, true);
    dv.setUint8(o + 0x42, type);
    dv.setUint8(o + 0x43, 1); // black
    dv.setUint32(o + 0x44, NONE, true);
    dv.setUint32(o + 0x48, right, true);
    dv.setUint32(o + 0x4c, child, true);
    dv.setUint32(o + 0x74, start, true);
    dv.setUint32(o + 0x78, size, true);
  };
  entry(
    0,
    'Root Entry',
    5,
    sorted.length ? 1 : NONE,
    NONE,
    miniCount ? miniStreamStart : END,
    miniStreamBytes,
  );
  sorted.forEach((s, i) => {
    const start = s.data.length < CUTOFF ? miniStarts.get(s.name)! : largeStarts[large.indexOf(s)]!;
    entry(i + 1, s.name, 2, NONE, i + 1 < sorted.length ? i + 2 : NONE, start, s.data.length);
  });
  for (let i = sorted.length + 1; i < dirSectors * 4; i++) {
    const o = dirOff + i * 128;
    dv.setUint32(o + 0x44, NONE, true);
    dv.setUint32(o + 0x48, NONE, true);
    dv.setUint32(o + 0x4c, NONE, true);
  }

  miniFat.forEach((v, i) => dv.setUint32(sectorOffset(miniFatStart) + i * 4, v, true));
  for (const s of small) {
    const start = miniStarts.get(s.name)!;
    if (start !== END) out.set(s.data, sectorOffset(miniStreamStart) + start * MINI);
  }
  large.forEach((s, i) => out.set(s.data, sectorOffset(largeStarts[i]!)));
  return out;
}

export function writeMsg(props: MsgProp[]): Uint8Array {
  return writeCompoundFile(msgStreams(props));
}
