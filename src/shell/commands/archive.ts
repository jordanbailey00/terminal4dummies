// Archiving and compression programs: tar, gzip, gunzip, zcat, zip, unzip.
//
// Archives are binary files (BlobData) whose payload describes what is inside
// them: { format: 'tar' | 'gzip' | 'bzip2' | 'xz' | 'zip', ... }. The sizes
// shown by `ls -l`, `gzip -v` and `unzip -v` come from a model of the real
// on-disk formats plus an estimate of what zlib's DEFLATE would produce, so
// the numbers learners see are close to what a real Ubuntu machine prints.
//
// Binary data cannot travel through the simulator's text pipes directly, so
// when a program writes an archive to standard output it is encoded as a
// tagged string (see ../vfs/binstream); every program here decodes it again.

import type { CommandContext } from '../types';
import { asBinary, encodeBinaryStream, isTruncatedStream } from '../vfs/binstream';
import { FsError, dataSize, dataToText, type BlobData, type FileData, type Inode } from '../vfs/fs';
import { basename, dirname } from '../vfs/path';
import { patternToRegExp } from '../glob';
import { DAYS, MONTHS, OptError, defineCommand, errText, gnuHelp, pad2, parseOpts, type CommandDef } from './util';

// ===========================================================================
// Payload formats

export interface TarEntry {
  /** Member name as stored (directories end with "/"). */
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'chardev';
  mode: number;
  uid: number;
  gid: number;
  uname: string;
  gname: string;
  /** Modification time in ms. */
  mtime: number;
  /** Size of the file content (0 for everything else). */
  size: number;
  /** File content: text, or binary data (a program, an image, another archive...). */
  data?: FileData;
  /** Symlink target, or the member a hard link points to. */
  target?: string;
  /** Character device kind (/dev/null...). */
  device?: string;
}

export interface TarPayload {
  format: 'tar';
  entries: TarEntry[];
}

export interface CompressedPayload {
  format: 'gzip' | 'bzip2' | 'xz';
  /** Original file name stored in the gzip header (absent for data from a pipe). */
  name?: string;
  /** Original modification time stored in the header (0 when absent). */
  mtime?: number;
  level?: number;
  /** The uncompressed data. */
  data: FileData;
}

export interface ZipEntry {
  /** Name as stored (directories end with "/"). */
  name: string;
  kind: 'file' | 'dir' | 'symlink';
  mode: number;
  mtime: number;
  /** Uncompressed and compressed sizes. */
  size: number;
  csize: number;
  method: 'store' | 'deflate';
  crc: number;
  /** File content, or the target of a symlink. */
  data?: FileData;
}

export interface ZipPayload {
  format: 'zip';
  entries: ZipEntry[];
}

export type ArchivePayload = TarPayload | CompressedPayload | ZipPayload;

export const TAR_DESCRIPTION = 'POSIX tar archive (GNU)';

/** The archive payload of some file data, if it is one of ours. */
export function archivePayload(data: FileData | undefined): ArchivePayload | null {
  if (!data || typeof data === 'string' || data.kind !== 'blob') return null;
  const p = data.payload as { format?: unknown } | null;
  if (!p || typeof p !== 'object') return null;
  if (p.format === 'tar' || p.format === 'gzip' || p.format === 'bzip2' || p.format === 'xz' || p.format === 'zip') return p as ArchivePayload;
  return null;
}

// ===========================================================================
// Bytes, CRC-32 and a DEFLATE size model

const encoder = new TextEncoder();

function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** CRC-32 of file content (binary content gets a stable pseudo value). */
function contentCrc(data: FileData | undefined): number {
  if (data === undefined) return 0;
  if (typeof data === 'string') return data === '' ? 0 : crc32(utf8(data));
  const seed = data.kind === 'native' ? 'native:' + data.command : data.description + ':' + data.size;
  return crc32(utf8(seed));
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_CODE = (() => {
  const t = new Uint8Array(259);
  for (let c = 0; c < 29; c++) {
    const end = c === 28 ? 259 : LEN_BASE[c + 1];
    for (let l = LEN_BASE[c]; l < end && l < 259; l++) t[l] = c;
  }
  t[258] = 28;
  return t;
})();

function distCode(d: number): number {
  let lo = 0;
  let hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Huffman code lengths for the given symbol frequencies. */
function huffmanLengths(freq: number[]): number[] {
  const lens = new Array<number>(freq.length).fill(0);
  type HNode = { f: number; sym: number; l: number; r: number };
  const nodes: HNode[] = [];
  const heap: number[] = [];
  const less = (a: number, b: number) => nodes[a].f < nodes[b].f;
  const push = (x: number) => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] > 0) {
      nodes.push({ f: freq[i], sym: i, l: -1, r: -1 });
      push(nodes.length - 1);
    }
  }
  if (heap.length === 0) return lens;
  if (heap.length === 1) {
    lens[nodes[heap[0]].sym] = 1;
    return lens;
  }
  while (heap.length > 1) {
    const a = pop();
    const b = pop();
    nodes.push({ f: nodes[a].f + nodes[b].f, sym: -1, l: a, r: b });
    push(nodes.length - 1);
  }
  const stack: [number, number][] = [[heap[0], 0]];
  while (stack.length) {
    const [idx, depth] = stack.pop()!;
    const nd = nodes[idx];
    if (nd.sym >= 0) lens[nd.sym] = Math.min(15, Math.max(1, depth));
    else {
      stack.push([nd.l, depth + 1]);
      stack.push([nd.r, depth + 1]);
    }
  }
  return lens;
}

interface BlockStats {
  lit: number[];
  dist: number[];
  extraBits: number;
  bytes: number;
}

/** Bits needed for one deflate block: the cheapest of stored, fixed and dynamic Huffman. */
function blockBits(s: BlockStats): number {
  const stored = (s.bytes + 5) * 8;
  let fixed = 3 + s.extraBits;
  for (let i = 0; i < 286; i++) {
    const f = s.lit[i];
    if (f) fixed += f * (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8);
  }
  for (let i = 0; i < 30; i++) fixed += s.dist[i] * 5;
  const ll = huffmanLengths(s.lit);
  const dl = huffmanLengths(s.dist);
  let dyn = 3 + 14 + 42 + 20 + s.extraBits;
  for (let i = 0; i < 286; i++) if (s.lit[i]) dyn += s.lit[i] * ll[i] + 4;
  for (let i = 0; i < 30; i++) if (s.dist[i]) dyn += s.dist[i] * dl[i] + 4;
  return Math.min(stored, fixed, dyn);
}

const LEVELS: Record<number, { good: number; lazy: number; nice: number; chain: number }> = {
  1: { good: 4, lazy: 4, nice: 8, chain: 4 },
  2: { good: 4, lazy: 5, nice: 16, chain: 8 },
  3: { good: 4, lazy: 6, nice: 32, chain: 32 },
  4: { good: 4, lazy: 4, nice: 16, chain: 16 },
  5: { good: 8, lazy: 16, nice: 32, chain: 32 },
  6: { good: 8, lazy: 16, nice: 128, chain: 128 },
  7: { good: 8, lazy: 32, nice: 128, chain: 256 },
  8: { good: 32, lazy: 128, nice: 258, chain: 1024 },
  9: { good: 32, lazy: 258, nice: 258, chain: 4096 },
};

const SAMPLE_LIMIT = 1 << 20;

/**
 * Size in bytes of the raw DEFLATE stream zlib would produce for `data` at
 * the given level. This runs zlib's LZ77 match finder and costs the result
 * with Huffman code lengths; it lands within a percent or two of real gzip.
 */
export function deflateSize(data: Uint8Array, level = 6): number {
  if (data.length > SAMPLE_LIMIT * 2) {
    // Big inputs: measure the first megabyte and extrapolate.
    const head = deflateSize(data.subarray(0, SAMPLE_LIMIT), level);
    return Math.round(head * (data.length / SAMPLE_LIMIT));
  }
  const cfg = LEVELS[Math.min(9, Math.max(1, Math.round(level)))];
  const n = data.length;
  if (n === 0) return 2;
  const WSIZE = 32768;
  const HSIZE = 1 << 15;
  const MAX_DIST = WSIZE - 262;
  const head = new Int32Array(HSIZE).fill(-1);
  const prev = new Int32Array(WSIZE).fill(-1);
  let total = 0;
  const newBlock = (): BlockStats => ({ lit: new Array(286).fill(0), dist: new Array(30).fill(0), extraBits: 0, bytes: 0 });
  let blk = newBlock();
  let syms = 0;
  const flush = () => {
    blk.lit[256]++;
    total += blockBits(blk);
    blk = newBlock();
    syms = 0;
  };
  const emitLit = (b: number) => {
    blk.lit[b]++;
    blk.bytes++;
    if (++syms >= 16383) flush();
  };
  const emitMatch = (len: number, dist: number) => {
    const lc = LEN_CODE[len];
    blk.lit[257 + lc]++;
    blk.extraBits += LEN_EXTRA[lc];
    const dc = distCode(dist);
    blk.dist[dc]++;
    blk.extraBits += DIST_EXTRA[dc];
    blk.bytes += len;
    if (++syms >= 16383) flush();
  };
  const insert = (i: number): number => {
    if (i + 2 >= n) return -1;
    const h = ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HSIZE - 1);
    const old = head[h];
    prev[i & (WSIZE - 1)] = old;
    head[h] = i;
    return old;
  };
  let matchStart = 0;
  const longest = (i: number, cand: number, prevLen: number): number => {
    let best = prevLen;
    let chain = prevLen >= cfg.good ? cfg.chain >> 2 : cfg.chain;
    const limit = i > MAX_DIST ? i - MAX_DIST : 0;
    const maxLen = Math.min(258, n - i);
    while (cand >= limit && chain-- > 0) {
      if (data[cand + best] === data[i + best] && data[cand] === data[i] && data[cand + 1] === data[i + 1]) {
        let l = 2;
        while (l < maxLen && data[cand + l] === data[i + l]) l++;
        if (l > best) {
          best = l;
          matchStart = cand;
          if (l >= cfg.nice || l >= maxLen) break;
        }
      }
      const nx = prev[cand & (WSIZE - 1)];
      if (nx < 0 || nx >= cand) break;
      cand = nx;
    }
    return Math.min(best, maxLen);
  };
  let pos = 0;
  if (level < 4) {
    while (pos < n) {
      const hh = insert(pos);
      let ml = 2;
      if (hh >= 0 && pos - hh <= MAX_DIST) ml = longest(pos, hh, 2);
      if (ml >= 3) {
        emitMatch(ml, pos - matchStart);
        if (ml <= cfg.lazy) for (let k = 1; k < ml; k++) insert(pos + k);
        pos += ml;
      } else {
        emitLit(data[pos]);
        pos++;
      }
    }
  } else {
    let available = false;
    let matchLength = 2;
    let curStart = 0;
    while (pos < n) {
      const hh = insert(pos);
      const prevLength = matchLength;
      const prevMatch = curStart;
      matchLength = 2;
      if (hh >= 0 && prevLength < cfg.lazy && pos - hh <= MAX_DIST) {
        const l = longest(pos, hh, prevLength);
        if (l > prevLength) {
          matchLength = l;
          curStart = matchStart;
          if (matchLength === 3 && pos - curStart > 4096) matchLength = 2;
        } else {
          matchLength = 2;
        }
      }
      if (prevLength >= 3 && matchLength <= prevLength) {
        emitMatch(prevLength, pos - 1 - prevMatch);
        for (let k = 1; k <= prevLength - 2; k++) insert(pos + k);
        pos += prevLength - 1;
        available = false;
        matchLength = 2;
      } else if (available) {
        emitLit(data[pos - 1]);
        pos++;
      } else {
        available = true;
        pos++;
      }
    }
    if (available) emitLit(data[pos - 1]);
  }
  flush();
  return Math.ceil(total / 8);
}

const INCOMPRESSIBLE = /^(gzip|bzip2|XZ|Zip archive|Zstandard|JPEG|PNG|GIF|RIFF|Ogg|ISO Media|WebM|Audio file|MPEG|Matroska|7-zip|RAR|Debian binary package|data$)/i;

/** Estimated DEFLATE size of any file content. */
function contentDeflated(data: FileData | undefined, level: number): number {
  if (data === undefined) return 2;
  if (typeof data === 'string') return deflateSize(utf8(data), level);
  if (data.kind === 'native') return Math.max(2, Math.round(data.size * 0.42));
  const p = archivePayload(data);
  if (p && p.format === 'tar') return tarDeflated(p.entries, level);
  if (INCOMPRESSIBLE.test(data.description)) return data.size + 5 * Math.ceil(Math.max(1, data.size) / 16383);
  if (/^ELF/.test(data.description)) return Math.round(data.size * 0.42);
  if (/^PDF/.test(data.description)) return Math.round(data.size * 0.9);
  return Math.max(2, Math.round(data.size * 0.6));
}

// ===========================================================================
// tar format model

const TYPEFLAG: Record<TarEntry['type'], number> = { file: 48, hardlink: 49, symlink: 50, chardev: 51, dir: 53 };

function octalField(n: number, digits: number): string {
  return Math.max(0, Math.floor(n)).toString(8).padStart(digits, '0').slice(-digits);
}

/** Bytes of the 512-byte header block(s) GNU tar writes for an entry. */
function tarHeaderBlocks(e: TarEntry): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  const nameBytes = utf8(e.name);
  const targetBytes = utf8(e.target ?? '');
  const longLink = (bytes: Uint8Array, flag: number) => {
    const h = new Uint8Array(512);
    h.set(utf8('././@LongLink'), 0);
    h.set(utf8('0000644'), 100);
    h.set(utf8('0000000'), 108);
    h.set(utf8('0000000'), 116);
    h.set(utf8(octalField(bytes.length + 1, 11)), 124);
    h.set(utf8('00000000000'), 136);
    h[156] = flag;
    h.set(utf8('ustar  '), 257);
    h.set(utf8('root'), 265);
    h.set(utf8('root'), 297);
    blocks.push(h);
    const data = new Uint8Array(Math.ceil((bytes.length + 1) / 512) * 512);
    data.set(bytes);
    blocks.push(data);
  };
  if (nameBytes.length > 100) longLink(nameBytes, 76);
  if (targetBytes.length > 100) longLink(targetBytes, 75);
  const h = new Uint8Array(512);
  h.set(nameBytes.subarray(0, 100), 0);
  h.set(utf8(octalField(e.mode & 0o7777, 7)), 100);
  h.set(utf8(octalField(e.uid, 7)), 108);
  h.set(utf8(octalField(e.gid, 7)), 116);
  h.set(utf8(octalField(e.type === 'file' ? e.size : 0, 11)), 124);
  h.set(utf8(octalField(e.mtime / 1000, 11)), 136);
  h.fill(32, 148, 156);
  h[156] = TYPEFLAG[e.type];
  h.set(targetBytes.subarray(0, 100), 157);
  h.set(utf8('ustar  '), 257);
  h.set(utf8(e.uname).subarray(0, 31), 265);
  h.set(utf8(e.gname).subarray(0, 31), 297);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.set(utf8(octalField(sum, 6)), 148);
  h[154] = 0;
  blocks.push(h);
  return blocks;
}

function headerBlockCount(e: TarEntry): number {
  let n = 1;
  const nl = utf8(e.name).length;
  if (nl > 100) n += 1 + Math.ceil((nl + 1) / 512);
  const tl = e.target ? utf8(e.target).length : 0;
  if (tl > 100) n += 1 + Math.ceil((tl + 1) / 512);
  return n;
}

