// awk / mawk: an interpreter for the AWK language, modelled on mawk 1.3.4
// (Ubuntu's default awk): same number formatting, error messages, for-in
// ordering (mawk's FNV-1a hash tables) and I/O behaviour.

import { CaptureOutput, Pipe, type InputStream, type OutputStream } from '../streams';
import type { CommandContext } from '../types';
import { FsError } from '../vfs/fs';
import { openOutput } from './findutils';
import { convertPosixRegex } from './sed';
import { defineCommand, errText, type CommandDef } from './util';

// ---------------------------------------------------------------------------
// Values

/** A string from input that looks like a number ("strnum"). */
class StrNum {
  readonly s: string;
  readonly n: number;
  constructor(s: string, n: number) {
    this.s = s;
    this.n = n;
  }
}

/** undefined = uninitialized (both "" and 0). */
type Val = number | string | StrNum | undefined;

const NUMERIC_RE = /^[ \t\n\r\f\v]*[-+]?(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)[ \t\n\r\f\v]*$/;
const STRTOD_RE = /^[ \t\n\r\f\v]*([-+]?)(?:0[xX]([0-9a-fA-F]+)|(inf(?:inity)?|nan)|((?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?))/i;

function inputVal(s: string): Val {
  if (s.length > 0 && s.length < 400 && NUMERIC_RE.test(s)) return new StrNum(s, Number(s));
  return s;
}

function strToNum(s: string): number {
  if (s === '') return 0;
  const c = s.charCodeAt(0);
  if (c >= 48 && c <= 57 && s.length < 16 && /^\d+$/.test(s)) return +s;
  const m = STRTOD_RE.exec(s);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  if (m[2] !== undefined) return sign * parseInt(m[2], 16);
  if (m[3] !== undefined) return m[3][0].toLowerCase() === 'i' ? sign * Infinity : NaN;
  return sign * Number(m[4]);
}

function toNum(v: Val): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return strToNum(v);
  if (v === undefined) return 0;
  return v.n;
}

function isNumeric(v: Val): boolean {
  return typeof v === 'number' || v instanceof StrNum || v === undefined;
}

// ---------------------------------------------------------------------------
// printf engine (C semantics, exact rounding like glibc)

function decompose(x: number): [bigint, number] {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  let e = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (e === 0) e = 1;
  else m |= 1n << 52n;
  return [m, e - 1075];
}

/** round(|x| * 10^p) with ties to even, exactly. */
function scaledRound(x: number, p: number): bigint {
  if (x === 0) return 0n;
  const [m, e] = decompose(Math.abs(x));
  let num = m;
  let den = 1n;
  if (e >= 0) num <<= BigInt(e);
  else den <<= BigInt(-e);
  if (p >= 0) num *= 10n ** BigInt(p);
  else den *= 10n ** BigInt(-p);
  const q = num / den;
  const r2 = (num % den) * 2n;
  if (r2 > den || (r2 === den && (q & 1n) === 1n)) return q + 1n;
  return q;
}

function fmtFixed(x: number, prec: number): string {
  const q = scaledRound(x, prec).toString();
  if (prec === 0) return q;
  const s = q.padStart(prec + 1, '0');
  return s.slice(0, s.length - prec) + '.' + s.slice(s.length - prec);
}

/** Digits and exponent for %e with `prec` digits after the point. */
function expParts(x: number, prec: number): { digits: string; exp: number } {
  if (x === 0) return { digits: '0'.repeat(prec + 1), exp: 0 };
  let e = Math.floor(Math.log10(Math.abs(x)));
  for (let k = 0; k < 3; k++) {
    const q = scaledRound(x, prec - e);
    const s = q.toString();
    if (s.length > prec + 1) {
      e++;
      continue;
    }
    if (s.length < prec + 1) {
      e--;
      continue;
    }
    return { digits: s, exp: e };
  }
  const s = scaledRound(x, prec - e).toString();
  return { digits: s.slice(0, prec + 1).padEnd(prec + 1, '0'), exp: e };
}

function fmtExp(x: number, prec: number, upper: boolean): string {
  const { digits, exp } = expParts(x, prec);
  const mant = prec > 0 ? digits[0] + '.' + digits.slice(1) : digits[0];
  const es = (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  return mant + (upper ? 'E' : 'e') + es;
}

function stripZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

function fmtG(x: number, prec: number, upper: boolean, alt: boolean): string {
  const P = prec === 0 ? 1 : prec;
  if (x === 0) return alt ? fmtFixed(0, P - 1) : '0';
  const { exp } = expParts(x, P - 1);
  if (P > exp && exp >= -4) {
    const s = fmtFixed(x, P - 1 - exp);
    return alt ? s : stripZeros(s);
  }
  let s = fmtExp(x, P - 1, upper);
  if (!alt) {
    const i = s.indexOf(upper ? 'E' : 'e');
    s = stripZeros(s.slice(0, i)) + s.slice(i);
  }
  return s;
}

function padNum(body: string, sign: string, width: number, left: boolean, zero: boolean): string {
  const len = sign.length + body.length;
  if (len >= width) return sign + body;
  if (left) return sign + body + ' '.repeat(width - len);
  if (zero) return sign + '0'.repeat(width - len) + body;
  return ' '.repeat(width - len) + sign + body;
}

function formatFloat(conv: string, x: number, flags: string, width: number, prec: number | null): string {
  const left = flags.includes('-');
  const neg = x < 0 || Object.is(x, -0);
  const sign = neg ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
  const ax = Math.abs(x);
  let body: string;
  if (!Number.isFinite(x)) {
    body = Number.isNaN(x) ? 'nan' : 'inf';
    if (conv === 'E' || conv === 'G') body = body.toUpperCase();
    const s = Number.isNaN(x) ? '-' : sign;
    return padNum(body, s, width, left, false);
  }
  const p = prec ?? 6;
  switch (conv) {
    case 'f':
      body = fmtFixed(ax, p);
      if (flags.includes('#') && p === 0) body += '.';
      break;
    case 'e':
    case 'E':
      body = fmtExp(ax, p, conv === 'E');
      break;
    default:
      body = fmtG(ax, p, conv === 'G', flags.includes('#'));
      break;
  }
  return padNum(body, sign, width, left, flags.includes('0') && !left);
}

const MAX_LONG = 9223372036854775807;
const TWO64 = 18446744073709551616;

/** mawk's double -> integer conversion for %d: returns a BigInt. */
function dToInt(d: number): bigint {
  if (Number.isNaN(d)) return -9223372036854775808n;
  if (d >= MAX_LONG) return d >= TWO64 ? 18446744073709551615n : BigInt(Math.trunc(d));
  if (d <= -MAX_LONG) return -9223372036854775807n;
  return BigInt(Math.trunc(d));
}

function formatInt(conv: string, v: bigint, flags: string, width: number, prec: number | null): string {
  const left = flags.includes('-');
  let sign = '';
  let body: string;
  if (conv === 'd' || conv === 'i') {
    if (v < 0n) {
      sign = '-';
      v = -v;
    } else sign = flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
    body = v.toString();
  } else {
    let u = v < 0n ? BigInt.asUintN(64, v) : v;
    if (u > 18446744073709551615n) u = 18446744073709551615n;
    body = conv === 'o' ? u.toString(8) : conv === 'u' ? u.toString() : u.toString(16);
    if (conv === 'X') body = body.toUpperCase();
    if (flags.includes('#') && u !== 0n) {
      if (conv === 'o') body = '0' + body;
      else if (conv === 'x') sign = '0x';
      else if (conv === 'X') sign = '0X';
    }
  }
  if (prec !== null) {
    if (prec === 0 && body === '0') body = '';
    body = body.padStart(prec, '0');
  }
  return padNum(body, sign, width, left, flags.includes('0') && !left && prec === null);
}

class AwkRuntimeError extends Error {
  /** Output produced by printf before the error. */
  partial = '';
}

/** awk's sprintf/printf. `fn` is printf or sprintf (for messages). */
function awkFormat(rt: { toStr(v: Val): string }, fmt: string, args: Val[], fn: string): string {
  let out = '';
  let ai = 0;
  let convNum = 0;
  const shown = () => `${fn}("${fmt}")`;
  const fail = (msg: string): never => {
    const e = new AwkRuntimeError(msg);
    e.partial = out;
    throw e;
  };
  const nextArg = (): Val => {
    if (ai >= args.length) fail(`not enough arguments passed to ${shown()}`);
    return args[ai++];
  };
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '%') {
      out += c;
      continue;
    }
    if (fmt[i + 1] === '%') {
      out += '%';
      i++;
      continue;
    }
    convNum++;
    let j = i + 1;
    let flags = '';
    while (j < fmt.length && '-+ #0'.includes(fmt[j])) flags += fmt[j++];
    let width = 0;
    if (fmt[j] === '*') {
      width = Math.trunc(toNum(nextArg()));
      j++;
      if (width < 0) {
        flags += '-';
        width = -width;
      }
    } else {
      const m = /^\d+/.exec(fmt.slice(j));
      if (m) {
        width = parseInt(m[0], 10);
        j += m[0].length;
      }
    }
    let prec: number | null = null;
    if (fmt[j] === '.') {
      j++;
      if (fmt[j] === '*') {
        prec = Math.trunc(toNum(nextArg()));
        if (prec < 0) prec = null;
        j++;
      } else {
        const m = /^\d+/.exec(fmt.slice(j));
        prec = m ? parseInt(m[0], 10) : 0;
        if (m) j += m[0].length;
      }
    }
    let conv = fmt[j];
    if (conv === 'l' && 'dioxXu'.includes(fmt[j + 1] ?? '')) conv = fmt[++j];
    if (conv === undefined) {
      // a lone % at the end is printed as is
      out += fmt.slice(i);
      break;
    }
    if (!'cdieEfgGosuxX%'.includes(conv)) {
      if (ai < args.length) fail(`improper conversion(number ${convNum}) in ${shown()}`);
      fail(`not enough arguments passed to ${shown()}`);
    }
    const arg = nextArg();
    const left = flags.includes('-');
    switch (conv) {
      case '%':
        out += '%';
        break;
      case 'c': {
        let ch: string;
        if (typeof arg === 'number' || arg instanceof StrNum) ch = String.fromCharCode(Math.trunc(toNum(arg)) & 255);
        else {
          const s = rt.toStr(arg);
          ch = s === '' ? '\0' : String.fromCodePoint(s.codePointAt(0)!);
        }
        out += left ? ch.padEnd(width) : ch.padStart(width);
        break;
      }
      case 's': {
        let s = rt.toStr(arg);
        if (prec !== null) s = s.slice(0, prec);
        out += left ? s.padEnd(width) : s.padStart(width);
        break;
      }
      case 'd':
      case 'i':
      case 'o':
      case 'x':
      case 'X':
      case 'u':
        out += formatInt(conv, dToInt(toNum(arg)), flags, width, prec);
        break;
      default:
        out += formatFloat(conv, toNum(arg), flags, width, prec);
    }
    i = j;
  }
  return out;
}

/** Number -> string the way mawk does it (integers print as integers). */
function numToStr(d: number, fmt: string): string {
  if (Number.isInteger(d) && d >= -9223372036854775808 && d <= TWO64) {
    if (d <= 9007199254740991 && d >= -9007199254740991) return String(d);
    if (d >= 18446744073709551615) return '18446744073709551615';
    return BigInt(d).toString();
  }
  if (fmt === '%.6g') {
    if (Number.isNaN(d)) return '-nan';
    if (!Number.isFinite(d)) return d > 0 ? 'inf' : '-inf';
    return formatFloat('g', d, '', 0, 6);
  }
  return awkFormat({ toStr: (v) => (typeof v === 'string' ? v : String(v)) }, fmt, [d], 'sprintf');
}

// ---------------------------------------------------------------------------
// Arrays with mawk's iteration order (dual hash tables, FNV-1a, move-to-front)

interface Cell {
  v: Val;
}

interface ANode {
  sval: string | null;
  ival: number | null;
  hval: number;
  cell: Cell;
  slink: ANode | null;
  ilink: ANode | null;
}

const AY_NULL = 0;
const AY_INT = 1;
const AY_STR = 2;
const AY_SPLIT = 4;
const STARTING_HASH_SIZE = 64;
const MAX_AVE_LIST_LENGTH = 12;

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      h ^= c;
      h = Math.imul(h, 16777619);
    } else {
      for (const b of new TextEncoder().encode(s.slice(i, i + (c >= 0xd800 && c < 0xdc00 ? 2 : 1)))) {
        h ^= b;
        h = Math.imul(h, 16777619);
      }
      if (c >= 0xd800 && c < 0xdc00) i++;
    }
  }
  return h >>> 0;
}

class AwkArray {
  type = AY_NULL;
  size = 0;
  private hmask = 0;
  private limit = 0;
  private stable: (ANode | null)[] = [];
  private itable: (ANode | null)[] = [];
  private split: Cell[] = [];
  private redo = false;

  clear(): void {
    this.type = AY_NULL;
    this.size = 0;
    this.stable = [];
    this.itable = [];
    this.split = [];
  }

  /** split(): load values 1..n. */
  load(values: Val[]): void {
    this.clear();
    if (values.length === 0) return;
    this.type = AY_SPLIT;
    this.split = values.map((v) => ({ v }));
    this.size = values.length;
  }

  private makeEmptyTable(type: number): void {
    this.type = type;
    this.hmask = STARTING_HASH_SIZE - 1;
    this.limit = STARTING_HASH_SIZE * MAX_AVE_LIST_LENGTH;
    this.stable = new Array(STARTING_HASH_SIZE).fill(null);
    this.itable = new Array(STARTING_HASH_SIZE).fill(null);
  }

  private convertSplitToTable(): void {
    const cells = this.split;
    this.hmask = STARTING_HASH_SIZE - 1;
    this.limit = (this.hmask + 1) * MAX_AVE_LIST_LENGTH;
    while (this.size > this.limit) {
      this.hmask = this.hmask * 2 + 1;
      this.limit = (this.hmask + 1) * MAX_AVE_LIST_LENGTH;
    }
    this.stable = new Array(this.hmask + 1).fill(null);
    this.itable = new Array(this.hmask + 1).fill(null);
    for (let i = 0; i < this.size; i++) {
      const j = i + 1;
      const p: ANode = { sval: null, ival: j, hval: 0, cell: cells[i], slink: null, ilink: null };
      const idx = j & this.hmask;
      p.ilink = this.itable[idx];
      this.itable[idx] = p;
    }
    this.split = [];
    this.type = AY_INT;
  }

  private addStringAssociations(): void {
    if (this.type === AY_NULL) {
      this.makeEmptyTable(AY_STR);
      return;
    }
    if (this.type === AY_SPLIT) this.convertSplitToTable();
    for (let i = 0; i <= this.hmask; i++) {
      let p = this.itable[i];
      while (p) {
        if (p.sval === null) {
          p.sval = String(p.ival);
          p.hval = fnv1a(p.sval);
          const idx = p.hval & this.hmask;
          p.slink = this.stable[idx];
          this.stable[idx] = p;
        }
        p = p.ilink;
      }
    }
    this.type |= AY_STR;
  }

  private findBySval(sval: string, create: boolean): ANode | null {
    if (!(this.type & AY_STR)) this.addStringAssociations();
    const hval = fnv1a(sval);
    const idx = hval & this.hmask;
    let p = this.stable[idx];
    let q: ANode | null = null;
    for (;;) {
      if (!p) {
        if (!create) return null;
        p = { sval, ival: null, hval, cell: { v: undefined }, slink: null, ilink: null };
        if (++this.size > this.limit) this.redo = true;
        break;
      }
      if (p.hval === hval && p.sval === sval) {
        if (!q) return p;
        q.slink = p.slink;
        break;
      }
      q = p;
      p = p.slink;
    }
    p.slink = this.stable[idx];
    this.stable[idx] = p;
    return p;
  }

