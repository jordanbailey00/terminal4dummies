// Byte viewers: od, xxd, hexdump (and hd). They show what is really inside
// a file, which makes invisible characters (tabs, \r, trailing spaces) visible.

import type { CommandContext } from '../types';
import { FsError } from '../vfs/fs';
import { defineCommand, deviceStream, errText, getopts, qf, readUpTo } from './util';

const enc = new TextEncoder();

/**
 * Concatenated input of all operands (like cat); reports unreadable files.
 * At most `max` bytes are read, so `od -N 16 /dev/urandom` stops (endless
 * devices are cut off after 64 KiB anyway).
 */
async function readInput(ctx: CommandContext, files: string[], label = ctx.name, max = Infinity): Promise<{ bytes: Uint8Array; ok: boolean }> {
  const parts: Uint8Array[] = [];
  let ok = true;
  let have = 0;
  for (const f of files.length ? files : ['-']) {
    if (have >= max) break;
    try {
      let text: string;
      if (f === '-') text = Number.isFinite(max) ? await readUpTo(ctx.stdin, max - have, ctx.signal) : await ctx.stdin.readAll();
      else {
        const node = ctx.fs.stat(f);
        if (node.type === 'dir') throw new FsError('EISDIR', f);
        const dev = deviceStream(ctx, f);
        text = dev ? await readUpTo(dev, Math.min(max - have, 65536), ctx.signal) : ctx.fs.readFile(f);
      }
      const b = enc.encode(text);
      parts.push(b);
      have += b.length;
    } catch (e) {
      await ctx.err(`${label}: ${qf(f)}: ${errText(e)}\n`);
      ok = false;
    }
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, ok };
}