/** Size of a tar file: headers, content padded to 512 bytes, two zero blocks, rounded up to 10 KiB records. */
export function tarSize(entries: TarEntry[]): number {
  let blocks = 2;
  for (const e of entries) {
    blocks += headerBlockCount(e);
    if (e.type === 'file') blocks += Math.ceil(e.size / 512);
  }
  return Math.ceil((blocks * 512) / 10240) * 10240;
}

/** DEFLATE size of a tar stream, built from real header bytes and file contents. */
function tarDeflated(entries: TarEntry[], level: number): number {
  const CAP = 3 * 1024 * 1024;
  const parts: Uint8Array[] = [];
  let len = 0;
  let skipped = 0;
  let extra = 0;
  for (const e of entries) {
    for (const b of tarHeaderBlocks(e)) {
      parts.push(b);
      len += b.length;
    }
    if (e.type !== 'file' || e.size === 0) continue;
    const pad = (512 - (e.size % 512)) % 512;
    if (typeof e.data === 'string') {
      if (len < CAP) {
        const bytes = utf8(e.data);
        parts.push(bytes);
        len += bytes.length;
      } else {
        skipped += e.size;
      }
    } else {
      extra += contentDeflated(e.data, level);
    }
    if (pad) {
      parts.push(new Uint8Array(pad));
      len += pad;
    }
  }
  const total = tarSize(entries);
  const tail = Math.max(1024, total - len - skipped - entries.reduce((n, e) => n + (e.type === 'file' && typeof e.data !== 'string' ? e.size : 0), 0));
  parts.push(new Uint8Array(Math.min(tail, 20480)));
  len += Math.min(tail, 20480);
  const buf = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  const est = deflateSize(buf, level);
  const ratio = len > 0 ? est / len : 1;
  return est + Math.round(skipped * ratio) + extra;
}

export function makeTarBlob(entries: TarEntry[]): BlobData {
  const payload: TarPayload = { format: 'tar', entries };
  return { kind: 'blob', description: TAR_DESCRIPTION, payload, size: tarSize(entries) };
}

// ===========================================================================
// gzip / bzip2 / xz