  private findByIval(ival: number, create: boolean): ANode | null {
    const idx = ival & this.hmask;
    let p = this.itable[idx];
    let q: ANode | null = null;
    for (;;) {
      if (!p) {
        if (!(this.type & AY_STR) && !create) return null;
        if (this.type & AY_STR) {
          p = this.findBySval(String(ival), create);
          if (!p) return null;
        } else {
          p = { sval: null, ival, hval: 0, cell: { v: undefined }, slink: null, ilink: null };
          if (++this.size > this.limit) this.redo = true;
        }
        p.ival = ival;
        this.type |= AY_INT;
        break;
      }
      if (p.ival === ival) {
        if (!q) return p;
        q.ilink = p.ilink;
        break;
      }
      q = p;
      p = p.ilink;
    }
    p.ilink = this.itable[idx];
    this.itable[idx] = p;
    return p;
  }

  private doubleTable(): void {
    const oldMask = this.hmask;
    const newMask = oldMask * 2 + 1;
    const grow = (table: (ANode | null)[], key: (p: ANode) => number, next: 'slink' | 'ilink') => {
      for (let i = 0; i <= oldMask; i++) table.push(null);
      for (let i = 0; i <= oldMask; i++) {
        const keep: ANode[] = [];
        const move: ANode[] = [];
        for (let p = table[i]; p; p = p[next]) ((key(p) & newMask) !== i ? move : keep).push(p);
        const link = (arr: ANode[]): ANode | null => {
          for (let k = 0; k < arr.length; k++) arr[k][next] = k + 1 < arr.length ? arr[k + 1] : null;
          return arr[0] ?? null;
        };
        table[i] = link(keep);
        table[i + oldMask + 1] = link(move);
      }
    };
    if (this.type & AY_STR) grow(this.stable, (p) => p.hval, 'slink');
    else for (let i = 0; i <= oldMask; i++) this.stable.push(null);
    if (this.type & AY_INT) grow(this.itable, (p) => p.ival!, 'ilink');
    else for (let i = 0; i <= oldMask; i++) this.itable.push(null);
    this.hmask = newMask;
    this.limit = (newMask + 1) * MAX_AVE_LIST_LENGTH;
  }

  /** Find (and optionally create) the cell for a subscript value. */
  find(key: Val, keyStr: (v: Val) => string, create: boolean): Cell | null {
    if (this.size === 0 && !create) return null;
    let node: ANode | null;
    if (typeof key === 'number') {
      if (Number.isInteger(key) && key >= -2147483647 && key <= 2147483647) {
        if (this.type === AY_SPLIT) {
          if (key >= 1 && key <= this.size) return this.split[key - 1];
          if (!create) return null;
          this.convertSplitToTable();
        } else if (this.type === AY_NULL) this.makeEmptyTable(AY_INT);
        node = this.findByIval(key, create);
      } else node = this.findBySval(keyStr(key), create);
    } else if (key === undefined) node = this.findBySval('', create);
    else node = this.findBySval(typeof key === 'string' ? key : key.s, create);
    if (this.redo) {
      this.redo = false;
      this.doubleTable();
    }
    return node ? node.cell : null;
  }

  delete(key: Val, keyStr: (v: Val) => string): void {
    if (this.size === 0) return;
    let ap: ANode | null = null;
    if (typeof key === 'number' && Number.isInteger(key) && key >= -2147483647 && key <= 2147483647) {
      if (this.type === AY_SPLIT) {
        if (key >= 1 && key <= this.size) this.convertSplitToTable();
        else return;
      }
      ap = this.findByIval(key, false);
      if (!ap) return;
      this.itable[key & this.hmask] = ap.ilink;
      if (ap.sval !== null) {
        const idx = ap.hval & this.hmask;
        let p = this.stable[idx];
        let q: ANode | null = null;
        while (p && p !== ap) {
          q = p;
          p = p.slink;
        }
        if (q) q.slink = ap.slink;
        else this.stable[idx] = ap.slink;
      }
    } else {
      const s = typeof key === 'number' ? keyStr(key) : key === undefined ? '' : typeof key === 'string' ? key : key.s;
      if (this.type === AY_SPLIT) this.convertSplitToTable();
      ap = this.findBySval(s, false);
      if (!ap) return;
      this.stable[ap.hval & this.hmask] = ap.slink;
      if (ap.ival !== null) {
        const idx = ap.ival & this.hmask;
        let p = this.itable[idx];
        let q: ANode | null = null;
        while (p && p !== ap) {
          q = p;
          p = p.ilink;
        }
        if (q) q.ilink = ap.ilink;
        else this.itable[idx] = ap.ilink;
      }
    }
    if (--this.size === 0) this.clear();
  }

  /** Keys in mawk's for-in order. */
  keys(): string[] {
    if (this.size === 0) return [];
    if (!(this.type & AY_STR)) this.addStringAssociations();
    const out: string[] = [];
    for (let i = 0; i <= this.hmask; i++) for (let p = this.stable[i]; p; p = p.slink) out.push(p.sval!);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Lexer

type TT = 'num' | 'str' | 'ere' | 'name' | 'func' | 'builtin' | 'kw' | 'op' | 'nl' | 'eof' | 'err';

interface Tok {
  t: TT;
  v: string;
  n: number;
  line: number;
  paren: number;
  brace: number;
  /** Lexical error messages (t === 'err'). */
  msgs?: string[];
  /** For 'name': immediately followed by '(' without a space. */
  call?: boolean;
}

const KEYWORDS = new Set(['BEGIN', 'END', 'function', 'if', 'else', 'while', 'for', 'do', 'break', 'continue', 'next', 'nextfile', 'exit', 'return', 'delete', 'getline', 'print', 'printf', 'in']);
const BUILTINS = new Set(['length', 'substr', 'index', 'split', 'sub', 'gsub', 'match', 'sprintf', 'sin', 'cos', 'atan2', 'exp', 'log', 'int', 'sqrt', 'rand', 'srand', 'tolower', 'toupper', 'system', 'close', 'fflush']);
const OPS = ['+=', '-=', '*=', '/=', '%=', '^=', '==', '<=', '>=', '!=', '++', '--', '&&', '||', '>>', '!~', '{', '}', '(', ')', '[', ']', ';', ',', '+', '-', '*', '/', '%', '^', '!', '>', '<', '|', '?', ':', '~', '$', '='];

function unescapeAwk(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const n = s[++i];
    switch (n) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'v':
        out += '\v';
        break;
      case 'a':
        out += '\x07';
        break;
      case '\\':
        out += '\\';
        break;
      case '"':
        out += '"';
        break;
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
        if (m) {
          out += String.fromCharCode(parseInt(m[0], 16));
          i += m[0].length;
        } else out += '\\x';
        break;
      }
      default:
        if (n >= '0' && n <= '7') {
          const m = /^[0-7]{1,3}/.exec(s.slice(i))!;
          out += String.fromCharCode(parseInt(m[0], 8) & 255);
          i += m[0].length - 1;
        } else out += '\\' + n;
    }
  }
  return out;
}

function tokenize(src: string, extraOut: string[]): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let paren = 0;
  let brace = 0;
  const extra: string[] = [];
  const push = (t: TT, v: string, n = 0, extraProps: Partial<Tok> = {}) => {
    toks.push({ t, v, n, line, paren, brace, ...extraProps });
  };
  const divOk = () => {
    const p = toks[toks.length - 1];
    if (!p) return false;
    if (p.t === 'num' || p.t === 'str' || p.t === 'ere' || p.t === 'name' || p.t === 'builtin') return true;
    if (p.t === 'op' && (p.v === ')' || p.v === ']' || p.v === '$' || p.v === '++' || p.v === '--')) return true;
    return false;
  };
  const lexErr = (msg: string) => {
    toks.push({ t: 'err', v: '', n: 0, line, paren, brace, msgs: [msg] });
  };
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      line++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\r' && src[i + 2] === '\n') {
      i += 3;
      line++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      push('nl', '\n');
      line++;
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let raw = '';
      while (j < src.length && src[j] !== '"' && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < src.length) {
          if (src[j + 1] === '\n') {
            j += 2;
            line++;
            continue;
          }
          raw += src[j] + src[j + 1];
          j += 2;
          continue;
        }
        raw += src[j++];
      }
      if (src[j] !== '"') {
        lexErr(`line ${line}: runaway string constant "${raw.slice(0, 10)} ...`);
        return toks;
      }
      push('str', unescapeAwk(raw));
      i = j + 1;
      continue;
    }
    if (c === '/' && !divOk()) {
      // regular expression literal
      let j = i + 1;
      let raw = '';
      let inBr = false;
      while (j < src.length && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\' && j + 1 < src.length && src[j + 1] !== '\n') {
          if (src[j + 1] === '/') raw += '/';
          else raw += d + src[j + 1];
          j += 2;
          continue;
        }
        if (inBr) {
          if (d === ']' && !(raw.endsWith('[') || raw.endsWith('[^'))) inBr = false;
          raw += d;
          j++;
          continue;
        }
        if (d === '[') {
          inBr = true;
          raw += d;
          j++;
          if (src[j] === '^') {
            raw += '^';
            j++;
          }
          if (src[j] === ']') {
            raw += ']';
            j++;
          }
          continue;
        }
        if (d === '/') break;
        raw += d;
        j++;
      }
      if (src[j] !== '/') {
        lexErr(`line ${line}: runaway regular expression /${raw.slice(0, 10)} ...`);
        return toks;
      }
      push('ere', raw);
      i = j + 1;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i))!;
      const v = Number(m[0]);
      const mant = m[0].replace(/[eE].*/, '');
      if (!Number.isFinite(v) || (v === 0 && /[1-9]/.test(mant)) || (v !== 0 && v < 2.2250738585072014e-308)) {
        lexErr(`line ${line}: ${m[0]} : decimal overflow`);
        return toks;
      }
      push('num', m[0], v);
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      const w = m[0];
      i += w.length;
      if (KEYWORDS.has(w)) push('kw', w);
      else if (BUILTINS.has(w)) push('builtin', w);
      else push('name', w, 0, { call: src[i] === '(' });
      continue;
    }
    let op = '';
    for (const o of OPS) {
      if (src.startsWith(o, i)) {
        op = o;
        break;
      }
    }
    if (!op) {
      lexErr(`${line}: unexpected character '${c}'`);
      return toks;
    }
    if (op === '/=' && !divOk()) op = '/';
    i += op.length;
    if (op === '(') paren++;
    else if (op === ')') {
      if (paren === 0) {
        extra.push(`line ${line}: extra ')'`);
        continue;
      }
      paren--;
    } else if (op === '{') brace++;
    else if (op === '}') {
      if (brace === 0) {
        const msgs = [`line ${line}: extra '}'`];
        let k = i;
        let b = 0;
        while (k < src.length) {
          if (src[k] === '}' && b === 0) msgs.push(`line ${line}: extra '}'`);
          else if (src[k] === '{') b++;
          else if (src[k] === '}') b--;
          k++;
        }
        msgs.push(`line ${line}: syntax error at or near end of line`);
        toks.push({ t: 'err', v: '', n: 0, line, paren, brace, msgs });
        return toks;
      }
      brace--;
    }
    push('op', op);
  }
  push('nl', '\n');
  line++;
  push('eof', '');
  extraOut.push(...extra);
  return toks;
}

// ---------------------------------------------------------------------------
// AST

interface AwkRegex {
  re: RegExp;
  src: string;
}

type ArrRef = { k: 'garr'; slot: number; name: string } | { k: 'larr'; idx: number; name: string };

type Expr = (
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 're'; re: AwkRegex }
  | { k: 'var'; slot: number; name: string }
  | { k: 'local'; idx: number; name: string }
  | { k: 'field'; e: Expr }
  | { k: 'index'; arr: ArrRef; subs: Expr[] }
  | { k: 'assign'; op: string; target: Expr; e: Expr }
  | { k: 'cond'; c: Expr; a: Expr; b: Expr }
  | { k: 'or' | 'and'; a: Expr; b: Expr }
  | { k: 'in'; subs: Expr[]; arr: ArrRef }
  | { k: 'match'; neg: boolean; a: Expr; re: Expr }
  | { k: 'cmp'; op: string; a: Expr; b: Expr }
  | { k: 'cat'; parts: Expr[] }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'neg' | 'plus' | 'not'; e: Expr }
  | { k: 'incdec'; pre: boolean; d: number; target: Expr }
  | { k: 'call'; name: string; args: Expr[]; fn: Func | null; line: number }
  | { k: 'builtin'; name: string; args: Expr[] }
  | { k: 'getline'; src: 'main' | 'file' | 'cmd'; target: Expr | null; e: Expr | null }
  | { k: 'group'; e: Expr }
  /** length(name): array or scalar, decided at run time. */
  | { k: 'lengthof'; name: string; local: number }
  /** A bare name passed to a function: array or scalar, decided at run time. */
  | { k: 'namearg'; name: string; local: number }
) & { async?: boolean };

type Redirect = { kind: '>' | '>>' | '|'; e: Expr };

type Stmt = (
  | { k: 'expr'; e: Expr }
  | { k: 'print'; args: Expr[]; dest: Redirect | null }
  | { k: 'printf'; args: Expr[]; dest: Redirect | null }
  | { k: 'if'; c: Expr; t: Stmt; f: Stmt | null }
  | { k: 'while'; c: Expr; body: Stmt }
  | { k: 'do'; body: Stmt; c: Expr }
  | { k: 'for'; init: Stmt | null; c: Expr | null; step: Stmt | null; body: Stmt }
  | { k: 'forin'; v: Expr; arr: ArrRef; body: Stmt }
  | { k: 'block'; body: Stmt[] }
  | { k: 'next' | 'nextfile' | 'break' | 'continue' | 'empty' }
  | { k: 'exit' | 'return'; e: Expr | null }
  | { k: 'delete'; arr: ArrRef; subs: Expr[] | null }
) & { async?: boolean };

interface Func {
  name: string;
  params: string[];
  body: Stmt[];
  arrayParams: Set<number>;
  async: boolean;
  defined: boolean;
}

interface Rule {
  pattern: Expr | null;
  pattern2: Expr | null;
  action: Stmt[] | null;
  inRange: boolean;
}

interface Program {
  begins: Stmt[][];
  ends: Stmt[][];
  rules: Rule[];
  funcs: Map<string, Func>;
  globals: Map<string, number>;
  arrays: Map<string, number>;
}

class AwkSyntaxError extends Error {
  readonly msgs: string[];
  constructor(msgs: string[]) {
    super(msgs[0]);
    this.msgs = msgs;
  }
}

// special variable slots
const SPECIALS = ['NF', 'NR', 'FNR', 'FS', 'OFS', 'ORS', 'RS', 'FILENAME', 'SUBSEP', 'RSTART', 'RLENGTH', 'CONVFMT', 'OFMT', 'ARGC'];
const V_NF = 0;
const V_NR = 1;
const V_FNR = 2;
const V_FS = 3;
const V_OFS = 4;
const V_ORS = 5;
const V_RS = 6;
const V_FILENAME = 7;
const V_SUBSEP = 8;
const V_RSTART = 9;
const V_RLENGTH = 10;
const V_CONVFMT = 11;
const V_OFMT = 12;
const V_ARGC = 13;