function printable(b: number): boolean {
  return b >= 0x20 && b < 0x7f;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// od

interface OdSpec {
  kind: 'a' | 'c' | 'd' | 'o' | 'u' | 'x';
  size: 1 | 2 | 4 | 8;
  /** -t x1z: show the characters after the line */
  trailer: boolean;
}

const OD_DIGITS: Record<OdSpec['kind'], Record<number, number>> = {
  a: { 1: 3 },
  c: { 1: 3 },
  d: { 1: 4, 2: 6, 4: 11, 8: 20 },
  o: { 1: 3, 2: 6, 4: 11, 8: 22 },
  u: { 1: 3, 2: 5, 4: 10, 8: 20 },
  x: { 1: 2, 2: 4, 4: 8, 8: 16 },
};

const CHAR_NAMES = ['nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', 'bs', 'ht', 'nl', 'vt', 'ff', 'cr', 'so', 'si', 'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us', 'sp'];
const C_ESCAPES: Record<number, string> = { 0: '\\0', 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v' };

function parseOdType(t: string): OdSpec[] | null {
  const out: OdSpec[] = [];
  let i = 0;
  while (i < t.length) {
    const kind = t[i++];
    if (!'acdoux'.includes(kind)) return null;
    let size = kind === 'a' || kind === 'c' ? 1 : 4;
    const m = /^(\d+|[CSIL])/.exec(t.slice(i));
    if (m && kind !== 'a' && kind !== 'c') {
      size = { C: 1, S: 2, I: 4, L: 8 }[m[1]] ?? parseInt(m[1], 10);
      i += m[1].length;
    }
    if (![1, 2, 4, 8].includes(size)) return null;
    let trailer = false;
    if (t[i] === 'z') {
      trailer = true;
      i++;
    }
    out.push({ kind: kind as OdSpec['kind'], size: size as OdSpec['size'], trailer });
  }
  return out;
}

function odValue(spec: OdSpec, bytes: Uint8Array, at: number): string {
  if (spec.kind === 'c') {
    const b = bytes[at];
    return C_ESCAPES[b] ?? (printable(b) ? String.fromCharCode(b) : b.toString(8).padStart(3, '0'));
  }
  if (spec.kind === 'a') {
    const b = bytes[at] & 0x7f;
    return b < 33 ? CHAR_NAMES[b] : b === 127 ? 'del' : String.fromCharCode(b);
  }
  // little-endian, padded with zero bytes past the end
  let v = 0n;
  for (let k = spec.size - 1; k >= 0; k--) v = (v << 8n) | BigInt(bytes[at + k] ?? 0);
  if (spec.kind === 'd') {
    const bits = BigInt(spec.size * 8);
    if (v >= 1n << (bits - 1n)) v -= 1n << bits;
    return v.toString(10);
  }
  if (spec.kind === 'u') return v.toString(10);
  const digits = OD_DIGITS[spec.kind][spec.size];
  return v.toString(spec.kind === 'o' ? 8 : 16).padStart(digits, '0');
}

defineCommand({
  name: 'od',
  pkg: 'coreutils',
  size: 68680,
  doc: {
    category: 'viewing',
    summary: 'dump files in octal and other formats',
    synopsis: ['od [OPTION]... [FILE]...'],
    description:
      'Write an unambiguous representation, octal bytes by default, of FILE to standard output. With more than one FILE argument, concatenate them in the listed order to form the input.\n\nWith no FILE, or when FILE is -, read standard input.\n\nEach line starts with the offset (position) of its first byte, in octal unless -A says otherwise. A line with just * means "the same as the line above, repeated".',
    options: [
      { flags: '-A, --address-radix=RADIX', desc: 'output format for file offsets; RADIX is one of [doxn], for Decimal, Octal, Hex or None' },
      { flags: '-j, --skip-bytes=BYTES', desc: 'skip BYTES input bytes first' },
      { flags: '-N, --read-bytes=BYTES', desc: 'limit dump to BYTES input bytes' },
      { flags: '-t, --format=TYPE', desc: 'select output format or formats: a (named characters), c (characters), d/o/u/x[SIZE] (signed decimal, octal, unsigned decimal, hex); add z to show the characters at the end of each line' },
      { flags: '-v, --output-duplicates', desc: 'do not use * to mark line suppression' },
      { flags: '-w, --width[=BYTES]', desc: 'output BYTES bytes per output line; 32 is implied when BYTES is not specified' },
      { flags: '-a', desc: 'same as -t a, select named characters' },
      { flags: '-b', desc: 'same as -t o1, select octal bytes' },
      { flags: '-c', desc: 'same as -t c, select printable characters or backslash escapes' },
      { flags: '-d', desc: 'same as -t u2, select unsigned decimal 2-byte units' },
      { flags: '-o', desc: 'same as -t o2, select octal 2-byte units' },
      { flags: '-x', desc: 'same as -t x2, select hexadecimal 2-byte units' },
    ],
    examples: [
      { cmd: 'od -c notes.txt', desc: 'Show every character, with \\n for newlines and \\t for tabs.' },
      { cmd: "printf 'a\\tb\\n' | od -c", desc: 'See the hidden tab and newline in some text.' },
      { cmd: 'od -An -t x1 file', desc: 'Hex bytes without offsets.' },
    ],
    seeAlso: ['xxd', 'hexdump', 'cat'],
  },
  run: async (ctx) => {
    // -w takes an optional argument, -t is repeatable
    const opts = await getopts(ctx, {
      short: 'A:j:N:t:vw::abcdiloxs',
      long: {
        'address-radix': { key: 'A', arg: 'required' },
        'skip-bytes': { key: 'j', arg: 'required' },
        'read-bytes': { key: 'N', arg: 'required' },
        format: { key: 't', arg: 'required' },
        'output-duplicates': 'v',
        width: { key: 'w', arg: 'optional' },
      },
    });
    if (!opts) return 1;
    const specs: OdSpec[] = [];
    const legacy: Record<string, OdSpec> = {
      a: { kind: 'a', size: 1, trailer: false },
      b: { kind: 'o', size: 1, trailer: false },
      c: { kind: 'c', size: 1, trailer: false },
      d: { kind: 'u', size: 2, trailer: false },
      o: { kind: 'o', size: 2, trailer: false },
      x: { kind: 'x', size: 2, trailer: false },
      s: { kind: 'd', size: 2, trailer: false },
      i: { kind: 'd', size: 4, trailer: false },
      l: { kind: 'd', size: 8, trailer: false },
    };
    let radix = 'o';
    let skip = 0;
    let limit: number | null = null;
    let width = 16;
    for (const { key, value } of opts.list) {
      if (legacy[key]) specs.push(legacy[key]);
      else if (key === 't') {
        const t = parseOdType(String(value));
        if (!t) {
          await ctx.error(`invalid type string ${qf(String(value))}`);
          return 1;
        }
        specs.push(...t);
      } else if (key === 'A') {
        if (!/^[doxn]$/.test(String(value))) {
          await ctx.error(`invalid output address radix '${value}'; it must be one character from [doxn]`);
          return 1;
        }
        radix = String(value);
      } else if (key === 'j' || key === 'N') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
          await ctx.error(`invalid ${key === 'j' ? '-j' : '-N'} argument ${qf(String(value))}`);
          return 1;
        }
        if (key === 'j') skip = n;
        else limit = n;
      } else if (key === 'w') width = value === true ? 32 : Math.max(1, parseInt(String(value), 10) || 16);
    }
    if (specs.length === 0) specs.push(legacy.o);
    const { bytes: all, ok } = await readInput(ctx, opts.operands, ctx.name, limit === null ? Infinity : skip + limit);
    let data = all.slice(skip);
    if (limit !== null) data = data.slice(0, limit);
    const maxSize = Math.max(...specs.map((s) => s.size));
    if (width % maxSize !== 0) width = Math.max(maxSize, width - (width % maxSize));

    const addrDigits = radix === 'x' ? 6 : 7;
    const addr = (n: number) => (radix === 'n' ? '' : n.toString(radix === 'd' ? 10 : radix === 'x' ? 16 : 8).padStart(addrDigits, '0'));
    const blank = radix === 'n' ? '' : ' '.repeat(addrDigits);
    // pad every format to the same line width so the columns line up (as GNU od does)
    const fieldWidth = (s: OdSpec) => OD_DIGITS[s.kind][s.size];
    const lineWidth = Math.max(...specs.map((s) => (fieldWidth(s) + 1) * (width / s.size)));

    let out = '';
    let prev: Uint8Array | null = null;
    let starred = false;
    for (let off = 0; off < data.length; off += width) {
      const block = data.slice(off, off + width);
      if (!opts.has('v') && prev && block.length === width && sameBytes(block, prev)) {
        if (!starred) out += '*\n';
        starred = true;
        continue;
      }
      starred = false;
      prev = block;
      specs.forEach((s, si) => {
        const fields = width / s.size;
        const shown = Math.ceil(block.length / s.size);
        // spread the padding over the fields the way GNU od does
        const pad = lineWidth - fieldWidth(s) * fields;
        let remaining = pad;
        let line = si === 0 ? addr(skip + off) : blank;
        for (let f = fields; f > fields - shown; f--) {
          const next = Math.floor((pad * (f - 1)) / fields);
          const idx = (fields - f) * s.size;
          line += odValue(s, block, idx).padStart(remaining - next + fieldWidth(s));
          remaining = next;
        }
        if (s.trailer) {
          line += ' '.repeat((fields - shown) * (fieldWidth(s) + 1));
          line += '  >' + [...block].map((b) => (printable(b) ? String.fromCharCode(b) : '.')).join('') + '<';
        }
        out += line + '\n';
      });
      if (out.length > 65536) {
        await ctx.out(out);
        out = '';
        await ctx.checkpoint();
      }
    }
    if (radix !== 'n') out += addr(skip + data.length) + '\n';
    await ctx.out(out);
    return ok ? 0 : 1;
  },
});

