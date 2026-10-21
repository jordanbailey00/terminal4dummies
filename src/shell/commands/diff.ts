// GNU diffutils 3.10: diff and cmp.
//
// The comparison follows GNU diff's own algorithm (analyze.c and gnulib's
// diffseq.h): identical prefix/suffix trimming, discarding of confusing
// lines, Myers' O(ND) middle-snake search and shift_boundaries(), so the
// hunks chosen are the same ones GNU diff prints.

import { compareLocale } from '../collate';
import { matchPattern } from '../glob';
import type { CommandContext } from '../types';
import { FsError, isBinaryData, type Inode } from '../vfs/fs';
import { convertPosixRegex } from './sed';
import { defineCommand, errText, pad2, parseOpts, OptError, tzOffset, type CommandDef } from './util';

// ---------------------------------------------------------------------------
// The core algorithm

interface Change {
  line0: number;
  line1: number;
  deleted: number;
  inserted: number;
  ignore: boolean;
}

const INT_MAX = 0x7fffffff;

class DiffContext {
  readonly xv: Int32Array;
  readonly yv: Int32Array;
  readonly fd: Int32Array;
  readonly bd: Int32Array;
  readonly off: number;
  readonly tooExpensive: number;
  readonly changed0: Uint8Array;
  readonly changed1: Uint8Array;
  readonly real0: Int32Array;
  readonly real1: Int32Array;
  constructor(xv: Int32Array, yv: Int32Array, real0: Int32Array, real1: Int32Array, changed0: Uint8Array, changed1: Uint8Array) {
    this.xv = xv;
    this.yv = yv;
    this.real0 = real0;
    this.real1 = real1;
    this.changed0 = changed0;
    this.changed1 = changed1;
    let diags = xv.length + yv.length + 3;
    this.off = yv.length + 1;
    this.fd = new Int32Array(diags);
    this.bd = new Int32Array(diags);
    let te = 1;
    for (; diags !== 0; diags >>= 2) te <<= 1;
    this.tooExpensive = Math.max(4096, te);
  }
}

interface Part {
  xmid: number;
  ymid: number;
  lo: boolean;
  hi: boolean;
}

function diag(xoff: number, xlim: number, yoff: number, ylim: number, findMinimal: boolean, c: DiffContext): Part {
  const fd = c.fd;
  const bd = c.bd;
  const o = c.off;
  const xv = c.xv;
  const yv = c.yv;
  const dmin = xoff - ylim;
  const dmax = xlim - yoff;
  const fmid = xoff - yoff;
  const bmid = xlim - ylim;
  let fmin = fmid;
  let fmax = fmid;
  let bmin = bmid;
  let bmax = bmid;
  const odd = ((fmid - bmid) & 1) !== 0;
  fd[o + fmid] = xoff;
  bd[o + bmid] = xlim;
  for (let cost = 1; ; ++cost) {
    if (fmin > dmin) fd[o + --fmin - 1] = -1;
    else ++fmin;
    if (fmax < dmax) fd[o + ++fmax + 1] = -1;
    else --fmax;
    for (let d = fmax; d >= fmin; d -= 2) {
      const tlo = fd[o + d - 1];
      const thi = fd[o + d + 1];
      const x0 = tlo < thi ? thi : tlo + 1;
      let x = x0;
      let y = x0 - d;
      while (x < xlim && y < ylim && xv[x] === yv[y]) {
        x++;
        y++;
      }
      fd[o + d] = x;
      if (odd && bmin <= d && d <= bmax && bd[o + d] <= x) return { xmid: x, ymid: y, lo: true, hi: true };
    }
    if (bmin > dmin) bd[o + --bmin - 1] = INT_MAX;
    else ++bmin;
    if (bmax < dmax) bd[o + ++bmax + 1] = INT_MAX;
    else --bmax;
    for (let d = bmax; d >= bmin; d -= 2) {
      const tlo = bd[o + d - 1];
      const thi = bd[o + d + 1];
      const x0 = tlo < thi ? tlo : thi - 1;
      let x = x0;
      let y = x0 - d;
      while (xoff < x && yoff < y && xv[x - 1] === yv[y - 1]) {
        x--;
        y--;
      }
      bd[o + d] = x;
      if (!odd && fmin <= d && d <= fmax && x <= fd[o + d]) return { xmid: x, ymid: y, lo: true, hi: true };
    }
    if (findMinimal) continue;
    if (cost >= c.tooExpensive) {
      let fxybest = -1;
      let fxbest = 0;
      for (let d = fmax; d >= fmin; d -= 2) {
        let x = Math.min(fd[o + d], xlim);
        let y = x - d;
        if (ylim < y) {
          x = ylim + d;
          y = ylim;
        }
        if (fxybest < x + y) {
          fxybest = x + y;
          fxbest = x;
        }
      }
      let bxybest = INT_MAX;
      let bxbest = 0;
      for (let d = bmax; d >= bmin; d -= 2) {
        let x = Math.max(xoff, bd[o + d]);
        let y = x - d;
        if (y < yoff) {
          x = yoff + d;
          y = yoff;
        }
        if (x + y < bxybest) {
          bxybest = x + y;
          bxbest = x;
        }
      }
      if (xlim + ylim - bxybest < fxybest - (xoff + yoff)) return { xmid: fxbest, ymid: fxybest - fxbest, lo: true, hi: false };
      return { xmid: bxbest, ymid: bxybest - bxbest, lo: false, hi: true };
    }
  }
}

function compareseq(xoff: number, xlim: number, yoff: number, ylim: number, findMinimal: boolean, c: DiffContext): void {
  const xv = c.xv;
  const yv = c.yv;
  for (;;) {
    while (xoff < xlim && yoff < ylim && xv[xoff] === yv[yoff]) {
      xoff++;
      yoff++;
    }
    while (xoff < xlim && yoff < ylim && xv[xlim - 1] === yv[ylim - 1]) {
      xlim--;
      ylim--;
    }
    if (xoff === xlim) {
      while (yoff < ylim) c.changed1[c.real1[yoff++] + 1] = 1;
      return;
    }
    if (yoff === ylim) {
      while (xoff < xlim) c.changed0[c.real0[xoff++] + 1] = 1;
      return;
    }
    const p = diag(xoff, xlim, yoff, ylim, findMinimal, c);
    if (xlim + ylim - (p.xmid + p.ymid) < p.xmid + p.ymid - (xoff + yoff)) {
      compareseq(p.xmid, xlim, p.ymid, ylim, p.hi, c);
      xlim = p.xmid;
      ylim = p.ymid;
      findMinimal = p.lo;
    } else {
      compareseq(xoff, p.xmid, yoff, p.ymid, p.lo, c);
      xoff = p.xmid;
      yoff = p.ymid;
      findMinimal = p.hi;
    }
  }
}