function asctimeUtc(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** Bytes in a gzip header + trailer. */
function gzipOverhead(name: string | undefined): number {
  return 10 + (name ? utf8(name).length + 1 : 0) + 8;
}

/** Compress data into a gzip, bzip2 or xz blob. */
export function makeCompressedBlob(format: CompressedPayload['format'], data: FileData, opts: { name?: string; mtime?: number; level?: number } = {}): BlobData {
  const level = opts.level ?? (format === 'gzip' ? 6 : 9);
  const deflated = contentDeflated(data, Math.min(9, level));
  const payload: CompressedPayload = { format, data, level };
  if (format === 'gzip') {
    if (opts.name) payload.name = opts.name;
    if (opts.mtime) payload.mtime = opts.mtime;
    let desc = 'gzip compressed data';
    if (opts.name) desc += `, was "${opts.name}"`;
    if (opts.mtime) desc += `, last modified: ${asctimeUtc(opts.mtime)}`;
    if (level === 9) desc += ', max compression';
    else if (level === 1) desc += ', max speed';
    desc += `, from Unix, original size modulo 2^32 ${dataSize(data) % 4294967296}`;
    return { kind: 'blob', description: desc, payload, size: gzipOverhead(opts.name) + deflated };
  }
  if (format === 'bzip2') {
    return { kind: 'blob', description: 'bzip2 compressed data, block size = 900k', payload, size: Math.round(deflated * 0.92) + 38 };
  }
  return { kind: 'blob', description: 'XZ compressed data, checksum CRC64', payload, size: Math.round(deflated * 0.9) + 56 };
}

// ===========================================================================
// Binary data through text streams (encoding lives in ../vfs/binstream)

export { asBinary, decodeBinaryStream, encodeBinaryStream } from '../vfs/binstream';

/** Write data to standard output: text as is, binary data encoded (a redirected file stores it as binary again). */
export async function writeDataToStdout(ctx: CommandContext, data: FileData): Promise<void> {
  if (typeof data === 'string') {
    await ctx.out(data);
    return;
  }
  await ctx.out(ctx.stdout.isTTY ? dataToText(data) : encodeBinaryStream(data));
}

/** Read all of standard input as file data. */
async function readStdinData(ctx: CommandContext): Promise<FileData> {
  return asBinary(await ctx.stdin.readAll());
}

/** Total length of the text stored inside an archive (guards against runaway nesting). */
function payloadTextBytes(data: FileData | undefined, depth = 0): number {
  if (data === undefined || depth > 20) return 0;
  if (typeof data === 'string') return data.length;
  const p = archivePayload(data);
  if (!p) return 0;
  if (p.format === 'tar') return p.entries.reduce((n, e) => n + payloadTextBytes(e.data, depth + 1) + e.name.length, 0);
  if (p.format === 'zip') return p.entries.reduce((n, e) => n + payloadTextBytes(e.data, depth + 1) + e.name.length, 0);
  return payloadTextBytes(p.data, depth + 1);
}

function checkArchiveSpace(ctx: CommandContext, blob: BlobData, path: string): void {
  if (payloadTextBytes(blob) > ctx.system.fs.quota) throw new FsError('ENOSPC', path);
}

// ===========================================================================
// Small helpers

function permString(typeChar: string, mode: number): string {
  const rwx = (shift: number, special: number, ch: string) => {
    const r = mode & (4 << shift) ? 'r' : '-';
    const w = mode & (2 << shift) ? 'w' : '-';
    const xb = mode & (1 << shift);
    let x = xb ? 'x' : '-';
    if (mode & special) x = xb ? ch : ch.toUpperCase();
    return r + w + x;
  };
  return typeChar + rwx(6, 0o4000, 's') + rwx(3, 0o2000, 's') + rwx(0, 0o1000, 't');
}

function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function joinPath(dir: string, name: string): string {
  if (dir === '' || dir === '.') return name;
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

/** gzip's "%5.1f%%" ratio. */
function ratioText(saved: number, of: number): string {
  const v = of === 0 ? 0 : (100 * saved) / of;
  return (v.toFixed(1) + '%').padStart(6);
}

/** Glob match where * and ? also match "/" (tar and zip member patterns). */
function wildMatch(pattern: string, text: string): boolean {
  try {
    return patternToRegExp(pattern).test(text);
  } catch {
    return pattern === text;
  }
}

function hasWildcards(s: string): boolean {
  return /[*?[]/.test(s);
}

async function writeErrLines(ctx: CommandContext, lines: string[]): Promise<void> {
  if (lines.length) await ctx.err(lines.map((l) => l + '\n').join(''));
}

// ===========================================================================
// tar

interface TarOptDef {
  key: string;
  arg?: 'required' | 'optional';
  positional?: boolean;
}

const TAR_SHORT: Record<string, TarOptDef> = {
  A: { key: 'catenate' }, c: { key: 'create' }, d: { key: 'diff' }, r: { key: 'append' }, t: { key: 'list' }, u: { key: 'update' }, x: { key: 'extract' },
  f: { key: 'file', arg: 'required' }, C: { key: 'directory', arg: 'required', positional: true },
  z: { key: 'gzip' }, j: { key: 'bzip2' }, J: { key: 'xz' }, a: { key: 'auto-compress' }, Z: { key: 'compress' },
  v: { key: 'verbose' }, k: { key: 'keep-old-files' }, O: { key: 'to-stdout' }, p: { key: 'preserve-permissions' },
  P: { key: 'absolute-names' }, h: { key: 'dereference' }, m: { key: 'touch' }, o: { key: 'no-same-owner' },
  T: { key: 'files-from', arg: 'required' }, X: { key: 'exclude-from', arg: 'required' },
  w: { key: 'interactive' }, W: { key: 'verify' }, B: { key: 'read-full-records' }, l: { key: 'check-links' }, M: { key: 'multi-volume' },
  s: { key: 'same-order' }, S: { key: 'sparse' }, U: { key: 'unlink-first' }, i: { key: 'ignore-zeros' }, G: { key: 'incremental' },
  R: { key: 'block-number' }, n: { key: 'seek' },
  b: { key: 'blocking-factor', arg: 'required' }, g: { key: 'listed-incremental', arg: 'required' }, K: { key: 'starting-file', arg: 'required' },
  N: { key: 'newer', arg: 'required' }, L: { key: 'tape-length', arg: 'required' }, V: { key: 'label', arg: 'required' },
  F: { key: 'info-script', arg: 'required' }, H: { key: 'format', arg: 'required' }, I: { key: 'use-compress-program', arg: 'required' },
};

const TAR_LONG: Record<string, TarOptDef> = {
  create: { key: 'create' }, extract: { key: 'extract' }, get: { key: 'extract' }, list: { key: 'list' }, append: { key: 'append' },
  update: { key: 'update' }, diff: { key: 'diff' }, compare: { key: 'diff' }, catenate: { key: 'catenate' }, concatenate: { key: 'catenate' },
  delete: { key: 'delete' }, 'test-label': { key: 'test-label' },
  file: { key: 'file', arg: 'required' }, directory: { key: 'directory', arg: 'required', positional: true },
  gzip: { key: 'gzip' }, gunzip: { key: 'gzip' }, ungzip: { key: 'gzip' }, bzip2: { key: 'bzip2' }, xz: { key: 'xz' },
  'auto-compress': { key: 'auto-compress' }, compress: { key: 'compress' }, uncompress: { key: 'compress' },
  verbose: { key: 'verbose' }, 'keep-old-files': { key: 'keep-old-files' }, 'skip-old-files': { key: 'skip-old-files' },
  overwrite: { key: 'overwrite' }, 'overwrite-dir': { key: 'overwrite-dir' }, 'keep-newer-files': { key: 'keep-newer-files' },
  'to-stdout': { key: 'to-stdout' }, 'preserve-permissions': { key: 'preserve-permissions' }, 'same-permissions': { key: 'preserve-permissions' },
  'no-same-permissions': { key: 'no-same-permissions' }, 'same-owner': { key: 'same-owner' }, 'no-same-owner': { key: 'no-same-owner' },
  'numeric-owner': { key: 'numeric-owner' }, 'absolute-names': { key: 'absolute-names' }, dereference: { key: 'dereference' },
  touch: { key: 'touch' }, 'files-from': { key: 'files-from', arg: 'required' }, 'exclude-from': { key: 'exclude-from', arg: 'required' },
  exclude: { key: 'exclude', arg: 'required', positional: true }, 'strip-components': { key: 'strip-components', arg: 'required' },
  wildcards: { key: 'wildcards', positional: true }, 'no-wildcards': { key: 'no-wildcards', positional: true },
  anchored: { key: 'anchored', positional: true }, 'no-anchored': { key: 'no-anchored', positional: true },
  'ignore-case': { key: 'ignore-case', positional: true }, 'no-ignore-case': { key: 'no-ignore-case', positional: true },
  totals: { key: 'totals', arg: 'optional' }, 'remove-files': { key: 'remove-files' }, 'one-file-system': { key: 'one-file-system' },
  'exclude-vcs': { key: 'exclude-vcs', positional: true }, 'exclude-backups': { key: 'exclude-backups', positional: true },
  recursion: { key: 'recursion', positional: true }, 'no-recursion': { key: 'no-recursion', positional: true },
  sort: { key: 'sort', arg: 'required' }, owner: { key: 'owner', arg: 'required' }, group: { key: 'group', arg: 'required' },
  mode: { key: 'mode', arg: 'required' }, mtime: { key: 'mtime', arg: 'required' }, 'show-defaults': { key: 'show-defaults' },
  usage: { key: 'usage' }, help: { key: 'help' }, version: { key: 'version' }, 'unlink-first': { key: 'unlink-first' },
  'recursive-unlink': { key: 'recursive-unlink' }, warning: { key: 'warning', arg: 'required' }, checkpoint: { key: 'checkpoint', arg: 'optional' },
  'checkpoint-action': { key: 'checkpoint-action', arg: 'required' }, 'blocking-factor': { key: 'blocking-factor', arg: 'required' },
  'record-size': { key: 'record-size', arg: 'required' }, format: { key: 'format', arg: 'required' }, posix: { key: 'posix' },
  'old-archive': { key: 'old-archive' }, label: { key: 'label', arg: 'required' }, interactive: { key: 'interactive' },
  confirmation: { key: 'interactive' }, verify: { key: 'verify' }, 'check-links': { key: 'check-links' }, sparse: { key: 'sparse' },
  transform: { key: 'transform', arg: 'required' }, xform: { key: 'transform', arg: 'required' }, 'ignore-failed-read': { key: 'ignore-failed-read' },
  'ignore-zeros': { key: 'ignore-zeros' }, null: { key: 'null' }, 'show-transformed-names': { key: 'show-transformed-names' },
  'force-local': { key: 'force-local' }, utc: { key: 'utc' }, 'full-time': { key: 'full-time' }, 'no-overwrite-dir': { key: 'no-overwrite-dir' },
};

const TAR_ARG_LETTERS = new Set(Object.entries(TAR_SHORT).filter(([, d]) => d.arg).map(([k]) => k));
const TAR_MODES = new Set(['catenate', 'create', 'diff', 'append', 'list', 'update', 'extract', 'delete', 'test-label']);

class TarUsage extends Error {}
class TarFatal extends Error {
  readonly lines: string[];
  constructor(...lines: string[]) {
    super(lines.join('\n'));
    this.lines = lines;
  }
}

interface TarItem {
  kind: 'opt' | 'operand';
  key: string;
  value: string | true;
  /** How the option was written (for "has no effect" warnings). */
  spelling: string;
  positional?: boolean;
}

/** Parse tar's argument vector: old-style bundles, short clusters, long options. */
function tarTokenize(args: string[]): TarItem[] {
  const items: TarItem[] = [];
  let rest = [...args];
  if (rest.length > 0 && rest[0] !== '' && !rest[0].startsWith('-')) {
    // Traditional syntax: "tar cvf archive.tar dir" — letters take arguments in order.
    const bundle = rest[0];
    const pending: string[] = rest.slice(1);
    const expanded: string[] = [];
    for (const c of bundle) {
      if (!TAR_SHORT[c]) throw new TarUsage(`invalid option -- '${c}'`);
      expanded.push('-' + c);
      if (TAR_ARG_LETTERS.has(c)) {
        if (pending.length === 0) throw new TarUsage(`Old option '${c}' requires an argument.`);
        expanded.push(pending.shift()!);
      }
    }
    rest = [...expanded, ...pending];
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      for (const op of rest.slice(i + 1)) items.push({ kind: 'operand', key: '', value: op, spelling: op });
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let def = TAR_LONG[name];
      let full = name;
      if (!def) {
        const matches = Object.keys(TAR_LONG).filter((k) => k.startsWith(name));
        const distinct = [...new Set(matches.map((m) => TAR_LONG[m].key))];
        if (matches.length === 0 || name === '') throw new TarUsage(`unrecognized option '${eq === -1 ? a : a.slice(0, eq)}'`);
        if (distinct.length > 1) throw new TarUsage(`option '${a}' is ambiguous; possibilities:${matches.map((m) => ` '--${m}'`).join('')}`);
        full = matches[0];
        def = TAR_LONG[full];
      }
      if (!def.arg) {
        if (eq !== -1) throw new TarUsage(`option '--${full}' doesn't allow an argument`);
        items.push({ kind: 'opt', key: def.key, value: true, spelling: `--${full}`, positional: def.positional });
      } else if (def.arg === 'optional') {
        items.push({ kind: 'opt', key: def.key, value: eq === -1 ? true : a.slice(eq + 1), spelling: `--${full}`, positional: def.positional });
      } else if (eq !== -1) {
        items.push({ kind: 'opt', key: def.key, value: a.slice(eq + 1), spelling: `--${full}`, positional: def.positional });
      } else if (i + 1 < rest.length) {
        items.push({ kind: 'opt', key: def.key, value: rest[++i], spelling: `--${full}`, positional: def.positional });
      } else {
        throw new TarUsage(`option '--${full}' requires an argument`);
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        const def = TAR_SHORT[c];
        if (!def) throw new TarUsage(`invalid option -- '${c}'`);
        if (!def.arg) {
          items.push({ kind: 'opt', key: def.key, value: true, spelling: `-${c}`, positional: def.positional });
          continue;
        }
        const tail = a.slice(j + 1);
        if (tail !== '') items.push({ kind: 'opt', key: def.key, value: tail, spelling: `-${c}`, positional: def.positional });
        else if (i + 1 < rest.length) items.push({ kind: 'opt', key: def.key, value: rest[++i], spelling: `-${c}`, positional: def.positional });
        else throw new TarUsage(`option requires an argument -- '${c}'`);
        break;
      }
      continue;
    }
    items.push({ kind: 'operand', key: '', value: a, spelling: a });
  }
  return items;
}

interface TarOperand {
  name: string;
  /** -C directory in effect for this operand (create mode). */
  dir: string | null;
  excludes: string[];
}

interface TarOptions {
  mode: string;
  archive: string;
  compress: CompressedPayload['format'] | null;
  autoCompress: boolean;
  verbose: number;
  directory: string | null;
  operands: TarOperand[];
  excludes: string[];
  keepOld: boolean;
  skipOld: boolean;
  toStdout: boolean;
  preserve: boolean;
  sameOwner: boolean | null;
  numericOwner: boolean;
  absolute: boolean;
  dereference: boolean;
  touch: boolean;
  strip: number;
  wildcards: boolean;
  totals: boolean;
  removeFiles: boolean;
  recursion: boolean;
  noEffect: string[];
  filesFrom: string[];
  excludeFrom: string[];
}

const TAR_TRY = "Try 'tar --help' or 'tar --usage' for more information.";

function tarOptions(ctx: CommandContext, items: TarItem[]): TarOptions {
  const o: TarOptions = {
    mode: '',
    archive: ctx.env.get('TAPE') || '-',
    compress: null,
    autoCompress: false,
    verbose: 0,
    directory: null,
    operands: [],
    excludes: [],
    keepOld: false,
    skipOld: false,
    toStdout: false,
    preserve: ctx.creds.uid === 0,
    sameOwner: null,
    numericOwner: false,
    absolute: false,
    dereference: false,
    touch: false,
    strip: 0,
    wildcards: false,
    totals: false,
    removeFiles: false,
    recursion: true,
    noEffect: [],
    filesFrom: [],
    excludeFrom: [],
  };
  let lastOperand = -1;
  items.forEach((it, i) => {
    if (it.kind === 'operand') lastOperand = i;
  });
  let curDir: string | null = null;
  let curExcludes: string[] = [];
  const setCompress = (c: CompressedPayload['format']) => {
    if (o.compress && o.compress !== c) throw new TarUsage('Conflicting compression options');
    o.compress = c;
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'operand') {
      o.operands.push({ name: it.value as string, dir: curDir, excludes: [...curExcludes] });
      continue;
    }
    const v = it.value;
    if (TAR_MODES.has(it.key)) {
      if (o.mode && o.mode !== it.key) throw new TarUsage("You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option");
      o.mode = it.key;
      continue;
    }
    if (it.positional && i > lastOperand && lastOperand >= 0) {
      o.noEffect.push(typeof v === 'string' ? `${it.spelling} ‘${v}’` : it.spelling);
    }
    switch (it.key) {
      case 'file': o.archive = v as string; break;
      case 'directory': curDir = v as string; o.directory = v as string; break;
      case 'gzip': setCompress('gzip'); break;
      case 'bzip2': setCompress('bzip2'); break;
      case 'xz': setCompress('xz'); break;
      case 'compress': throw new TarFatal('tar (child): compress: Cannot exec: No such file or directory', 'tar (child): Error is not recoverable: exiting now');
      case 'auto-compress': o.autoCompress = true; break;
      case 'verbose': o.verbose++; break;
      case 'keep-old-files': o.keepOld = true; break;
      case 'skip-old-files': o.skipOld = true; break;
      case 'overwrite': o.keepOld = false; o.skipOld = false; break;
      case 'to-stdout': o.toStdout = true; break;
      case 'preserve-permissions': o.preserve = true; break;
      case 'no-same-permissions': o.preserve = false; break;
      case 'same-owner': o.sameOwner = true; break;
      case 'no-same-owner': o.sameOwner = false; break;
      case 'numeric-owner': o.numericOwner = true; break;
      case 'absolute-names': o.absolute = true; break;
      case 'dereference': o.dereference = true; break;
      case 'touch': o.touch = true; break;
      case 'files-from': o.filesFrom.push(v as string); break;
      case 'exclude-from': o.excludeFrom.push(v as string); break;
      case 'exclude':
        curExcludes = [...curExcludes, v as string];
        o.excludes.push(v as string);
        break;
      case 'exclude-vcs':
        for (const p of ['.git', '.svn', '.hg', 'CVS', '.bzr']) {
          curExcludes = [...curExcludes, p];
          o.excludes.push(p);
        }
        break;
      case 'strip-components': {
        const n = Number(v);
        if (!/^\d+$/.test(String(v))) throw new TarUsage(`Invalid number of elements: ‘${v}’`);
        o.strip = n;
        break;
      }
      case 'wildcards': o.wildcards = true; break;
      case 'no-wildcards': o.wildcards = false; break;
      case 'totals': o.totals = true; break;
      case 'remove-files': o.removeFiles = true; break;
      case 'recursion': o.recursion = true; break;
      case 'no-recursion': o.recursion = false; break;
      default: break;
    }
  }
  return o;
}

interface TarRun {
  ctx: CommandContext;
  o: TarOptions;
  status: number;
  warnedPrefixes: Set<string>;
  ugswidth: { v: number };
  /** Where -v listings go (stderr when the archive itself goes to stdout). */
  listTo: 'out' | 'err';
}

async function tarWarn(run: TarRun, msg: string): Promise<void> {
  await run.ctx.err(`tar: ${msg}\n`);
}

async function tarError(run: TarRun, msg: string): Promise<void> {
  run.status = 2;
  await run.ctx.err(`tar: ${msg}\n`);
}

async function tarList(run: TarRun, line: string): Promise<void> {
  if (run.listTo === 'err') await run.ctx.err(line + '\n');
  else await run.ctx.out(line + '\n');
}

/** GNU tar's safer_name_suffix: strip leading "/" and anything up to a ".." component. */
async function saferName(run: TarRun, name: string, linkTarget = false): Promise<string> {
  if (run.o.absolute) return name;
  let prefixLen = 0;
  let p = 0;
  while (p < name.length) {
    if (name[p] === '.' && name[p + 1] === '.' && (name[p + 2] === '/' || p + 2 === name.length)) prefixLen = p + 2;
    while (p < name.length) {
      const c = name[p++];
      if (c === '/') break;
    }
  }
  let q2 = prefixLen;
  while (name[q2] === '/') q2++;
  prefixLen = q2;
  if (prefixLen > 0) {
    const prefix = name.slice(0, prefixLen);
    const key = (linkTarget ? 'L' : 'M') + prefix;
    if (!run.warnedPrefixes.has(key)) {
      run.warnedPrefixes.add(key);
      await tarWarn(run, `Removing leading \`${prefix}' from ${linkTarget ? 'hard link targets' : 'member names'}`);
    }
  }
  const rest = name.slice(prefixLen);
  return rest === '' ? '.' : rest;
}

function tarQuote(name: string): string {
  return name.replace(/[\\\x00-\x1f\x7f]/g, (c) => {
    if (c === '\\') return '\\\\';
    if (c === '\n') return '\\n';
    if (c === '\t') return '\\t';
    return '\\' + c.charCodeAt(0).toString(8).padStart(3, '0');
  });
}

function tarLongLine(run: TarRun, e: TarEntry, name: string): string {
  const typeChar = { file: '-', dir: 'd', symlink: 'l', hardlink: 'h', chardev: 'c' }[e.type];
  const modes = permString(typeChar, e.mode);
  const user = run.o.numericOwner || !e.uname ? String(e.uid) : e.uname;
  const group = run.o.numericOwner || !e.gname ? String(e.gid) : e.gname;
  const size = e.type === 'chardev' ? '1,' + ({ null: 3, zero: 5, random: 8, tty: 0 }[e.device ?? 'null'] ?? 3) : String(e.type === 'file' ? e.size : 0);
  const pad = user.length + 1 + group.length + 1 + size.length;
  if (pad > run.ugswidth.v) run.ugswidth.v = pad;
  let line = `${modes} ${user}/${group} ${size.padStart(run.ugswidth.v - pad + size.length)} ${localStamp(e.mtime)} ${tarQuote(name)}`;
  if (e.type === 'symlink') line += ` -> ${tarQuote(e.target ?? '')}`;
  if (e.type === 'hardlink') line += ` link to ${tarQuote(e.target ?? '')}`;
  return line;
}

async function tarVerbose(run: TarRun, e: TarEntry, name: string): Promise<void> {
  if (run.o.verbose >= 2) await tarList(run, tarLongLine(run, e, name));
  else if (run.o.verbose === 1) await tarList(run, tarQuote(name));
}

function isExcluded(name: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const clean = name.replace(/\/+$/, '');
  const parts = clean.split('/');
  for (const pat of patterns) {
    const p = pat.replace(/\/+$/, '');
    for (let i = 0; i < parts.length; i++) {
      if (wildMatch(p, parts.slice(i).join('/'))) return true;
    }
  }
  return false;
}

function autoCompressFor(name: string): CompressedPayload['format'] | null {
  if (/\.(t?gz|taz)$/.test(name) || /\.tgz$/.test(name)) return 'gzip';
  if (/\.(bz2|tbz2?|tz2|tbz)$/.test(name)) return 'bzip2';
  if (/\.(xz|txz)$/.test(name)) return 'xz';
  return null;
}

/** Collect archive entries for one operand (create mode). */
async function tarCollect(run: TarRun, operand: TarOperand, out: TarEntry[], seen: Map<Inode, string>, archiveNode: Inode | null): Promise<void> {
  const ctx = run.ctx;
  const fsPathOf = (display: string) => (operand.dir && !display.startsWith('/') ? joinPath(operand.dir, display) : display);
  const visit = async (display: string): Promise<void> => {
    await ctx.checkpoint();
    const real = fsPathOf(display);
    let node: Inode;
    try {
      node = run.o.dereference ? ctx.fs.stat(real) : ctx.fs.lstat(real);
    } catch (e) {
      await tarError(run, `${display}: Cannot stat: ${errText(e)}`);
      return;
    }
    if (archiveNode && node === archiveNode) {
      await tarWarn(run, `${display}: archive cannot contain itself; not dumped`);
      return;
    }
    let member = await saferName(run, display.replace(/\/{2,}/g, '/'));
    member = member.replace(/\/+$/, '') || member;
    if (isExcluded(member, operand.excludes)) return;
    const base = {
      mode: node.mode & 0o7777,
      uid: node.uid,
      gid: node.gid,
      uname: ctx.system.userName(node.uid),
      gname: ctx.system.groupName(node.gid),
      mtime: node.mtime,
    };
    if (node.type === 'dir') {
      const entry: TarEntry = { ...base, name: member === '.' ? './' : member + '/', type: 'dir', size: 0 };
      out.push(entry);
      await tarVerbose(run, entry, entry.name);
      if (!run.o.recursion) return;
      let names: string[];
      try {
        names = ctx.fs.readdir(real).sort(byteOrder);
      } catch (e) {
        await tarError(run, `${display}: Cannot open: ${errText(e)}`);
        return;
      }
      for (const n of names) await visit(display.endsWith('/') ? display + n : display + '/' + n);
      return;
    }
    if (node.type === 'symlink') {
      const entry: TarEntry = { ...base, name: member, type: 'symlink', size: 0, target: node.target, mode: 0o777 };
      out.push(entry);
      await tarVerbose(run, entry, member);
      return;
    }
    if (node.type === 'chardev') {
      const entry: TarEntry = { ...base, name: member, type: 'chardev', size: 0, device: node.device };
      out.push(entry);
      await tarVerbose(run, entry, member);
      return;
    }
    if (node.nlink > 1 && seen.has(node)) {
      const entry: TarEntry = { ...base, name: member, type: 'hardlink', size: 0, target: seen.get(node)! };
      out.push(entry);
      await tarVerbose(run, entry, member);
      return;
    }
    let data: FileData;
    try {
      data = ctx.fs.readData(real);
    } catch (e) {
      await tarError(run, `${display}: Cannot open: ${errText(e)}`);
      return;
    }
    if (node.nlink > 1) seen.set(node, member);
    const entry: TarEntry = { ...base, name: member, type: 'file', size: dataSize(data), data: typeof data === 'string' ? data : { ...data } };
    out.push(entry);
    await tarVerbose(run, entry, member);
  };
  await visit(operand.name);
}

/** Read an archive's raw data from a file or standard input. */
async function tarReadArchive(run: TarRun): Promise<FileData> {
  const ctx = run.ctx;
  const o = run.o;
  if (o.archive === '-') {
    if (ctx.stdin.isTTY) throw new TarFatal('tar: Refusing to read archive contents from terminal (missing -f option?)', 'tar: Error is not recoverable: exiting now');
    return readStdinData(ctx);
  }
  let node: Inode;
  try {
    node = ctx.fs.stat(o.archive);
  } catch (e) {
    throw new TarFatal(`tar: ${o.archive}: Cannot open: ${errText(e)}`, 'tar: Error is not recoverable: exiting now');
  }
  if (node.type === 'dir') throw new TarFatal(`tar: ${o.archive}: Cannot read: Is a directory`, 'tar: At beginning of tape, quitting now', 'tar: Error is not recoverable: exiting now');
  try {
    return asBinary(ctx.fs.readData(o.archive));
  } catch (e) {
    throw new TarFatal(`tar: ${o.archive}: Cannot open: ${errText(e)}`, 'tar: Error is not recoverable: exiting now');
  }
}

const COMPRESS_FLAGS: Record<CompressedPayload['format'], string> = { gzip: '-z', bzip2: '-j', xz: '-J' };

/** Turn raw archive data into tar entries, handling -z/-j/-J and auto-detection. Null means "not a tar archive". */
function tarDecode(run: TarRun, data: FileData): TarEntry[] | null {
  const o = run.o;
  const p = archivePayload(data);
  let inner: FileData = data;
  if (o.compress) {
    if (!p || p.format !== o.compress) {
      if (o.compress === 'gzip') throw new TarFatal('', 'gzip: stdin: not in gzip format', 'tar: Child returned status 1', 'tar: Error is not recoverable: exiting now');
      if (o.compress === 'bzip2') throw new TarFatal('bzip2: (stdin) is not a bzip2 file.', 'tar: Child returned status 2', 'tar: Error is not recoverable: exiting now');
      throw new TarFatal('xz: (stdin): File format not recognized', 'tar: Child returned status 1', 'tar: Error is not recoverable: exiting now');
    }
    inner = (p as CompressedPayload).data;
  } else if (p && (p.format === 'gzip' || p.format === 'bzip2' || p.format === 'xz')) {
    if (o.archive === '-') throw new TarFatal(`tar: Archive is compressed. Use ${COMPRESS_FLAGS[p.format]} option`, 'tar: Error is not recoverable: exiting now');
    inner = p.data;
  }
  const tp = archivePayload(asBinary(inner));
  if (!tp || tp.format !== 'tar') return null;
  return tp.entries;
}

function memberMatches(name: string, member: string, wildcards: boolean): boolean {
  const n = name.replace(/\/+$/, '');
  const m = member.replace(/\/+$/, '');
  if (wildcards && hasWildcards(m)) {
    if (wildMatch(m, n)) return true;
    const parts = n.split('/');
    for (let i = 1; i < parts.length; i++) if (wildMatch(m, parts.slice(0, i).join('/'))) return true;
    return false;
  }
  return n === m || n.startsWith(m + '/') || (m === '.' && n.startsWith('./'));
}

function humanIec(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = -1;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return v < 10 ? `${(Math.ceil(v * 10) / 10).toFixed(1).replace(/\.0$/, '')}${units[u]}` : `${Math.ceil(v)}${units[u]}`;
}

async function tarTotals(run: TarRun, written: boolean, bytes: number): Promise<void> {
  if (!run.o.totals) return;
  const rate = humanIec(Math.round(bytes / 0.0021));
  await run.ctx.err(`Total bytes ${written ? 'written' : 'read'}: ${bytes} (${humanIec(bytes)}, ${rate}/s)\n`);
}

async function readListFile(run: TarRun, file: string): Promise<string[]> {
  const ctx = run.ctx;
  let text: string;
  try {
    text = file === '-' ? await ctx.stdin.readAll() : ctx.fs.readFile(file);
  } catch (e) {
    throw new TarFatal(`tar: ${file}: Cannot open: ${errText(e)}`, 'tar: Error is not recoverable: exiting now');
  }
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

async function tarCreate(run: TarRun): Promise<void> {
  const ctx = run.ctx;
  const o = run.o;
  for (const f of o.filesFrom) for (const n of await readListFile(run, f)) o.operands.push({ name: n, dir: o.directory, excludes: [...o.excludes] });
  for (const f of o.excludeFrom) {
    const pats = await readListFile(run, f);
    for (const op of o.operands) op.excludes.push(...pats);
  }
  if (o.mode === 'create' && o.operands.length === 0) {
    throw new TarUsage('Cowardly refusing to create an empty archive');
  }
  if (o.noEffect.length) {
    await tarWarn(run, 'The following options were used after non-option arguments.  These options are positional and affect only arguments that follow them.  Please, rearrange them properly.');
    for (const ne of o.noEffect) await tarError(run, `${ne} has no effect`);
  }
  let compress = o.compress;
  if (!compress && o.autoCompress && o.archive !== '-') compress = autoCompressFor(o.archive);
  if (o.archive === '-' && ctx.stdout.isTTY) {
    throw new TarFatal('tar: Refusing to write archive contents to terminal (missing -f option?)', 'tar: Error is not recoverable: exiting now');
  }
  let existing: TarEntry[] = [];
  let archiveNode: Inode | null = null;
  if (o.archive !== '-') {
    if (o.mode === 'append' || o.mode === 'update') {
      const node = ctx.fs.tryStat(o.archive);
      if (node) {
        const data = await tarReadArchive(run);
        if (dataSize(data) > 0) {
          const ents = tarDecode(run, data);
          if (!ents) throw new TarFatal('tar: This does not look like a tar archive', 'tar: Exiting with failure status due to previous errors');
          existing = ents;
        }
      }
    }
    try {
      const node = ctx.fs.tryStat(o.archive);
      if (node && node.type === 'dir') throw new FsError('EISDIR', o.archive);
      if (!node || o.mode === 'create') ctx.fs.writeFile(o.archive, '');
      archiveNode = ctx.fs.stat(o.archive);
    } catch (e) {
      throw new TarFatal(`tar: ${o.archive}: Cannot open: ${errText(e)}`, 'tar: Error is not recoverable: exiting now');
    }
  }
  const entries: TarEntry[] = [];
  const seen = new Map<Inode, string>();
  for (const op of o.operands) await tarCollect(run, op, entries, seen, archiveNode);
  let finalEntries = entries;
  if (o.mode === 'update') {
    const latest = new Map<string, number>();
    for (const e of existing) latest.set(e.name, e.mtime);
    finalEntries = entries.filter((e) => {
      const t = latest.get(e.name);
      return t === undefined || (e.type !== 'dir' && e.mtime > t);
    });
  }
  const all = [...existing, ...finalEntries];
  let blob: BlobData = makeTarBlob(all);
  const tarBytes = blob.size;
  if (compress) blob = makeCompressedBlob(compress, blob, { level: 6 });
  if (o.archive === '-') {
    await writeDataToStdout(ctx, blob);
  } else {
    try {
      checkArchiveSpace(ctx, blob, o.archive);
      ctx.fs.writeFile(o.archive, blob);
    } catch (e) {
      throw new TarFatal(`tar: ${o.archive}: Cannot write: ${errText(e)}`, 'tar: Error is not recoverable: exiting now');
    }
  }
  if (o.removeFiles) {
    const dirs: string[] = [];
    for (const op of o.operands) {
      const remove = (path: string) => {
        const node = ctx.fs.tryStat(path, false);
        if (!node) return;
        if (node.type === 'dir') {
          for (const n of ctx.fs.readdir(path)) remove(joinPath(path, n));
          dirs.push(path);
        } else {
          ctx.fs.unlink(path);
        }
      };
      try {
        remove(op.dir && !op.name.startsWith('/') ? joinPath(op.dir, op.name) : op.name);
      } catch (e) {
        await tarError(run, `${op.name}: Cannot unlink: ${errText(e)}`);
      }
    }
    for (const d of dirs) {
      try {
        ctx.fs.rmdir(d);
      } catch {
        // not empty or no permission
      }
    }
  }
  await tarTotals(run, true, tarBytes);
}

async function tarListOrExtract(run: TarRun): Promise<void> {
  const ctx = run.ctx;
  const o = run.o;
  const raw = await tarReadArchive(run);
  if (typeof raw === 'string' && isTruncatedStream(raw)) {
    throw new TarFatal('tar: Unexpected EOF in archive', 'tar: Error is not recoverable: exiting now');
  }
  const entries = tarDecode(run, raw);
  if (!entries) {
    await tarError(run, 'This does not look like a tar archive');
    return;
  }
  const members = o.operands.map((m) => m.name);
  const matched = new Set<string>();
  const extract = o.mode === 'extract';
  let base = '.';
  if (extract && o.directory !== null) {
    const node = ctx.fs.tryStat(o.directory);
    if (!node) throw new TarFatal(`tar: ${o.directory}: Cannot open: No such file or directory`, 'tar: Error is not recoverable: exiting now');
    if (node.type !== 'dir') throw new TarFatal(`tar: ${o.directory}: Cannot open: Not a directory`, 'tar: Error is not recoverable: exiting now');
    base = o.directory;
  }
  const dirTimes: { path: string; e: TarEntry }[] = [];
  const umask = ctx.umask;
  const owner = (o.sameOwner ?? ctx.creds.uid === 0) && ctx.creds.uid === 0;
  for (const e of entries) {
    await ctx.checkpoint();
    if (members.length) {
      const m = members.find((mm) => memberMatches(e.name, mm, o.wildcards));
      if (m === undefined) continue;
      matched.add(m);
    }
    if (isExcluded(e.name, o.excludes)) continue;
    if (!extract) {
      // list (-t)
      if (o.verbose >= 1) await ctx.out(tarLongLine(run, e, e.name) + '\n');
      else await ctx.out(tarQuote(e.name) + '\n');
      continue;
    }
    let name = await saferName(run, e.name);
    if (!o.absolute && name.split('/').includes('..')) {
      await tarError(run, `${name}: Member name contains '..'`);
      continue;
    }
    if (o.strip > 0) {
      const parts = name.split('/').filter(Boolean);
      if (parts.length <= o.strip) continue;
      name = parts.slice(o.strip).join('/') + (e.type === 'dir' ? '/' : '');
    }
    await tarVerbose(run, e, e.name);
    if (o.toStdout) {
      if (e.type === 'file' && e.data !== undefined) await writeDataToStdout(ctx, e.data);
      continue;
    }
    const target = joinPath(base, name.replace(/\/+$/, '') || '.');
    const display = name.replace(/\/+$/, '') || '.';
    try {
      const existing = ctx.fs.tryStat(target, false);
      if (e.type === 'dir') {
        if (existing && existing.type === 'dir') {
          if (o.skipOld && o.verbose) await tarWarn(run, `${display}: skipping existing file`);
        } else {
          if (existing) ctx.fs.unlink(target);
          mkdirParents(ctx, dirname(target));
          ctx.fs.mkdir(target, 0o700);
        }
        dirTimes.push({ path: target, e });
        continue;
      }
      if (existing) {
        if (o.skipOld) {
          if (o.verbose) await tarWarn(run, `${display}: skipping existing file`);
          continue;
        }
        if (o.keepOld) {
          if (e.type === 'symlink') await tarError(run, `${display}: Cannot create symlink to ‘${e.target}’: File exists`);
          else if (e.type === 'hardlink') await tarError(run, `${display}: Cannot hard link to ‘${e.target}’: File exists`);
          else await tarError(run, `${display}: Cannot open: File exists`);
          continue;
        }
        if (existing.type === 'dir') {
          await tarError(run, `${display}: Cannot open: Is a directory`);
          continue;
        }
        ctx.fs.unlink(target);
      } else {
        mkdirParents(ctx, dirname(target));
      }
      switch (e.type) {
        case 'file': {
          const data = e.data ?? '';
          ctx.fs.writeFile(target, typeof data === 'string' ? data : { ...data }, { mode: 0o600 });
          break;
        }
        case 'symlink':
          ctx.fs.symlink(e.target ?? '', target);
          continue;
        case 'hardlink': {
          const linkTarget = joinPath(base, (await saferName(run, e.target ?? '', true)).replace(/\/+$/, ''));
          try {
            ctx.fs.link(linkTarget, target);
          } catch (err) {
            await tarError(run, `${display}: Cannot hard link to ‘${e.target}’: ${errText(err)}`);
          }
          continue;
        }
        case 'chardev':
          if (ctx.creds.uid !== 0) {
            await tarError(run, `${display}: Cannot mknod: Operation not permitted`);
            continue;
          }
          ctx.fs.mknod(target, (e.device ?? 'null') as 'null', e.mode & 0o777);
          break;
      }
      const mode = o.preserve ? e.mode & 0o7777 : e.mode & 0o777 & ~umask;
      ctx.fs.chmod(target, mode);
      if (!o.touch) ctx.fs.setTimes(target, ctx.system.now(), e.mtime);
      if (owner) {
        const uid = o.numericOwner ? e.uid : (ctx.system.userByName(e.uname)?.uid ?? e.uid);
        const gid = o.numericOwner ? e.gid : (ctx.system.groupByName(e.gname)?.gid ?? e.gid);
        ctx.fs.chown(target, uid, gid);
      }
    } catch (err) {
      const code = err instanceof FsError ? err.code : '';
      const what = e.type === 'dir' ? 'Cannot mkdir' : e.type === 'symlink' ? `Cannot create symlink to ‘${e.target}’` : 'Cannot open';
      await tarError(run, `${display}: ${code === 'ENOSPC' ? 'Cannot write' : what}: ${errText(err)}`);
    }
  }
  for (const { path, e } of dirTimes.reverse()) {
    try {
      const mode = o.preserve ? e.mode & 0o7777 : e.mode & 0o777 & ~umask;
      ctx.fs.chmod(path, mode);
      if (!o.touch) ctx.fs.setTimes(path, ctx.system.now(), e.mtime);
      if (owner) {
        const uid = o.numericOwner ? e.uid : (ctx.system.userByName(e.uname)?.uid ?? e.uid);
        const gid = o.numericOwner ? e.gid : (ctx.system.groupByName(e.gname)?.gid ?? e.gid);
        ctx.fs.chown(path, uid, gid);
      }
    } catch {
      // ignore
    }
  }
  let warnedWildcards = false;
  for (const m of members) {
    if (matched.has(m)) continue;
    if (!o.wildcards && hasWildcards(m) && !warnedWildcards) {
      warnedWildcards = true;
      await tarWarn(run, 'Pattern matching characters used in file names');
      await tarWarn(run, 'Use --wildcards to enable pattern matching, or --no-wildcards to suppress this warning');
    }
    await tarError(run, `${m}: Not found in archive`);
  }
  await tarTotals(run, false, archivePayload(raw)?.format === 'tar' ? dataSize(raw) : tarSize(entries));
}

/** mkdir -p for the parents of extracted files (silently, like tar). */
function mkdirParents(ctx: CommandContext, dir: string): void {
  if (dir === '.' || dir === '/' || dir === '') return;
  const node = ctx.fs.tryStat(dir);
  if (node) {
    if (node.type !== 'dir') throw new FsError('ENOTDIR', dir);
    return;
  }
  mkdirParents(ctx, dirname(dir));
  ctx.fs.mkdir(dir);
}

async function tarDiff(run: TarRun): Promise<void> {
  const ctx = run.ctx;
  const o = run.o;
  const raw = await tarReadArchive(run);
  const entries = tarDecode(run, raw);
  if (!entries) {
    await tarError(run, 'This does not look like a tar archive');
    return;
  }
  const base = o.directory ?? '.';
  let differ = false;
  for (const e of entries) {
    const name = e.name.replace(/\/+$/, '') || '.';
    await tarVerbose(run, e, e.name);
    const node = ctx.fs.tryStat(joinPath(base, name), false);
    if (!node) {
      await ctx.err(`tar: ${name}: Warning: Cannot stat: No such file or directory\n`);
      differ = true;
      continue;
    }
    if (e.type === 'file' && node.type === 'file') {
      if ((node.mode & 0o7777) !== (e.mode & 0o7777)) {
        await ctx.out(`${name}: Mode differs\n`);
        differ = true;
      }
      if (Math.floor(node.mtime / 1000) !== Math.floor(e.mtime / 1000)) {
        await ctx.out(`${name}: Mod time differs\n`);
        differ = true;
      }
      if (dataSize(node.data) !== e.size) {
        await ctx.out(`${name}: Size differs\n`);
        differ = true;
      } else if (typeof node.data === 'string' && typeof e.data === 'string' && node.data !== e.data) {
        await ctx.out(`${name}: Contents differ\n`);
        differ = true;
      }
    }
  }
  if (differ && run.status === 0) run.status = 1;
}

async function tarDelete(run: TarRun): Promise<void> {
  const ctx = run.ctx;
  const o = run.o;
  if (o.archive === '-') throw new TarUsage("Options '-Aru' are incompatible with '-f -'");
  const raw = await tarReadArchive(run);
  if (archivePayload(raw) && archivePayload(raw)!.format !== 'tar') throw new TarFatal('tar: Cannot update compressed archives', 'tar: Error is not recoverable: exiting now');
  const entries = tarDecode(run, raw);
  if (!entries) {
    await tarError(run, 'This does not look like a tar archive');
    return;
  }
  const members = o.operands.map((m) => m.name);
  const matched = new Set<string>();
  const kept = entries.filter((e) => {
    const m = members.find((mm) => memberMatches(e.name, mm, o.wildcards));
    if (m !== undefined) matched.add(m);
    return m === undefined;
  });
  ctx.fs.writeFile(o.archive, makeTarBlob(kept));
  for (const m of members) if (!matched.has(m)) await tarError(run, `${m}: Not found in archive`);
}

async function tarCatenate(run: TarRun): Promise<void> {
  const ctx = run.ctx;
  const o = run.o;
  const raw = await tarReadArchive(run);
  const entries = tarDecode(run, raw) ?? [];
  const all = [...entries];
  for (const op of o.operands) {
    let data: FileData;
    try {
      data = asBinary(ctx.fs.readData(op.name));
    } catch (e) {
      await tarError(run, `${op.name}: Cannot open: ${errText(e)}`);
      continue;
    }
    const p = archivePayload(data);
    if (!p || p.format !== 'tar') {
      await tarError(run, `${op.name}: This does not look like a tar archive`);
      continue;
    }
    all.push(...p.entries);
  }
  ctx.fs.writeFile(o.archive, makeTarBlob(all));
}

const TAR_DEF: CommandDef = {
  name: 'tar',
  pkg: 'tar',
  size: 531416,
  gnu: false,
  doc: {
    category: 'archives',
    summary: 'an archiving utility',
    synopsis: ['tar -c [-f ARCHIVE] [OPTIONS] [FILE...]', 'tar -x [-f ARCHIVE] [OPTIONS] [MEMBER...]', 'tar -t [-f ARCHIVE] [OPTIONS] [MEMBER...]', 'tar {-r|-u} -f ARCHIVE [OPTIONS] [FILE...]'],
    description:
      'GNU tar saves many files together into a single archive file (a "tarball"), and can restore individual files from the archive. On its own tar does not compress anything; add -z to compress the archive with gzip, -j for bzip2 or -J for xz.\n\n' +
      'Exactly one operation must be given: -c creates an archive, -x extracts it, -t lists its contents, -r appends files and -u adds files that are newer than their copies in the archive. -f ARCHIVE names the archive file; without -f, tar reads standard input or writes standard output.\n\n' +
      'Options can be bundled: tar -czvf backup.tar.gz Documents means create (c), gzip (z), verbose (v), file (f) backup.tar.gz. The old style without the dash (tar czvf ...) also works. Because -f takes an argument, keep the f last in a bundle.\n\n' +
      'Leading "/" is removed from member names so that extracting an archive never overwrites files outside the current directory. When extracting, existing files are replaced, directories are created as needed and modification times are restored.',
    options: [
      { flags: '-c, --create', desc: 'create a new archive' },
      { flags: '-x, --extract, --get', desc: 'extract files from an archive' },
      { flags: '-t, --list', desc: 'list the contents of an archive' },
      { flags: '-r, --append', desc: 'append files to the end of an archive' },
      { flags: '-u, --update', desc: 'only append files newer than copy in archive' },
      { flags: '-d, --diff, --compare', desc: 'find differences between archive and file system' },
      { flags: '--delete', desc: 'delete from the archive' },
      { flags: '-f, --file=ARCHIVE', desc: 'use archive file or device ARCHIVE ("-" means standard input/output)' },
      { flags: '-v, --verbose', desc: 'verbosely list files processed (give it twice for a long listing)' },
      { flags: '-z, --gzip', desc: 'filter the archive through gzip' },
      { flags: '-j, --bzip2', desc: 'filter the archive through bzip2' },
      { flags: '-J, --xz', desc: 'filter the archive through xz' },
      { flags: '-a, --auto-compress', desc: 'use archive suffix to determine the compression program' },
      { flags: '-C, --directory=DIR', desc: 'change to directory DIR' },
      { flags: '--exclude=PATTERN', desc: 'exclude files matching PATTERN, a glob(3)-style wildcard pattern' },
      { flags: '--strip-components=NUMBER', desc: 'strip NUMBER leading components from file names on extraction' },
      { flags: '-k, --keep-old-files', desc: "don't replace existing files when extracting, treat them as errors" },
      { flags: '--skip-old-files', desc: "don't replace existing files when extracting, silently skip over them" },
      { flags: '-O, --to-stdout', desc: 'extract files to standard output' },
      { flags: '-p, --preserve-permissions', desc: 'extract information about file permissions (default for superuser)' },
      { flags: '-P, --absolute-names', desc: "don't strip leading '/'s from file names" },
      { flags: '-h, --dereference', desc: 'follow symlinks; archive and dump the files they point to' },
      { flags: '-m, --touch', desc: "don't extract file modified time" },
      { flags: '-T, --files-from=FILE', desc: 'get names to extract or create from FILE' },
      { flags: '-X, --exclude-from=FILE', desc: 'exclude patterns listed in FILE' },
      { flags: '--wildcards', desc: 'use wildcards for member names' },
      { flags: '--remove-files', desc: 'remove files after adding them to the archive' },
      { flags: '--totals', desc: 'print total bytes after processing the archive' },
    ],
    examples: [
      { cmd: 'tar -czvf backup.tar.gz Documents', desc: 'Pack the Documents folder into a gzip-compressed archive, listing each file.' },
      { cmd: 'tar -tvf backup.tar.gz', desc: 'Look inside an archive without extracting it.' },
      { cmd: 'tar -xzvf backup.tar.gz', desc: 'Unpack an archive into the current directory.' },
      { cmd: 'tar -xzf backup.tar.gz -C /tmp', desc: 'Unpack into another directory.' },
      { cmd: 'tar -xzf backup.tar.gz Documents/notes.txt', desc: 'Extract just one file.' },
      { cmd: 'tar -cf - Documents | gzip > docs.tar.gz', desc: 'Write the archive to a pipe instead of a file.' },
    ],
    seeAlso: ['gzip', 'zip', 'unzip'],
    tip: 'Remember the letters: c = create, x = extract (eXtract), t = list (Table of contents), v = verbose, f = file, z = gzip. "tar -czvf name.tar.gz folder" packs, "tar -xzvf name.tar.gz" unpacks.',
  },
  run: async (ctx) => tarMain(ctx),
};

async function tarMain(ctx: CommandContext): Promise<number> {
  const args = ctx.args;
  const end = args.indexOf('--');
  const scan = end === -1 ? args : args.slice(0, end);
  if (scan.includes('--help') || scan.includes('--usage') || scan.includes('-?')) {
    await ctx.out(gnuHelp(TAR_DEF));
    return 0;
  }
  if (scan.includes('--version')) {
    await ctx.out('tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by John Gilmore and Jay Fenlason.\n');
    return 0;
  }
  const run: TarRun = { ctx, o: undefined as unknown as TarOptions, status: 0, warnedPrefixes: new Set(), ugswidth: { v: 19 }, listTo: 'out' };
  try {
    const items = tarTokenize(args);
    const o = tarOptions(ctx, items);
    run.o = o;
    if (!o.mode) throw new TarUsage("You must specify one of the '-Acdtrux', '--delete' or '--test-label' options");
    if ((o.mode === 'append' || o.mode === 'update' || o.mode === 'catenate') && o.archive === '-') throw new TarUsage("Options '-Aru' are incompatible with '-f -'");
    if ((o.mode === 'append' || o.mode === 'update' || o.mode === 'catenate' || o.mode === 'delete') && o.compress) throw new TarUsage('Cannot update compressed archives');
    if (o.mode === 'test-label') return 0;
    if ((o.mode === 'create' && o.archive === '-') || (o.mode === 'extract' && o.toStdout)) run.listTo = 'err';
    switch (o.mode) {
      case 'create':
      case 'append':
      case 'update':
        if ((o.mode === 'append' || o.mode === 'update') && o.archive !== '-') {
          const existing = ctx.fs.tryStat(o.archive);
          if (existing && existing.type === 'file') {
            const p = archivePayload(asBinary(existing.data));
            if (p && p.format !== 'tar') throw new TarFatal('tar: Cannot update compressed archives', 'tar: Error is not recoverable: exiting now');
          }
        }
        await tarCreate(run);
        break;
      case 'extract':
      case 'list':
        await tarListOrExtract(run);
        break;
      case 'diff':
        await tarDiff(run);
        break;
      case 'delete':
        await tarDelete(run);
        break;
      case 'catenate':
        await tarCatenate(run);
        break;
    }
  } catch (e) {
    if (e instanceof TarUsage) {
      await ctx.err(`tar: ${e.message}\n${TAR_TRY}\n`);
      return 2;
    }
    if (e instanceof TarFatal) {
      await writeErrLines(ctx, e.lines);
      return 2;
    }
    throw e;
  }
  if (run.status === 2) await ctx.err('tar: Exiting with failure status due to previous errors\n');
  return run.status;
}

defineCommand(TAR_DEF);

// ===========================================================================
// gzip, gunzip, zcat

interface GzOpts {
  stdout: boolean;
  decompress: boolean;
  force: boolean;
  keep: boolean;
  list: boolean;
  noName: boolean;
  name: boolean;
  quiet: boolean;
  recursive: boolean;
  suffix: string;
  test: boolean;
  verbose: boolean;
  level: number;
}

interface GzRun {
  ctx: CommandContext;
  o: GzOpts;
  errors: boolean;
  warnings: boolean;
  listHeaderDone: boolean;
  totals: { c: number; u: number; header: number; n: number };
}

const GZ_SUFFIXES = ['.gz', '-gz', '.z', '-z', '_z', '.tgz', '.taz'];

async function gzError(r: GzRun, msg: string): Promise<void> {
  r.errors = true;
  await r.ctx.err(`gzip: ${msg}\n`);
}

async function gzWarn(r: GzRun, msg: string): Promise<void> {
  r.warnings = true;
  if (!r.o.quiet) await r.ctx.err(`gzip: ${msg}\n`);
}

/** Bytes of the gzip header + trailer stored in a gzip blob. */
function gzHeaderBytes(p: CompressedPayload): number {
  return gzipOverhead(p.name);
}

function gzSuffixOf(name: string, o: GzOpts): string | null {
  const lower = name.toLowerCase();
  const list = o.suffix && !GZ_SUFFIXES.includes(o.suffix) ? [o.suffix, ...GZ_SUFFIXES] : GZ_SUFFIXES;
  for (const s of list) if (lower.endsWith(s.toLowerCase()) && name.length > s.length) return name.slice(name.length - s.length);
  return null;
}

/** Ask "overwrite?" like gzip; true means go ahead. */
async function gzMayOverwrite(r: GzRun, out: string): Promise<boolean> {
  const ctx = r.ctx;
  if (!ctx.fs.tryStat(out, false)) return true;
  if (r.o.force) return true;
  if (ctx.stdin.isTTY && !r.o.quiet) {
    await ctx.err(`gzip: ${out} already exists; do you wish to overwrite (y or n)? `);
    const line = await ctx.stdin.readLine();
    if (line !== null && /^\s*[yY]/.test(line)) return true;
    await ctx.err('\tnot overwritten\n');
    r.warnings = true;
    return false;
  }
  await gzWarn(r, `${out} already exists;\tnot overwritten`);
  return false;
}

async function gzListLine(r: GzRun, label: string, blob: BlobData, p: CompressedPayload, mtime: number): Promise<void> {
  const ctx = r.ctx;
  if (!r.listHeaderDone) {
    r.listHeaderDone = true;
    await ctx.out(r.o.verbose ? 'method  crc     date  time           compressed        uncompressed  ratio uncompressed_name\n' : '         compressed        uncompressed  ratio uncompressed_name\n');
  }
  const u = dataSize(p.data);
  const header = gzHeaderBytes(p);
  r.totals.c += blob.size;
  r.totals.u += u;
  r.totals.header = header;
  r.totals.n++;
  let line = '';
  if (r.o.verbose) {
    const d = new Date(p.mtime || mtime);
    line += `defla ${contentCrc(p.data).toString(16).padStart(8, '0')} ${MONTHS[d.getMonth()]}${String(d.getDate()).padStart(3)} ${pad2(d.getHours())}:${pad2(d.getMinutes())} `;
  }
  line += `${String(blob.size).padStart(19)} ${String(u).padStart(19)} ${ratioText(u - (blob.size - header), u)} ${label}\n`;
  await ctx.out(line);
}

async function gzListTotals(r: GzRun): Promise<void> {
  const t = r.totals;
  const ratio = ratioText(t.u - (t.c - t.header), t.u);
  await r.ctx.out(`${r.o.verbose ? ' '.repeat(28) : ''}${String(t.c).padStart(19)} ${String(t.u).padStart(19)} ${ratio} (totals)\n`);
}

/** Compress or decompress one file operand. */
async function gzFile(r: GzRun, path: string, top: boolean): Promise<void> {
  const ctx = r.ctx;
  const o = r.o;
  await ctx.checkpoint();
  let node = ctx.fs.tryStat(path, false);
  let actual = path;
  if (!node && (o.decompress || o.list || o.test)) {
    // gunzip foo finds foo.gz
    for (const s of [o.suffix, ...GZ_SUFFIXES.filter((x) => x !== o.suffix)]) {
      const n = ctx.fs.tryStat(path + s, false);
      if (n) {
        node = n;
        actual = path + s;
        break;
      }
    }
    if (!node) {
      await gzError(r, `${gzSuffixOf(path, o) ? path : path + o.suffix}: No such file or directory`);
      return;
    }
  }
  if (!node) {
    try {
      ctx.fs.lstat(path);
    } catch (e) {
      await gzError(r, `${path}: ${errText(e)}`);
      return;
    }
    return;
  }
  if (node.type === 'symlink') {
    if (!o.force && !o.stdout) {
      await gzError(r, `${actual}: Too many levels of symbolic links`);
      return;
    }
    const t = ctx.fs.tryStat(actual);
    if (!t) {
      await gzError(r, `${actual}: No such file or directory`);
      return;
    }
    node = t;
  }
  if (node.type === 'dir') {
    if (o.recursive) {
      let names: string[];
      try {
        names = ctx.fs.readdir(actual).sort(byteOrder);
      } catch (e) {
        await gzError(r, `${actual}: ${errText(e)}`);
        return;
      }
      for (const n of names) await gzFile(r, joinPath(actual, n), false);
      return;
    }
    await gzWarn(r, `${actual} is a directory -- ignored`);
    return;
  }
  if (node.type !== 'file') {
    await gzWarn(r, `${actual} is not a directory or a regular file - ignored`);
    return;
  }
  const decompressing = o.decompress || o.list || o.test;
  if (!top && decompressing && !gzSuffixOf(actual, o)) return;
  if (!top && !decompressing && gzSuffixOf(actual, o)) return;
  let data: FileData;
  try {
    data = asBinary(ctx.fs.readData(actual));
  } catch (e) {
    await gzError(r, `${actual}: ${errText(e)}`);
    return;
  }
  if (!decompressing) {
    if (gzSuffixOf(actual, o) && !o.stdout) {
      await gzWarn(r, `${actual} already has ${gzSuffixOf(actual, o)} suffix -- unchanged`);
      return;
    }
    if (node.nlink > 1 && !o.force && !o.stdout) {
      const others = node.nlink - 1;
      await gzWarn(r, `${actual} has ${others} other link${others === 1 ? '' : 's'} -- file ignored`);
      return;
    }
    const blob = makeCompressedBlob('gzip', data, { name: o.noName ? undefined : basename(actual), mtime: o.noName ? undefined : node.mtime, level: o.level });
    const p = blob.payload as CompressedPayload;
    const ratio = ratioText(dataSize(data) - (blob.size - gzHeaderBytes(p)), dataSize(data));
    if (o.stdout) {
      if (ctx.stdout.isTTY && !o.force) {
        await ctx.err('gzip: compressed data not written to a terminal. Use -f to force compression.\nFor help, type: gzip -h\n');
        r.errors = true;
        return;
      }
      if (o.verbose) await ctx.err(`${actual}:\t${ratio} -- replaced with stdout\n`);
      await writeDataToStdout(ctx, blob);
      return;
    }
    const out = actual + o.suffix;
    if (!(await gzMayOverwrite(r, out))) return;
    try {
      checkArchiveSpace(ctx, blob, out);
      const existing = ctx.fs.tryStat(out, false);
      if (existing) ctx.fs.unlink(out);
      ctx.fs.writeFile(out, blob, { mode: node.mode & 0o777 });
      ctx.fs.chmod(out, node.mode & 0o7777);
      ctx.fs.setTimes(out, node.atime, node.mtime);
      if (!o.keep) ctx.fs.unlink(actual);
    } catch (e) {
      await gzError(r, `${out}: ${errText(e)}`);
      return;
    }
    if (o.verbose) await ctx.err(`${actual}:\t${ratio} -- ${o.keep ? 'created' : 'replaced with'} ${out}\n`);
    return;
  }
  // decompression, test and list
  const suffix = gzSuffixOf(actual, o);
  if (!suffix && !o.stdout && !o.list && !o.test) {
    await gzWarn(r, `${actual}: unknown suffix -- ignored`);
    return;
  }
  if (typeof data === 'string' && isTruncatedStream(data)) {
    await ctx.err(`\ngzip: ${actual}: unexpected end of file\n`);
    r.errors = true;
    return;
  }
  const p = archivePayload(data);
  if (!p || p.format !== 'gzip' || typeof data === 'string' || data.kind !== 'blob') {
    await ctx.err(`\ngzip: ${actual}: not in gzip format\n`);
    r.errors = true;
    return;
  }
  const gp = p as CompressedPayload;
  const ratio = ratioText(dataSize(gp.data) - (data.size - gzHeaderBytes(gp)), dataSize(gp.data));
  if (o.list) {
    let base = actual.slice(0, actual.length - (suffix ?? '').length);
    if (suffix && /^\.t[ag]z$/i.test(suffix)) base += '.tar';
    await gzListLine(r, base, data, gp, node.mtime);
    return;
  }
  if (o.test) {
    if (o.verbose) await ctx.err(`${actual}:\t OK\n`);
    return;
  }
  if (o.stdout) {
    if (o.verbose) await ctx.err(`${actual}:\t${ratio} -- replaced with stdout\n`);
    await writeDataToStdout(ctx, gp.data);
    return;
  }
  let out = actual.slice(0, actual.length - suffix!.length);
  if (/^\.t[ag]z$/i.test(suffix!)) out += '.tar';
  if (o.name && gp.name) out = joinPath(dirname(actual) === '.' && !actual.includes('/') ? '' : dirname(actual), gp.name);
  if (!(await gzMayOverwrite(r, out))) return;
  try {
    const existing = ctx.fs.tryStat(out, false);
    if (existing) ctx.fs.unlink(out);
    const content = gp.data;
    ctx.fs.writeFile(out, typeof content === 'string' ? content : { ...content }, { mode: node.mode & 0o777 });
    ctx.fs.chmod(out, node.mode & 0o7777);
    ctx.fs.setTimes(out, node.atime, o.name && gp.mtime ? gp.mtime : node.mtime);
    if (!o.keep) ctx.fs.unlink(actual);
  } catch (e) {
    await gzError(r, `${out}: ${errText(e)}`);
    return;
  }
  if (o.verbose) await ctx.err(`${actual}:\t${ratio} -- ${o.keep ? 'created' : 'replaced with'} ${out}\n`);
}

/** gzip/gunzip/zcat on standard input. */
async function gzStdin(r: GzRun): Promise<void> {
  const ctx = r.ctx;
  const o = r.o;
  const decompressing = o.decompress || o.list || o.test;
  if (!decompressing) {
    if (ctx.stdout.isTTY && !o.force) {
      if (!o.quiet) await ctx.err('gzip: compressed data not written to a terminal. Use -f to force compression.\nFor help, type: gzip -h\n');
      r.errors = true;
      return;
    }
    const data = await readStdinData(ctx);
    const blob = makeCompressedBlob('gzip', data, { level: o.level });
    if (o.verbose) await ctx.err(`${ratioText(dataSize(data) - (blob.size - gzHeaderBytes(blob.payload as CompressedPayload)), dataSize(data))}\n`);
    await writeDataToStdout(ctx, blob);
    return;
  }
  if (ctx.stdin.isTTY && !o.force) {
    if (!o.quiet) await ctx.err('gzip: compressed data not read from a terminal. Use -f to force decompression.\nFor help, type: gzip -h\n');
    r.errors = true;
    return;
  }
  const text = await ctx.stdin.readAll();
  if (isTruncatedStream(text)) {
    await ctx.err('\ngzip: stdin: unexpected end of file\n');
    r.errors = true;
    return;
  }
  const data = asBinary(text);
  const p = archivePayload(data);
  if (!p || p.format !== 'gzip' || typeof data === 'string' || data.kind !== 'blob') {
    if (o.force && o.stdout && !o.list && !o.test) {
      await writeDataToStdout(ctx, data);
      return;
    }
    await ctx.err('\ngzip: stdin: not in gzip format\n');
    r.errors = true;
    return;
  }
  const gp = p as CompressedPayload;
  if (o.list) {
    await gzListLine(r, 'stdout', data, gp, ctx.system.now());
    return;
  }
  if (o.test) return;
  await writeDataToStdout(ctx, gp.data);
}

function gzDef(name: 'gzip' | 'gunzip' | 'zcat'): CommandDef {
  const docs: Record<string, CommandDef['doc']> = {
    gzip: {
      category: 'archives',
      summary: 'compress or expand files',
      synopsis: ['gzip [OPTION]... [FILE]...'],
      description:
        'Compress or uncompress FILEs (by default, compress FILES in-place).\n\n' +
        'gzip reduces the size of each file using Lempel-Ziv coding. Each file is replaced by one with the extension .gz, keeping the same ownership, modes and modification time. Use -k to keep the original, or -c to write the compressed data to standard output instead.\n\n' +
        'gzip compresses single files only. To compress a whole directory, first pack it with tar (tar -czf archive.tar.gz dir does both steps at once).',
      options: [
        { flags: '-c, --stdout', desc: 'write on standard output, keep original files unchanged' },
        { flags: '-d, --decompress', desc: 'decompress' },
        { flags: '-f, --force', desc: 'force overwrite of output file and compress links' },
        { flags: '-h, --help', desc: 'give this help' },
        { flags: '-k, --keep', desc: "keep (don't delete) input files" },
        { flags: '-l, --list', desc: 'list compressed file contents' },
        { flags: '-n, --no-name', desc: 'do not save or restore the original name and timestamp' },
        { flags: '-N, --name', desc: 'save or restore the original name and timestamp' },
        { flags: '-q, --quiet', desc: 'suppress all warnings' },
        { flags: '-r, --recursive', desc: 'operate recursively on directories' },
        { flags: '-S, --suffix=SUF', desc: 'use suffix SUF on compressed files' },
        { flags: '-t, --test', desc: 'test compressed file integrity' },
        { flags: '-v, --verbose', desc: 'verbose mode' },
        { flags: '-V, --version', desc: 'display version number' },
        { flags: '-1, --fast', desc: 'compress faster' },
        { flags: '-9, --best', desc: 'compress better' },
      ],
      examples: [
        { cmd: 'gzip notes.txt', desc: 'Replace notes.txt with the smaller notes.txt.gz.' },
        { cmd: 'gzip -k notes.txt', desc: 'Compress but keep the original file too.' },
        { cmd: 'gzip -v notes.txt', desc: 'Show how much space was saved.' },
        { cmd: 'gzip -d notes.txt.gz', desc: 'Decompress (same as gunzip).' },
        { cmd: 'gzip -l notes.txt.gz', desc: 'Show the compressed and original sizes.' },
      ],
      seeAlso: ['gunzip', 'zcat', 'tar', 'zip'],
      tip: 'gzip deletes the original file after compressing it. Add -k if you want to keep it.',
    },
    gunzip: {
      category: 'archives',
      summary: 'decompress files',
      synopsis: ['gunzip [OPTION]... [FILE]...'],
      description: 'Uncompress FILEs (by default, in-place).\n\ngunzip replaces each file ending in .gz (or .tgz, .z) with the original uncompressed file, restoring its modes and modification time. gunzip is the same program as gzip -d.',
      options: [
        { flags: '-c, --stdout', desc: 'write on standard output, keep original files unchanged' },
        { flags: '-f, --force', desc: 'force overwrite of output file and compress links' },
        { flags: '-k, --keep', desc: "keep (don't delete) input files" },
        { flags: '-l, --list', desc: 'list compressed file contents' },
        { flags: '-N, --name', desc: 'save or restore the original name and timestamp' },
        { flags: '-q, --quiet', desc: 'suppress all warnings' },
        { flags: '-r, --recursive', desc: 'operate recursively on directories' },
        { flags: '-S, --suffix=SUF', desc: 'use suffix SUF on compressed files' },
        { flags: '-t, --test', desc: 'test compressed file integrity' },
        { flags: '-v, --verbose', desc: 'verbose mode' },
      ],
      examples: [
        { cmd: 'gunzip notes.txt.gz', desc: 'Restore notes.txt.' },
        { cmd: 'gunzip -k notes.txt.gz', desc: 'Decompress but keep the .gz file.' },
        { cmd: 'gunzip -c notes.txt.gz | less', desc: 'Read a compressed file without unpacking it.' },
      ],
      seeAlso: ['gzip', 'zcat', 'tar'],
    },
    zcat: {
      category: 'archives',
      summary: 'decompress files to standard output',
      synopsis: ['zcat [OPTION]... [FILE]...'],
      description: 'Uncompress FILEs to standard output.\n\nzcat is like cat for compressed files: it prints the uncompressed contents and leaves the .gz files alone. It is the same as gzip -dc.',
      options: [
        { flags: '-f, --force', desc: 'force; read compressed data even from a terminal' },
        { flags: '-l, --list', desc: 'list compressed file contents' },
        { flags: '-q, --quiet', desc: 'suppress all warnings' },
        { flags: '-t, --test', desc: 'test compressed file integrity' },
        { flags: '-v, --verbose', desc: 'verbose mode' },
      ],
      examples: [
        { cmd: 'zcat notes.txt.gz', desc: 'Print the contents of a compressed file.' },
        { cmd: 'zcat access.log.gz | grep 404', desc: 'Search inside a compressed log.' },
      ],
      seeAlso: ['gzip', 'gunzip', 'cat'],
    },
  };
  const def: CommandDef = {
    name,
    pkg: 'gzip',
    size: name === 'gzip' ? 98136 : 2346,
    gnu: false,
    doc: docs[name],
    run: async (ctx) => gzMain(ctx, name, def),
  };
  return def;
}

async function gzMain(ctx: CommandContext, name: 'gzip' | 'gunzip' | 'zcat', def: CommandDef): Promise<number> {
  let parsed;
  try {
    parsed = parseOpts(ctx.args, {
      short: 'cdfhklLnNqrS:tvV123456789',
      long: {
        stdout: 'c', 'to-stdout': 'c', decompress: 'd', uncompress: 'd', force: 'f', help: 'h', keep: 'k', list: 'l', license: 'L',
        'no-name': 'n', name: 'N', quiet: 'q', silent: 'q', recursive: 'r', suffix: { key: 'S', arg: 'required' }, test: 't',
        verbose: 'v', version: 'V', fast: '1', best: '9', rsyncable: 'R', synchronous: 'Y', 'no-rsyncable': 'R',
      },
    });
  } catch (e) {
    if (e instanceof OptError) {
      await ctx.err(`gzip: ${e.message}\nTry \`gzip --help' for more information.\n`);
      return 1;
    }
    throw e;
  }
  if (parsed.has('h')) {
    await ctx.out(gnuHelp(def));
    return 0;
  }
  if (parsed.has('V') || parsed.has('L')) {
    await ctx.out('gzip 1.12\nCopyright (C) 2018 Free Software Foundation, Inc.\nCopyright (C) 1993 Jean-loup Gailly.\nThis is free software.  You may redistribute copies of it under the terms of\nthe GNU General Public License <https://www.gnu.org/licenses/gpl.html>.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by Jean-loup Gailly.\n');
    return 0;
  }
  let level = 6;
  for (const { key } of parsed.list) if (/^[1-9]$/.test(key)) level = Number(key);
  const suffix = parsed.get('S') ?? '.gz';
  if (suffix === '') {
    await ctx.err('gzip: invalid suffix \'\'\n');
    return 1;
  }
  const o: GzOpts = {
    stdout: parsed.has('c') || name === 'zcat',
    decompress: parsed.has('d') || name !== 'gzip',
    force: parsed.has('f'),
    keep: parsed.has('k'),
    list: parsed.has('l'),
    noName: parsed.has('n'),
    name: parsed.has('N'),
    quiet: parsed.has('q'),
    recursive: parsed.has('r'),
    suffix,
    test: parsed.has('t'),
    verbose: parsed.has('v') && !parsed.has('q'),
    level,
  };
  const r: GzRun = { ctx, o, errors: false, warnings: false, listHeaderDone: false, totals: { c: 0, u: 0, header: 0, n: 0 } };
  const files = parsed.operands.length ? parsed.operands : ['-'];
  for (const f of files) {
    if (f === '-') await gzStdin(r);
    else await gzFile(r, f, true);
  }
  if (o.list && files.length > 1 && r.totals.n > 0) await gzListTotals(r);
  if (r.errors) return 1;
  return r.warnings ? 2 : 0;
}

for (const n of ['gzip', 'gunzip', 'zcat'] as const) defineCommand(gzDef(n));

// ===========================================================================
// zip

/** Archive size: local headers + data + central directory + end record. */
function zipSize(entries: ZipEntry[]): number {
  let n = 22;
  for (const e of entries) {
    const nl = utf8(e.name).length;
    n += 30 + nl + 28 + e.csize + 46 + nl + 24;
  }
  return n;
}

function zipDescription(entries: ZipEntry[]): string {
  if (entries.length === 0) return 'Zip archive data (empty)';
  const first = entries[0];
  return first.method === 'deflate' ? 'Zip archive data, at least v2.0 to extract, compression method=deflate' : 'Zip archive data, at least v1.0 to extract, compression method=store';
}

export function makeZipBlob(entries: ZipEntry[]): BlobData {
  const payload: ZipPayload = { format: 'zip', entries };
  return { kind: 'blob', description: zipDescription(entries), payload, size: zipSize(entries) };
}

function zipPercent(size: number, csize: number): number {
  return size > csize && size > 0 ? Math.round(((size - csize) * 100) / size) : 0;
}

function zipEntryFor(name: string, kind: ZipEntry['kind'], node: Inode, data: FileData | undefined, level: number): ZipEntry {
  const size = data === undefined ? 0 : dataSize(data);
  let method: ZipEntry['method'] = 'store';
  let csize = size;
  if (kind !== 'dir' && level > 0 && size > 0) {
    const d = contentDeflated(data, level);
    if (d < size) {
      method = 'deflate';
      csize = d;
    }
  }
  return { name, kind, mode: node.mode & 0o7777, mtime: node.mtime, size, csize, method, crc: contentCrc(data), data: data === undefined ? undefined : typeof data === 'string' ? data : { ...data } };
}

const ZIP_USAGE =
  `Copyright (c) 1990-2008 Info-ZIP - Type 'zip "-L"' for software license.\n` +
  'Zip 3.0 (July 5th 2008). Usage:\n' +
  'zip [-options] [-b path] [-t mmddyyyy] [-n suffixes] [zipfile list] [-xi list]\n' +
  '  The default action is to add or replace zipfile entries from list, which\n' +
  '  can include the special name - to compress standard input.\n' +
  '  If zipfile and list are omitted, zip compresses stdin to stdout.\n' +
  '  -f   freshen: only changed files  -u   update: only changed or new files\n' +
  '  -d   delete entries in zipfile    -m   move into zipfile (delete OS files)\n' +
  '  -r   recurse into directories     -j   junk (don\'t record) directory names\n' +
  '  -0   store only                   -l   convert LF to CR LF (-ll CR LF to LF)\n' +
  '  -1   compress faster              -9   compress better\n' +
  '  -q   quiet operation              -v   verbose operation/print version info\n' +
  '  -c   add one-line comments        -z   add zipfile comment\n' +
  '  -@   read names from stdin        -o   make zipfile as old as latest entry\n' +
  '  -x   exclude the following names  -i   include only the following names\n' +
  '  -F   fix zipfile (-FF try harder) -D   do not add directory entries\n' +
  '  -A   adjust self-extracting exe   -J   junk zipfile prefix (unzipsfx)\n' +
  '  -T   test zipfile integrity       -X   eXclude eXtra file attributes\n' +
  '  -y   store symbolic links as the link instead of the referenced file\n' +
  '  -e   encrypt                      -n   don\'t compress these suffixes\n' +
  '  -h2  show more help\n\n';

const ZIP_VERSION =
  `Copyright (c) 1990-2008 Info-ZIP - Type 'zip "-L"' for software license.\n` +
  'This is Zip 3.0 (July 5th 2008), by Info-ZIP.\n' +
  'Currently maintained by E. Gordon.  Please send bug reports to\n' +
  'the authors using the web page at www.info-zip.org; see README for details.\n\n' +
  'Latest sources and executables are at ftp://ftp.info-zip.org/pub/infozip,\n' +
  'as of above date; see http://www.info-zip.org/ for other sites.\n\n' +
  'Compiled with gcc 13.2.0 for Unix (Linux ELF).\n';

/** Read a zip archive file; returns entries, null when the file is missing, or 'invalid'. */
function readZipEntries(ctx: CommandContext, path: string): ZipEntry[] | null | 'invalid' {
  const node = ctx.fs.tryStat(path);
  if (!node || node.type !== 'file') return null;
  const data = asBinary(node.data);
  if (dataSize(data) === 0) return [];
  const p = archivePayload(data);
  if (!p || p.format !== 'zip') return 'invalid';
  return p.entries.map((e) => ({ ...e }));
}

const ZIP_DEF: CommandDef = {
  name: 'zip',
  pkg: 'zip',
  size: 220464,
  gnu: false,
  doc: {
    category: 'archives',
    summary: 'package and compress (archive) files',
    synopsis: ['zip [-options] zipfile file...', 'zip -r zipfile directory...', 'zip -d zipfile entry...'],
    description:
      'zip is a compression and file packaging utility. It puts one or more files into a single zip archive, compressing them along the way. Zip files are the most common archive format on Windows and macOS, so they are a good choice for sharing files with people who do not use Linux.\n\n' +
      'If the zip file already exists, the named files are added to it, and entries with the same names are replaced ("updating:"). If the zip file name has no extension, .zip is added.\n\n' +
      'To include everything inside a directory you must use -r. Without it, zip only stores the empty directory entry itself.',
    options: [
      { flags: '-r', desc: 'travel the directory structure recursively' },
      { flags: '-q', desc: 'quiet operation' },
      { flags: '-v', desc: 'verbose operation, or print version information when used alone' },
      { flags: '-0', desc: 'store files without compressing them' },
      { flags: '-1 ... -9', desc: 'compress faster (-1) or better (-9); the default is -6' },
      { flags: '-j', desc: 'junk paths: store just the file names, not the directories' },
      { flags: '-d', desc: 'delete entries from the zip archive' },
      { flags: '-u', desc: 'update: only add files that are new or changed' },
      { flags: '-f', desc: 'freshen: only replace entries whose files changed' },
      { flags: '-m', desc: 'move the files into the archive (delete the originals)' },
      { flags: '-x pattern...', desc: 'exclude files matching the patterns' },
      { flags: '-D', desc: 'do not add directory entries' },
      { flags: '-y', desc: 'store symbolic links as links instead of the files they point to' },
      { flags: '-T', desc: 'test the integrity of the new zip file' },
    ],
    examples: [
      { cmd: 'zip notes.zip notes.txt todo.txt', desc: 'Create notes.zip containing two files.' },
      { cmd: 'zip -r project.zip project', desc: 'Zip a whole directory (note the -r).' },
      { cmd: "zip -r site.zip site -x '*.log'", desc: 'Zip a directory but leave out log files.' },
      { cmd: 'zip -d project.zip project/secret.txt', desc: 'Remove one file from an archive.' },
    ],
    seeAlso: ['unzip', 'tar', 'gzip'],
    tip: 'Forgetting -r is the classic zip mistake: "zip backup.zip folder" stores only the empty folder. Use "zip -r backup.zip folder".',
  },
  run: async (ctx) => zipMain(ctx),
};

async function zipMain(ctx: CommandContext): Promise<number> {
  const args = ctx.args;
  if (args.includes('--help') || args.includes('-h') || args.includes('-?')) {
    await ctx.out(ZIP_USAGE);
    return 0;
  }
  if (args.length === 0) {
    if (ctx.stdout.isTTY || ctx.stdin.isTTY) {
      await ctx.out(ZIP_USAGE);
      return 0;
    }
  }
  if (args.length === 1 && (args[0] === '-v' || args[0] === '--version')) {
    await ctx.out(ZIP_VERSION);
    return 0;
  }
  let recurse = false;
  let quiet = false;
  let level = 6;
  let junk = false;
  let del = false;
  let update = false;
  let freshen = false;
  let move = false;
  let noDirs = false;
  let symlinks = false;
  let test = false;
  let fromStdin = false;
  const excludes: string[] = [];
  const includes: string[] = [];
  const operands: string[] = [];
  let listMode: 'x' | 'i' | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const long: Record<string, string> = { '--recurse-paths': 'r', '--quiet': 'q', '--junk-paths': 'j', '--delete': 'd', '--update': 'u', '--freshen': 'f', '--move': 'm', '--no-dir-entries': 'D', '--symlinks': 'y', '--test': 'T', '--exclude': 'x', '--include': 'i' };
      const c = long[a];
      if (!c) {
        await ctx.out(`\nzip error: Invalid command arguments (long option '${a.slice(2)}' not supported)\n`);
        return 16;
      }
      if (c === 'x' || c === 'i') listMode = c;
      else if (c === 'r') recurse = true;
      else if (c === 'q') quiet = true;
      else if (c === 'j') junk = true;
      else if (c === 'd') del = true;
      else if (c === 'u') update = true;
      else if (c === 'f') freshen = true;
      else if (c === 'm') move = true;
      else if (c === 'D') noDirs = true;
      else if (c === 'y') symlinks = true;
      else if (c === 'T') test = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      listMode = null;
      for (const c of a.slice(1)) {
        if (/[0-9]/.test(c)) level = Number(c);
        else if (c === 'r' || c === 'R') recurse = true;
        else if (c === 'q') quiet = true;
        else if (c === 'j') junk = true;
        else if (c === 'd') del = true;
        else if (c === 'u') update = true;
        else if (c === 'f') freshen = true;
        else if (c === 'm') move = true;
        else if (c === 'D') noDirs = true;
        else if (c === 'y') symlinks = true;
        else if (c === 'T') test = true;
        else if (c === '@') fromStdin = true;
        else if (c === 'x' || c === 'i') listMode = c;
        else if (c === 'v' || c === 'o' || c === 'X' || c === 'l') continue;
        else {
          await ctx.out(`\nzip error: Invalid command arguments (short option '${c}' not supported)\n`);
          return 16;
        }
      }
      continue;
    }
    if (listMode === 'x') excludes.push(a);
    else if (listMode === 'i') includes.push(a);
    else operands.push(a);
  }
  if (operands.length === 0) {
    await ctx.out('\nzip error: Nothing to do! (try: zip -h for help)\n');
    return 12;
  }
  let zipName = operands[0];
  if (!basename(zipName).includes('.')) zipName += '.zip';
  const names = operands.slice(1);
  if (fromStdin) names.push(...(await ctx.stdin.readAll()).split('\n').map((s) => s.trim()).filter(Boolean));
  const existing = readZipEntries(ctx, zipName);
  if (existing === 'invalid') {
    await ctx.out(`\tzip warning: missing end signature--probably not a zip file (did you\n\tzip warning: remember to use binary mode when you transferred it?)\n\tzip warning: (if you are trying to read a damaged archive try -F)\n\nzip error: Zip file structure invalid (${zipName})\n`);
    return 3;
  }
  const entries: ZipEntry[] = existing ?? [];
  if (del) {
    if (!existing) {
      await ctx.out(`\tzip warning: ${zipName} not found or empty\n\nzip error: Nothing to do! (${zipName})\n`);
      return 12;
    }
    const kept: ZipEntry[] = [];
    const matched = new Set<string>();
    for (const e of entries) {
      const m = names.find((n) => wildMatch(n, e.name) || n === e.name);
      if (m !== undefined) {
        matched.add(m);
        if (!quiet) await ctx.out(`deleting: ${e.name}\n`);
      } else kept.push(e);
    }
    for (const n of names) if (!matched.has(n)) await ctx.out(`\tzip warning: name not matched: ${n}\n`);
    if (matched.size === 0) {
      await ctx.out(`\nzip error: Nothing to do! (${zipName})\n`);
      return 12;
    }
    ctx.fs.writeFile(zipName, makeZipBlob(kept));
    return 0;
  }
  // Collect files.
  const found: { name: string; kind: ZipEntry['kind']; node: Inode; data?: FileData; path: string }[] = [];
  const zipNode = ctx.fs.tryStat(zipName);
  let warned = false;
  const add = async (path: string, top: boolean): Promise<void> => {
    await ctx.checkpoint();
    const node = symlinks ? ctx.fs.tryStat(path, false) : ctx.fs.tryStat(path);
    if (!node) {
      if (top) {
        warned = true;
        await ctx.out(`\tzip warning: name not matched: ${path}\n`);
      }
      return;
    }
    if (zipNode && node === zipNode) return;
    let name = path.replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    if (junk) name = basename(name);
    if (excludes.some((p) => wildMatch(p, name) || wildMatch(p, name + '/'))) return;
    if (node.type === 'dir') {
      if (!junk && !noDirs && name !== '' && name !== '.') {
        const dname = name.replace(/\/+$/, '') + '/';
        if (includes.length === 0 || includes.some((p) => wildMatch(p, dname))) found.push({ name: dname, kind: 'dir', node, path });
      }
      if (!recurse) return;
      let kids: string[];
      try {
        kids = ctx.fs.readdir(path).sort(byteOrder);
      } catch {
        await ctx.out(`\tzip warning: could not open for reading: ${path}\n`);
        return;
      }
      for (const k of kids) await add(path === '.' ? k : path.replace(/\/+$/, '') + '/' + k, false);
      return;
    }
    if (includes.length && !includes.some((p) => wildMatch(p, name))) return;
    if (node.type === 'symlink') {
      found.push({ name, kind: 'symlink', node, data: node.target, path });
      return;
    }
    if (node.type !== 'file') return;
    let data: FileData;
    try {
      data = asBinary(ctx.fs.readData(path));
    } catch {
      await ctx.out(`\tzip warning: could not open for reading: ${path}\n`);
      return;
    }
    found.push({ name, kind: 'file', node, data, path });
  };
  for (const n of names) await add(n, true);
  let changed = 0;
  const added: string[] = [];
  for (const f of found) {
    const idx = entries.findIndex((e) => e.name === f.name);
    if ((update || freshen) && idx !== -1 && Math.floor(entries[idx].mtime / 2000) >= Math.floor(f.node.mtime / 2000)) continue;
    if (freshen && idx === -1) continue;
    const entry = zipEntryFor(f.name, f.kind, f.node, f.data, level);
    const how = entry.method === 'deflate' ? `deflated ${zipPercent(entry.size, entry.csize)}%` : 'stored 0%';
    if (idx !== -1) {
      entries[idx] = entry;
      if (!quiet) await ctx.out(`updating: ${f.name} (${how})\n`);
    } else {
      entries.push(entry);
      if (!quiet) await ctx.out(`  adding: ${f.name} (${how})\n`);
    }
    added.push(f.path);
    changed++;
  }
  if (changed === 0) {
    if (update || freshen) return 12;
    if (warned || found.length === 0) {
      await ctx.out(`\nzip error: Nothing to do! (${zipName})\n`);
      return 12;
    }
  }
  const blob = makeZipBlob(entries);
  try {
    checkArchiveSpace(ctx, blob, zipName);
    ctx.fs.writeFile(zipName, blob);
  } catch (e) {
    await ctx.out(`\nzip error: Could not create output file (${zipName}): ${errText(e)}\n`);
    return 15;
  }
  if (move) {
    for (const p of added.reverse()) {
      try {
        const n = ctx.fs.tryStat(p, false);
        if (n?.type === 'dir') ctx.fs.rmdir(p);
        else ctx.fs.unlink(p);
      } catch {
        // leave it
      }
    }
  }
  if (test) await ctx.out(`test of ${zipName} OK\n`);
  return 0;
}