function regexError(msg: string): string {
  const map: Record<string, string> = {
    'Invalid range end': 'bad class -- [], [^] or [',
    'Invalid character class name': 'bad class -- [], [^] or [',
    'Unmatched [, [^, [:, [., or [=': 'bad class -- [], [^] or [',
    'Invalid preceding regular expression': 'missing operand',
  };
  return map[msg] ?? msg;
}

function compileAwkRegex(src: string): AwkRegex {
  const conv = convertPosixRegex(src, { extended: true, dialect: 'awk' });
  return { re: new RegExp(conv.source, 'gs'), src };
}

// ---------------------------------------------------------------------------
// Parser

class Parser {
  private readonly toks: Tok[];
  private i = 0;
  private readonly prog: Program;
  private func: Func | null = null;
  private locals: Map<string, number> | null = null;
  private inBeginEnd = false;
  private loopDepth = 0;
  private readonly knownFuncs: Set<string>;
  private readonly errors: string[] = [];
  /** First use of each global name: 'scalar' | 'array'. */
  private readonly kinds = new Map<string, 'scalar' | 'array'>();

  constructor(toks: Tok[], src: string, extra: string[] = []) {
    this.toks = toks;
    this.errors.push(...extra);
    this.prog = { begins: [], ends: [], rules: [], funcs: new Map(), globals: new Map(), arrays: new Map() };
    SPECIALS.forEach((n, idx) => {
      this.prog.globals.set(n, idx);
      this.kinds.set(n, 'scalar');
    });
    this.prog.arrays.set('ENVIRON', 0);
    this.prog.arrays.set('ARGV', 1);
    this.kinds.set('ENVIRON', 'array');
    this.kinds.set('ARGV', 'array');
    this.knownFuncs = new Set();
    for (const m of src.matchAll(/\bfunction[ \t]+([A-Za-z_][A-Za-z0-9_]*)/g)) this.knownFuncs.add(m[1]);
  }

  private peek(o = 0): Tok {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)];
  }
  private next(): Tok {
    const t = this.peek();
    if (t.t === 'err') throw new AwkSyntaxError(t.msgs!);
    this.i++;
    return t;
  }
  private isOp(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t.t === 'op' && t.v === v;
  }
  private isKw(v: string): boolean {
    const t = this.peek();
    return t.t === 'kw' && t.v === v;
  }
  private tokText(t: Tok): string {
    switch (t.t) {
      case 'nl':
        return 'end of line';
      case 'eof':
        return 'end of file';
      case 'ere':
        return '/' + t.v + '/';
      default:
        return t.v;
    }
  }
  private fail(t: Tok = this.peek()): never {
    if (t.t === 'err') throw new AwkSyntaxError(t.msgs!);
    const text = this.tokText(t);
    const closing = t.t === 'nl' || t.t === 'eof' || (t.t === 'op' && t.v === '}');
    let msg: string;
    if (closing && t.paren > 0) msg = `line ${t.line}: missing ) near ${text}`;
    else if (t.t === 'eof' && t.brace > 0) msg = `line ${t.line}: missing } near ${text}`;
    else msg = `line ${t.line}: syntax error at or near ${text}`;
    const msgs = [msg];
    if (t.t !== 'eof') {
      const last = this.toks[this.toks.length - 1].t === 'err' ? this.toks[this.toks.length - 2] : this.toks[this.toks.length - 1];
      if (last && last.t === 'eof' && last.brace > 0) msgs.push(`line ${last.line}: missing } near end of file`);
    }
    throw new AwkSyntaxError(msgs);
  }
  private expectOp(v: string): void {
    if (!this.isOp(v)) this.fail();
    this.next();
  }
  private skipNl(): void {
    while (this.peek().t === 'nl') this.next();
  }
  private compileError(msg: string): void {
    this.errors.push(msg);
  }

  // --- names
  private globalSlot(name: string): number {
    let s = this.prog.globals.get(name);
    if (s === undefined) {
      s = this.prog.globals.size;
      this.prog.globals.set(name, s);
    }
    return s;
  }
  private useScalar(name: string, line: number): Expr {
    if (this.locals?.has(name)) return { k: 'local', idx: this.locals.get(name)!, name };
    if (this.knownFuncs.has(name)) this.fail();
    const kind = this.kinds.get(name);
    if (kind === 'array') this.compileError(`line ${line}: illegal reference to array ${name}`);
    else this.kinds.set(name, 'scalar');
    return { k: 'var', slot: this.globalSlot(name), name };
  }
  private useArray(name: string, line: number): ArrRef {
    if (this.locals?.has(name)) {
      const idx = this.locals.get(name)!;
      this.func!.arrayParams.add(idx);
      return { k: 'larr', idx, name };
    }
    const kind = this.kinds.get(name);
    if (kind === 'scalar') this.compileError(`line ${line}: illegal reference to variable ${name}`);
    else this.kinds.set(name, 'array');
    let s = this.prog.arrays.get(name);
    if (s === undefined) {
      s = this.prog.arrays.size;
      this.prog.arrays.set(name, s);
    }
    return { k: 'garr', slot: s, name };
  }

  parseProgram(): Program {
    for (;;) {
      while (this.peek().t === 'nl' || this.isOp(';')) this.next();
      const t = this.peek();
      if (t.t === 'eof') break;
      if (t.t === 'err') throw new AwkSyntaxError(t.msgs!);
      if (t.t === 'kw' && t.v === 'function') {
        this.parseFunction();
        continue;
      }
      if (t.t === 'kw' && (t.v === 'BEGIN' || t.v === 'END')) {
        this.next();
        if (!this.isOp('{')) this.fail();
        this.inBeginEnd = true;
        const body = this.parseBlock();
        this.inBeginEnd = false;
        (t.v === 'BEGIN' ? this.prog.begins : this.prog.ends).push(body);
        continue;
      }
      let pattern: Expr | null = null;
      let pattern2: Expr | null = null;
      if (!this.isOp('{')) {
        pattern = this.parseExpr(false);
        if (this.isOp(',')) {
          this.next();
          this.skipNl();
          pattern2 = this.parseExpr(false);
        }
      }
      let action: Stmt[] | null = null;
      if (this.isOp('{')) action = this.parseBlock();
      else {
        const n = this.peek();
        if (!(n.t === 'nl' || n.t === 'eof' || (n.t === 'op' && n.v === ';'))) this.fail();
      }
      this.prog.rules.push({ pattern, pattern2, action, inRange: false });
    }
    for (const [name, f] of this.prog.funcs) {
      if (!f.defined && this.errors.length === 0) {
        const eof = this.toks.find((x) => x.t === 'eof')!;
        this.compileError(`line ${eof.line}: function ${name} never defined`);
      }
    }
    if (this.errors.length) throw new AwkSyntaxError(this.errors);
    return this.prog;
  }

  private getFunc(name: string): Func {
    let f = this.prog.funcs.get(name);
    if (!f) {
      f = { name, params: [], body: [], arrayParams: new Set(), async: false, defined: false };
      this.prog.funcs.set(name, f);
    }
    return f;
  }

  private parseFunction(): void {
    const kwTok = this.next();
    const nameTok = this.next();
    if (nameTok.t !== 'name') this.fail(nameTok);
    const f = this.getFunc(nameTok.v);
    if (f.defined) this.compileError(`line ${kwTok.line}: function ${nameTok.v} redefined`);
    f.defined = true;
    this.expectOp('(');
    const params: string[] = [];
    while (!this.isOp(')')) {
      const p = this.next();
      if (p.t !== 'name') this.fail(p);
      if (params.includes(p.v)) this.compileError(`line ${p.line}: ${p.v} is duplicated in argument list`);
      params.push(p.v);
      if (this.isOp(',')) {
        this.next();
        this.skipNl();
      } else if (!this.isOp(')')) this.fail();
    }
    this.next();
    this.skipNl();
    f.params = params;
    this.func = f;
    this.locals = new Map(params.map((p, i) => [p, i]));
    if (!this.isOp('{')) this.fail();
    f.body = this.parseBlock();
    this.func = null;
    this.locals = null;
  }

  private parseBlock(): Stmt[] {
    this.expectOp('{');
    const body: Stmt[] = [];
    for (;;) {
      while (this.peek().t === 'nl' || this.isOp(';')) this.next();
      if (this.isOp('}')) break;
      if (this.peek().t === 'eof' || this.peek().t === 'err') this.fail();
      body.push(this.parseStmt());
    }
    this.next();
    return body;
  }

  /** Statement terminator after a simple statement. */
  private endSimple(): void {
    const t = this.peek();
    if (t.t === 'nl' || (t.t === 'op' && t.v === ';')) {
      this.next();
      return;
    }
    if ((t.t === 'op' && t.v === '}') || t.t === 'eof') return;
    this.fail(t);
  }

  private parseSimpleOrBlock(): Stmt {
    // a body statement: `}` right away means an empty statement
    if (this.isOp('}')) return { k: 'empty' };
    if (this.isOp(';')) {
      this.next();
      return { k: 'empty' };
    }
    return this.parseStmt();
  }

  private parseStmt(): Stmt {
    const t = this.peek();
    if (t.t === 'op' && t.v === '{') return { k: 'block', body: this.parseBlock() };
    if (t.t === 'op' && t.v === ';') {
      this.next();
      return { k: 'empty' };
    }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'if': {
          this.next();
          this.expectOp('(');
          const c = this.parseExpr(false);
          this.expectOp(')');
          this.skipNl();
          const th = this.parseSimpleOrBlock();
          const save = this.i;
          while (this.peek().t === 'nl' || this.isOp(';')) this.next();
          if (this.isKw('else')) {
            this.next();
            this.skipNl();
            return { k: 'if', c, t: th, f: this.parseSimpleOrBlock() };
          }
          this.i = save;
          return { k: 'if', c, t: th, f: null };
        }
        case 'while': {
          this.next();
          this.expectOp('(');
          const c = this.parseExpr(false);
          this.expectOp(')');
          if (this.isOp(';')) {
            this.next();
            return { k: 'while', c, body: { k: 'empty' } };
          }
          this.skipNl();
          this.loopDepth++;
          const body = this.parseSimpleOrBlock();
          this.loopDepth--;
          return { k: 'while', c, body };
        }
        case 'do': {
          this.next();
          this.skipNl();
          this.loopDepth++;
          const body = this.parseSimpleOrBlock();
          this.loopDepth--;
          while (this.peek().t === 'nl' || this.isOp(';')) this.next();
          if (!this.isKw('while')) this.fail();
          this.next();
          this.expectOp('(');
          const c = this.parseExpr(false);
          this.expectOp(')');
          this.endSimple();
          return { k: 'do', body, c };
        }
        case 'for': {
          this.next();
          this.expectOp('(');
          // for (name in array)
          if (this.peek().t === 'name' && this.peek(1).t === 'kw' && this.peek(1).v === 'in' && this.peek(2).t === 'name' && this.isOp(')', 3)) {
            const nameTok = this.next();
            this.next();
            const arrTok = this.next();
            this.next();
            const v = this.useScalar(nameTok.v, nameTok.line);
            const arr = this.useArray(arrTok.v, arrTok.line);
            this.skipNl();
            this.loopDepth++;
            const body = this.parseSimpleOrBlock();
            this.loopDepth--;
            return { k: 'forin', v, arr, body };
          }
          if (this.isOp('(') && this.peek(1).t === 'name' && this.peek(2).t === 'kw' && this.peek(2).v === 'in') {
            // for ((k) in a) is not valid awk
          }
          const init = this.isOp(';') ? null : this.parseSimpleStmt();
          this.expectOp(';');
          this.skipNl();
          const c = this.isOp(';') ? null : this.parseExpr(false);
          this.expectOp(';');
          this.skipNl();
          const step = this.isOp(')') ? null : this.parseSimpleStmt();
          this.expectOp(')');
          if (this.isOp(';')) {
            this.next();
            return { k: 'for', init, c, step, body: { k: 'empty' } };
          }
          this.skipNl();
          this.loopDepth++;
          const body = this.parseSimpleOrBlock();
          this.loopDepth--;
          return { k: 'for', init, c, step, body };
        }
        default:
          break;
      }
    }
    const s = this.parseSimpleStmt();
    this.endSimple();
    return s;
  }

  private parseSimpleStmt(): Stmt {
    const t = this.peek();
    if (t.t === 'kw') {
      switch (t.v) {
        case 'print':
        case 'printf': {
          this.next();
          let args: Expr[] = [];
          const save = this.i;
          if (this.isOp('(')) {
            // print (a, b) > "file"  -- grouping form
            this.next();
            const list = this.parseExprList(false, ')');
            this.expectOp(')');
            const n = this.peek();
            if (n.t === 'nl' || n.t === 'eof' || (n.t === 'op' && [';', '}', '>', '>>', '|'].includes(n.v))) args = list;
            else {
              this.i = save;
              args = this.parseExprList(true, null);
            }
          } else if (!this.atPrintEnd()) args = this.parseExprList(true, null);
          if (t.v === 'printf' && args.length === 0) {
            this.compileError(`line ${t.line}: no arguments in call to printf`);
          }
          let dest: Redirect | null = null;
          const r = this.peek();
          if (r.t === 'op' && (r.v === '>' || r.v === '>>' || r.v === '|')) {
            this.next();
            dest = { kind: r.v as '>' | '>>' | '|', e: this.parseConcatTarget() };
          }
          return { k: t.v, args, dest };
        }
        case 'next':
        case 'nextfile':
          this.next();
          if (this.inBeginEnd || this.func) this.compileError(`line ${t.line}: improper use of ${t.v}`);
          return { k: t.v };
        case 'break':
        case 'continue':
          this.next();
          return { k: t.v };
        case 'exit':
        case 'return': {
          this.next();
          if (t.v === 'return' && !this.func) this.compileError(`line ${t.line}: return outside function body`);
          const n = this.peek();
          const e = n.t === 'nl' || n.t === 'eof' || (n.t === 'op' && (n.v === ';' || n.v === '}')) ? null : this.parseExpr(false);
          return { k: t.v, e };
        }
        case 'delete': {
          this.next();
          const nameTok = this.next();
          if (nameTok.t !== 'name') this.fail(nameTok);
          const arr = this.useArray(nameTok.v, nameTok.line);
          if (this.isOp('[')) {
            this.next();
            const subs = this.parseExprList(false, ']');
            this.expectOp(']');
            return { k: 'delete', arr, subs };
          }
          return { k: 'delete', arr, subs: null };
        }
        default:
          break;
      }
    }
    return { k: 'expr', e: this.parseExpr(false) };
  }

  private atPrintEnd(): boolean {
    const n = this.peek();
    return n.t === 'nl' || n.t === 'eof' || (n.t === 'op' && [';', '}', '>', '>>', '|'].includes(n.v));
  }

  /** The target of > >> | in print: a full expression (comparisons allowed). */
  private parseConcatTarget(): Expr {
    return this.parseTernary(false);
  }

  private parseExprList(noGt: boolean, close: string | null): Expr[] {
    const list: Expr[] = [];
    if (close && this.isOp(close)) return list;
    for (;;) {
      list.push(this.parseExpr(noGt));
      if (!this.isOp(',')) break;
      this.next();
      this.skipNl();
    }
    return list;
  }

  parseExpr(noGt: boolean): Expr {
    return this.parseTernary(noGt);
  }

  private isLvalue(e: Expr): boolean {
    return e.k === 'var' || e.k === 'local' || e.k === 'field' || e.k === 'index';
  }

  private parseTernary(ng: boolean): Expr {
    const c = this.parseOr(ng);
    const t = this.peek();
    if (t.t === 'op' && t.v === '?') {
      this.next();
      this.skipNl();
      const a = this.parseTernary(ng);
      this.skipNl();
      this.expectOp(':');
      this.skipNl();
      const b = this.parseTernary(ng);
      return { k: 'cond', c, a, b };
    }
    if (t.t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(t.v)) {
      if (!this.isLvalue(c)) this.fail(t);
      this.next();
      this.skipNl();
      const e = this.parseTernary(ng);
      return { k: 'assign', op: t.v, target: c, e };
    }
    return c;
  }

  private parseOr(ng: boolean): Expr {
    let a = this.parseAnd(ng);
    while (this.isOp('||')) {
      this.next();
      this.skipNl();
      a = { k: 'or', a, b: this.parseAnd(ng) };
    }
    return a;
  }

  private parseAnd(ng: boolean): Expr {
    let a = this.parseIn(ng);
    while (this.isOp('&&')) {
      this.next();
      this.skipNl();
      a = { k: 'and', a, b: this.parseIn(ng) };
    }
    return a;
  }

  private parseIn(ng: boolean): Expr {
    let a = this.parseMatch(ng);
    while (this.isKw('in')) {
      this.next();
      const nameTok = this.next();
      if (nameTok.t !== 'name') this.fail(nameTok);
      a = { k: 'in', subs: [a], arr: this.useArray(nameTok.v, nameTok.line) };
      // mawk's grammar lets comparisons and matches follow an `in` test
      for (;;) {
        const t = this.peek();
        if (t.t === 'op' && ['<', '<=', '!=', '==', '>=', '>'].includes(t.v) && !(t.v === '>' && ng)) {
          this.next();
          a = { k: 'cmp', op: t.v, a, b: this.parseCat(ng) };
        } else if (t.t === 'op' && (t.v === '~' || t.v === '!~')) {
          this.next();
          a = { k: 'match', neg: t.v === '!~', a, re: this.parseCmp(ng) };
        } else break;
      }
    }
    return a;
  }

  private parseMatch(ng: boolean): Expr {
    let a = this.parseCmp(ng);
    while (this.isOp('~') || this.isOp('!~')) {
      const neg = this.next().v === '!~';
      a = { k: 'match', neg, a, re: this.parseCmp(ng) };
    }
    return a;
  }

  private parseCmp(ng: boolean): Expr {
    let a = this.parseCat(ng);
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op') return a;
      if (!['<', '<=', '!=', '==', '>=', '>'].includes(t.v)) return a;
      if (t.v === '>' && ng) return a;
      this.next();
      a = { k: 'cmp', op: t.v, a, b: this.parseCat(ng) };
    }
  }

  private startsOperand(t: Tok): boolean {
    switch (t.t) {
      case 'num':
      case 'str':
      case 'ere':
      case 'name':
      case 'builtin':
        return true;
      case 'kw':
        return t.v === 'getline';
      case 'op':
        return t.v === '$' || t.v === '!' || t.v === '(' || t.v === '++' || t.v === '--';
      default:
        return false;
    }
  }

  private parseCat(ng: boolean): Expr {
    const first = this.parseAddPipe(ng);
    if (!this.startsOperand(this.peek())) return first;
    const parts = [first];
    while (this.startsOperand(this.peek())) parts.push(this.parseAddPipe(ng));
    return { k: 'cat', parts };
  }

  private parseAddPipe(ng: boolean): Expr {
    let e = this.parseAdd(ng);
    while (this.isOp('|') && this.peek(1).t === 'kw' && this.peek(1).v === 'getline') {
      this.next();
      this.next();
      const target = this.parseOptLvalue();
      e = { k: 'getline', src: 'cmd', target, e };
    }
    return e;
  }

  private parseAdd(ng: boolean): Expr {
    let a = this.parseMul(ng);
    for (;;) {
      if (this.isOp('+') || this.isOp('-')) {
        const op = this.next().v;
        a = { k: 'bin', op, a, b: this.parseMul(ng) };
      } else return a;
    }
  }

  private parseMul(ng: boolean): Expr {
    let a = this.parseUnary(ng);
    for (;;) {
      if (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
        const op = this.next().v;
        a = { k: 'bin', op, a, b: this.parseUnary(ng) };
      } else return a;
    }
  }

  private parseUnary(ng: boolean): Expr {
    const t = this.peek();
    if (t.t === 'op' && (t.v === '!' || t.v === '-' || t.v === '+')) {
      this.next();
      const e = this.parseUnary(ng);
      return { k: t.v === '!' ? 'not' : t.v === '-' ? 'neg' : 'plus', e };
    }
    return this.parsePow(ng);
  }

  private parsePow(ng: boolean): Expr {
    const base = this.parsePostfix(ng);
    if (this.isOp('^')) {
      this.next();
      return { k: 'bin', op: '^', a: base, b: this.parseUnary(ng) };
    }
    return base;
  }

  private parsePostfix(ng: boolean): Expr {
    const e = this.parsePrimary(ng);
    if ((this.isOp('++') || this.isOp('--')) && this.isLvalue(e)) {
      const d = this.next().v === '++' ? 1 : -1;
      return { k: 'incdec', pre: false, d, target: e };
    }
    return e;
  }

  /** An optional lvalue after getline. */
  private parseOptLvalue(): Expr | null {
    const t = this.peek();
    if (t.t === 'name' && !t.call) return this.parseNameRef();
    if (t.t === 'op' && t.v === '$') {
      this.next();
      return { k: 'field', e: this.parseDollarOperand() };
    }
    return null;
  }

  private parseNameRef(): Expr {
    const t = this.next();
    if (this.isOp('[')) {
      this.next();
      const subs = this.parseExprList(false, ']');
      if (subs.length === 0) this.fail();
      this.expectOp(']');
      return { k: 'index', arr: this.useArray(t.v, t.line), subs };
    }
    return this.useScalar(t.v, t.line);
  }

  private parseDollarOperand(): Expr {
    const t = this.peek();
    if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
      this.next();
      const target = this.parsePrimaryLvalue();
      return { k: 'incdec', pre: true, d: t.v === '++' ? 1 : -1, target };
    }
    if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '!')) {
      this.next();
      const e = this.parseDollarOperand();
      return { k: t.v === '!' ? 'not' : t.v === '-' ? 'neg' : 'plus', e };
    }
    return this.parsePrimary(false);
  }

  private parsePrimaryLvalue(): Expr {
    const t = this.peek();
    if (t.t === 'name') return this.parseNameRef();
    if (t.t === 'op' && t.v === '$') {
      this.next();
      return { k: 'field', e: this.parseDollarOperand() };
    }
    return this.fail(t);
  }

  private regexArg(e: Expr): Expr {
    // a string constant used as a regex is compiled now (errors are compile errors)
    if (e.k === 'str') {
      try {
        compileAwkRegex(e.v);
      } catch (err) {
        this.compileError(`line ${this.peek().line}: regular expression compile failed (${regexError(err instanceof Error ? err.message : String(err))})\n${e.v}`);
      }
    }
    return e;
  }

  private parsePrimary(ng: boolean): Expr {
    const t = this.peek();
    switch (t.t) {
      case 'num':
        this.next();
        return { k: 'num', v: t.n };
      case 'str':
        this.next();
        return { k: 'str', v: t.v };
      case 'ere': {
        this.next();
        try {
          return { k: 're', re: compileAwkRegex(t.v) };
        } catch (err) {
          this.compileError(`line ${t.line}: regular expression compile failed (${regexError(err instanceof Error ? err.message : String(err))})\n${t.v}`);
          return { k: 'num', v: 0 };
        }
      }
      case 'name': {
        if (this.knownFuncs.has(t.v) || t.call) {
          if (this.locals?.has(t.v) || (!this.knownFuncs.has(t.v) && !this.isOp('(', 1))) return this.parseNameRef();
          this.next();
          this.expectOp('(');
          const args = this.parseCallArgs(true);
          this.expectOp(')');
          const fn = this.getFunc(t.v);
          return { k: 'call', name: t.v, args, fn, line: t.line };
        }
        return this.parseNameRef();
      }
      case 'builtin':
        return this.parseBuiltin();
      case 'kw':
        if (t.v === 'getline') {
          this.next();
          const target = this.parseOptLvalue();
          if (this.isOp('<')) {
            this.next();
            const file = this.parsePrimaryForFile();
            return { k: 'getline', src: 'file', target, e: file };
          }
          return { k: 'getline', src: 'main', target, e: null };
        }
        return this.fail(t);
      case 'op':
        switch (t.v) {
          case '(': {
            this.next();
            const list = this.parseExprList(false, ')');
            if (list.length === 0) this.fail();
            this.expectOp(')');
            if (list.length > 1) {
              if (!this.isKw('in')) this.fail();
              this.next();
              const nameTok = this.next();
              if (nameTok.t !== 'name') this.fail(nameTok);
              return { k: 'in', subs: list, arr: this.useArray(nameTok.v, nameTok.line) };
            }
            return { k: 'group', e: list[0] };
          }
          case '$': {
            this.next();
            return { k: 'field', e: this.parseDollarOperand() };
          }
          case '++':
          case '--': {
            this.next();
            const target = this.parsePrimaryLvalue();
            return { k: 'incdec', pre: true, d: t.v === '++' ? 1 : -1, target };
          }
          case '-':
          case '+':
          case '!': {
            this.next();
            const e = this.parseUnary(ng);
            return { k: t.v === '!' ? 'not' : t.v === '-' ? 'neg' : 'plus', e };
          }
          default:
            return this.fail(t);
        }
      default:
        return this.fail(t);
    }
  }

  private parsePrimaryForFile(): Expr {
    const t = this.peek();
    if (t.t === 'op' && (t.v === '-' || t.v === '!' || t.v === '+')) return this.parseUnary(false);
    return this.parsePostfix(false);
  }

  private parseCallArgs(bareNames = false): Expr[] {
    const args: Expr[] = [];
    if (this.isOp(')')) return args;
    for (;;) {
      const t = this.peek();
      if (bareNames && t.t === 'name' && !t.call && !this.knownFuncs.has(t.v) && (this.isOp(',', 1) || this.isOp(')', 1))) {
        this.next();
        args.push({ k: 'namearg', name: t.v, local: this.locals?.get(t.v) ?? -1 });
      } else args.push(this.parseExpr(false));
      if (!this.isOp(',')) break;
      this.next();
      this.skipNl();
    }
    return args;
  }

  private parseBuiltin(): Expr {
    const t = this.next();
    const name = t.v;
    if (name === 'length' && !this.isOp('(')) return { k: 'builtin', name, args: [] };
    if (name === 'length' && this.peek(1).t === 'name' && !this.peek(1).call && this.isOp(')', 2) && !this.knownFuncs.has(this.peek(1).v)) {
      this.next();
      const n = this.next();
      this.next();
      return { k: 'lengthof', name: n.v, local: this.locals?.get(n.v) ?? -1 };
    }
    if (!this.isOp('(')) this.fail();
    this.next();
    let args: Expr[] = [];
    const strict = name === 'split' || name === 'sub' || name === 'gsub' || name === 'match';
    if (strict) {
      // these have their own grammar rules: wrong shapes are syntax errors
      args.push(this.parseExpr(false));
      this.expectOp(',');
      this.skipNl();
      if (name === 'split') {
        const nameTok = this.next();
        if (nameTok.t !== 'name') this.fail(nameTok);
        const arr = this.useArray(nameTok.v, nameTok.line);
        args.push({ k: 'in', subs: [], arr });
        if (this.isOp(',')) {
          this.next();
          this.skipNl();
          args.push(this.regexArg(this.parseExpr(false)));
        }
      } else if (name === 'match') {
        args.push(this.regexArg(this.parseExpr(false)));
      } else {
        args[0] = this.regexArg(args[0]);
        args.push(this.parseExpr(false));
        if (this.isOp(',')) {
          this.next();
          this.skipNl();
          const target = this.parseExpr(false);
          if (!this.isLvalue(target)) this.fail();
          args.push(target);
        }
      }
      this.expectOp(')');
      return { k: 'builtin', name, args };
    }
    args = this.parseCallArgs();
    this.expectOp(')');
    const arity: Record<string, [number, number]> = {
      length: [0, 1],
      substr: [2, 3],
      index: [2, 2],
      sprintf: [1, 255],
      sin: [1, 1],
      cos: [1, 1],
      atan2: [2, 2],
      exp: [1, 1],
      log: [1, 1],
      int: [1, 1],
      sqrt: [1, 1],
      rand: [0, 0],
      srand: [0, 1],
      tolower: [1, 1],
      toupper: [1, 1],
      system: [1, 1],
      close: [1, 1],
      fflush: [0, 1],
    };
    const [lo, hi] = arity[name];
    if (args.length < lo || args.length > hi) {
      if (name === 'sprintf' && args.length === 0) this.compileError(`line ${t.line}: no arguments in call to sprintf`);
      else this.compileError(`line ${t.line}: wrong number of arguments in call to ${name}`);
    }
    return { k: 'builtin', name, args };
  }
}