/** GNU's discard_confusing_lines(). changed arrays are offset by one (sentinel at -1). */
function discardConfusing(eq: [Int32Array, Int32Array], nclasses: number, minimal: boolean, changed: [Uint8Array, Uint8Array]): { undiscarded: [Int32Array, Int32Array]; real: [Int32Array, Int32Array] } {
  const counts: [Int32Array, Int32Array] = [new Int32Array(nclasses + 1), new Int32Array(nclasses + 1)];
  for (let f = 0; f < 2; f++) for (const e of eq[f]) counts[f][e]++;
  const discarded: [Uint8Array, Uint8Array] = [new Uint8Array(eq[0].length), new Uint8Array(eq[1].length)];
  for (let f = 0; f < 2; f++) {
    const end = eq[f].length;
    const discards = discarded[f];
    const other = counts[1 - f];
    const equivs = eq[f];
    let many = 5;
    let tem = Math.floor(end / 64);
    while ((tem = tem >> 2) > 0) many *= 2;
    for (let i = 0; i < end; i++) {
      if (equivs[i] === 0) continue;
      const nmatch = other[equivs[i]];
      if (nmatch === 0) discards[i] = 1;
      else if (nmatch > many) discards[i] = 2;
    }
  }
  for (let f = 0; f < 2; f++) {
    const end = eq[f].length;
    const discards = discarded[f];
    for (let i = 0; i < end; i++) {
      if (discards[i] === 2) discards[i] = 0;
      else if (discards[i] !== 0) {
        let j: number;
        let provisional = 0;
        for (j = i; j < end; j++) {
          if (discards[j] === 0) break;
          if (discards[j] === 2) ++provisional;
        }
        while (j > i && discards[j - 1] === 2) {
          discards[--j] = 0;
          --provisional;
        }
        const length = j - i;
        if (provisional * 4 > length) {
          while (j > i) if (discards[--j] === 2) discards[j] = 0;
        } else {
          let minimum = 1;
          let t = length >> 2;
          while (0 < (t >>= 2)) minimum <<= 1;
          minimum++;
          let consec = 0;
          for (j = 0, consec = 0; j < length; j++) {
            if (discards[i + j] !== 2) consec = 0;
            else if (minimum === ++consec) j -= consec;
            else if (minimum < consec) discards[i + j] = 0;
          }
          for (j = 0, consec = 0; j < length; j++) {
            if (j >= 8 && discards[i + j] === 1) break;
            if (discards[i + j] === 2) {
              consec = 0;
              discards[i + j] = 0;
            } else if (discards[i + j] === 0) consec = 0;
            else consec++;
            if (consec === 3) break;
          }
          i += length - 1;
          for (j = 0, consec = 0; j < length; j++) {
            if (j >= 8 && discards[i - j] === 1) break;
            if (discards[i - j] === 2) {
              consec = 0;
              discards[i - j] = 0;
            } else if (discards[i - j] === 0) consec = 0;
            else consec++;
            if (consec === 3) break;
          }
        }
      }
    }
  }
  const undiscarded: Int32Array[] = [];
  const real: Int32Array[] = [];
  for (let f = 0; f < 2; f++) {
    const end = eq[f].length;
    const u = new Int32Array(end);
    const r = new Int32Array(end);
    let j = 0;
    for (let i = 0; i < end; i++) {
      if (minimal || discarded[f][i] === 0) {
        u[j] = eq[f][i];
        r[j++] = i;
      } else changed[f][i + 1] = 1;
    }
    undiscarded.push(u.subarray(0, j));
    real.push(r.subarray(0, j));
  }
  return { undiscarded: undiscarded as [Int32Array, Int32Array], real: real as [Int32Array, Int32Array] };
}

/** GNU's shift_boundaries(): slide change groups to look nicer. */
function shiftBoundaries(eq: [Int32Array, Int32Array], changed: [Uint8Array, Uint8Array]): void {
  for (let f = 0; f < 2; f++) {
    const ch = changed[f];
    const oc = changed[1 - f];
    const equivs = eq[f];
    const C = (i: number) => ch[i + 1];
    const O = (j: number) => oc[j + 1];
    let i = 0;
    let j = 0;
    const iEnd = equivs.length;
    for (;;) {
      while (i < iEnd && !C(i)) {
        while (O(j++)) continue;
        i++;
      }
      if (i === iEnd) break;
      let start = i;
      while (C(++i)) continue;
      while (O(j)) j++;
      let runlength: number;
      let corresponding: number;
      do {
        runlength = i - start;
        while (start && equivs[start - 1] === equivs[i - 1]) {
          ch[--start + 1] = 1;
          ch[--i + 1] = 0;
          while (C(start - 1)) start--;
          while (O(--j)) continue;
        }
        corresponding = O(j - 1) ? i : iEnd;
        while (i !== iEnd && equivs[start] === equivs[i]) {
          ch[start++ + 1] = 0;
          ch[i++ + 1] = 1;
          while (C(i)) i++;
          while (O(++j)) corresponding = i;
        }
      } while (runlength !== i - start);
      while (corresponding < i) {
        ch[--start + 1] = 1;
        ch[--i + 1] = 0;
        while (O(--j)) continue;
      }
    }
  }
}

interface FileText {
  name: string;
  /** Lines without their newline. */
  lines: string[];
  missingNewline: boolean;
  text: string;
  mtime: number;
  binary: boolean;
}

function splitText(text: string): { lines: string[]; missingNewline: boolean } {
  if (text === '') return { lines: [], missingNewline: false };
  const lines = text.split('\n');
  const missing = lines[lines.length - 1] !== '';
  if (!missing) lines.pop();
  return { lines, missingNewline: missing };
}

interface CompareOptions {
  ignoreCase: boolean;
  ignoreAllSpace: boolean;
  ignoreSpaceChange: boolean;
  ignoreTrailingSpace: boolean;
  ignoreTabExpansion: boolean;
  stripCr: boolean;
  ignoreBlank: boolean;
  ignoreRe: RegExp[];
  minimal: boolean;
  horizon: number;
}

function normalizeLine(s: string, o: CompareOptions): string {
  let t = s;
  if (o.stripCr && t.endsWith('\r')) t = t.slice(0, -1);
  if (o.ignoreTabExpansion && t.includes('\t')) {
    let out = '';
    for (const ch of t) out += ch === '\t' ? ' '.repeat(8 - (out.length % 8)) : ch;
    t = out;
  }
  if (o.ignoreAllSpace) t = t.replace(/[ \t\v\f\r]+/g, '');
  else if (o.ignoreSpaceChange) t = t.replace(/[ \t\v\f\r]+/g, ' ').replace(/ $/, '');
  else if (o.ignoreTrailingSpace) t = t.replace(/[ \t\v\f\r]+$/, '');
  if (o.ignoreCase) t = t.toLowerCase();
  return t;
}