defineCommand(ZIP_DEF);

// ===========================================================================
// unzip

const UNZIP_USAGE =
  'UnZip 6.00 of 20 April 2009, by Debian. Original by Info-ZIP.\n\n' +
  'Usage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]\n' +
  '  Default action is to extract files in list, except those in xlist, to exdir;\n' +
  '  file[.zip] may be a wildcard.  -Z => ZipInfo mode ("unzip -Z" for usage).\n\n' +
  '  -p  extract files to pipe, no messages     -l  list files (short format)\n' +
  '  -f  freshen existing files, create none    -t  test compressed archive data\n' +
  '  -u  update files, create if necessary      -z  display archive comment only\n' +
  '  -v  list verbosely/show version info       -T  timestamp archive to latest\n' +
  '  -x  exclude files that follow (in xlist)   -d  extract files into exdir\n' +
  'modifiers:\n' +
  '  -n  never overwrite existing files         -q  quiet mode (-qq => quieter)\n' +
  '  -o  overwrite files WITHOUT prompting      -a  auto-convert any text files\n' +
  '  -j  junk paths (do not make directories)   -aa treat ALL files as text\n' +
  '  -U  use escapes for all non-ASCII Unicode  -UU ignore any Unicode fields\n' +
  '  -C  match filenames case-insensitively     -L  make (some) names lowercase\n' +
  '  -X  restore UID/GID info                   -V  retain VMS version numbers\n' +
  '  -K  keep setuid/setgid/tacky permissions   -M  pipe through "more" pager\n' +
  '  -O CHARSET  specify a character encoding for DOS, Windows and OS/2 archives\n' +
  '  -I CHARSET  specify a character encoding for UNIX and other archives\n\n' +
  'See "unzip -hh" or unzip.txt for more help.  Examples:\n' +
  '  unzip data1 -x joe   => extract all files except joe from zipfile data1.zip\n' +
  '  unzip -p foo | more  => send contents of foo.zip via pipe into program more\n' +
  '  unzip -fo foo ReadMe => quietly replace existing ReadMe if archive file newer\n';