// ---------------------------------------------------------------------------
// Analysis: which nodes need async evaluation

function markAsync(prog: Program): void {
  // fixpoint over functions
  const funcs = [...prog.funcs.values()];
  for (const f of funcs) f.async = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of funcs) {
      if (!f.async && f.body.some((s) => stmtAsync(s, false))) {
        f.async = true;
        changed = true;
      }
    }
  }
  const all = (list: Stmt[]) => list.forEach((s) => stmtAsync(s, true));
  prog.begins.forEach(all);
  prog.ends.forEach(all);
  funcs.forEach((f) => all(f.body));
  for (const r of prog.rules) {
    if (r.pattern) exprAsync(r.pattern, true);
    if (r.pattern2) exprAsync(r.pattern2, true);
    if (r.action) all(r.action);
  }
}

function exprAsync(e: Expr, mark: boolean): boolean {
  let a = false;
  const sub = (x: Expr | null) => {
    if (x && exprAsync(x, mark)) a = true;
  };
  switch (e.k) {
    case 'num':
    case 'str':
    case 're':
    case 'var':
    case 'local':
    case 'lengthof':
    case 'namearg':
      break;
    case 'field':
    case 'neg':
    case 'plus':
    case 'not':
    case 'group':
      sub(e.e);
      break;
    case 'index':
      e.subs.forEach(sub);
      break;
    case 'in':
      e.subs.forEach(sub);
      break;
    case 'assign':
      sub(e.target);
      sub(e.e);
      break;
    case 'cond':
      sub(e.c);
      sub(e.a);
      sub(e.b);
      break;
    case 'or':
    case 'and':
    case 'cmp':
    case 'bin':
      sub(e.a);
      sub(e.b);
      break;
    case 'match':
      sub(e.a);
      sub(e.re);
      break;
    case 'cat':
      e.parts.forEach(sub);
      break;
    case 'incdec':
      sub(e.target);
      break;
    case 'call':
      e.args.forEach(sub);
      if (e.fn?.async) a = true;
      break;
    case 'builtin':
      e.args.forEach(sub);
      if (e.name === 'system' || e.name === 'close' || e.name === 'fflush') a = true;
      break;
    case 'getline':
      sub(e.target);
      sub(e.e);
      a = true;
      break;
  }
  if (mark) e.async = a;
  return a;
}