// ---------------------------------------------------------------------------
// xxd

defineCommand({
  name: 'xxd',
  pkg: 'xxd',
  size: 18712,
  version: 'xxd 2023-10-25 by Juergen Weigert et al.',
  doc: {
    category: 'viewing',
    summary: 'make a hex dump or do the reverse',
    synopsis: ['xxd [options] [infile [outfile]]', 'xxd -r [-p] [infile [outfile]]'],
    description:
      'xxd creates a hex dump of a given file or standard input. Each line shows the offset, the bytes in hexadecimal, and the same bytes as text (non-printable bytes appear as a dot).\n\nIt can also convert a hex dump back into the original bytes (-r).',
    options: [
      { flags: '-b', desc: 'binary digit dump: show each byte as 8 bits (0s and 1s)' },
      { flags: '-c cols', desc: 'format <cols> octets per line. Default 16 (-i: 12, -p: 30, -b: 6)' },
      { flags: '-g bytes', desc: 'number of octets per group in normal output. Default 2 (-b: 1)' },
      { flags: '-i', desc: 'output in C include file style' },
      { flags: '-l len', desc: 'stop after <len> octets' },
      { flags: '-p', desc: 'output in plain hexdump style (one continuous string of hex digits)' },
      { flags: '-r', desc: 'reverse operation: convert (or patch) hexdump into binary' },
      { flags: '-s seek', desc: 'start at <seek> bytes from the beginning' },
      { flags: '-u', desc: 'use upper case hex letters' },
    ],
    examples: [
      { cmd: 'xxd notes.txt', desc: 'Hex dump of a file.' },
      { cmd: 'echo hi | xxd -p', desc: 'Just the hex digits: 68690a.' },
      { cmd: 'echo 68690a | xxd -r -p', desc: 'Turn hex back into text.' },
    ],
    seeAlso: ['od', 'hexdump'],
  },
  run: async (ctx) => {
    let cols: number | null = null;
    let group: number | null = null;
    let len: number | null = null;
    let seek = 0;
    let mode: 'normal' | 'plain' | 'include' | 'bits' = 'normal';
    let upper = false;
    let reverse = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const num = async (v: string | undefined, what: string): Promise<number | null> => {
        const n = v === undefined ? NaN : Number(v.startsWith('0x') ? parseInt(v, 16) : v);
        if (!Number.isFinite(n) || n < 0) {
          await ctx.err(`xxd: option '${what}' requires an argument\n`);
          return null;
        }
        return n;
      };
      const val = () => (a.length > 2 && !a.startsWith('--') ? a.slice(2) : args[++i]);
      if (a === '-p' || a === '-ps' || a === '-postscript' || a === '-plain') mode = 'plain';
      else if (a === '-i' || a === '-include') mode = 'include';
      else if (a === '-b' || a === '-bits') mode = 'bits';
      else if (a === '-u') upper = true;
      else if (a === '-r' || a === '-revert') reverse = true;
      else if (/^-c/.test(a)) {
        const n = await num(val(), '-c');
        if (n === null) return 1;
        cols = n;
      } else if (/^-g/.test(a)) {
        const n = await num(val(), '-g');
        if (n === null) return 1;
        group = n;
      } else if (/^-l/.test(a)) {
        const n = await num(val(), '-l');
        if (n === null) return 1;
        len = n;
      } else if (/^-s/.test(a)) {
        const n = await num(val(), '-s');
        if (n === null) return 1;
        seek = n;
      } else if (a === '-v' || a === '-version') {
        await ctx.err('xxd 2023-10-25 by Juergen Weigert et al.\n');
        return 0;
      } else if (a.startsWith('-') && a !== '-') {
        await ctx.err(`xxd: unknown option ${a}\n`);
        return 1;
      } else files.push(a);
    }
    if (files.length > 2) {
      await ctx.err('Usage:\n       xxd [options] [infile [outfile]]\n    or\n       xxd -r [-s [-]offset] [-c cols] [-ps] [infile [outfile]]\n');
      return 1;
    }
    const { bytes: input, ok } = await readInput(ctx, files.slice(0, 1), 'xxd', len === null || reverse ? Infinity : seek + len);
    if (!ok) return 2;
    let out: string;
    if (reverse) {
      const text = new TextDecoder().decode(input);
      let hex = '';
      if (mode === 'plain') hex = text.replace(/[^0-9a-fA-F]/g, '');
      else {
        for (const line of text.split('\n')) {
          const m = /^[0-9a-fA-F]+:\s?(.*)$/.exec(line);
          if (!m) continue;
          // the hex part ends at the double space before the text column
          hex += m[1].split('  ')[0].replace(/[^0-9a-fA-F]/g, '');
        }
      }
      const bytes = new Uint8Array(Math.floor(hex.length / 2));
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      out = new TextDecoder().decode(bytes);
    } else {
      let data = input.slice(seek);
      if (len !== null) data = data.slice(0, len);
      const h = (b: number) => {
        const s = b.toString(16).padStart(2, '0');
        return upper ? s.toUpperCase() : s;
      };
      if (mode === 'plain') {
        const per = cols ?? 30;
        const lines: string[] = [];
        for (let i = 0; i < data.length; i += per) lines.push([...data.slice(i, i + per)].map(h).join(''));
        out = lines.map((l) => l + '\n').join('');
      } else if (mode === 'include') {
        const per = cols ?? 12;
        const name = files[0] && files[0] !== '-' ? files[0].replace(/[^A-Za-z0-9]/g, '_').replace(/^(\d)/, '__$1') : null;
        const lines: string[] = [];
        for (let i = 0; i < data.length; i += per) lines.push('  ' + [...data.slice(i, i + per)].map((b) => `0x${h(b)}`).join(', '));
        const body = lines.join(',\n') + (lines.length ? '\n' : '');
        out = name ? `unsigned char ${name}[] = {\n${body}};\nunsigned int ${name}_len = ${data.length};\n` : body;
      } else {
        const per = cols ?? (mode === 'bits' ? 6 : 16);
        const g = group ?? (mode === 'bits' ? 1 : 2);
        const cell = (b: number) => (mode === 'bits' ? b.toString(2).padStart(8, '0') : h(b));
        const cellWidth = mode === 'bits' ? 8 : 2;
        const hexWidth = per * cellWidth + (g > 0 ? Math.ceil(per / g) : 0);
        const lines: string[] = [];
        for (let i = 0; i < data.length; i += per) {
          const chunk = [...data.slice(i, i + per)];
          let hex = '';
          chunk.forEach((b, k) => {
            hex += cell(b);
            if (g > 0 && (k + 1) % g === 0) hex += ' ';
          });
          if (g > 0 && chunk.length % g !== 0) hex += ' ';
          const offset = (i + seek).toString(16).padStart(8, '0');
          lines.push(`${offset}: ${hex.padEnd(hexWidth)} ${chunk.map((b) => (printable(b) ? String.fromCharCode(b) : '.')).join('')}\n`);
        }
        out = lines.join('');
      }
    }
    if (files[1] && files[1] !== '-') {
      try {
        ctx.fs.writeFile(files[1], out);
      } catch (e) {
        await ctx.err(`xxd: ${files[1]}: ${errText(e)}\n`);
        return 2;
      }
      return 0;
    }
    await ctx.out(out);
    return 0;
  },
});