function zipDate(ms: number): string {
  return localStamp(ms);
}

const UNZIP_DEF: CommandDef = {
  name: 'unzip',
  pkg: 'unzip',
  size: 182680,
  gnu: false,
  doc: {
    category: 'archives',
    summary: 'list, test and extract compressed files in a ZIP archive',
    synopsis: ['unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]'],
    description:
      'unzip extracts the files stored in a .zip archive into the current directory (or into the directory given with -d), recreating the folders stored in the archive. It can also list (-l) or test (-t) an archive without extracting anything.\n\n' +
      'When a file being extracted already exists, unzip asks what to do: y (yes), n (no), A (all), N (none) or r (rename). Use -o to overwrite without asking or -n to never overwrite.',
    options: [
      { flags: '-l', desc: 'list archive files (short format)' },
      { flags: '-v', desc: 'list archive files verbosely, with compression method, ratio and CRC' },
      { flags: '-t', desc: 'test archive files: check that every file can be extracted' },
      { flags: '-p', desc: 'extract files to standard output (no messages)' },
      { flags: '-d exdir', desc: 'extract files into directory exdir' },
      { flags: '-o', desc: 'overwrite existing files without prompting' },
      { flags: '-n', desc: 'never overwrite existing files' },
      { flags: '-j', desc: 'junk paths: put every file in the same directory' },
      { flags: '-q', desc: 'quiet mode (-qq for even quieter)' },
      { flags: '-x xlist', desc: 'exclude the listed files' },
      { flags: '-Z1', desc: 'print just the file names, one per line' },
    ],
    examples: [
      { cmd: 'unzip project.zip', desc: 'Extract everything into the current directory.' },
      { cmd: 'unzip -l project.zip', desc: 'See what is inside before extracting.' },
      { cmd: 'unzip project.zip -d /tmp/project', desc: 'Extract into another directory.' },
      { cmd: 'unzip project.zip README.md', desc: 'Extract a single file.' },
    ],
    seeAlso: ['zip', 'tar', 'gunzip'],
    tip: 'Run unzip -l first to see whether the archive has its own top-level folder; otherwise its files will spill into the current directory.',
  },
  run: async (ctx) => unzipMain(ctx),
};