function stmtAsync(s: Stmt, mark: boolean): boolean {
  let a = false;
  const ex = (x: Expr | null) => {
    if (x && exprAsync(x, mark)) a = true;
  };
  const st = (x: Stmt | null) => {
    if (x && stmtAsync(x, mark)) a = true;
  };
  switch (s.k) {
    case 'expr':
      ex(s.e);
      break;
    case 'print':
    case 'printf':
      s.args.forEach(ex);
      if (s.dest) {
        ex(s.dest.e);
        if (s.dest.kind === '|') a = true;
      }
      break;
    case 'if':
      ex(s.c);
      st(s.t);
      st(s.f);
      break;
    case 'while':
    case 'do':
      ex(s.c);
      st(s.body);
      a = true;
      break;
    case 'for':
      st(s.init);
      ex(s.c);
      st(s.step);
      st(s.body);
      a = true;
      break;
    case 'forin':
      ex(s.v);
      st(s.body);
      a = true;
      break;
    case 'block':
      s.body.forEach(st);
      break;
    case 'exit':
    case 'return':
      ex(s.e);
      break;
    case 'delete':
      s.subs?.forEach(ex);
      break;
    default:
      break;
  }
  if (mark) s.async = a;
  return a;
}

/** Visit every expression node of the program. */
function walkProgram(prog: Program, fn: (e: Expr) => void): void {
  const seen = new Set<object>();
  const walk = (x: unknown) => {
    if (!x || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    if (Array.isArray(x)) {
      x.forEach(walk);
      return;
    }
    const o = x as Record<string, unknown>;
    if (typeof o.k === 'string' && o.k !== 'garr' && o.k !== 'larr') fn(o as unknown as Expr);
    for (const [key, v] of Object.entries(o)) if (key !== 'fn' && key !== 're' && v && typeof v === 'object') walk(v);
  };
  walk(prog.begins);
  walk(prog.ends);
  walk(prog.rules);
  for (const f of prog.funcs.values()) walk(f.body);
}

/** mawk's compile-time check: a scalar passed where the function wants an array. */
function checkCallTypes(prog: Program): string[] {
  const msgs: string[] = [];
  walkProgram(prog, (e) => {
    if (e.k !== 'call' || !e.fn) return;
    e.args.forEach((a, i) => {
      if (a.k === 'namearg' && a.local === -1 && e.fn!.arrayParams.has(i) && prog.globals.has(a.name) && !prog.arrays.has(a.name)) {
        msgs.push(`line ${e.line}: type error in arg(${i + 1}) in call to ${e.name} (actual local variable vs local array)`);
      }
    });
  });
  return msgs;
}

/** Function parameters used as arrays, including those passed on to array parameters. */
function inferArrayParams(prog: Program): void {
  let changed = true;
  const visit = (f: Func | null, s: Stmt | Expr, onCall: (c: Extract<Expr, { k: 'call' }>, f: Func | null) => void) => {
    const walkE = (e: Expr | null) => {
      if (!e) return;
      if (e.k === 'call') onCall(e, f);
      for (const v of Object.values(e)) {
        if (v && typeof v === 'object') {
          if (Array.isArray(v)) v.forEach((x) => x && typeof x === 'object' && 'k' in x && walkAny(x));
          else if ('k' in v) walkAny(v as Expr);
        }
      }
    };
    const walkAny = (x: Stmt | Expr) => {
      walkE(x as Expr);
    };
    walkAny(s);
  };
  while (changed) {
    changed = false;
    const onCall = (c: Extract<Expr, { k: 'call' }>, caller: Func | null) => {
      const callee = c.fn;
      if (!callee) return;
      c.args.forEach((arg, i) => {
        if (!callee.arrayParams.has(i)) return;
        const idx = arg.k === 'local' ? arg.idx : arg.k === 'namearg' ? arg.local : -1;
        if (idx >= 0 && caller && !caller.arrayParams.has(idx)) {
          caller.arrayParams.add(idx);
          changed = true;
        }
      });
    };
    for (const f of prog.funcs.values()) for (const s of f.body) visit(f, s, onCall);
  }
}

// ---------------------------------------------------------------------------
// Runtime

const NORMAL = 0;
const BREAK = 1;
const CONTINUE = 2;
const NEXT = 3;
const NEXTFILE = 4;
const EXIT = 5;
const RETURN = 6;

class AwkExit extends Error {
  readonly status: number;
  constructor(status: number) {
    super('exit');
    this.status = status;
  }
}

class AwkFatal extends Error {}

/** Reads records from a string buffer that may be refilled from a stream. */
class RecordReader {
  private buf: string;
  private pos = 0;
  private eof: boolean;
  private readonly stream: InputStream | null;
  private readonly before: () => Promise<void>;
  constructor(text: string | null, stream: InputStream | null, before: () => Promise<void>) {
    this.buf = text ?? '';
    this.stream = stream;
    this.eof = stream === null;
    this.before = before;
  }
  private async more(): Promise<boolean> {
    if (this.eof) return false;
    await this.before();
    const chunk = await this.stream!.read();
    if (chunk === null) {
      this.eof = true;
      return false;
    }
    if (this.pos > 0) {
      this.buf = this.buf.slice(this.pos);
      this.pos = 0;
    }
    this.buf += chunk;
    return true;
  }
  async next(rs: string, rsRe: RegExp | null): Promise<string | null> {
    if (rs === '\n' || (rs.length === 1 && !rsRe)) {
      const sep = rs;
      for (;;) {
        const idx = this.buf.indexOf(sep, this.pos);
        if (idx !== -1) {
          const r = this.buf.slice(this.pos, idx);
          this.pos = idx + 1;
          return r;
        }
        if (!(await this.more())) {
          if (this.pos >= this.buf.length) return null;
          const r = this.buf.slice(this.pos);
          this.pos = this.buf.length;
          return r;
        }
      }
    }
    if (rs === '') {
      // paragraph mode
      for (;;) {
        while (this.pos < this.buf.length && this.buf[this.pos] === '\n') this.pos++;
        if (this.pos < this.buf.length || !(await this.more())) break;
      }
      if (this.pos >= this.buf.length) return null;
      for (;;) {
        const m = /\n\n+/g;
        m.lastIndex = this.pos;
        const r = m.exec(this.buf);
        if (r && (r.index + r[0].length < this.buf.length || this.eof)) {
          const rec = this.buf.slice(this.pos, r.index);
          this.pos = r.index + r[0].length;
          return rec;
        }
        if (!(await this.more())) {
          let rec = this.buf.slice(this.pos);
          this.pos = this.buf.length;
          rec = rec.replace(/\n+$/, '');
          return rec;
        }
      }
    }
    // regular expression RS
    const re = rsRe!;
    for (;;) {
      re.lastIndex = this.pos;
      let m = re.exec(this.buf);
      while (m && m[0] === '') {
        re.lastIndex = m.index + 1;
        if (re.lastIndex > this.buf.length) {
          m = null;
          break;
        }
        m = re.exec(this.buf);
      }
      if (m && (m.index + m[0].length < this.buf.length || this.eof)) {
        const rec = this.buf.slice(this.pos, m.index);
        this.pos = m.index + m[0].length;
        return rec;
      }
      if (!(await this.more())) {
        if (m) {
          const rec = this.buf.slice(this.pos, m.index);
          this.pos = m.index + m[0].length;
          return rec;
        }
        if (this.pos >= this.buf.length) return null;
        const rec = this.buf.slice(this.pos);
        this.pos = this.buf.length;
        return rec;
      }
    }
  }
}

interface OutFile {
  kind: 'file' | 'pipe';
  stream: OutputStream;
  pipe?: Pipe;
  done?: Promise<number>;
}

interface InFile {
  reader: RecordReader;
  status: number;
}

type Frame = (Val | AwkArray)[];

class Interp {
  readonly ctx: CommandContext;
  readonly prog: Program;
  readonly progName: string;
  vals: Val[];
  arrays: AwkArray[];
  // record state
  private record = '';
  private recordVal: Val = '';
  private fields: Val[] = [];
  private nf = 0;
  private splitDone = true;
  // cached special values
  private fsSplit: { kind: 'space' | 'char' | 'empty' | 're'; ch: string; re: RegExp | null } = { kind: 'space', ch: ' ', re: null };
  /** The field splitter in effect when the current record was read. */
  private recSplit = this.fsSplit;
  private rsRe: RegExp | null = null;
  private convfmt = '%.6g';
  private ofmt = '%.6g';
  private subsep = '\x1c';
  // output
  private queue: { stream: OutputStream; data: string }[] = [];
  private queued = 0;
  private outputs = new Map<string, OutFile>();
  private inputs = new Map<string, InFile>();
  private commands = new Map<string, InFile>();
  // main input
  private mainReader: RecordReader | null = null;
  private argIndex = 1;
  private usedFile = false;
  private mainDone = false;
  // calls
  private frame: Frame = [];
  private depth = 0;
  private retVal: Val = undefined;
  exitCode = 0;
  private regexCache = new Map<string, AwkRegex>();
  private prevSeed = 0;
  private steps = 0;
  private readonly isTTY: boolean;

  constructor(ctx: CommandContext, prog: Program, progName: string) {
    this.ctx = ctx;
    this.prog = prog;
    this.progName = progName;
    this.vals = new Array(prog.globals.size).fill(undefined);
    this.arrays = [];
    for (let i = 0; i < prog.arrays.size; i++) this.arrays.push(new AwkArray());
    this.vals[V_NF] = 0;
    this.vals[V_NR] = 0;
    this.vals[V_FNR] = 0;
    this.vals[V_FS] = ' ';
    this.vals[V_OFS] = ' ';
    this.vals[V_ORS] = '\n';
    this.vals[V_RS] = '\n';
    this.vals[V_FILENAME] = '';
    this.vals[V_SUBSEP] = '\x1c';
    this.vals[V_CONVFMT] = '%.6g';
    this.vals[V_OFMT] = '%.6g';
    this.isTTY = ctx.stdout.isTTY;
    const env = this.arrays[0];
    for (const [k, v] of ctx.env) env.find(k, (x) => this.toStr(x), true)!.v = inputVal(v);
    this.prevSeed = Math.floor(ctx.system.random() * 2147483647);
  }

  // --- conversions
  toStr(v: Val): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return numToStr(v, this.convfmt);
    if (v === undefined) return '';
    return v.s;
  }
  private toOut(v: Val): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return numToStr(v, this.ofmt);
    if (v === undefined) return '';
    return v.s;
  }
  private toBool(v: Val): boolean {
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v !== '';
    if (v === undefined) return false;
    return v.n !== 0;
  }
  private compare(a: Val, b: Val): number {
    if (isNumeric(a) && isNumeric(b)) {
      const x = toNum(a);
      const y = toNum(b);
      return x < y ? -1 : x > y ? 1 : x === y ? 0 : NaN;
    }
    const s = this.toStr(a);
    const t = this.toStr(b);
    return s < t ? -1 : s > t ? 1 : 0;
  }

  // --- errors
  runtimeError(msg: string): never {
    throw new AwkRuntimeError(msg);
  }
  errorTrailer(): string {
    return `\tFILENAME="${this.toStr(this.vals[V_FILENAME])}" FNR=${this.toStr(this.vals[V_FNR])} NR=${this.toStr(this.vals[V_NR])}`;
  }

  // --- special variables
  private setSpecial(slot: number, v: Val): void {
    switch (slot) {
      case V_NF: {
        this.ensureSplit();
        let n = Math.trunc(toNum(v));
        if (n < 0) n = 0;
        if (n > this.nf) for (let i = this.nf + 1; i <= n; i++) this.fields[i] = '';
        this.nf = n;
        this.fields.length = n + 1;
        this.vals[V_NF] = n;
        this.rebuild();
        return;
      }
      case V_FS:
        this.vals[V_FS] = v;
        this.setFS(this.toStr(v));
        return;
      case V_RS: {
        this.vals[V_RS] = v;
        const rs = this.toStr(v);
        this.rsRe = rs.length > 1 ? this.dynRegex(rs).re : null;
        return;
      }
      case V_CONVFMT:
        this.vals[slot] = v;
        this.convfmt = this.toStr(v);
        return;
      case V_OFMT:
        this.vals[slot] = v;
        this.ofmt = this.toStr(v);
        return;
      case V_SUBSEP:
        this.vals[slot] = v;
        this.subsep = this.toStr(v);
        return;
      default:
        this.vals[slot] = v;
    }
  }
  private setFS(fs: string): void {
    if (fs === ' ') this.fsSplit = { kind: 'space', ch: ' ', re: null };
    else if (fs === '') this.fsSplit = { kind: 'empty', ch: '', re: null };
    else if (fs.length === 1 && fs !== '\\') this.fsSplit = { kind: 'char', ch: fs, re: null };
    else if (fs === '\\') this.fsSplit = { kind: 'char', ch: '\\', re: null };
    else this.fsSplit = { kind: 're', ch: '', re: this.dynRegex(fs).re };
  }
  private getVar(slot: number): Val {
    if (slot === V_NF) {
      this.ensureSplit();
      return this.nf;
    }
    return this.vals[slot];
  }
  private setVar(slot: number, v: Val): void {
    if (slot < SPECIALS.length) this.setSpecial(slot, v);
    else this.vals[slot] = v;
  }

  // --- record and fields
  setRecord(s: string): void {
    this.record = s;
    this.recordVal = inputVal(s);
    this.splitDone = false;
    this.recSplit = this.fsSplit;
  }
  private ensureSplit(): void {
    if (this.splitDone) return;
    this.splitDone = true;
    const parts = this.splitString(this.record, this.recSplit);
    this.nf = parts.length;
    this.fields = new Array(parts.length + 1);
    for (let i = 0; i < parts.length; i++) this.fields[i + 1] = inputVal(parts[i]);
    this.vals[V_NF] = this.nf;
  }
  private splitString(s: string, fs: { kind: string; ch: string; re: RegExp | null }): string[] {
    if (s === '') return [];
    switch (fs.kind) {
      case 'space': {
        const t = s.replace(/^[ \t\n]+/, '');
        if (t === '') return [];
        const parts = t.split(/[ \t\n]+/);
        if (parts[parts.length - 1] === '') parts.pop();
        return parts;
      }
      case 'empty':
        return Array.from(s);
      case 'char':
        return s.split(fs.ch);
      default: {
        const re = fs.re!;
        const out: string[] = [];
        let last = 0;
        let pos = 0;
        while (pos <= s.length) {
          re.lastIndex = pos;
          const m = re.exec(s);
          if (!m) break;
          if (m[0] === '') {
            pos = m.index + 1;
            if (m.index >= s.length) break;
            continue;
          }
          out.push(s.slice(last, m.index));
          last = pos = m.index + m[0].length;
        }
        out.push(s.slice(last));
        return out;
      }
    }
  }
  private rebuild(): void {
    const ofs = this.toStr(this.vals[V_OFS]);
    let s = '';
    for (let i = 1; i <= this.nf; i++) {
      if (i > 1) s += ofs;
      s += this.toStr(this.fields[i]);
    }
    this.record = s;
    this.recordVal = s;
  }
  getField(i: number): Val {
    if (i === 0) return this.recordVal;
    if (i < 0) this.runtimeError(`negative field index $${i}`);
    this.ensureSplit();
    return i <= this.nf ? this.fields[i] : undefined;
  }
  setField(i: number, v: Val): void {
    if (i === 0) {
      this.setRecord(this.toStr(v));
      return;
    }
    if (i < 0) this.runtimeError(`negative field index $${i}`);
    this.ensureSplit();
    if (i > this.nf) {
      for (let k = this.nf + 1; k < i; k++) this.fields[k] = '';
      this.nf = i;
      this.vals[V_NF] = i;
    }
    this.fields[i] = v;
    this.rebuild();
  }

  // --- regexes
  dynRegex(src: string): AwkRegex {
    let r = this.regexCache.get(src);
    if (!r) {
      try {
        r = compileAwkRegex(src);
      } catch (e) {
        this.runtimeError(`regular expression compile failed (${regexError(e instanceof Error ? e.message : String(e))})\n${src}`);
      }
      if (this.regexCache.size > 200) this.regexCache.clear();
      this.regexCache.set(src, r!);
    }
    return r!;
  }
  private regexOf(e: Expr, v: Val | null): RegExp {
    if (e.k === 're') return e.re.re;
    return this.dynRegex(this.toStr(v ?? undefined)).re;
  }

  // --- arrays
  private arrOf(r: ArrRef): AwkArray {
    if (r.k === 'garr') return this.arrays[r.slot];
    let a = this.frame[r.idx];
    if (!(a instanceof AwkArray)) {
      a = new AwkArray();
      this.frame[r.idx] = a;
    }
    return a;
  }
  private subscript(vals: Val[]): Val {
    if (vals.length === 1) return vals[0];
    return vals.map((v) => this.toStr(v)).join(this.subsep);
  }
  private keyStr = (v: Val) => this.toStr(v);

  // --- output
  write(stream: OutputStream, data: string): void {
    const last = this.queue[this.queue.length - 1];
    if (last && last.stream === stream) last.data += data;
    else this.queue.push({ stream, data });
    this.queued += data.length;
  }
  async flush(): Promise<void> {
    const q = this.queue;
    this.queue = [];
    this.queued = 0;
    for (const item of q) await item.stream.write(item.data);
  }
  async maybeFlush(): Promise<void> {
    if (this.queued > 65536 || (this.isTTY && this.queued > 0)) await this.flush();
  }
  private outStream(dest: Redirect, name: string): OutputStream {
    if (dest.kind === '|') return this.outputs.get(name)!.stream;
    if (name === '/dev/stdout' || name === '-' && false) return this.ctx.stdout;
    let f = this.outputs.get(name);
    if (!f) {
      try {
        f = { kind: 'file', stream: name === '/dev/stdout' ? this.ctx.stdout : name === '/dev/stderr' ? this.ctx.stderr : openOutput(this.ctx, name, dest.kind === '>>') };
      } catch (e) {
        throw new AwkFatal(`cannot open "${name}" for output (${errText(e)})`);
      }
      this.outputs.set(name, f);
    }
    return f.stream;
  }
  private async openPipe(cmd: string): Promise<OutFile> {
    let f = this.outputs.get(cmd);
    if (f) return f;
    await this.flush();
    const pipe = new Pipe();
    const done = this.ctx.exec(['sh', '-c', cmd], { stdin: pipe.reader }).finally(() => pipe.reader.close());
    f = { kind: 'pipe', stream: pipe.writer, pipe, done };
    this.outputs.set(cmd, f);
    return f;
  }
  async closeName(name: string): Promise<number> {
    await this.flush();
    const o = this.outputs.get(name);
    let result = -1;
    if (o) {
      this.outputs.delete(name);
      if (o.kind === 'pipe') {
        o.pipe!.writer.close();
        result = await o.done!;
      } else result = 0;
    }
    if (this.inputs.has(name)) {
      this.inputs.delete(name);
      result = 0;
    }
    const c = this.commands.get(name);
    if (c) {
      this.commands.delete(name);
      result = c.status;
    }
    return result;
  }
  async closeAll(): Promise<void> {
    if (this.isTTY) await this.flush();
    else {
      const rest = this.queue.filter((q) => q.stream !== this.ctx.stdout);
      const stdoutParts = this.queue.filter((q) => q.stream === this.ctx.stdout);
      this.queue = rest;
      await this.flush();
      this.queue = stdoutParts;
    }
    for (const [name, o] of [...this.outputs]) {
      this.outputs.delete(name);
      if (o.kind === 'pipe') {
        o.pipe!.writer.close();
        await o.done;
      }
    }
    await this.flush();
  }

  // --- input
  private readonly beforeRead = async () => {
    await this.flush();
  };
  private async openMainNext(): Promise<boolean> {
    const argv = this.arrays[1];
    for (;;) {
      const argc = Math.trunc(toNum(this.vals[V_ARGC]));
      if (this.argIndex >= argc) {
        if (!this.usedFile) {
          this.usedFile = true;
          this.mainReader = new RecordReader(null, this.ctx.stdin, this.beforeRead);
          this.vals[V_FILENAME] = '-';
          this.vals[V_FNR] = 0;
          return true;
        }
        return false;
      }
      const cell = argv.find(this.argIndex, this.keyStr, false);
      this.argIndex++;
      const arg = cell ? this.toStr(cell.v) : '';
      if (arg === '') continue;
      const am = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(arg);
      if (am) {
        this.assignVar(am[1], am[2]);
        continue;
      }
      this.usedFile = true;
      this.vals[V_FILENAME] = arg;
      this.vals[V_FNR] = 0;
      if (arg === '-' || arg === '/dev/stdin') {
        this.mainReader = new RecordReader(null, this.ctx.stdin, this.beforeRead);
        return true;
      }
      try {
        const node = this.ctx.fs.stat(arg);
        if (node.type === 'dir') {
          // mawk silently reads a directory as empty input
          this.mainReader = new RecordReader('', null, this.beforeRead);
          return true;
        }
        this.mainReader = new RecordReader(this.ctx.fs.readFile(arg), null, this.beforeRead);
        return true;
      } catch (e) {
        throw new AwkFatal(`cannot open "${arg}" (${errText(e)})`);
      }
    }
  }
  /** Assign a command-line var=value (escapes processed, strnum check). */
  assignVar(name: string, value: string): void {
    const v = inputVal(unescapeAwk(value));
    const slot = this.prog.globals.get(name);
    if (slot !== undefined) this.setVar(slot, v);
  }
  async nextMain(): Promise<string | null> {
    if (this.mainDone) return null;
    for (;;) {
      if (!this.mainReader) {
        if (!(await this.openMainNext())) {
          this.mainDone = true;
          return null;
        }
      }
      const r = await this.mainReader!.next(this.toStr(this.vals[V_RS]), this.rsRe);
      if (r !== null) {
        this.vals[V_NR] = toNum(this.vals[V_NR]) + 1;
        this.vals[V_FNR] = toNum(this.vals[V_FNR]) + 1;
        return r;
      }
      this.mainReader = null;
    }
  }
  nextFile(): void {
    this.mainReader = null;
  }
  private async readFrom(map: Map<string, InFile>, name: string, open: () => Promise<RecordReader | null>): Promise<string | null | -1> {
    let f = map.get(name);
    if (!f) {
      const r = await open();
      if (!r) return -1;
      f = { reader: r, status: 0 };
      map.set(name, f);
    }
    return f.reader.next(this.toStr(this.vals[V_RS]), this.rsRe);
  }
  async getlineFile(name: string): Promise<string | null | -1> {
    if (name === '-' || name === '/dev/stdin') {
      return this.readFrom(this.inputs, name, async () => new RecordReader(null, this.ctx.stdin, this.beforeRead));
    }
    return this.readFrom(this.inputs, name, async () => {
      try {
        const node = this.ctx.fs.stat(name);
        if (node.type === 'dir') throw new AwkFatal('read error (Is a directory)');
        return new RecordReader(this.ctx.fs.readFile(name), null, this.beforeRead);
      } catch (e) {
        if (e instanceof AwkFatal) throw e;
        return null;
      }
    });
  }
  async getlineCmd(cmd: string): Promise<string | null | -1> {
    let f = this.commands.get(cmd);
    if (!f) {
      await this.flush();
      const cap = new CaptureOutput();
      const status = await this.ctx.exec(['sh', '-c', cmd], { stdout: cap });
      f = { reader: new RecordReader(cap.text(), null, this.beforeRead), status };
      this.commands.set(cmd, f);
    }
    return f.reader.next(this.toStr(this.vals[V_RS]), this.rsRe);
  }

  // --- lvalues
  /** Resolve an lvalue to get/set closures, evaluating subscripts once. */
  private lref(target: Expr, subs: Val[] | null): { get: () => Val; set: (v: Val) => void } {
    switch (target.k) {
      case 'var':
        return { get: () => this.getVar(target.slot), set: (v) => this.setVar(target.slot, v) };
      case 'local':
        return {
          get: () => {
            const v = this.frame[target.idx];
            return v instanceof AwkArray ? undefined : v;
          },
          set: (v) => {
            this.frame[target.idx] = v;
          },
        };
      case 'field': {
        const i = Math.trunc(toNum(subs![0]));
        return { get: () => this.getField(i), set: (v) => this.setField(i, v) };
      }
      case 'index': {
        const cell = this.arrOf(target.arr).find(this.subscript(subs!), this.keyStr, true)!;
        return { get: () => cell.v, set: (v) => (cell.v = v) };
      }
      default:
        return this.runtimeError('assignment to non-lvalue');
    }
  }
  private lvSubs(target: Expr): Val[] | null {
    if (target.k === 'field') return [this.ev(target.e)];
    if (target.k === 'index') return target.subs.map((s) => this.ev(s));
    return null;
  }
  private async lvSubsA(target: Expr): Promise<Val[] | null> {
    if (target.k === 'field') return [await this.evA(target.e)];
    if (target.k === 'index') {
      const out: Val[] = [];
      for (const s of target.subs) out.push(await this.evA(s));
      return out;
    }
    return null;
  }

  private arith(op: string, a: number, b: number): number {
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return a / b;
      case '%':
        return a % b;
      default:
        return Math.pow(a, b);
    }
  }

  private assignOp(op: string, cur: Val, v: Val): Val {
    if (op === '=') return v;
    return this.arith(op[0], toNum(cur), toNum(v));
  }

  // --- expression evaluation (synchronous)
  ev(e: Expr): Val {
    switch (e.k) {
      case 'num':
        return e.v;
      case 'str':
        return e.v;
      case 're': {
        const re = e.re.re;
        re.lastIndex = 0;
        return re.test(this.toStr(this.recordVal)) ? 1 : 0;
      }
      case 'var':
        return e.slot === V_NF ? this.getVar(V_NF) : this.vals[e.slot];
      case 'local': {
        const v = this.frame[e.idx];
        return v instanceof AwkArray ? this.runtimeError(`can't use array ${e.name} in scalar context`) : v;
      }
      case 'field':
        return this.getField(Math.trunc(toNum(this.ev(e.e))));
      case 'index': {
        const key = e.subs.length === 1 ? this.ev(e.subs[0]) : this.subscript(e.subs.map((s) => this.ev(s)));
        return this.arrOf(e.arr).find(key, this.keyStr, true)!.v;
      }
      case 'group':
        return this.ev(e.e);
      case 'assign': {
        const subs = this.lvSubs(e.target);
        const v = this.ev(e.e);
        const r = this.lref(e.target, subs);
        const nv = this.assignOp(e.op, e.op === '=' ? undefined : r.get(), v);
        r.set(nv);
        return nv;
      }
      case 'cond':
        return this.toBool(this.ev(e.c)) ? this.ev(e.a) : this.ev(e.b);
      case 'or':
        return this.toBool(this.ev(e.a)) || this.toBool(this.ev(e.b)) ? 1 : 0;
      case 'and':
        return this.toBool(this.ev(e.a)) && this.toBool(this.ev(e.b)) ? 1 : 0;
      case 'in': {
        const key = this.subscript(e.subs.map((s) => this.ev(s)));
        return this.arrOf(e.arr).find(key, this.keyStr, false) ? 1 : 0;
      }
      case 'match': {
        const s = this.toStr(this.ev(e.a));
        const re = this.regexOf(e.re, e.re.k === 're' ? null : this.ev(e.re));
        re.lastIndex = 0;
        return re.test(s) !== e.neg ? 1 : 0;
      }
      case 'cmp':
        return this.cmpResult(e.op, this.ev(e.a), this.ev(e.b));
      case 'cat': {
        let s = '';
        for (const p of e.parts) s += this.toStr(this.ev(p));
        return s;
      }
      case 'bin':
        return this.arith(e.op, toNum(this.ev(e.a)), toNum(this.ev(e.b)));
      case 'neg':
        return -toNum(this.ev(e.e));
      case 'plus':
        return toNum(this.ev(e.e));
      case 'not':
        return this.toBool(this.ev(e.e)) ? 0 : 1;
      case 'incdec': {
        const r = this.lref(e.target, this.lvSubs(e.target));
        const old = toNum(r.get());
        r.set(old + e.d);
        return e.pre ? old + e.d : old;
      }
      case 'call':
        return this.callSync(e);
      case 'builtin':
        return this.builtin(e.name, e.args, null);
      case 'getline':
        return this.runtimeError('internal error: getline in synchronous context');
      case 'lengthof': {
        if (e.local >= 0) {
          const v = this.frame[e.local];
          return v instanceof AwkArray ? v.size : this.toStr(v).length;
        }
        const arr = this.prog.arrays.get(e.name);
        if (arr !== undefined) return this.arrays[arr].size;
        const slot = this.prog.globals.get(e.name);
        return slot === undefined ? 0 : this.toStr(this.getVar(slot)).length;
      }
      case 'namearg': {
        if (e.local >= 0) {
          const v = this.frame[e.local];
          return v instanceof AwkArray ? undefined : v;
        }
        const slot = this.prog.globals.get(e.name);
        return slot === undefined ? undefined : this.getVar(slot);
      }
    }
  }

  private cmpResult(op: string, a: Val, b: Val): number {
    const c = this.compare(a, b);
    switch (op) {
      case '<':
        return c < 0 ? 1 : 0;
      case '<=':
        return c <= 0 ? 1 : 0;
      case '>':
        return c > 0 ? 1 : 0;
      case '>=':
        return c >= 0 ? 1 : 0;
      case '==':
        return c === 0 ? 1 : 0;
      default:
        return c !== 0 ? 1 : 0;
    }
  }

  // --- expression evaluation (asynchronous: getline, system, pipes...)
  async evA(e: Expr): Promise<Val> {
    if (!e.async) return this.ev(e);
    switch (e.k) {
      case 'field':
        return this.getField(Math.trunc(toNum(await this.evA(e.e))));
      case 'index': {
        const vals: Val[] = [];
        for (const s of e.subs) vals.push(await this.evA(s));
        return this.arrOf(e.arr).find(this.subscript(vals), this.keyStr, true)!.v;
      }
      case 'group':
        return this.evA(e.e);
      case 'assign': {
        const subs = await this.lvSubsA(e.target);
        const v = await this.evA(e.e);
        const r = this.lref(e.target, subs);
        const nv = this.assignOp(e.op, e.op === '=' ? undefined : r.get(), v);
        r.set(nv);
        return nv;
      }
      case 'cond':
        return this.toBool(await this.evA(e.c)) ? this.evA(e.a) : this.evA(e.b);
      case 'or':
        return this.toBool(await this.evA(e.a)) || this.toBool(await this.evA(e.b)) ? 1 : 0;
      case 'and':
        return this.toBool(await this.evA(e.a)) && this.toBool(await this.evA(e.b)) ? 1 : 0;
      case 'in': {
        const vals: Val[] = [];
        for (const s of e.subs) vals.push(await this.evA(s));
        return this.arrOf(e.arr).find(this.subscript(vals), this.keyStr, false) ? 1 : 0;
      }
      case 'match': {
        const s = this.toStr(await this.evA(e.a));
        const re = this.regexOf(e.re, e.re.k === 're' ? null : await this.evA(e.re));
        re.lastIndex = 0;
        return re.test(s) !== e.neg ? 1 : 0;
      }
      case 'cmp':
        return this.cmpResult(e.op, await this.evA(e.a), await this.evA(e.b));
      case 'cat': {
        let s = '';
        for (const p of e.parts) s += this.toStr(await this.evA(p));
        return s;
      }
      case 'bin': {
        const a = toNum(await this.evA(e.a));
        return this.arith(e.op, a, toNum(await this.evA(e.b)));
      }
      case 'neg':
        return -toNum(await this.evA(e.e));
      case 'plus':
        return toNum(await this.evA(e.e));
      case 'not':
        return this.toBool(await this.evA(e.e)) ? 0 : 1;
      case 'incdec': {
        const r = this.lref(e.target, await this.lvSubsA(e.target));
        const old = toNum(r.get());
        r.set(old + e.d);
        return e.pre ? old + e.d : old;
      }
      case 'call':
        return this.callAsync(e);
      case 'builtin': {
        const vals: Val[] = [];
        for (const a of e.args) vals.push(a.k === 'in' && a.subs.length === 0 ? undefined : await this.evA(a));
        if (e.name === 'system') {
          await this.flush();
          const st = await this.ctx.exec(['sh', '-c', this.toStr(vals[0])]);
          return st;
        }
        if (e.name === 'close') return this.closeName(this.toStr(vals[0]));
        if (e.name === 'fflush') {
          await this.flush();
          return 0;
        }
        return this.builtin(e.name, e.args, vals);
      }
      case 'getline':
        return this.getline(e);
      default:
        return this.ev(e);
    }
  }

  private async getline(e: Extract<Expr, { k: 'getline' }>): Promise<Val> {
    let line: string | null | -1;
    if (e.src === 'main') {
      const subs = e.target ? await this.lvSubsA(e.target) : null;
      line = await this.nextMain();
      if (line === null) return 0;
      if (e.target) this.lref(e.target, subs).set(inputVal(line));
      else this.setRecord(line);
      return 1;
    }
    const name = this.toStr(await this.evA(e.e!));
    const subs = e.target ? await this.lvSubsA(e.target) : null;
    line = e.src === 'file' ? await this.getlineFile(name) : await this.getlineCmd(name);
    if (line === -1) return -1;
    if (line === null) return 0;
    // (mawk does not count records read from a command in NR)
    if (e.target) this.lref(e.target, subs).set(inputVal(line));
    else this.setRecord(line);
    return 1;
  }

  // --- functions
  private bindArgs(e: Extract<Expr, { k: 'call' }>, f: Func, vals: (Val | AwkArray)[]): Frame {
    const frame: Frame = new Array(Math.max(f.params.length, 0)).fill(undefined);
    if (e.args.length > f.params.length) this.runtimeError(`too many arguments in call to ${f.name}`);
    for (let i = 0; i < f.params.length; i++) if (i < vals.length) frame[i] = vals[i];
    return frame;
  }
  private argValue(f: Func, i: number, a: Expr): Val | AwkArray | null {
    if (a.k === 'namearg') {
      if (a.local >= 0) {
        const cur = this.frame[a.local];
        if (cur instanceof AwkArray) return cur;
        if (f.arrayParams.has(i) && cur === undefined) {
          const arr = new AwkArray();
          this.frame[a.local] = arr;
          return arr;
        }
        return cur ?? undefined;
      }
      let slot = this.prog.arrays.get(a.name);
      if (slot === undefined && f.arrayParams.has(i)) {
        slot = this.arrays.length;
        this.prog.arrays.set(a.name, slot);
        this.arrays.push(new AwkArray());
      }
      if (slot !== undefined) return this.arrays[slot];
      const g = this.prog.globals.get(a.name);
      return g === undefined ? undefined : this.getVar(g);
    }
    // arrays are passed by reference
    if (f.arrayParams.has(i) || a.k === 'var' || a.k === 'local') {
      if (a.k === 'var' && this.prog.arrays.has(a.name) && !this.prog.globals.has(a.name)) return this.arrays[this.prog.arrays.get(a.name)!];
      if (a.k === 'var' && f.arrayParams.has(i)) {
        const slot = this.prog.arrays.get(a.name);
        if (slot !== undefined) return this.arrays[slot];
      }
      if (a.k === 'local') {
        const cur = this.frame[a.idx];
        if (cur instanceof AwkArray) return cur;
        if (f.arrayParams.has(i) && cur === undefined) {
          const arr = new AwkArray();
          this.frame[a.idx] = arr;
          return arr;
        }
      }
    }
    return null;
  }
  private enter(): void {
    if (++this.depth > 1000) throw new AwkFatal('program limit exceeded: eval stack size=1024');
  }
  private callSync(e: Extract<Expr, { k: 'call' }>): Val {
    const f = e.fn!;
    const vals: (Val | AwkArray)[] = e.args.map((a, i) => (a.k === 'namearg' ? this.argValue(f, i, a) : (this.argValue(f, i, a) ?? this.ev(a))) as Val | AwkArray);
    const frame = this.bindArgs(e, f, vals);
    const saved = this.frame;
    this.enter();
    this.frame = frame;
    try {
      this.retVal = undefined;
      const code = this.execListSync(f.body);
      if (code === EXIT) throw new AwkExitSignal();
      if (code === NEXT || code === NEXTFILE) throw new AwkNextSignal(code);
      const r = this.retVal;
      this.retVal = undefined;
      return r;
    } finally {
      this.frame = saved;
      this.depth--;
    }
  }
  private async callAsync(e: Extract<Expr, { k: 'call' }>): Promise<Val> {
    const f = e.fn!;
    const vals: (Val | AwkArray)[] = [];
    for (let i = 0; i < e.args.length; i++) {
      const a = e.args[i];
      vals.push((a.k === 'namearg' ? this.argValue(f, i, a) : (this.argValue(f, i, a) ?? (await this.evA(a)))) as Val | AwkArray);
    }
    const frame = this.bindArgs(e, f, vals);
    const saved = this.frame;
    this.enter();
    this.frame = frame;
    try {
      this.retVal = undefined;
      const code = await this.execList(f.body);
      if (code === EXIT) throw new AwkExitSignal();
      if (code === NEXT || code === NEXTFILE) throw new AwkNextSignal(code);
      const r = this.retVal;
      this.retVal = undefined;
      return r;
    } finally {
      this.frame = saved;
      this.depth--;
    }
  }

  // --- builtins
  private builtin(name: string, args: Expr[], pre: Val[] | null): Val {
    const arg = (i: number): Val => (pre ? pre[i] : this.ev(args[i]));
    switch (name) {
      case 'length':
        return args.length === 0 ? this.toStr(this.recordVal).length : this.lengthOf(args[0], pre ? pre[0] : null);
      case 'alength': {
        const a = args[0] as Extract<Expr, { k: 'in' }>;
        return this.arrOf(a.arr).size;
      }
      case 'substr': {
        const s = this.toStr(arg(0));
        const len = s.length;
        if (len === 0) return '';
        let b = Math.trunc(toNum(arg(1)));
        let l = args.length > 2 ? Math.trunc(toNum(arg(2))) : Infinity;
        if (Number.isNaN(b)) b = 1;
        if (Number.isNaN(l)) l = 0;
        if (b < 1) {
          l -= b;
          b = 1;
        }
        if (l <= 0 || b > len) return '';
        return s.slice(b - 1, l === Infinity ? len : Math.min(len, b - 1 + l));
      }
      case 'index': {
        const s = this.toStr(arg(0));
        const t = this.toStr(arg(1));
        return s.indexOf(t) + 1;
      }
      case 'split': {
        const s = this.toStr(arg(0));
        const arrExpr = args[1] as Extract<Expr, { k: 'in' }>;
        const arr = this.arrOf(arrExpr.arr);
        let parts: string[];
        if (args.length < 3) parts = this.splitString(s, this.fsSplit);
        else {
          const fe = args[2];
          if (fe.k === 're') parts = this.splitString(s, { kind: fe.re.src === '' ? 'empty' : 're', ch: '', re: fe.re.re });
          else {
            const fs = this.toStr(arg(2));
            const spec =
              fs === ' ' ? { kind: 'space', ch: ' ', re: null } : fs === '' ? { kind: 'empty', ch: '', re: null } : fs.length === 1 ? { kind: 'char', ch: fs, re: null } : { kind: 're', ch: '', re: this.dynRegex(fs).re };
            parts = this.splitString(s, spec);
          }
        }
        arr.load(parts.map(inputVal));
        return parts.length;
      }
      case 'sub':
      case 'gsub':
        return this.subst(name === 'gsub', args, pre);
      case 'match': {
        const s = this.toStr(arg(0));
        const re = this.regexOf(args[1], args[1].k === 're' ? null : arg(1));
        re.lastIndex = 0;
        const m = re.exec(s);
        if (!m) {
          this.vals[V_RSTART] = 0;
          this.vals[V_RLENGTH] = -1;
          return 0;
        }
        this.vals[V_RSTART] = m.index + 1;
        this.vals[V_RLENGTH] = m[0].length;
        return m.index + 1;
      }
      case 'sprintf': {
        const vals = args.map((_, i) => arg(i));
        return awkFormat(this, this.toStr(vals[0]), vals.slice(1), 'sprintf');
      }
      case 'sin':
        return Math.sin(toNum(arg(0)));
      case 'cos':
        return Math.cos(toNum(arg(0)));
      case 'atan2':
        return Math.atan2(toNum(arg(0)), toNum(arg(1)));
      case 'exp':
        return Math.exp(toNum(arg(0)));
      case 'log':
        return Math.log(toNum(arg(0)));
      case 'sqrt':
        return Math.sqrt(toNum(arg(0)));
      case 'int':
        return Math.trunc(toNum(arg(0)));
      case 'rand':
        // Ubuntu's mawk uses arc4random: srand() does not make rand() repeatable
        return this.ctx.system.random();
      case 'srand': {
        const prev = this.prevSeed;
        const seed = args.length ? toNum(arg(0)) : Math.floor(this.ctx.system.now() / 1000);
        this.prevSeed = seed;
        return prev;
      }
      case 'tolower':
        return this.toStr(arg(0)).replace(/[A-Z]+/g, (m) => m.toLowerCase());
      case 'toupper':
        return this.toStr(arg(0)).replace(/[a-z]+/g, (m) => m.toUpperCase());
      default:
        return this.runtimeError(`internal error: builtin ${name}`);
    }
  }

  private lengthOf(a: Expr, pre: Val | null): Val {
    if (a.k === 'var' && this.prog.arrays.has(a.name) && !this.prog.globals.has(a.name)) return this.arrays[this.prog.arrays.get(a.name)!].size;
    if (a.k === 'local') {
      const v = this.frame[a.idx];
      if (v instanceof AwkArray) return v.size;
    }
    return this.toStr(pre ?? this.ev(a)).length;
  }

  private subst(global: boolean, args: Expr[], pre: Val[] | null): Val {
    const reExpr = args[0];
    const re = this.regexOf(reExpr, reExpr.k === 're' ? null : pre ? pre[0] : this.ev(reExpr));
    const repl = this.toStr(pre ? pre[1] : this.ev(args[1]));
    const target = args.length > 2 ? args[2] : ({ k: 'field', e: { k: 'num', v: 0 } } as Expr);
    const subs = pre && target.k !== 'field' && target.k !== 'index' ? null : this.lvSubs(target);
    const ref = this.lref(target, subs);
    const s = this.toStr(ref.get());
    let out = '';
    let last = 0;
    let pos = 0;
    let prevEnd = -1;
    let count = 0;
    while (pos <= s.length) {
      re.lastIndex = pos;
      const m = re.exec(s);
      if (!m) break;
      const start = m.index;
      const end = start + m[0].length;
      if (start === end && start === prevEnd) {
        if (start >= s.length) break;
        pos = start + 1;
        continue;
      }
      out += s.slice(last, start);
      for (let i = 0; i < repl.length; i++) {
        const c = repl[i];
        if (c === '\\' && (repl[i + 1] === '&' || repl[i + 1] === '\\')) {
          out += repl[++i];
          continue;
        }
        out += c === '&' ? m[0] : c;
      }
      last = end;
      prevEnd = end;
      count++;
      if (!global) break;
      pos = start === end ? end + 1 : end;
    }
    if (count > 0) ref.set(out + s.slice(last));
    return count;
  }

  // --- statements
  private printArgs(s: Extract<Stmt, { k: 'print' | 'printf' }>, vals: Val[]): string {
    if (s.k === 'print') {
      const ors = this.toStr(this.vals[V_ORS]);
      if (vals.length === 0) return this.toStr(this.recordVal) + ors;
      const ofs = this.toStr(this.vals[V_OFS]);
      let line = '';
      for (let i = 0; i < vals.length; i++) {
        if (i) line += ofs;
        line += this.toOut(vals[i]);
      }
      return line + ors;
    }
    return awkFormat(this, this.toStr(vals[0]), vals.slice(1), 'printf');
  }

  private formatPrint(s: Extract<Stmt, { k: 'print' | 'printf' }>, vals: Val[], dest: () => OutputStream): string {
    try {
      return this.printArgs(s, vals);
    } catch (e) {
      if (e instanceof AwkRuntimeError && e.partial) this.write(dest(), e.partial);
      throw e;
    }
  }

  private execPrintSync(s: Extract<Stmt, { k: 'print' | 'printf' }>): void {
    const vals = s.args.map((a) => this.ev(a));
    const text = this.formatPrint(s, vals, () => this.ctx.stdout);
    if (!s.dest) this.write(this.ctx.stdout, text);
    else {
      const name = this.toStr(this.ev(s.dest.e));
      this.write(this.outStream(s.dest, name), text);
    }
  }

  private async execPrintAsync(s: Extract<Stmt, { k: 'print' | 'printf' }>): Promise<void> {
    const vals: Val[] = [];
    for (const a of s.args) vals.push(await this.evA(a));
    const text = this.formatPrint(s, vals, () => this.ctx.stdout);
    if (!s.dest) {
      this.write(this.ctx.stdout, text);
      return;
    }
    const name = this.toStr(await this.evA(s.dest.e));
    if (s.dest.kind === '|') {
      const p = await this.openPipe(name);
      this.write(p.stream, text);
      if (this.queued > 65536) await this.flush();
      return;
    }
    this.write(this.outStream(s.dest, name), text);
  }

  execListSync(list: Stmt[]): number {
    for (const s of list) {
      const c = this.execSync(s);
      if (c !== NORMAL) return c;
    }
    return NORMAL;
  }

  execSync(s: Stmt): number {
    switch (s.k) {
      case 'expr':
        this.ev(s.e);
        return NORMAL;
      case 'print':
      case 'printf':
        this.execPrintSync(s);
        return NORMAL;
      case 'if':
        return this.toBool(this.ev(s.c)) ? this.execSync(s.t) : s.f ? this.execSync(s.f) : NORMAL;
      case 'block':
        return this.execListSync(s.body);
      case 'next':
        return NEXT;
      case 'nextfile':
        return NEXTFILE;
      case 'break':
        return BREAK;
      case 'continue':
        return CONTINUE;
      case 'empty':
        return NORMAL;
      case 'exit':
        if (s.e) this.exitCode = Math.trunc(toNum(this.ev(s.e))) & 255;
        return EXIT;
      case 'return':
        this.retVal = s.e ? this.ev(s.e) : undefined;
        return RETURN;
      case 'delete': {
        const arr = this.arrOf(s.arr);
        if (s.subs) arr.delete(this.subscript(s.subs.map((x) => this.ev(x))), this.keyStr);
        else arr.clear();
        return NORMAL;
      }
      default:
        throw new AwkRuntimeError('internal error: loop in synchronous context');
    }
  }

  async execList(list: Stmt[]): Promise<number> {
    for (const s of list) {
      const c = s.async ? await this.execA(s) : this.execSync(s);
      if (c !== NORMAL) return c;
    }
    return NORMAL;
  }

  private async tick(): Promise<void> {
    if (++this.steps >= 2000) {
      this.steps = 0;
      await this.ctx.checkpoint();
      if (this.queued > 65536) await this.flush();
    }
  }

  private async execA(s: Stmt): Promise<number> {
    switch (s.k) {
      case 'expr':
        await this.evA(s.e);
        return NORMAL;
      case 'print':
      case 'printf':
        await this.execPrintAsync(s);
        return NORMAL;
      case 'if': {
        const c = this.toBool(await this.evA(s.c));
        const branch = c ? s.t : s.f;
        if (!branch) return NORMAL;
        return branch.async ? this.execA(branch) : this.execSync(branch);
      }
      case 'block':
        return this.execList(s.body);
      case 'while':
        for (;;) {
          await this.tick();
          if (!this.toBool(await this.evA(s.c))) return NORMAL;
          const c = s.body.async ? await this.execA(s.body) : this.execSync(s.body);
          if (c === BREAK) return NORMAL;
          if (c !== NORMAL && c !== CONTINUE) return c;
        }
      case 'do':
        for (;;) {
          await this.tick();
          const c = s.body.async ? await this.execA(s.body) : this.execSync(s.body);
          if (c === BREAK) return NORMAL;
          if (c !== NORMAL && c !== CONTINUE) return c;
          if (!this.toBool(await this.evA(s.c))) return NORMAL;
        }
      case 'for': {
        if (s.init) await this.execA(s.init);
        for (;;) {
          await this.tick();
          if (s.c && !this.toBool(await this.evA(s.c))) return NORMAL;
          const c = s.body.async ? await this.execA(s.body) : this.execSync(s.body);
          if (c === BREAK) return NORMAL;
          if (c !== NORMAL && c !== CONTINUE) return c;
          if (s.step) {
            if (s.step.async) await this.execA(s.step);
            else this.execSync(s.step);
          }
        }
      }
      case 'forin': {
        const arr = this.arrOf(s.arr);
        for (const k of arr.keys()) {
          await this.tick();
          const subs = await this.lvSubsA(s.v);
          this.lref(s.v, subs).set(k);
          const c = s.body.async ? await this.execA(s.body) : this.execSync(s.body);
          if (c === BREAK) return NORMAL;
          if (c !== NORMAL && c !== CONTINUE) return c;
        }
        return NORMAL;
      }
      case 'exit':
        if (s.e) this.exitCode = Math.trunc(toNum(await this.evA(s.e))) & 255;
        return EXIT;
      case 'return':
        this.retVal = s.e ? await this.evA(s.e) : undefined;
        return RETURN;
      case 'delete': {
        const arr = this.arrOf(s.arr);
        if (s.subs) {
          const vals: Val[] = [];
          for (const x of s.subs) vals.push(await this.evA(x));
          arr.delete(this.subscript(vals), this.keyStr);
        } else arr.clear();
        return NORMAL;
      }
      default:
        return this.execSync(s);
    }
  }

  // --- the main program
  async matchPattern(p: Expr): Promise<boolean> {
    return this.toBool(p.async ? await this.evA(p) : this.ev(p));
  }

  async runRules(): Promise<number> {
    for (const r of this.prog.rules) {
      let hit: boolean;
      if (!r.pattern) hit = true;
      else if (!r.pattern2) hit = await this.matchPattern(r.pattern);
      else if (r.inRange) {
        hit = true;
        if (await this.matchPattern(r.pattern2)) r.inRange = false;
      } else if (await this.matchPattern(r.pattern)) {
        hit = true;
        r.inRange = !(await this.matchPattern(r.pattern2));
      } else hit = false;
      if (!hit) continue;
      if (!r.action) {
        this.write(this.ctx.stdout, this.toStr(this.recordVal) + this.toStr(this.vals[V_ORS]));
        continue;
      }
      const c = await this.execList(r.action);
      if (c === NEXT || c === NEXTFILE || c === EXIT) return c;
    }
    return NORMAL;
  }

  hasMain(): boolean {
    return this.prog.rules.length > 0 || this.prog.ends.length > 0;
  }
}