// ---------------------------------------------------------------------------
// hexdump / hd

type HexFormat = 'C' | 'c' | 'x' | 'b' | 'd' | 'o' | 'default';

async function hexdumpMain(ctx: CommandContext, canonicalDefault: boolean): Promise<number> {
  const opts = await getopts(ctx, { short: 'bcCdoxvn:s:', long: { canonical: 'C', 'no-squeezing': 'v', length: { key: 'n', arg: 'required' }, skip: { key: 's', arg: 'required' } } });
  if (!opts) return 1;
  const formats: HexFormat[] = [];
  let length: number | null = null;
  let skip = 0;
  for (const { key, value } of opts.list) {
    if ('bcCdox'.includes(key)) formats.push(key as HexFormat);
    else if (key === 'n' || key === 's') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        await ctx.error(`invalid ${key === 'n' ? 'length' : 'offset'} argument: ${String(value)}`);
        return 1;
      }
      if (key === 'n') length = n;
      else skip = n;
    }
  }
  if (formats.length === 0) formats.push(canonicalDefault ? 'C' : 'default');
  const { bytes: all, ok } = await readInput(ctx, opts.operands, 'hexdump', length === null ? Infinity : skip + length);
  let data = all.slice(skip);
  if (length !== null) data = data.slice(0, length);
  if (data.length === 0) return ok ? 0 : 1;
  const canonical = formats.includes('C');
  const hex2 = (b: number) => b.toString(16).padStart(2, '0');
  const word = (block: Uint8Array, i: number) => (block[i] ?? 0) | ((block[i + 1] ?? 0) << 8);
  let out = '';
  let prev: Uint8Array | null = null;
  let starred = false;
  for (let off = 0; off < data.length; off += 16) {
    const block = data.slice(off, off + 16);
    if (!opts.has('v') && prev && block.length === 16 && sameBytes(block, prev)) {
      if (!starred) out += '*\n';
      starred = true;
      continue;
    }
    starred = false;
    prev = block;
    for (const f of formats) {
      if (f === 'C') {
        let hex = '';
        for (let i = 0; i < 16; i++) {
          hex += i < block.length ? hex2(block[i]) + ' ' : '   ';
          if (i === 7) hex += ' ';
        }
        out += `${off.toString(16).padStart(8, '0')}  ${hex} |${[...block].map((b) => (printable(b) ? String.fromCharCode(b) : '.')).join('')}|\n`;
        continue;
      }
      let line = off.toString(16).padStart(7, '0');
      const words = Math.ceil(block.length / 2);
      if (f === 'default') {
        for (let i = 0; i < words; i++) line += ' ' + word(block, i * 2).toString(16).padStart(4, '0');
        line = line.padEnd(7 + 40);
      } else if (f === 'x') {
        for (let i = 0; i < words; i++) line += '    ' + word(block, i * 2).toString(16).padStart(4, '0');
        line = line.padEnd(7 + 64);
      } else if (f === 'd') {
        for (let i = 0; i < words; i++) line += '   ' + String(word(block, i * 2)).padStart(5, '0');
        line = line.padEnd(7 + 64);
      } else if (f === 'o') {
        for (let i = 0; i < words; i++) line += '  ' + word(block, i * 2).toString(8).padStart(6, '0');
        line = line.padEnd(7 + 64);
      } else if (f === 'b') {
        for (const b of block) line += ' ' + b.toString(8).padStart(3, '0');
        line = line.padEnd(7 + 64);
      } else {
        for (const b of block) line += (C_ESCAPES[b] ?? (printable(b) ? String.fromCharCode(b) : b.toString(8).padStart(3, '0'))).padStart(4);
        line = line.padEnd(7 + 64);
      }
      out += line + '\n';
    }
  }
  out += canonical ? data.length.toString(16).padStart(8, '0') + '\n' : data.length.toString(16).padStart(7, '0') + '\n';
  await ctx.out(out);
  return ok ? 0 : 1;
}