async function unzipMain(ctx: CommandContext): Promise<number> {
  const args = ctx.args;
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    await ctx.out(UNZIP_USAGE);
    return 0;
  }
  let list = false;
  let verboseList = false;
  let test = false;
  let pipe = false;
  let overwrite: 'ask' | 'always' | 'never' = 'ask';
  let junk = false;
  let quiet = 0;
  let zipinfo1 = false;
  let zipinfo = false;
  let exdir: string | null = null;
  const members: string[] = [];
  const excludes: string[] = [];
  let zipArg: string | null = null;
  let inExclude = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-') && a.length > 1) {
      inExclude = false;
      if (a === '-Z1') {
        zipinfo1 = true;
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (c === 'l') list = true;
        else if (c === 'v') verboseList = true;
        else if (c === 't') test = true;
        else if (c === 'p') pipe = true;
        else if (c === 'c') pipe = true;
        else if (c === 'o') overwrite = 'always';
        else if (c === 'n') overwrite = 'never';
        else if (c === 'j') junk = true;
        else if (c === 'q') quiet++;
        else if (c === 'Z') {
          if (a[j + 1] === '1') zipinfo1 = true;
          else zipinfo = true;
          break;
        } else if (c === 'x') inExclude = true;
        else if (c === 'd') {
          const rest = a.slice(j + 1);
          if (rest) exdir = rest;
          else if (i + 1 < args.length) exdir = args[++i];
          else {
            await ctx.err('error:  must specify directory to which to extract with -d option\n');
            return 10;
          }
          break;
        } else if ('afuzTCLXVKMaUOI'.includes(c)) continue;
        else {
          await ctx.out(UNZIP_USAGE);
          return 10;
        }
      }
      continue;
    }
    if (inExclude) excludes.push(a);
    else if (zipArg === null) zipArg = a;
    else members.push(a);
  }
  if (zipArg === null) {
    if (verboseList) {
      await ctx.out('UnZip 6.00 of 20 April 2009, by Debian. Original by Info-ZIP.\n\nLatest sources and executables are at ftp://ftp.info-zip.org/pub/infozip/ ;\nsee ftp://ftp.info-zip.org/pub/infozip/UnZip.html for other sites.\n');
      return 0;
    }
    await ctx.out(UNZIP_USAGE);
    return 0;
  }
  // Find the archive: name, name.zip, name.ZIP
  let path: string | null = null;
  for (const cand of [zipArg, zipArg + '.zip', zipArg + '.ZIP']) {
    const n = ctx.fs.tryStat(cand);
    if (n && n.type === 'file') {
      path = cand;
      break;
    }
  }
  if (!path) {
    await ctx.err(`unzip:  cannot find or open ${zipArg}, ${zipArg}.zip or ${zipArg}.ZIP.\n`);
    return 9;
  }
  const entries = readZipEntries(ctx, path);
  if (entries === null || entries === 'invalid') {
    if (!pipe && !zipinfo1) await ctx.out(`Archive:  ${path}\n`);
    await ctx.err(`  End-of-central-directory signature not found.  Either this file is not\n  a zipfile, or it constitutes one disk of a multi-part archive.  In the\n  latter case the central directory and zipfile comment will be found on\n  the last disk(s) of this archive.\nunzip:  cannot find zipfile directory in one of ${zipArg} or\n        ${zipArg}.zip, and cannot find ${zipArg}.ZIP, period.\n`);
    return 9;
  }
  const selected = entries.filter((e) => {
    if (members.length && !members.some((m) => wildMatch(m, e.name) || m === e.name)) return false;
    if (excludes.some((x) => wildMatch(x, e.name))) return false;
    return true;
  });
  const unmatched = members.filter((m) => !entries.some((e) => wildMatch(m, e.name) || m === e.name));
  const caution = async () => {
    for (const m of unmatched) await ctx.err(`caution: filename not matched:  ${m}\n`);
  };
  if (zipinfo1) {
    for (const e of selected) await ctx.out(e.name + '\n');
    return 0;
  }
  if (zipinfo) {
    const blobSize = zipSize(entries);
    let out = `Archive:  ${path}\nZip file size: ${blobSize} bytes, number of entries: ${entries.length}\n`;
    let tu = 0;
    let tc = 0;
    for (const e of selected) {
      const d = new Date(e.mtime);
      const t = e.kind === 'dir' ? 'd' : e.kind === 'symlink' ? 'l' : '-';
      const kind = e.kind === 'dir' ? 'bx' : typeof e.data === 'string' ? 'tx' : 'bx';
      const meth = e.method === 'deflate' ? 'defN' : 'stor';
      out += `${permString(t, e.mode)}  3.0 unx ${String(e.size).padStart(8)} ${kind} ${meth} ${String(d.getFullYear() % 100).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())} ${e.name}\n`;
      tu += e.size;
      tc += e.csize;
    }
    const pct = tu === 0 ? 0 : ((tu - tc) * 100) / tu;
    out += `${selected.length} file${selected.length === 1 ? '' : 's'}, ${tu} bytes uncompressed, ${tc} bytes compressed:  ${pct.toFixed(1)}%\n`;
    await ctx.out(out);
    return 0;
  }
  if (list || verboseList) {
    let out = `Archive:  ${path}\n`;
    let tu = 0;
    let tc = 0;
    if (verboseList) {
      out += ' Length   Method    Size  Cmpr    Date    Time   CRC-32   Name\n--------  ------  ------- ---- ---------- ----- --------  ----\n';
      for (const e of selected) {
        const meth = e.method === 'deflate' ? 'Defl:N' : 'Stored';
        out += `${String(e.size).padStart(8)}  ${meth} ${String(e.csize).padStart(8)} ${String(zipPercent(e.size, e.csize)).padStart(3)}% ${zipDate(e.mtime)} ${e.crc.toString(16).padStart(8, '0')}  ${e.name}\n`;
        tu += e.size;
        tc += e.csize;
      }
      out += '--------          -------  ---                            -------\n';
      out += `${String(tu).padStart(8)}         ${String(tc).padStart(8)} ${String(zipPercent(tu, tc)).padStart(3)}%                            ${selected.length} file${selected.length === 1 ? '' : 's'}\n`;
    } else {
      out += '  Length      Date    Time    Name\n---------  ---------- -----   ----\n';
      for (const e of selected) {
        out += `${String(e.size).padStart(9)}  ${zipDate(e.mtime)}   ${e.name}\n`;
        tu += e.size;
      }
      out += '---------                     -------\n';
      out += `${String(tu).padStart(9)}                     ${selected.length} file${selected.length === 1 ? '' : 's'}\n`;
    }
    await ctx.out(out);
    await caution();
    return unmatched.length ? 11 : 0;
  }
  if (test) {
    if (quiet < 1) await ctx.out(`Archive:  ${path}\n`);
    for (const e of selected) if (quiet < 1) await ctx.out(`    testing: ${e.name.padEnd(22)}   OK\n`);
    if (quiet < 2) await ctx.out(`No errors detected in compressed data of ${path}.\n`);
    await caution();
    return unmatched.length ? 11 : 0;
  }
  if (pipe) {
    for (const e of selected) if (e.kind === 'file' && e.data !== undefined) await writeDataToStdout(ctx, e.data);
    await caution();
    return unmatched.length ? 11 : 0;
  }
  // Extract.
  if (quiet < 1) await ctx.out(`Archive:  ${path}\n`);
  let base = '.';
  if (exdir !== null) {
    const n = ctx.fs.tryStat(exdir);
    if (!n) {
      try {
        ctx.fs.mkdir(exdir);
      } catch (e) {
        await ctx.err(`checkdir:  cannot create extraction directory: ${exdir}\n           ${errText(e)}\n`);
        return 3;
      }
    } else if (n.type !== 'dir') {
      await ctx.err(`checkdir error:  ${exdir} exists but is not directory\n                 unable to process ${exdir}.\n`);
      return 3;
    }
    base = exdir;
  }
  const show = (rel: string) => (base === '.' ? rel : joinPath(base, rel));
  let status = 0;
  let replaceAll = overwrite === 'always';
  let replaceNone = overwrite === 'never';
  const dirTimes: { path: string; e: ZipEntry }[] = [];
  const deferred: { name: string; target: string }[] = [];
  for (const e of selected) {
    await ctx.checkpoint();
    let rel = e.name.replace(/^\/+/, '');
    if (rel.split('/').includes('..')) {
      await ctx.err(`warning:  skipped "../" path component(s) in ${e.name}\n`);
      rel = rel.split('/').filter((p) => p !== '..').join('/');
    }
    if (junk) {
      if (e.kind === 'dir') continue;
      rel = basename(rel);
    }
    const target = joinPath(base, rel.replace(/\/+$/, ''));
    try {
      if (e.kind === 'dir') {
        const n = ctx.fs.tryStat(target);
        if (!n) {
          mkdirParents(ctx, dirname(target));
          ctx.fs.mkdir(target);
          if (quiet < 1) await ctx.out(`   creating: ${show(rel)}\n`);
        }
        dirTimes.push({ path: target, e });
        continue;
      }
      if (ctx.fs.tryStat(target, false)) {
        if (replaceNone) continue;
        if (!replaceAll) {
          let decided = false;
          let skip = false;
          let renamed: string | null = null;
          while (!decided) {
            await ctx.out(`replace ${show(rel)}? [y]es, [n]o, [A]ll, [N]one, [r]ename: `);
            const line = await ctx.stdin.readLine();
            if (line === null) {
              await ctx.out(' NULL\n(EOF or read error, treating as "[N]one" ...)\n');
              replaceNone = true;
              skip = true;
              status = 1;
              break;
            }
            const ans = line.replace(/\n$/, '').trim();
            if (ans.startsWith('y')) decided = true;
            else if (ans.startsWith('n')) {
              decided = true;
              skip = true;
            } else if (ans.startsWith('A')) {
              replaceAll = true;
              decided = true;
            } else if (ans.startsWith('N')) {
              replaceNone = true;
              decided = true;
              skip = true;
            } else if (ans.startsWith('r')) {
              await ctx.out('new name: ');
              const nn = await ctx.stdin.readLine();
              if (nn === null || nn.trim() === '') continue;
              renamed = nn.trim();
              decided = true;
            } else {
              await ctx.out(`error:  invalid response [${ans}]\n`);
            }
          }
          if (skip) continue;
          if (renamed) {
            rel = renamed;
          }
        }
      }
      const finalTarget = joinPath(base, rel.replace(/\/+$/, ''));
      mkdirParents(ctx, dirname(finalTarget));
      const existing = ctx.fs.tryStat(finalTarget, false);
      if (existing) ctx.fs.unlink(finalTarget);
      if (e.kind === 'symlink') {
        const tgt = typeof e.data === 'string' ? e.data : '';
        if (quiet < 1) await ctx.out(`    linking: ${show(rel).padEnd(22)}  -> ${tgt} \n`);
        deferred.push({ name: finalTarget, target: tgt });
        continue;
      }
      if (quiet < 1) await ctx.out(`${e.method === 'deflate' ? '  inflating' : ' extracting'}: ${show(rel).padEnd(22)}  \n`);
      const data = e.data ?? '';
      ctx.fs.writeFile(finalTarget, typeof data === 'string' ? data : { ...data }, { mode: 0o600 });
      ctx.fs.chmod(finalTarget, e.mode & 0o777);
      ctx.fs.setTimes(finalTarget, ctx.system.now(), e.mtime);
    } catch (err) {
      await ctx.err(`error:  cannot create ${show(rel)}\n        ${errText(err)}\n`);
      status = 50;
    }
  }
  if (deferred.length) {
    if (quiet < 1) await ctx.out('finishing deferred symbolic links:\n');
    for (const d of deferred) {
      if (quiet < 1) await ctx.out(`  ${(base === '.' ? d.name : d.name).padEnd(22)} -> ${d.target}\n`);
      try {
        ctx.fs.symlink(d.target, d.name);
      } catch (err) {
        await ctx.err(`error:  cannot create symlink ${d.name}: ${errText(err)}\n`);
      }
    }
  }
  for (const { path: p, e } of dirTimes.reverse()) {
    try {
      ctx.fs.chmod(p, e.mode & 0o777);
      ctx.fs.setTimes(p, ctx.system.now(), e.mtime);
    } catch {
      // ignore
    }
  }
  await caution();
  if (unmatched.length && status === 0) status = 11;
  return status;
}

defineCommand(UNZIP_DEF);