class AwkExitSignal extends Error {}
class AwkNextSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super('next');
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Command line

const MAWK_USAGE = `Usage: mawk [Options] [Program] [file ...]

Program:
    The -f option value is the name of a file containing program text.
    If no -f option is given, a "--" ends option processing; the following
    parameters are the program text.

Options:
    -f program-file  Program  text is read from file instead of from the
                     command-line.  Multiple -f options are accepted.
    -F value         sets the field separator, FS, to value.
    -v var=value     assigns value to program variable var.
    --               unambiguous end of options.

    Implementation-specific options are prefixed with "-W".  They can be
    abbreviated:

    -W version       show version information and exit.
    -W compat        pre-POSIX 2001.
    -W dump          show assembler-like listing of program and exit.
    -W help          show this message and exit.
    -W interactive   set unbuffered output, line-buffered input.
    -W exec file     use file as program as well as last option.
    -W posix         stricter POSIX checking.
    -W random=number set initial random seed.
    -W sprintf=number adjust size of sprintf buffer.
    -W usage         show this message and exit.
`;

const MAWK_VERSION = `mawk 1.3.4 20240123
Copyright 2008-2023,2024, Thomas E. Dickey
Copyright 1991-1996,2014, Michael D. Brennan

random-funcs:       arc4random_stir/arc4random
regex-funcs:        internal

compiled limits:
sprintf buffer      8192
maximum-integer     9223372036854775808
`;