const HEXDUMP_DOC = {
  category: 'viewing' as const,
  summary: 'display file contents in hexadecimal, decimal, octal, or ascii',
  synopsis: ['hexdump [options] file ...', 'hd [options] file ...'],
  description:
    'The hexdump utility is a filter which displays the specified files, or standard input if no files are specified, in a user-specified format.\n\nhexdump -C (or hd) is the most useful form: offsets, the bytes in hex, and the text alongside.',
  options: [
    { flags: '-b, --one-byte-octal', desc: 'one-byte octal display' },
    { flags: '-c, --one-byte-char', desc: 'one-byte character display' },
    { flags: '-C, --canonical', desc: 'canonical hex+ASCII display' },
    { flags: '-d, --two-bytes-decimal', desc: 'two-byte decimal display' },
    { flags: '-o, --two-bytes-octal', desc: 'two-byte octal display' },
    { flags: '-x, --two-bytes-hex', desc: 'two-byte hexadecimal display' },
    { flags: '-n, --length length', desc: 'interpret only length bytes of input' },
    { flags: '-s, --skip offset', desc: 'skip offset bytes from the beginning' },
    { flags: '-v, --no-squeezing', desc: 'output identical lines' },
  ],
  examples: [{ cmd: 'hexdump -C notes.txt', desc: 'Hex and text side by side.' }],
  seeAlso: ['od', 'xxd'],
};

defineCommand({ name: 'hexdump', pkg: 'bsdextrautils', size: 51408, version: 'hexdump from util-linux 2.39.3', doc: HEXDUMP_DOC, run: (ctx) => hexdumpMain(ctx, false) });
defineCommand({ name: 'hd', pkg: 'bsdextrautils', size: 51408, version: 'hd from util-linux 2.39.3', doc: { ...HEXDUMP_DOC, summary: 'display file contents in hexadecimal (same as hexdump -C)' }, run: (ctx) => hexdumpMain(ctx, true) });