/** Compute the edit script between two files, GNU style. */
function computeChanges(a: FileText, b: FileText, o: CompareOptions): Change[] {
  const n0 = a.lines.length;
  const n1 = b.lines.length;
  // --- identical prefix (in whole lines), keeping `horizon` lines
  let p = 0;
  const lim = Math.min(n0, n1);
  while (p < lim && a.lines[p] === b.lines[p]) p++;
  // a last line without newline is not equal to the same text with one
  if (p === lim && p > 0 && (p === n0 || p === n1)) {
    const lastA = p === n0 && a.missingNewline;
    const lastB = p === n1 && b.missingNewline;
    if ((p === n0 && p === n1 && lastA !== lastB) || (p === n0 && lastA && p < n1) || (p === n1 && lastB && p < n0)) p--;
  }
  let prefix = Math.max(0, p - o.horizon);
  // --- identical suffix
  let s = 0;
  if (a.missingNewline === b.missingNewline) {
    const maxS = Math.min(n0, n1) - prefix;
    while (s < maxS && a.lines[n0 - 1 - s] === b.lines[n1 - 1 - s]) s++;
    s = Math.max(0, s - o.horizon);
  }
  if (prefix > Math.min(n0, n1)) prefix = Math.min(n0, n1);
  const m0 = n0 - prefix - s;
  const m1 = n1 - prefix - s;
  // --- equivalence classes
  const classes = new Map<string, number>();
  const classOf = (line: string, last: boolean): number => {
    let k = normalizeLine(line, o);
    if (last) k += '\u0000\u0001nonl';
    let c = classes.get(k);
    if (c === undefined) {
      c = classes.size + 1;
      classes.set(k, c);
    }
    return c;
  };
  const eq0 = new Int32Array(m0);
  const eq1 = new Int32Array(m1);
  for (let i = 0; i < m0; i++) eq0[i] = classOf(a.lines[prefix + i], a.missingNewline && prefix + i === n0 - 1);
  for (let i = 0; i < m1; i++) eq1[i] = classOf(b.lines[prefix + i], b.missingNewline && prefix + i === n1 - 1);
  const changed: [Uint8Array, Uint8Array] = [new Uint8Array(m0 + 2), new Uint8Array(m1 + 2)];
  const d = discardConfusing([eq0, eq1], classes.size, o.minimal, changed);
  const ctx = new DiffContext(d.undiscarded[0], d.undiscarded[1], d.real[0], d.real[1], changed[0], changed[1]);
  compareseq(0, d.undiscarded[0].length, 0, d.undiscarded[1].length, o.minimal, ctx);
  shiftBoundaries([eq0, eq1], changed);
  // --- build the script (forward order)
  const out: Change[] = [];
  let i0 = m0;
  let i1 = m1;
  const c0 = changed[0];
  const c1 = changed[1];
  while (i0 >= 0 || i1 >= 0) {
    if (c0[i0] | c1[i1]) {
      const line0 = i0;
      const line1 = i1;
      while (c0[i0]) --i0;
      while (c1[i1]) --i1;
      out.push({ line0: i0 + prefix, line1: i1 + prefix, deleted: line0 - i0, inserted: line1 - i1, ignore: false });
    }
    i0--;
    i1--;
  }
  out.reverse();
  // ignorable changes (-B, -I)
  if (o.ignoreBlank || o.ignoreRe.length) {
    const trivial = (line: string) => {
      if (o.ignoreBlank && (line === '' || ((o.ignoreAllSpace || o.ignoreSpaceChange || o.ignoreTrailingSpace) && /^[ \t\v\f\r]*$/.test(line)))) return true;
      return o.ignoreRe.some((re) => {
        re.lastIndex = 0;
        return re.test(line);
      });
    };
    for (const c of out) {
      let all = true;
      for (let k = 0; k < c.deleted && all; k++) if (!trivial(a.lines[c.line0 + k])) all = false;
      for (let k = 0; k < c.inserted && all; k++) if (!trivial(b.lines[c.line1 + k])) all = false;
      c.ignore = all;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output formats

interface OutputOptions {
  format: 'normal' | 'unified' | 'context' | 'sdiff' | 'ed' | 'rcs';
  context: number;
  color: boolean;
  width: number;
  suppressCommon: boolean;
  leftColumn: boolean;
  expandTabs: boolean;
  initialTab: boolean;
  labels: string[];
}

const C_RESET = '\x1b[0m';
const C_HEADER = '\x1b[1m';
const C_LINE = '\x1b[36m';
const C_DEL = '\x1b[31m';
const C_ADD = '\x1b[32m';

function numberRange(a: number, b: number): string {
  // a, b are 0-based inclusive; empty when b < a
  const ta = a + 1;
  const tb = b + 1;
  if (tb <= ta) return String(tb);
  return `${ta},${tb}`;
}

function unifiedRange(a: number, b: number): string {
  const ta = a + 1;
  const tb = b + 1;
  if (tb <= ta) return tb < ta ? `${tb},0` : `${tb}`;
  return `${ta},${tb - ta + 1}`;
}

function diffTime(t: number): string {
  const d = new Date(t);
  const ns = String((((t % 1000) + 1000) % 1000) * 1000000 + 427611).padStart(9, '0').slice(0, 9);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${ns} ${tzOffset(d)}`;
}

const NO_NL = '\\ No newline at end of file\n';

class Printer {
  out = '';
  private readonly o: OutputOptions;
  constructor(o: OutputOptions) {
    this.o = o;
  }
  paint(code: string, s: string): string {
    return this.o.color ? code + s + C_RESET : s;
  }
  /** A file line with prefix; adds the missing-newline marker. */
  line(prefix: string, f: FileText, i: number, color: string | null): void {
    const text = f.lines[i];
    const pre = this.o.initialTab && prefix !== '' ? prefix.replace(/ $/, '') + '\t' : prefix;
    if (color && this.o.color) this.out += color + pre + text + C_RESET + '\n';
    else this.out += pre + text + '\n';
    if (f.missingNewline && i === f.lines.length - 1) this.out += NO_NL;
  }
}

/** Group changes into hunks for context/unified output. */
function findHunks(changes: Change[], context: number): Change[][] {
  const hunks: Change[][] = [];
  let k = 0;
  while (k < changes.length) {
    const group = [changes[k]];
    let top0 = changes[k].line0 + changes[k].deleted;
    k++;
    while (k < changes.length) {
      const next = changes[k];
      const thresh = next.ignore ? context : 2 * context + 1;
      if (next.line0 - top0 < thresh) {
        group.push(next);
        top0 = next.line0 + next.deleted;
        k++;
      } else break;
    }
    hunks.push(group);
  }
  return hunks;
}

function printNormal(p: Printer, a: FileText, b: FileText, changes: Change[]): void {
  for (const c of changes) {
    if (c.ignore) continue;
    const r0 = numberRange(c.line0, c.line0 + c.deleted - 1);
    const r1 = numberRange(c.line1, c.line1 + c.inserted - 1);
    const op = c.deleted && c.inserted ? 'c' : c.deleted ? 'd' : 'a';
    p.out += p.paint(C_LINE, `${r0}${op}${r1}`) + '\n';
    for (let k = 0; k < c.deleted; k++) p.line('< ', a, c.line0 + k, C_DEL);
    if (op === 'c') p.out += '---\n';
    for (let k = 0; k < c.inserted; k++) p.line('> ', b, c.line1 + k, C_ADD);
  }
}

function printUnified(p: Printer, a: FileText, b: FileText, changes: Change[], o: OutputOptions): void {
  const ctx = o.context;
  const hunks = findHunks(changes, ctx).filter((h) => h.some((c) => !c.ignore));
  if (!hunks.length) return;
  const h0 = o.labels[0] !== undefined ? o.labels[0] : `${a.name}\t${diffTime(a.mtime)}`;
  const h1 = o.labels[1] !== undefined ? o.labels[1] : `${b.name}\t${diffTime(b.mtime)}`;
  p.out += p.paint(C_HEADER, `--- ${h0}`) + '\n';
  p.out += p.paint(C_HEADER, `+++ ${h1}`) + '\n';
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const first0 = Math.max(0, first.line0 - ctx);
    const first1 = Math.max(0, first.line1 - ctx);
    const last0 = Math.min(a.lines.length - 1, last.line0 + last.deleted - 1 + ctx);
    const last1 = Math.min(b.lines.length - 1, last.line1 + last.inserted - 1 + ctx);
    p.out += p.paint(C_LINE, `@@ -${unifiedRange(first0, last0)} +${unifiedRange(first1, last1)} @@`) + '\n';
    let i = first0;
    for (const c of h) {
      for (; i < c.line0; i++) p.line(' ', a, i, null);
      for (let k = 0; k < c.deleted; k++) p.line('-', a, c.line0 + k, C_DEL);
      for (let k = 0; k < c.inserted; k++) p.line('+', b, c.line1 + k, C_ADD);
      i = c.line0 + c.deleted;
    }
    for (; i <= last0; i++) p.line(' ', a, i, null);
  }
}

function printContext(p: Printer, a: FileText, b: FileText, changes: Change[], o: OutputOptions): void {
  const ctx = o.context;
  const hunks = findHunks(changes, ctx).filter((h) => h.some((c) => !c.ignore));
  if (!hunks.length) return;
  const h0 = o.labels[0] !== undefined ? o.labels[0] : `${a.name}\t${diffTime(a.mtime)}`;
  const h1 = o.labels[1] !== undefined ? o.labels[1] : `${b.name}\t${diffTime(b.mtime)}`;
  p.out += p.paint(C_HEADER, `*** ${h0}`) + '\n';
  p.out += p.paint(C_HEADER, `--- ${h1}`) + '\n';
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const first0 = Math.max(0, first.line0 - ctx);
    const first1 = Math.max(0, first.line1 - ctx);
    const last0 = Math.min(a.lines.length - 1, last.line0 + last.deleted - 1 + ctx);
    const last1 = Math.min(b.lines.length - 1, last.line1 + last.inserted - 1 + ctx);
    p.out += '***************\n';
    p.out += p.paint(C_LINE, `*** ${numberRange(first0, last0)} ****`) + '\n';
    const anyDel = h.some((c) => c.deleted > 0);
    const anyIns = h.some((c) => c.inserted > 0);
    if (anyDel) {
      let i = first0;
      for (const c of h) {
        for (; i < c.line0; i++) p.line('  ', a, i, C_DEL);
        const mark = c.inserted ? '! ' : '- ';
        for (let k = 0; k < c.deleted; k++) p.line(mark, a, c.line0 + k, C_DEL);
        i = c.line0 + c.deleted;
      }
      for (; i <= last0; i++) p.line('  ', a, i, C_DEL);
    }
    p.out += p.paint(C_LINE, `--- ${numberRange(first1, last1)} ----`) + '\n';
    if (anyIns) {
      let j = first1;
      for (const c of h) {
        for (; j < c.line1; j++) p.line('  ', b, j, C_ADD);
        const mark = c.deleted ? '! ' : '+ ';
        for (let k = 0; k < c.inserted; k++) p.line(mark, b, c.line1 + k, C_ADD);
        j = c.line1 + c.inserted;
      }
      for (; j <= last1; j++) p.line('  ', b, j, C_ADD);
    }
  }
}

/** Side-by-side (-y), following GNU's sdiff.c column arithmetic. */
function printSdiff(p: Printer, a: FileText, b: FileText, changes: Change[], o: OutputOptions): void {
  const tab = 8;
  const t = o.expandTabs ? 1 : tab;
  const w = o.width;
  const off = Math.floor((w + t + 3) / (2 * t)) * t;
  const hw = Math.max(0, Math.min(off - 3, w - off));
  const c2o = hw ? off : w;
  const tabFromTo = (from: number, to: number): string => {
    let s = '';
    if (!o.expandTabs) {
      for (let tb = from + tab - (from % tab); tb <= to; tb += tab) {
        s += '\t';
        from = tb;
      }
    }
    while (from++ < to) s += ' ';
    return s;
  };
  const half = (text: string, bound: number): { s: string; col: number } => {
    let s = '';
    let inPos = 0;
    let outPos = 0;
    for (const ch of text) {
      if (ch === '\t') {
        const spaces = tab - (inPos % tab);
        if (inPos === outPos) {
          let tabstop = outPos + spaces;
          if (o.expandTabs) {
            if (bound < tabstop) tabstop = bound;
            for (; outPos < tabstop; outPos++) s += ' ';
          } else if (tabstop < bound) {
            outPos = tabstop;
            s += ch;
          }
        }
        inPos += spaces;
        continue;
      }
      if (ch === '\r') {
        s += ch;
        inPos = outPos = 0;
        continue;
      }
      inPos++;
      if (inPos <= bound) {
        outPos = inPos;
        s += ch;
      }
    }
    return { s, col: outPos };
  };
  const line1 = (left: string | null, sep: string, right: string | null) => {
    let s = '';
    let col = 0;
    if (left !== null) {
      const h = half(left, hw);
      s += h.s;
      col = h.col;
    }
    if (sep !== ' ') {
      s += tabFromTo(col, Math.floor((hw + c2o - 1) / 2));
      col = Math.floor((hw + c2o - 1) / 2) + 1;
      s += sep;
    }
    if (right !== null && right !== '') {
      s += tabFromTo(col, c2o);
      s += half(right, hw).s;
    }
    const color = sep === '<' ? C_DEL : sep === '>' ? C_ADD : null;
    if (color && o.color) p.out += color + s + '\n' + C_RESET;
    else p.out += s + '\n';
  };
  const common = (i0: number, i1: number, n: number) => {
    if (o.suppressCommon) return;
    for (let k = 0; k < n; k++) {
      if (o.leftColumn) line1(a.lines[i0 + k], '(', null);
      else line1(a.lines[i0 + k], ' ', b.lines[i1 + k]);
    }
  };
  let i0 = 0;
  let i1 = 0;
  for (const c of changes) {
    common(i0, i1, c.line0 - i0);
    let k0 = c.line0;
    let k1 = c.line1;
    const e0 = c.line0 + c.deleted;
    const e1 = c.line1 + c.inserted;
    if (c.deleted && c.inserted) {
      for (; k0 < e0 && k1 < e1; k0++, k1++) line1(a.lines[k0], '|', b.lines[k1]);
    }
    for (; k1 < e1; k1++) line1(null, '>', b.lines[k1]);
    for (; k0 < e0; k0++) line1(a.lines[k0], '<', null);
    i0 = e0;
    i1 = e1;
  }
  common(i0, i1, a.lines.length - i0);
}

function printEd(p: Printer, b: FileText, changes: Change[]): void {
  for (const c of [...changes].reverse()) {
    if (c.ignore) continue;
    const r0 = numberRange(c.line0, c.line0 + c.deleted - 1);
    if (!c.inserted) {
      p.out += `${r0}d\n`;
      continue;
    }
    p.out += c.deleted ? `${r0}c\n` : `${c.line0}a\n`;
    for (let k = 0; k < c.inserted; k++) {
      const l = b.lines[c.line1 + k];
      p.out += (l === '.' ? '..' : l) + '\n';
    }
    p.out += '.\n';
  }
}

// ---------------------------------------------------------------------------
// diff command

const DIFF_DOC: CommandDef['doc'] = {
  category: 'text',
  summary: 'compare files line by line',
  synopsis: ['diff [OPTION]... FILES'],
  description:
    'Compare FILES line by line and print the differences. FILES are two file names, or a file and a directory (the file with the same name inside it is used), or two directories (each pair of files with the same name is compared; -r also descends into subdirectories). A FILE of - means standard input.\n\n' +
    'The default ("normal") output lists changes as commands: 2c2 means "line 2 changed", 5d4 "line 5 deleted", 7a8,9 "lines 8-9 added after line 7". Lines starting with < come from the first file and lines starting with > from the second. The unified format (-u) is easier to read and is what most tools use: lines starting with - were removed, lines starting with + were added and other lines are unchanged context.\n\n' +
    'Exit status is 0 if inputs are the same, 1 if different, 2 if trouble.',
  options: [
    { flags: '-q, --brief', desc: 'report only when files differ' },
    { flags: '-s, --report-identical-files', desc: 'report when two files are the same' },
    { flags: '-c, -C NUM, --context[=NUM]', desc: 'output NUM (default 3) lines of copied context' },
    { flags: '-u, -U NUM, --unified[=NUM]', desc: 'output NUM (default 3) lines of unified context' },
    { flags: '-y, --side-by-side', desc: 'output in two columns' },
    { flags: '-W, --width=NUM', desc: 'output at most NUM (default 130) print columns' },
    { flags: '--suppress-common-lines', desc: 'do not output common lines (with -y)' },
    { flags: '-r, --recursive', desc: 'recursively compare any subdirectories found' },
    { flags: '-N, --new-file', desc: 'treat absent files as empty' },
    { flags: '-i, --ignore-case', desc: 'ignore case differences in file contents' },
    { flags: '-b, --ignore-space-change', desc: 'ignore changes in the amount of white space' },
    { flags: '-w, --ignore-all-space', desc: 'ignore all white space' },
    { flags: '-B, --ignore-blank-lines', desc: 'ignore changes where lines are all blank' },
    { flags: '-I, --ignore-matching-lines=RE', desc: 'ignore changes where all lines match RE' },
    { flags: '-a, --text', desc: 'treat all files as text' },
    { flags: '--color[=WHEN]', desc: "color output; WHEN is 'never', 'always', or 'auto'" },
    { flags: '--label LABEL', desc: 'use LABEL instead of file name and timestamp (can be repeated)' },
    { flags: '-d, --minimal', desc: 'try hard to find a smaller set of changes' },
  ],
  examples: [
    { cmd: 'diff old.txt new.txt', desc: 'Show what changed between two files.' },
    { cmd: 'diff -u old.txt new.txt', desc: 'Unified format: - lines were removed, + lines were added.' },
    { cmd: 'diff -q a.txt b.txt', desc: 'Only say whether the files differ.' },
    { cmd: 'diff -y -W 80 old.txt new.txt', desc: 'Compare side by side.' },
    { cmd: 'diff -r project-v1 project-v2', desc: 'Compare two directory trees.' },
    { cmd: 'diff -iw a.txt b.txt', desc: 'Ignore differences in letter case and spacing.' },
  ],
  seeAlso: ['cmp', 'comm', 'patch'],
  tip: 'Read diff -u output like a recipe: remove the - lines and add the + lines to turn the first file into the second.',
};

interface DiffOpts {
  cmp: CompareOptions;
  out: OutputOptions;
  brief: boolean;
  reportSame: boolean;
  recursive: boolean;
  newFile: boolean;
  text: boolean;
  exclude: string[];
  switches: string;
}

function shellWord(s: string): string {
  if (s !== '' && /^[A-Za-z0-9_%+,./:@-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function loadFile(ctx: CommandContext, name: string, node: Inode | null, stdinCache: { text?: string }): Promise<FileText> {
  if (name === '-') {
    if (stdinCache.text === undefined) stdinCache.text = await ctx.stdin.readAll();
    const { lines, missingNewline } = splitText(stdinCache.text);
    return { name, lines, missingNewline, text: stdinCache.text, mtime: ctx.system.now(), binary: stdinCache.text.includes('\0') };
  }
  const n = node ?? ctx.fs.stat(name);
  const data = ctx.fs.readData(name);
  const text = typeof data === 'string' ? data : ctx.fs.readFile(name);
  const { lines, missingNewline } = splitText(text);
  return { name, lines, missingNewline, text, mtime: n.mtime, binary: isBinaryData(data) || text.includes('\0') };
}

async function diffMain(ctx: CommandContext): Promise<number> {
  let opts;
  try {
    opts = parseOpts(ctx.args, {
      short: 'abBcC:dD:eEF:hiI:lL:nNpPqrsS:tTuU:vwW:x:X:yZ0123456789',
      allowNegativeNumbers: false,
      long: {
        text: 'a',
        'ignore-space-change': 'b',
        'ignore-blank-lines': 'B',
        context: { key: 'context', arg: 'optional' },
        minimal: 'd',
        ed: 'e',
        'ignore-tab-expansion': 'E',
        'ignore-case': 'i',
        'ignore-matching-lines': { key: 'I', arg: 'required' },
        label: { key: 'L', arg: 'required' },
        rcs: 'n',
        'new-file': 'N',
        'show-c-function': 'p',
        brief: 'q',
        recursive: 'r',
        'report-identical-files': 's',
        'starting-file': { key: 'S', arg: 'required' },
        'expand-tabs': 't',
        'initial-tab': 'T',
        unified: { key: 'unified', arg: 'optional' },
        'ignore-all-space': 'w',
        width: { key: 'W', arg: 'required' },
        exclude: { key: 'x', arg: 'required' },
        'exclude-from': { key: 'X', arg: 'required' },
        'side-by-side': 'y',
        'ignore-trailing-space': 'Z',
        'strip-trailing-cr': 'strip-cr',
        normal: 'normal',
        'left-column': 'left-column',
        'suppress-common-lines': 'suppress-common',
        color: { key: 'color', arg: 'optional' },
        'speed-large-files': 'speed',
        'horizon-lines': { key: 'horizon', arg: 'required' },
        'no-dereference': 'no-deref',
        'unidirectional-new-file': 'P',
        'ignore-file-name-case': 'ifnc',
        'no-ignore-file-name-case': 'nifnc',
        'tabsize': { key: 'tabsize', arg: 'required' },
        'suppress-blank-empty': 'sbe',
        help: 'help',
        version: 'version',
      },
    });
  } catch (e) {
    if (e instanceof OptError) {
      await ctx.error(e.message);
      await ctx.error(`Try '${ctx.name} --help' for more information.`);
      return 2;
    }
    throw e;
  }
  const bad = async (msg: string) => {
    await ctx.error(msg);
    await ctx.error(`Try '${ctx.name} --help' for more information.`);
    return 2;
  };
  const out: OutputOptions = { format: 'normal', context: 3, color: false, width: 130, suppressCommon: false, leftColumn: false, expandTabs: false, initialTab: false, labels: [] };
  const cmp: CompareOptions = {
    ignoreCase: false,
    ignoreAllSpace: false,
    ignoreSpaceChange: false,
    ignoreTrailingSpace: false,
    ignoreTabExpansion: false,
    stripCr: false,
    ignoreBlank: false,
    ignoreRe: [],
    minimal: false,
    horizon: 0,
  };
  let digits = '';
  let explicitContext = false;
  for (const { key, value } of opts.list) {
    const v = value === true ? '' : value;
    if (/^\d$/.test(key)) {
      digits += key;
      continue;
    }
    switch (key) {
      case 'a':
        break;
      case 'b':
        cmp.ignoreSpaceChange = true;
        break;
      case 'B':
        cmp.ignoreBlank = true;
        break;
      case 'c':
        out.format = 'context';
        break;
      case 'C':
      case 'context':
      case 'U':
      case 'unified': {
        if (value !== true) {
          if (!/^\d+$/.test(v)) return bad(`invalid context length '${v}'`);
          out.context = parseInt(v, 10);
          explicitContext = true;
        }
        out.format = key === 'C' || key === 'context' ? 'context' : 'unified';
        break;
      }
      case 'u':
        out.format = 'unified';
        break;
      case 'd':
        cmp.minimal = true;
        break;
      case 'e':
        out.format = 'ed';
        break;
      case 'E':
        cmp.ignoreTabExpansion = true;
        break;
      case 'i':
        cmp.ignoreCase = true;
        break;
      case 'I':
        try {
          cmp.ignoreRe.push(new RegExp(convertPosixRegex(v, { extended: false, dialect: 'sed' }).source));
        } catch (e) {
          await ctx.error(e instanceof Error ? e.message : String(e));
          return 2;
        }
        break;
      case 'L':
        out.labels.push(v);
        break;
      case 'n':
        out.format = 'rcs';
        break;
      case 't':
        out.expandTabs = true;
        break;
      case 'T':
        out.initialTab = true;
        break;
      case 'w':
        cmp.ignoreAllSpace = true;
        break;
      case 'W':
        if (!/^\d+$/.test(v) || parseInt(v, 10) === 0) return bad(`invalid width '${v}'`);
        out.width = parseInt(v, 10);
        break;
      case 'y':
        out.format = 'sdiff';
        break;
      case 'Z':
        cmp.ignoreTrailingSpace = true;
        break;
      case 'strip-cr':
        cmp.stripCr = true;
        break;
      case 'normal':
        out.format = 'normal';
        break;
      case 'left-column':
        out.leftColumn = true;
        break;
      case 'suppress-common':
        out.suppressCommon = true;
        break;
      case 'color': {
        const when = value === true ? 'auto' : v;
        if (!['never', 'always', 'auto'].includes(when)) return bad(`invalid color '${when}'`);
        out.color = when === 'always' || (when === 'auto' && ctx.stdout.isTTY && ctx.env.get('TERM') !== 'dumb');
        break;
      }
      default:
        break;
    }
  }
  if (digits) {
    out.context = parseInt(digits, 10);
    explicitContext = true;
  }
  void explicitContext;
  if (out.format === 'unified' || out.format === 'context') cmp.horizon = out.context;
  const d: DiffOpts = {
    cmp,
    out,
    brief: opts.has('q'),
    reportSame: opts.has('s'),
    recursive: opts.has('r'),
    newFile: opts.has('N'),
    text: opts.has('a'),
    exclude: opts.list.filter((x) => x.key === 'x').map((x) => String(x.value)),
    switches: '',
  };
  // the options as typed, for "diff -r a/x b/x" headers
  const operandSet = new Set<number>();
  {
    let k = 0;
    const args = ctx.args;
    const words: string[] = [];
    for (k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '--') {
        for (let m = k + 1; m < args.length; m++) operandSet.add(m);
        break;
      }
      if (a.startsWith('-') && a !== '-') {
        words.push(a);
        // options taking a separate argument
        const short = a.startsWith('--') ? null : a.slice(1);
        const needsArg = short !== null ? /^[^CDFILSUWxX]*[CDFILSUWxX]$/.test(short) : /^--(label|ignore-matching-lines|starting-file|width|exclude|exclude-from|horizon-lines|tabsize)$/.test(a);
        if (needsArg && k + 1 < args.length) words.push(args[++k]);
        continue;
      }
      operandSet.add(k);
    }
    d.switches = words.map(shellWord).join(' ');
  }
  const ops = opts.operands;
  if (ops.length === 0) return bad(`missing operand after '${ctx.name}'`);
  if (ops.length === 1) return bad(`missing operand after '${ops[0]}'`);
  if (ops.length > 2) return bad(`extra operand '${ops[2]}'`);

  const state = { status: 0, out: '' as string };
  const flush = async () => {
    if (state.out) {
      await ctx.out(state.out);
      state.out = '';
    }
  };
  const stdinCache: { text?: string } = {};

  const compareFiles = async (n0: string, n1: string, node0: Inode | null, node1: Inode | null, inDir: boolean): Promise<void> => {
    await ctx.checkpoint();
    let a: FileText;
    let b: FileText;
    try {
      a = node0 === null && n0 !== '-' ? { name: n0, lines: [], missingNewline: false, text: '', mtime: 0, binary: false } : await loadFile(ctx, n0, node0, stdinCache);
    } catch (e) {
      await flush();
      await ctx.error(`${n0}: ${errText(e)}`);
      state.status = 2;
      return;
    }
    try {
      b = node1 === null && n1 !== '-' ? { name: n1, lines: [], missingNewline: false, text: '', mtime: 0, binary: false } : await loadFile(ctx, n1, node1, stdinCache);
    } catch (e) {
      await flush();
      await ctx.error(`${n1}: ${errText(e)}`);
      state.status = 2;
      return;
    }
    const same = a.text === b.text;
    if ((a.binary || b.binary) && !d.text) {
      if (!same) {
        state.out += `Binary files ${n0} and ${n1} differ\n`;
        state.status = Math.max(state.status, 1);
      } else if (d.reportSame) state.out += `Files ${n0} and ${n1} are identical\n`;
      return;
    }
    let changes: Change[] = [];
    if (!same) changes = computeChanges(a, b, d.cmp);
    const real = changes.filter((c) => !c.ignore);
    if (real.length === 0) {
      if (d.reportSame) state.out += `Files ${n0} and ${n1} are identical\n`;
      else if (d.out.format === 'sdiff' && !d.brief && !inDir) {
        // side-by-side output lists the files even when they are the same
        const p = new Printer(d.out);
        printSdiff(p, a, b, changes, d.out);
        state.out += p.out;
      }
      return;
    }
    state.status = Math.max(state.status, 1);
    if (d.brief) {
      state.out += `Files ${n0} and ${n1} differ\n`;
      return;
    }
    if (inDir) state.out += `diff${d.switches ? ' ' + d.switches : ''} ${n0} ${n1}\n`;
    const p = new Printer(d.out);
    switch (d.out.format) {
      case 'unified':
        printUnified(p, a, b, changes, d.out);
        break;
      case 'context':
        printContext(p, a, b, changes, d.out);
        break;
      case 'sdiff':
        printSdiff(p, a, b, changes, d.out);
        break;
      case 'ed':
        printEd(p, b, changes);
        break;
      default:
        printNormal(p, a, b, changes);
    }
    state.out += p.out;
    if (state.out.length > 65536) await flush();
  };

  const excluded = (name: string) => d.exclude.some((pat) => matchPattern(pat, name));

  /** Compare two directories; `missing` names a side that does not exist (-N: treated as empty). */
  const compareDirs = async (d0: string, d1: string, missing: 0 | 1 | null = null): Promise<void> => {
    let e0: string[] = [];
    let e1: string[] = [];
    try {
      if (missing !== 0) e0 = ctx.fs.readdir(d0);
    } catch (e) {
      await flush();
      await ctx.error(`${d0}: ${errText(e)}`);
      state.status = 2;
      return;
    }
    try {
      if (missing !== 1) e1 = ctx.fs.readdir(d1);
    } catch (e) {
      await flush();
      await ctx.error(`${d1}: ${errText(e)}`);
      state.status = 2;
      return;
    }
    const set0 = new Set(e0);
    const set1 = new Set(e1);
    const names = [...new Set([...e0, ...e1])].filter((n) => !excluded(n)).sort(compareLocale);
    const join = (dir: string, n: string) => (dir.endsWith('/') ? dir + n : dir + '/' + n);
    for (const n of names) {
      await ctx.checkpoint();
      const p0 = join(d0, n);
      const p1 = join(d1, n);
      const s0 = set0.has(n) ? ctx.fs.tryStat(p0) : null;
      const s1 = set1.has(n) ? ctx.fs.tryStat(p1) : null;
      if (!s0 && !s1) continue;
      if (!s0 || !s1) {
        const present = s0 ?? s1!;
        if (d.newFile && present.type !== 'dir') {
          await compareFiles(p0, p1, s0, s1, true);
          continue;
        }
        if (d.newFile && present.type === 'dir' && d.recursive) {
          // compare against an empty directory
          await compareDirs(p0, p1, s0 ? 1 : 0);
          continue;
        }
        state.out += `Only in ${s0 ? d0 : d1}: ${n}\n`;
        state.status = Math.max(state.status, 1);
        continue;
      }
      if (s0.type === 'dir' && s1.type === 'dir') {
        if (d.recursive) await compareDirs(p0, p1);
        else state.out += `Common subdirectories: ${p0} and ${p1}\n`;
        continue;
      }
      if (s0.type === 'dir' || s1.type === 'dir') {
        const kind = (s: Inode) => (s.type === 'dir' ? 'directory' : s.type === 'file' ? (s.data === '' ? 'regular empty file' : 'regular file') : 'special file');
        state.out += `File ${p0} is a ${kind(s0)} while file ${p1} is a ${kind(s1)}\n`;
        state.status = Math.max(state.status, 1);
        continue;
      }
      await compareFiles(p0, p1, s0, s1, true);
    }
  };

  let [f0, f1] = ops;
  const statOp = (f: string): Inode | null | FsError => {
    if (f === '-') return null;
    try {
      return ctx.fs.stat(f);
    } catch (e) {
      return e instanceof FsError ? e : new FsError('ENOENT', f);
    }
  };
  let st0 = statOp(f0);
  let st1 = statOp(f1);
  if (st0 instanceof FsError && !(d.newFile && !(st1 instanceof FsError) && st0.code === 'ENOENT')) {
    await ctx.error(`${f0}: ${st0.reason}`);
    return 2;
  }
  if (st1 instanceof FsError && !(d.newFile && !(st0 instanceof FsError) && st1.code === 'ENOENT')) {
    await ctx.error(`${f1}: ${st1.reason}`);
    return 2;
  }
  // a file and a directory: compare with the same name inside the directory
  const isDir = (s: Inode | null | FsError) => s !== null && !(s instanceof FsError) && s.type === 'dir';
  if (isDir(st0) && !isDir(st1) && !(st1 instanceof FsError)) {
    if (f1 === '-') {
      await ctx.error(`cannot compare '-' to a directory`);
      return 2;
    }
    f0 = (f0.endsWith('/') ? f0 : f0 + '/') + f1.replace(/\/+$/, '').replace(/.*\//, '');
    st0 = statOp(f0);
    if (st0 instanceof FsError) {
      await ctx.error(`${f0}: ${st0.reason}`);
      return 2;
    }
  } else if (isDir(st1) && !isDir(st0) && !(st0 instanceof FsError)) {
    if (f0 === '-') {
      await ctx.error(`cannot compare '-' to a directory`);
      return 2;
    }
    f1 = (f1.endsWith('/') ? f1 : f1 + '/') + f0.replace(/\/+$/, '').replace(/.*\//, '');
    st1 = statOp(f1);
    if (st1 instanceof FsError) {
      await ctx.error(`${f1}: ${st1.reason}`);
      return 2;
    }
  }
  if (isDir(st0) && isDir(st1)) await compareDirs(f0, f1);
  else await compareFiles(f0, f1, st0 instanceof FsError ? null : st0, st1 instanceof FsError ? null : st1, false);
  await flush();
  return state.status;
}

const DIFF_VERSION = `diff (GNU diffutils) 3.10
Copyright (C) 2023 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.

Written by Paul Eggert, Mike Haertel, David Hayes,
Richard Stallman, and Len Tower.
`;

defineCommand({
  name: 'diff',
  pkg: 'diffutils',
  size: 137776,
  doc: DIFF_DOC,
  version: 'GNU diffutils) 3.10',
  run: async (ctx) => {
    const end = ctx.args.indexOf('--');
    const scan = end === -1 ? ctx.args : ctx.args.slice(0, end);
    if (scan.includes('-v')) {
      await ctx.out(DIFF_VERSION);
      return 0;
    }
    return diffMain(ctx);
  },
});

// ---------------------------------------------------------------------------
// cmp

const CMP_DOC: CommandDef['doc'] = {
  category: 'text',
  summary: 'compare two files byte by byte',
  synopsis: ['cmp [OPTION]... FILE1 [FILE2 [SKIP1 [SKIP2]]]'],
  description:
    'Compare two files byte by byte and report the first difference: "a.txt b.txt differ: byte 5, line 1". If the files are identical, cmp prints nothing. When FILE2 is omitted or is -, standard input is read.\n\n' +
    'The optional SKIP1 and SKIP2 specify the number of bytes to skip at the beginning of each file (zero by default).\n\n' +
    'Exit status is 0 if inputs are the same, 1 if different, 2 if trouble. That makes cmp -s handy in scripts: if cmp -s a b; then echo same; fi',
  options: [
    { flags: '-b, --print-bytes', desc: 'print differing bytes' },
    { flags: '-i, --ignore-initial=SKIP', desc: 'skip first SKIP bytes of both inputs' },
    { flags: '-i, --ignore-initial=SKIP1:SKIP2', desc: 'skip first SKIP1 bytes of FILE1 and first SKIP2 bytes of FILE2' },
    { flags: '-l, --verbose', desc: 'output byte numbers and differing byte values' },
    { flags: '-n, --bytes=LIMIT', desc: 'compare at most LIMIT bytes' },
    { flags: '-s, --quiet, --silent', desc: 'suppress all normal output' },
  ],
  examples: [
    { cmd: 'cmp a.bin b.bin', desc: 'Find the first byte where two files differ.' },
    { cmd: 'cmp -s a.txt b.txt && echo same', desc: 'Silently test whether two files are identical.' },
    { cmd: 'cmp -l a.txt b.txt', desc: 'List every differing byte (in octal).' },
  ],
  seeAlso: ['diff', 'comm'],
  tip: 'Use cmp for binary files (images, programs) and diff for text you want to read.',
};

function toBytes(s: string): Uint8Array {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
  return new TextEncoder().encode(s);
}

function printByte(c: number): string {
  let s = '';
  if (c >= 128) {
    s = 'M-';
    c -= 128;
  }
  if (c < 32) s += '^' + String.fromCharCode(c + 64);
  else if (c === 127) s += '^?';
  else s += String.fromCharCode(c);
  return s;
}

function parseSkip(s: string): number | null {
  const m = /^(\d+)([kKMGTPEZY]?)(i?B)?$/.exec(s);
  if (!m) return null;
  let n = parseInt(m[1], 10);
  const pow = { '': 0, k: 1, K: 1, M: 2, G: 3, T: 4, P: 5, E: 6, Z: 7, Y: 8 }[m[2]] ?? 0;
  const base = m[3] === 'B' ? 1000 : 1024;
  n *= base ** pow;
  return n;
}

defineCommand({
  name: 'cmp',
  pkg: 'diffutils',
  size: 43408,
  doc: CMP_DOC,
  version: 'GNU diffutils) 3.10',
  run: async (ctx) => {
    let opts;
    try {
      opts = parseOpts(ctx.args, {
        short: 'bci:ln:sv',
        long: {
          'print-bytes': 'b',
          'print-chars': 'c',
          'ignore-initial': { key: 'i', arg: 'required' },
          verbose: 'l',
          bytes: { key: 'n', arg: 'required' },
          quiet: 's',
          silent: 's',
        },
      });
    } catch (e) {
      if (e instanceof OptError) {
        await ctx.error(e.message);
        await ctx.error(`Try '${ctx.name} --help' for more information.`);
        return 2;
      }
      throw e;
    }
    const bad = async (msg: string) => {
      await ctx.error(msg);
      await ctx.error(`Try '${ctx.name} --help' for more information.`);
      return 2;
    };
    const verbose = opts.has('l');
    const quiet = opts.has('s');
    const printBytes = opts.has('b') || opts.has('c');
    let skip0 = 0;
    let skip1 = 0;
    if (opts.has('i')) {
      const v = opts.get('i')!;
      const [a, b] = v.split(':');
      const s0 = parseSkip(a);
      const s1 = b === undefined ? s0 : parseSkip(b);
      if (s0 === null || s1 === null) return bad(`invalid --ignore-initial value '${v}'`);
      skip0 = s0;
      skip1 = s1;
    }
    let limit = Infinity;
    if (opts.has('n')) {
      const v = parseSkip(opts.get('n')!);
      if (v === null) return bad(`invalid --bytes value '${opts.get('n')}'`);
      limit = v;
    }
    if (verbose && quiet) return bad('options -l and -s are incompatible');
    const ops = opts.operands;
    if (ops.length === 0) return bad(`missing operand after '${ctx.name}'`);
    if (ops.length > 4) return bad(`extra operand '${ops[4]}'`);
    if (ops.length > 2) {
      const s = parseSkip(ops[2]);
      if (s === null) return bad(`invalid --ignore-initial value '${ops[2]}'`);
      skip0 = s;
      skip1 = s;
    }
    if (ops.length > 3) {
      const s = parseSkip(ops[3]);
      if (s === null) return bad(`invalid --ignore-initial value '${ops[3]}'`);
      skip1 = s;
    }
    const names = [ops[0], ops[1] ?? '-'];
    const data: Uint8Array[] = [];
    let stdinText: string | null = null;
    for (const n of names) {
      try {
        if (n === '-') {
          stdinText ??= await ctx.stdin.readAll();
          data.push(toBytes(stdinText));
          continue;
        }
        const node = ctx.fs.stat(n);
        if (node.type === 'dir') throw new FsError('EISDIR', n);
        data.push(toBytes(ctx.fs.readFile(n)));
      } catch (e) {
        await ctx.error(`${n}: ${errText(e)}`);
        return 2;
      }
    }
    const a = data[0].subarray(Math.min(skip0, data[0].length));
    const b = data[1].subarray(Math.min(skip1, data[1].length));
    const n = Math.min(a.length, b.length, limit);
    let line = 1;
    let out = '';
    let differ = false;
    const width = String(Math.min(limit, names[0] === '-' ? Infinity : a.length, names[1] === '-' ? Infinity : b.length, Number.MAX_SAFE_INTEGER)).length;
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) {
        differ = true;
        if (quiet) return 1;
        if (!verbose) {
          let msg = `${names[0]} ${names[1]} differ: byte ${i + 1}, line ${line}`;
          if (printBytes) msg += ` is ${a[i].toString(8).padStart(3)} ${printByte(a[i])} ${b[i].toString(8).padStart(3)} ${printByte(b[i])}`;
          await ctx.out(msg + '\n');
          return 1;
        }
        if (printBytes) out += `${String(i + 1).padStart(width)} ${a[i].toString(8).padStart(3)} ${printByte(a[i]).padEnd(4)} ${b[i].toString(8).padStart(3)} ${printByte(b[i])}\n`;
        else out += `${String(i + 1).padStart(width)} ${a[i].toString(8).padStart(3)} ${b[i].toString(8).padStart(3)}\n`;
        if (out.length > 65536) {
          await ctx.out(out);
          out = '';
        }
      }
      if (a[i] === 10) line++;
      if (i % 65536 === 65535) await ctx.checkpoint();
    }
    if (out) await ctx.out(out);
    if (a.length !== b.length && n < limit) {
      const shorter = a.length < b.length ? 0 : 1;
      const len = shorter === 0 ? a.length : b.length;
      if (!quiet) {
        const nm = names[shorter];
        if (len === 0) await ctx.error(`EOF on ${nm} which is empty`);
        else if (verbose) await ctx.error(`EOF on ${nm} after byte ${len}`);
        else {
          const buf = shorter === 0 ? a : b;
          const endsNl = buf[len - 1] === 10;
          await ctx.error(`EOF on ${nm} after byte ${len}, ${endsNl ? 'line ' + (line - 1) : 'in line ' + line}`);
        }
      }
      return 1;
    }
    return differ ? 1 : 0;
  },
});