const AWK_DOC: CommandDef['doc'] = {
  category: 'text',
  summary: 'pattern scanning and text processing language',
  synopsis: ["awk [-F value] [-v var=value] [--] 'program text' [file ...]", 'awk [-F value] [-v var=value] [-f program-file] [--] [file ...]'],
  description:
    'awk reads its input one line (record) at a time, splits each line into fields, and runs a small program on it. The program is a list of pattern { action } pairs: for every line that matches the pattern, the action runs. Leave out the pattern to run the action for every line; leave out the action to print the matching lines.\n\n' +
    'Fields are $1, $2, ... and the whole line is $0. NF is the number of fields (so $NF is the last one) and NR is the current line number. By default fields are separated by runs of spaces and tabs; use -F to choose another separator, such as -F, for CSV files or -F: for /etc/passwd.\n\n' +
    'Patterns can be regular expressions (/error/), comparisons ($3 > 100), combinations (&& || !), ranges (/start/,/end/) and the special BEGIN and END patterns, which run before the first line and after the last. Actions use a C-like language: variables need no declaration, arrays are indexed by strings (count[$1]++), and there are if/else, while, for, for (key in array), printf, user functions and built-in functions such as length, substr, index, split, sub, gsub, match, sprintf, tolower, toupper, int, sqrt and rand.\n\n' +
    'This is mawk, the awk installed by default on Ubuntu.',
  options: [
    { flags: '-F value', desc: 'sets the field separator, FS, to value (a single character, or a regular expression)' },
    { flags: '-f file', desc: 'program text is read from file instead of from the command line (may be repeated)' },
    { flags: '-v var=value', desc: 'assigns value to program variable var before the program starts' },
    { flags: '--', desc: 'indicates the unambiguous end of options' },
    { flags: '-W version', desc: 'mawk writes its version and copyright to stdout and exits' },
  ],
  examples: [
    { cmd: "awk '{print $1}' file.txt", desc: 'Print the first word of every line.' },
    { cmd: "awk -F, '{print $2}' data.csv", desc: 'Print the second column of a CSV file.' },
    { cmd: "awk -F: '{print $1, $7}' /etc/passwd", desc: "Show each user's name and login shell." },
    { cmd: "awk '$3 > 100' sales.txt", desc: 'Print lines whose third field is greater than 100.' },
    { cmd: "awk '{sum += $2} END {print sum}' numbers.txt", desc: 'Add up the second column.' },
    { cmd: "awk 'NR > 1' data.csv", desc: 'Skip the header line.' },
    { cmd: "awk '{count[$1]++} END {for (w in count) print w, count[w]}' log.txt", desc: 'Count how often each first word appears.' },
    { cmd: "awk '{print NF}' file.txt", desc: 'Show how many fields each line has.' },
    { cmd: "awk 'length > 72' file.txt", desc: 'Show lines longer than 72 characters.' },
  ],
  seeAlso: ['sed', 'grep', 'cut', 'sort'],
  tip: "Put the awk program in single quotes so the shell does not touch $1. Inside awk, $1 is the first field, not a shell variable.",
};

async function awkMain(ctx: CommandContext): Promise<number> {
  const progName = ctx.name.replace(/.*\//, '') || 'awk';
  const args = ctx.args;
  const err = async (msg: string) => ctx.err(`${progName}: ${msg}\n`);
  let i = 0;
  const progFiles: string[] = [];
  let fs: string | null = null;
  const assigns: [string, string][] = [];
  while (i < args.length) {
    const a = args[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '--version' || a === '-version') {
      await ctx.out(MAWK_VERSION);
      return 0;
    }
    if (a === '--help' || a === '-help' || a === '--usage') {
      await ctx.out(MAWK_USAGE);
      return 0;
    }
    if (!a.startsWith('-') || a === '-') break;
    const opt = a[1];
    let val: string | undefined = a.length > 2 ? a.slice(2) : undefined;
    const take = async (): Promise<string | null> => {
      if (val !== undefined) return val;
      if (i + 1 < args.length) return args[++i];
      await err(`option -${opt} lacks argument`);
      return null;
    };
    switch (opt) {
      case 'f': {
        const v = await take();
        if (v === null) return 2;
        progFiles.push(v);
        break;
      }
      case 'F': {
        const v = await take();
        if (v === null) return 2;
        fs = v;
        break;
      }
      case 'v': {
        const v = await take();
        if (v === null) return 2;
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(v);
        if (!m) {
          await err(`improper assignment: -v ${v}`);
          return 2;
        }
        assigns.push([m[1], m[2]]);
        break;
      }
      case 'W': {
        const v = await take();
        if (v === null) return 2;
        const w = v.replace(/=.*/, '');
        if ('version'.startsWith(w) && w) {
          await ctx.out(MAWK_VERSION);
          return 0;
        }
        if (('help'.startsWith(w) || 'usage'.startsWith(w)) && w) {
          await ctx.out(MAWK_USAGE);
          return 0;
        }
        if (!['compat', 'dump', 'interactive', 'exec', 'posix', 'random', 'sprintf', 'traditional', 'repetitions'].some((o) => o.startsWith(w) && w)) {
          await err(`vacuous option: -W "${v}"`);
        }
        break;
      }
      default:
        await err(`not an option: ${a}`);
        return 2;
    }
    i++;
  }
  let src: string;
  const fileLines: { name: string; start: number; lines: number }[] = [];
  if (progFiles.length) {
    const parts: string[] = [];
    for (const f of progFiles) {
      try {
        if (f === '-' || f === '/dev/stdin') parts.push(await ctx.stdin.readAll());
        else {
          const node = ctx.fs.stat(f);
          if (node.type === 'dir') throw new FsError('EISDIR', f);
          parts.push(ctx.fs.readFile(f));
        }
      } catch (e) {
        await err(`cannot open "${f}" (${errText(e)})`);
        return 2;
      }
    }
    let line = 1;
    parts.forEach((p, k) => {
      const lines = p.split('\n').length - (p.endsWith('\n') ? 1 : 0);
      fileLines.push({ name: progFiles[k], start: line, lines });
      line += lines;
      if (!p.endsWith('\n') && k < parts.length - 1) parts[k] = p + '\n';
    });
    src = parts.join('');
  } else {
    if (i >= args.length) {
      await ctx.err(MAWK_USAGE);
      return 0;
    }
    src = args[i++];
  }
  const operands = args.slice(i);

  // compile
  let prog: Program;
  const where = (m: string): string => {
    if (!fileLines.length) return m;
    return m.replace(/^(line )?(\d+):/, (_all, word: string | undefined, n: string) => {
      const ln = parseInt(n, 10);
      let f = fileLines[fileLines.length - 1];
      for (const fl of fileLines) if (ln >= fl.start && ln < fl.start + fl.lines) f = fl;
      return `${f.name}: ${word ?? ''}${ln - f.start + 1}:`;
    });
  };
  try {
    const extra: string[] = [];
    const toks = tokenize(src, extra);
    const parser = new Parser(toks, src, extra);
    prog = parser.parseProgram();
    inferArrayParams(prog);
    const typeErrors = checkCallTypes(prog);
    if (typeErrors.length) throw new AwkSyntaxError(typeErrors);
    markAsync(prog);
  } catch (e) {
    if (e instanceof AwkSyntaxError) {
      for (const m of e.msgs) await err(where(m));
      return 2;
    }
    throw e;
  }

  const rt = new Interp(ctx, prog, progName);
  // ARGV / ARGC
  const argv = rt.arrays[1];
  argv.find(0, (v) => rt.toStr(v), true)!.v = progName;
  operands.forEach((o, k) => {
    argv.find(k + 1, (v) => rt.toStr(v), true)!.v = inputVal(o);
  });
  rt.vals[V_ARGC] = operands.length + 1;
  if (fs !== null) {
    let f = unescapeAwk(fs);
    if (fs === 't') f = 't';
    rt.vals[V_FS] = f;
    (rt as unknown as { setFS(s: string): void }).setFS(f);
  }
  for (const [name, value] of assigns) rt.assignVar(name, value);

  const report = async (e: unknown): Promise<number | null> => {
    if (e instanceof AwkRuntimeError) {
      await rt.flush().catch(() => {});
      await err(`run time error: ${e.message}\n${rt.errorTrailer()}`);
      return 2;
    }
    if (e instanceof AwkFatal) {
      await rt.flush().catch(() => {});
      await err(e.message);
      return 2;
    }
    return null;
  };

  let exiting = false;
  try {
    try {
      for (const b of prog.begins) {
        const c = await rt.execList(b);
        if (c === EXIT) {
          exiting = true;
          break;
        }
      }
    } catch (e) {
      if (e instanceof AwkExitSignal) exiting = true;
      else throw e;
    }
    if (!exiting && rt.hasMain()) {
      let n = 0;
      for (;;) {
        const rec = await rt.nextMain();
        if (rec === null) break;
        rt.setRecord(rec);
        let c: number;
        try {
          c = await rt.runRules();
        } catch (e) {
          if (e instanceof AwkExitSignal) c = EXIT;
          else if (e instanceof AwkNextSignal) c = e.code;
          else throw e;
        }
        if (c === EXIT) break;
        if (c === NEXTFILE) rt.nextFile();
        if (++n % 256 === 0) await ctx.checkpoint();
        await rt.maybeFlush();
      }
    }
    try {
      for (const b of prog.ends) {
        const c = await rt.execList(b);
        if (c === EXIT) break;
      }
    } catch (e) {
      if (!(e instanceof AwkExitSignal)) throw e;
    }
    await rt.closeAll();
  } catch (e) {
    const st = await report(e);
    if (st !== null) {
      await rt.closeAll().catch(() => {});
      return st;
    }
    throw e;
  }
  return rt.exitCode;
}

defineCommand({ name: 'mawk', pkg: 'mawk', size: 170768, doc: { ...AWK_DOC }, gnu: false, run: awkMain });
defineCommand({ name: 'awk', pkg: 'mawk', size: 170768, doc: AWK_DOC, gnu: false, run: awkMain });

export { AwkExit };
