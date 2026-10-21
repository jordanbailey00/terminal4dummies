// Text-processing programs: head, tail, wc, sort, uniq, cut, tr, grep, tee,
// nl, tac, rev, paste, fold, seq, yes, echo, printf, base64, *sum, shuf,
// comm, column, expr, factor.

import { echoText } from '../builtins/core';
import { compareLocale } from '../collate';
import type { CommandContext } from '../types';
import { formatPrintf } from '../util/printf';
import { base64Decode, base64Encode, md5, sha1, sha256 } from '../util/hash';
import { FsError, type Inode } from '../vfs/fs';
import { stringWidth } from '../wcwidth';
import { RegexError, buildMatcher } from './regex';
import { defineCommand, errText, getopts, parseOpts, OptError, q, qf, ql, readLines, readSources, splitLines } from './util';

async function missing(ctx: CommandContext, msg = 'missing operand'): Promise<number> {
  await ctx.error(msg);
  await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
  return 1;
}

/** Legacy "-5" style counts for head/tail. */
function legacyCount(args: string[]): string[] {
  return args.map((a) => (/^-\d+$/.test(a) ? `-n${a.slice(1)}` : /^\+\d+$/.test(a) ? `-n${a}` : a));
}

// ---------------------------------------------------------------------------
// head / tail

function parseCount(s: string): { n: number; neg: boolean; plus: boolean } | null {
  const m = /^([+-]?)(\d+)([kKmMbB]?)$/.exec(s.trim());
  if (!m) return null;
  let n = parseInt(m[2], 10);
  const unit = m[3].toLowerCase();
  if (unit === 'k') n *= 1024;
  else if (unit === 'm') n *= 1048576;
  else if (unit === 'b') n *= 512;
  return { n, neg: m[1] === '-', plus: m[1] === '+' };
}

defineCommand({
  name: 'head',
  pkg: 'coreutils',
  size: 43784,
  doc: {
    category: 'viewing',
    summary: 'output the first part of files',
    synopsis: ['head [OPTION]... [FILE]...'],
    description: 'Print the first 10 lines of each FILE to standard output. With more than one FILE, precede each with a header giving the file name.\n\nWith no FILE, or when FILE is -, read standard input.',
    options: [
      { flags: '-c, --bytes=[-]NUM', desc: "print the first NUM bytes of each file; with the leading '-', print all but the last NUM bytes of each file" },
      { flags: '-n, --lines=[-]NUM', desc: "print the first NUM lines instead of the first 10; with the leading '-', print all but the last NUM lines of each file" },
      { flags: '-q, --quiet, --silent', desc: 'never print headers giving file names' },
      { flags: '-v, --verbose', desc: 'always print headers giving file names' },
    ],
    examples: [
      { cmd: 'head notes.txt', desc: 'Show the first 10 lines.' },
      { cmd: 'head -n 3 notes.txt', desc: 'Show the first 3 lines.' },
    ],
    seeAlso: ['tail', 'less', 'cat'],
  },
  run: async (ctx) => {
    let opts;
    try {
      opts = parseOpts(legacyCount(ctx.args), { short: 'c:n:qvz', long: { bytes: { key: 'c', arg: 'required' }, lines: { key: 'n', arg: 'required' }, quiet: 'q', silent: 'q', verbose: 'v' } });
    } catch (e) {
      if (e instanceof OptError) return missing(ctx, e.message);
      throw e;
    }
    let mode: 'lines' | 'bytes' = 'lines';
    let count = { n: 10, neg: false, plus: false };
    for (const { key, value } of opts.list) {
      if (key === 'n' || key === 'c') {
        const c = parseCount(String(value));
        if (!c) {
          await ctx.error(`invalid number of ${key === 'n' ? 'lines' : 'bytes'}: ${ql(String(value))}`);
          return 1;
        }
        mode = key === 'n' ? 'lines' : 'bytes';
        count = c;
      }
    }
    const files = opts.operands.length ? opts.operands : ['-'];
    const headers = opts.has('v') || (files.length > 1 && !opts.has('q'));
    let status = 0;
    let first = true;
    for (const f of files) {
      await ctx.checkpoint();
      let text: string | null = null;
      if (f !== '-') {
        try {
          const node = ctx.fs.stat(f);
          if (node.type === 'dir') throw new FsError('EISDIR', f);
          text = ctx.fs.readFile(f);
        } catch (e) {
          await ctx.error(`cannot open ${q(f)} for reading: ${errText(e)}`);
          status = 1;
          continue;
        }
      }
      if (headers) {
        await ctx.out(`${first ? '' : '\n'}==> ${f === '-' ? 'standard input' : f} <==\n`);
      }
      first = false;
      if (text === null && mode === 'lines' && !count.neg) {
        // stream from stdin, stopping early (so `yes | head` ends)
        let n = 0;
        if (count.n === 0) continue;
        for await (const { line, nl } of readLines(ctx.stdin)) {
          await ctx.out(line + (nl ? '\n' : ''));
          if (++n >= count.n) break;
        }
        ctx.stdin.close();
        continue;
      }
      const data = text ?? (await ctx.stdin.readAll());
      if (mode === 'bytes') {
        const bytes = new TextEncoder().encode(data);
        const slice = count.neg ? bytes.slice(0, Math.max(0, bytes.length - count.n)) : bytes.slice(0, count.n);
        await ctx.out(new TextDecoder().decode(slice));
        continue;
      }
      const lines = data.split('\n');
      const trailing = data.endsWith('\n');
      if (trailing) lines.pop();
      const take = count.neg ? lines.slice(0, Math.max(0, lines.length - count.n)) : lines.slice(0, count.n);
      const ends = take.length === lines.length ? trailing : true;
      await ctx.out(take.join('\n') + (take.length && ends ? '\n' : ''));
    }
    return status;
  },
});

defineCommand({
  name: 'tail',
  pkg: 'coreutils',
  size: 64632,
  doc: {
    category: 'viewing',
    summary: 'output the last part of files',
    synopsis: ['tail [OPTION]... [FILE]...'],
    description: 'Print the last 10 lines of each FILE to standard output. With more than one FILE, precede each with a header giving the file name.\n\nWith no FILE, or when FILE is -, read standard input.',
    options: [
      { flags: '-c, --bytes=[+]NUM', desc: 'output the last NUM bytes; or use -c +NUM to output starting with byte NUM of each file' },
      { flags: '-f, --follow', desc: 'output appended data as the file grows (press Ctrl+C to stop)' },
      { flags: '-n, --lines=[+]NUM', desc: 'output the last NUM lines, instead of the last 10; or use -n +NUM to skip NUM-1 lines at the start' },
      { flags: '-q, --quiet, --silent', desc: 'never output headers giving file names' },
      { flags: '-v, --verbose', desc: 'always output headers giving file names' },
    ],
    examples: [
      { cmd: 'tail /var/log/syslog', desc: 'Show the 10 most recent log lines.' },
      { cmd: 'tail -n 3 notes.txt', desc: 'Show the last 3 lines.' },
      { cmd: 'tail -f app.log', desc: 'Watch a file as new lines are added (Ctrl+C to stop).' },
    ],
    seeAlso: ['head', 'less'],
  },
  run: async (ctx) => {
    let opts;
    try {
      opts = parseOpts(legacyCount(ctx.args), { short: 'c:fFn:qs:v', long: { bytes: { key: 'c', arg: 'required' }, follow: { key: 'f', arg: 'optional' }, lines: { key: 'n', arg: 'required' }, quiet: 'q', silent: 'q', verbose: 'v', 'sleep-interval': { key: 's', arg: 'required' }, retry: 'retry' } });
    } catch (e) {
      if (e instanceof OptError) return missing(ctx, e.message);
      throw e;
    }
    let mode: 'lines' | 'bytes' = 'lines';
    let count = { n: 10, neg: false, plus: false };
    for (const { key, value } of opts.list) {
      if (key === 'n' || key === 'c') {
        const c = parseCount(String(value));
        if (!c) {
          await ctx.error(`invalid number of ${key === 'n' ? 'lines' : 'bytes'}: ${ql(String(value))}`);
          return 1;
        }
        mode = key === 'n' ? 'lines' : 'bytes';
        count = c;
      }
    }
    const follow = opts.has('f') || opts.has('F');
    const files = opts.operands.length ? opts.operands : ['-'];
    const headers = opts.has('v') || (files.length > 1 && !opts.has('q'));
    let status = 0;
    let first = true;
    const tailOf = (data: string): string => {
      if (mode === 'bytes') {
        const bytes = new TextEncoder().encode(data);
        const slice = count.plus ? bytes.slice(Math.max(0, count.n - 1)) : bytes.slice(Math.max(0, bytes.length - count.n));
        return new TextDecoder().decode(slice);
      }
      const lines = data.split('\n');
      const trailing = data.endsWith('\n');
      if (trailing) lines.pop();
      const take = count.plus ? lines.slice(Math.max(0, count.n - 1)) : count.n === 0 ? [] : lines.slice(-count.n);
      return take.length ? take.join('\n') + (trailing ? '\n' : '') : '';
    };
    const sizes = new Map<string, number>();
    for (const f of files) {
      await ctx.checkpoint();
      let data: string;
      if (f === '-') data = await ctx.stdin.readAll();
      else {
        try {
          const node = ctx.fs.stat(f);
          if (node.type === 'dir') {
            await ctx.error(`error reading ${q(f)}: Is a directory`);
            status = 1;
            continue;
          }
          data = ctx.fs.readFile(f);
        } catch (e) {
          await ctx.error(`cannot open ${q(f)} for reading: ${errText(e)}`);
          status = 1;
          continue;
        }
      }
      if (headers) await ctx.out(`${first ? '' : '\n'}==> ${f === '-' ? 'standard input' : f} <==\n`);
      first = false;
      await ctx.out(tailOf(data));
      sizes.set(f, data.length);
    }
    if (follow) {
      const watched = files.filter((f) => f !== '-' && sizes.has(f));
      if (watched.length === 0) return status;
      let last = watched[watched.length - 1];
      for (;;) {
        await ctx.sleep(400);
        for (const f of watched) {
          let data: string;
          try {
            data = ctx.fs.readFile(f);
          } catch {
            continue;
          }
          const prev = sizes.get(f) ?? 0;
          if (data.length < prev) {
            await ctx.error(`${f}: file truncated`);
            sizes.set(f, 0);
            await ctx.out(data);
            sizes.set(f, data.length);
            continue;
          }
          if (data.length > prev) {
            if (headers && f !== last) await ctx.out(`\n==> ${f} <==\n`);
            last = f;
            await ctx.out(data.slice(prev));
            sizes.set(f, data.length);
          }
        }
      }
    }
    return status;
  },
});

// ---------------------------------------------------------------------------
// wc

defineCommand({
  name: 'wc',
  pkg: 'coreutils',
  size: 48224,
  doc: {
    category: 'text',
    summary: 'print newline, word, and byte counts for each file',
    synopsis: ['wc [OPTION]... [FILE]...'],
    description: 'Print newline, word, and byte counts for each FILE, and a total line if more than one FILE is specified. A word is a non-zero-length sequence of printable characters delimited by white space.\n\nWith no FILE, or when FILE is -, read standard input.',
    options: [
      { flags: '-c, --bytes', desc: 'print the byte counts' },
      { flags: '-m, --chars', desc: 'print the character counts' },
      { flags: '-l, --lines', desc: 'print the newline counts' },
      { flags: '-L, --max-line-length', desc: 'print the maximum display width' },
      { flags: '-w, --words', desc: 'print the word counts' },
    ],
    examples: [
      { cmd: 'wc -l notes.txt', desc: 'Count the lines in a file.' },
      { cmd: 'ls | wc -l', desc: 'Count how many files are here.' },
    ],
    seeAlso: ['cat', 'grep'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'clLmw', long: { bytes: 'c', chars: 'm', lines: 'l', 'max-line-length': 'L', words: 'w', total: { key: 'total', arg: 'required' } } });
    if (!opts) return 1;
    let which = ['l', 'w', 'm', 'c', 'L'].filter((k) => opts.has(k));
    if (which.length === 0) which = ['l', 'w', 'c'];
    const order = ['l', 'w', 'm', 'c', 'L'];
    which.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const files = opts.operands.length ? opts.operands : ['-'];
    const results: { name: string; counts: number[] }[] = [];
    let status = 0;
    let allRegular = true;
    let totalSize = 0;
    for (const f of files) {
      await ctx.checkpoint();
      let text: string;
      if (f === '-') {
        allRegular = false;
        text = await ctx.stdin.readAll();
      } else {
        let node: Inode;
        try {
          node = ctx.fs.stat(f);
          if (node.type === 'dir') {
            await ctx.error(`${qf(f)}: Is a directory`);
            results.push({ name: f, counts: which.map(() => 0) });
            status = 1;
            continue;
          }
          text = ctx.fs.readFile(f);
          totalSize += new TextEncoder().encode(text).length;
        } catch (e) {
          await ctx.error(`${qf(f)}: ${errText(e)}`);
          status = 1;
          continue;
        }
      }
      const bytes = new TextEncoder().encode(text).length;
      const counts = which.map((k) => {
        switch (k) {
          case 'l':
            return (text.match(/\n/g) ?? []).length;
          case 'w':
            return (text.match(/\S+/g) ?? []).length;
          case 'm':
            return [...text].length;
          case 'c':
            return bytes;
          default:
            return Math.max(0, ...text.split('\n').map((l) => stringWidth(l.replace(/\t/g, '        '))));
        }
      });
      results.push({ name: f, counts });
    }
    const showTotal = results.length > 1;
    const total = which.map((k, i) => (k === 'L' ? Math.max(0, ...results.map((r) => r.counts[i])) : results.reduce((s, r) => s + r.counts[i], 0)));
    let width: number;
    if (which.length === 1 && files.length === 1) width = 1;
    else if (allRegular) width = Math.max(1, String(totalSize).length);
    else width = 7;
    const fmt = (counts: number[]) => counts.map((c) => String(c).padStart(width)).join(' ');
    let out = '';
    for (const r of results) out += fmt(r.counts) + (r.name === '-' && files.length === 1 && opts.operands.length === 0 ? '' : ' ' + r.name) + '\n';
    if (showTotal) out += fmt(total) + ' total\n';
    await ctx.out(out);
    return status;
  },
});

// ---------------------------------------------------------------------------
// sort

interface SortKey {
  startField: number;
  startChar: number;
  endField: number | null;
  endChar: number;
  numeric: boolean;
  human: boolean;
  reverse: boolean;
  fold: boolean;
  blanks: boolean;
  version: boolean;
  month: boolean;
}

const HUMAN_UNITS: Record<string, number> = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
const MONTH_ORDER = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function leadingNumber(s: string): number {
  const m = /^\s*([-+]?(?:\d[\d,]*)?(?:\.\d+)?)/.exec(s);
  if (!m || m[1] === '' || m[1] === '-' || m[1] === '+') return 0;
  return parseFloat(m[1].replace(/,/g, '')) || 0;
}

function humanValue(s: string): number {
  const m = /^\s*([-+]?\d+(?:\.\d+)?)\s*([KMGTPE]?)/i.exec(s);
  if (!m) return 0;
  return parseFloat(m[1]) * 1024 ** (HUMAN_UNITS[m[2].toUpperCase()] ?? 0);
}

function extractKey(line: string, key: SortKey, sep: string | null): string {
  const fields: { start: number; end: number }[] = [];
  if (sep !== null) {
    let s = 0;
    for (let i = 0; i <= line.length; i++) {
      if (i === line.length || line[i] === sep) {
        fields.push({ start: s, end: i });
        s = i + 1;
      }
    }
  } else {
    // fields start at the beginning of leading blanks
    const re = /\s*\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) fields.push({ start: m.index, end: m.index + m[0].length });
    if (fields.length === 0) fields.push({ start: 0, end: line.length });
  }
  const sf = fields[key.startField - 1];
  if (!sf) return '';
  let start = sf.start;
  if (key.blanks || sep === null) {
    while (start < sf.end && /\s/.test(line[start]) && key.blanks) start++;
  }
  start = Math.min(sf.end, start + Math.max(0, key.startChar - 1));
  let end = line.length;
  if (key.endField !== null) {
    const ef = fields[key.endField - 1];
    if (!ef) end = line.length;
    else end = key.endChar > 0 ? Math.min(ef.end, ef.start + key.endChar) : ef.end;
  }
  return line.slice(start, Math.max(start, end));
}

function parseKeySpec(spec: string, global: Omit<SortKey, 'startField' | 'startChar' | 'endField' | 'endChar'>): SortKey | null {
  const m = /^(\d+)(?:\.(\d+))?([bdfgiMhnRrV]*)(?:,(\d+)(?:\.(\d+))?([bdfgiMhnRrV]*))?$/.exec(spec);
  if (!m) return null;
  const mods = (m[3] ?? '') + (m[6] ?? '');
  const hasMods = mods.length > 0;
  return {
    startField: parseInt(m[1], 10),
    startChar: m[2] ? parseInt(m[2], 10) : 1,
    endField: m[4] ? parseInt(m[4], 10) : null,
    endChar: m[5] ? parseInt(m[5], 10) : 0,
    numeric: hasMods ? /[ng]/.test(mods) : global.numeric,
    human: hasMods ? mods.includes('h') : global.human,
    reverse: hasMods ? mods.includes('r') : global.reverse,
    fold: hasMods ? mods.includes('f') : global.fold,
    blanks: hasMods ? mods.includes('b') : global.blanks,
    version: hasMods ? mods.includes('V') : global.version,
    month: hasMods ? mods.includes('M') : global.month,
  };
}

function versionCmp(a: string, b: string): number {
  const re = /(\d+|\D+)/g;
  const pa = a.match(re) ?? [];
  const pb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (/^\d/.test(pa[i]) && /^\d/.test(pb[i])) {
      const d = parseInt(pa[i], 10) - parseInt(pb[i], 10);
      if (d) return d;
    } else if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length - pb.length;
}

defineCommand({
  name: 'sort',
  pkg: 'coreutils',
  size: 104824,
  doc: {
    category: 'text',
    summary: 'sort lines of text files',
    synopsis: ['sort [OPTION]... [FILE]...'],
    description: 'Write sorted concatenation of all FILE(s) to standard output.\n\nWith no FILE, or when FILE is -, read standard input.',
    options: [
      { flags: '-b, --ignore-leading-blanks', desc: 'ignore leading blanks' },
      { flags: '-f, --ignore-case', desc: 'fold lower case to upper case characters' },
      { flags: '-h, --human-numeric-sort', desc: 'compare human readable numbers (e.g., 2K 1G)' },
      { flags: '-k, --key=KEYDEF', desc: 'sort via a key; KEYDEF gives location and type (e.g. -k2 or -k2,2n)' },
      { flags: '-n, --numeric-sort', desc: 'compare according to string numerical value' },
      { flags: '-o, --output=FILE', desc: 'write result to FILE instead of standard output' },
      { flags: '-r, --reverse', desc: 'reverse the result of comparisons' },
      { flags: '-R, --random-sort', desc: 'shuffle, but group identical keys' },
      { flags: '-t, --field-separator=SEP', desc: 'use SEP instead of non-blank to blank transition' },
      { flags: '-u, --unique', desc: 'output only the first of an equal run' },
      { flags: '-V, --version-sort', desc: 'natural sort of (version) numbers within text' },
    ],
    examples: [
      { cmd: 'sort names.txt', desc: 'Sort lines alphabetically.' },
      { cmd: 'sort -n scores.txt', desc: 'Sort numbers from smallest to largest.' },
      { cmd: 'sort -t, -k3 -n data.csv', desc: 'Sort a CSV by its third column, numerically.' },
    ],
    seeAlso: ['uniq', 'shuf'],
    tip: 'sort -r reverses the order. sort -n is needed for numbers, otherwise 10 comes before 9.',
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, {
      short: 'bcCdfghik:MnRo:rsSt:T:uVz',
      long: {
        'ignore-leading-blanks': 'b',
        check: 'c',
        'dictionary-order': 'd',
        'ignore-case': 'f',
        'general-numeric-sort': 'g',
        'human-numeric-sort': 'h',
        key: { key: 'k', arg: 'required' },
        'month-sort': 'M',
        'numeric-sort': 'n',
        output: { key: 'o', arg: 'required' },
        reverse: 'r',
        'random-sort': 'R',
        stable: 's',
        'field-separator': { key: 't', arg: 'required' },
        unique: 'u',
        'version-sort': 'V',
        'buffer-size': { key: 'S', arg: 'required' },
        parallel: { key: 'parallel', arg: 'required' },
      },
    });
    if (!opts) return 2;
    const global = {
      numeric: opts.has('n') || opts.has('g'),
      human: opts.has('h'),
      reverse: opts.has('r'),
      fold: opts.has('f'),
      blanks: opts.has('b'),
      version: opts.has('V'),
      month: opts.has('M'),
    };
    let sep: string | null = null;
    if (opts.get('t') !== undefined) {
      const t = opts.get('t')!;
      if (t.length !== 1 && t !== '\\0') {
        await ctx.error(`multi-character tab ${ql(t)}`);
        return 2;
      }
      sep = t === '\\0' ? '\0' : t;
    }
    const keys: SortKey[] = [];
    for (const { key, value } of opts.list) {
      if (key !== 'k') continue;
      const k = parseKeySpec(String(value), global);
      if (!k) {
        await ctx.error(`invalid number at field start: invalid count at start of ${ql(String(value))}`);
        return 2;
      }
      keys.push(k);
    }
    const lines: string[] = [];
    let status = 0;
    const sources = await readSources(ctx, opts.operands, {
      report: async (f, e) => {
        await ctx.error(`cannot read: ${qf(f)}: ${errText(e)}`);
        status = 2;
      },
    });
    if (status) return status;
    for (const s of sources) lines.push(...splitLines(s.text));
    const cmpValues = (a: string, b: string, k: Omit<SortKey, 'startField' | 'startChar' | 'endField' | 'endChar'>): number => {
      let r: number;
      if (k.numeric) r = leadingNumber(a) - leadingNumber(b);
      else if (k.human) r = humanValue(a) - humanValue(b);
      else if (k.version) r = versionCmp(a, b);
      else if (k.month) r = MONTH_ORDER.indexOf(a.trim().slice(0, 3).toUpperCase()) - MONTH_ORDER.indexOf(b.trim().slice(0, 3).toUpperCase());
      else {
        const x = k.blanks ? a.trimStart() : a;
        const y = k.blanks ? b.trimStart() : b;
        r = k.fold ? compareLocale(x.toUpperCase(), y.toUpperCase()) : compareLocale(x, y);
      }
      return k.reverse ? -r : r;
    };
    const compare = (a: string, b: string): number => {
      if (keys.length) {
        for (const k of keys) {
          const r = cmpValues(extractKey(a, k, sep), extractKey(b, k, sep), k);
          if (r !== 0) return r;
        }
      } else {
        const r = cmpValues(a, b, global);
        if (r !== 0) return r;
      }
      if (opts.has('s') || opts.has('u')) return 0;
      const r = compareLocale(a, b);
      return global.reverse ? -r : r;
    };
    if (opts.has('c') || opts.has('C')) {
      for (let i = 1; i < lines.length; i++) {
        const r = compare(lines[i - 1], lines[i]);
        if (r > 0 || (opts.has('u') && r === 0)) {
          if (opts.has('c')) await ctx.error(`${opts.operands[0] ?? '-'}:${i + 1}: disorder: ${lines[i]}`);
          return 1;
        }
      }
      return 0;
    }
    let sorted: string[];
    if (opts.has('R')) {
      const shuffled = [...lines];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(ctx.system.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      sorted = shuffled;
    } else {
      sorted = [...lines].sort(compare);
    }
    if (opts.has('u')) {
      const uniq: string[] = [];
      for (const l of sorted) if (uniq.length === 0 || compare(uniq[uniq.length - 1], l) !== 0) uniq.push(l);
      sorted = uniq;
    }
    const output = sorted.length ? sorted.join('\n') + '\n' : '';
    if (opts.get('o') !== undefined) {
      try {
        ctx.fs.writeFile(opts.get('o')!, output);
      } catch (e) {
        await ctx.error(`open failed: ${opts.get('o')}: ${errText(e)}`);
        return 2;
      }
      return 0;
    }
    await ctx.out(output);
    return 0;
  },
});

// ---------------------------------------------------------------------------
// uniq

defineCommand({
  name: 'uniq',
  pkg: 'coreutils',
  size: 43816,
  doc: {
    category: 'text',
    summary: 'report or omit repeated lines',
    synopsis: ['uniq [OPTION]... [INPUT [OUTPUT]]'],
    description: 'Filter adjacent matching lines from INPUT (or standard input), writing to OUTPUT (or standard output).\n\nNote: \'uniq\' does not detect repeated lines unless they are adjacent. You may want to sort the input first, or use \'sort -u\' without \'uniq\'.',
    options: [
      { flags: '-c, --count', desc: 'prefix lines by the number of occurrences' },
      { flags: '-d, --repeated', desc: 'only print duplicate lines, one for each group' },
      { flags: '-i, --ignore-case', desc: 'ignore differences in case when comparing' },
      { flags: '-u, --unique', desc: 'only print unique lines' },
    ],
    examples: [
      { cmd: 'sort words.txt | uniq', desc: 'Remove duplicate lines.' },
      { cmd: 'sort words.txt | uniq -c | sort -rn', desc: 'Count how often each line appears, most common first.' },
    ],
    seeAlso: ['sort', 'comm'],
    tip: 'uniq only removes duplicates that are next to each other, so sort first.',
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'cdDf:is:uw:z', long: { count: 'c', repeated: 'd', 'all-repeated': 'D', 'skip-fields': { key: 'f', arg: 'required' }, 'ignore-case': 'i', 'skip-chars': { key: 's', arg: 'required' }, unique: 'u', 'check-chars': { key: 'w', arg: 'required' } } });
    if (!opts) return 1;
    const [input, output] = opts.operands;
    let text: string;
    if (input && input !== '-') {
      try {
        text = ctx.fs.readFile(input);
      } catch (e) {
        await ctx.error(`${qf(input)}: ${errText(e)}`);
        return 1;
      }
    } else text = await ctx.stdin.readAll();
    const skipFields = parseInt(opts.get('f') ?? '0', 10);
    const skipChars = parseInt(opts.get('s') ?? '0', 10);
    const checkChars = opts.get('w') !== undefined ? parseInt(opts.get('w')!, 10) : Infinity;
    const keyOf = (l: string) => {
      let s = l;
      for (let i = 0; i < skipFields; i++) s = s.replace(/^\s*\S+/, '');
      s = s.slice(skipChars);
      if (checkChars !== Infinity) s = s.slice(0, checkChars);
      return opts.has('i') ? s.toLowerCase() : s;
    };
    const lines = splitLines(text);
    const groups: { line: string; count: number; all: string[] }[] = [];
    for (const l of lines) {
      const g = groups[groups.length - 1];
      if (g && keyOf(g.line) === keyOf(l)) {
        g.count++;
        g.all.push(l);
      } else groups.push({ line: l, count: 1, all: [l] });
    }
    let out = '';
    for (const g of groups) {
      if (opts.has('d') && g.count < 2) continue;
      if (opts.has('u') && g.count > 1) continue;
      if (opts.has('D')) {
        if (g.count > 1) out += g.all.join('\n') + '\n';
        continue;
      }
      out += (opts.has('c') ? String(g.count).padStart(7) + ' ' : '') + g.line + '\n';
    }
    if (output) {
      try {
        ctx.fs.writeFile(output, out);
      } catch (e) {
        await ctx.error(`${qf(output)}: ${errText(e)}`);
        return 1;
      }
      return 0;
    }
    await ctx.out(out);
    return 0;
  },
});

// ---------------------------------------------------------------------------
// cut

function parseList(spec: string): { ranges: [number, number][] } | null {
  const ranges: [number, number][] = [];
  for (const part of spec.split(',')) {
    let m: RegExpExecArray | null;
    if ((m = /^(\d+)$/.exec(part))) ranges.push([+m[1], +m[1]]);
    else if ((m = /^(\d+)-(\d+)$/.exec(part))) ranges.push([+m[1], +m[2]]);
    else if ((m = /^(\d+)-$/.exec(part))) ranges.push([+m[1], Infinity]);
    else if ((m = /^-(\d+)$/.exec(part))) ranges.push([1, +m[1]]);
    else return null;
    if (ranges[ranges.length - 1][0] === 0) return null;
  }
  return { ranges };
}

defineCommand({
  name: 'cut',
  pkg: 'coreutils',
  size: 43840,
  doc: {
    category: 'text',
    summary: 'remove sections from each line of files',
    synopsis: ['cut OPTION... [FILE]...'],
    description: 'Print selected parts of lines from each FILE to standard output.\n\nWith no FILE, or when FILE is -, read standard input.',
    options: [
      { flags: '-b, --bytes=LIST', desc: 'select only these bytes' },
      { flags: '-c, --characters=LIST', desc: 'select only these characters' },
      { flags: '-d, --delimiter=DELIM', desc: 'use DELIM instead of TAB for field delimiter' },
      { flags: '-f, --fields=LIST', desc: 'select only these fields; also print any line that contains no delimiter character, unless the -s option is specified' },
      { flags: '--complement', desc: 'complement the set of selected bytes, characters or fields' },
      { flags: '-s, --only-delimited', desc: 'do not print lines not containing delimiters' },
      { flags: '--output-delimiter=STRING', desc: 'use STRING as the output delimiter the default is to use the input delimiter' },
    ],
    examples: [
      { cmd: 'cut -d, -f2 data.csv', desc: 'Print the second column of a CSV file.' },
      { cmd: 'cut -d: -f1 /etc/passwd', desc: 'List every user name on the system.' },
      { cmd: 'cut -c1-5 notes.txt', desc: 'Print the first five characters of each line.' },
    ],
    seeAlso: ['awk', 'paste'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'b:c:d:f:nsz', long: { bytes: { key: 'b', arg: 'required' }, characters: { key: 'c', arg: 'required' }, delimiter: { key: 'd', arg: 'required' }, fields: { key: 'f', arg: 'required' }, complement: 'complement', 'only-delimited': 's', 'output-delimiter': { key: 'od', arg: 'required' } } });
    if (!opts) return 1;
    const listSpec = opts.get('f') ?? opts.get('c') ?? opts.get('b');
    const mode = opts.get('f') !== undefined ? 'f' : opts.get('c') !== undefined ? 'c' : opts.get('b') !== undefined ? 'b' : null;
    if (!mode || listSpec === undefined) return missing(ctx, 'you must specify a list of bytes, characters, or fields');
    const list = parseList(listSpec);
    if (!list) {
      await ctx.error(listSpec.split(',').some((p) => /^0/.test(p)) ? 'fields and positions are numbered from 1' : `invalid field value ${ql(listSpec)}`);
      await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
      return 1;
    }
    const delim = opts.get('d') ?? '\t';
    if ([...delim].length !== 1) return missing(ctx, 'the delimiter must be a single character');
    if (opts.get('d') !== undefined && mode !== 'f') return missing(ctx, 'an input delimiter may be specified only when operating on fields');
    const outDelim = opts.get('od') ?? (mode === 'f' ? delim : '');
    const complement = opts.has('complement');
    const selected = (i: number) => {
      const inList = list.ranges.some(([a, b]) => i >= a && i <= b);
      return complement ? !inList : inList;
    };
    const sources = await readSources(ctx, opts.operands);
    let out = '';
    let status = 0;
    for (const s of sources) {
      if (!s.ok) {
        status = 1;
        continue;
      }
      for (const line of splitLines(s.text)) {
        if (mode === 'f') {
          if (!line.includes(delim)) {
            if (!opts.has('s')) out += line + '\n';
            continue;
          }
          const fields = line.split(delim);
          out += fields.filter((_, i) => selected(i + 1)).join(outDelim) + '\n';
        } else {
          const chars = [...line];
          let picked = '';
          let lastIdx = -2;
          chars.forEach((ch, i) => {
            if (selected(i + 1)) {
              if (outDelim && lastIdx >= 0 && lastIdx !== i - 1) picked += outDelim;
              picked += ch;
              lastIdx = i;
            }
          });
          out += picked + '\n';
        }
      }
      if (out.length > 65536) {
        await ctx.out(out);
        out = '';
      }
    }
    await ctx.out(out);
    return status;
  },
});

// ---------------------------------------------------------------------------
// tr

const TR_CLASSES: Record<string, string> = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digit: '0123456789',
  alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  alnum: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  space: ' \t\n\r\f\v',
  blank: ' \t',
  punct: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  xdigit: '0123456789ABCDEFabcdef',
  cntrl: Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('') + '\x7f',
  print: Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join(''),
  graph: Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join(''),
};

function expandTrSet(spec: string): string[] | null {
  const out: string[] = [];
  const chars: string[] = [];
  // first resolve escapes into a token list
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === '\\' && i + 1 < spec.length) {
      const n = spec[++i];
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', a: '\x07', b: '\b', '\\': '\\' };
      if (map[n]) chars.push(map[n]);
      else if (/[0-7]/.test(n)) {
        const m = /^[0-7]{1,3}/.exec(spec.slice(i))!;
        chars.push(String.fromCharCode(parseInt(m[0], 8)));
        i += m[0].length - 1;
      } else chars.push(n);
      continue;
    }
    if (c === '[' && spec[i + 1] === ':') {
      const close = spec.indexOf(':]', i + 2);
      if (close !== -1) {
        const name = spec.slice(i + 2, close);
        if (!TR_CLASSES[name]) return null;
        chars.push(`\u0000CLASS:${name}`);
        i = close + 1;
        continue;
      }
    }
    if (c === '[' && /^\[.\*\d*\]/.test(spec.slice(i))) {
      const m = /^\[(.)\*(\d*)\]/.exec(spec.slice(i))!;
      chars.push(`\u0000REPEAT:${m[2] || '0'}:${m[1]}`);
      i += m[0].length - 1;
      continue;
    }
    chars.push(c);
  }
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c.startsWith('\u0000CLASS:')) {
      out.push(...TR_CLASSES[c.slice(7)]);
      continue;
    }
    if (c.startsWith('\u0000REPEAT:')) {
      out.push(c);
      continue;
    }
    if (chars[i + 1] === '-' && i + 2 < chars.length && !chars[i + 2].startsWith('\u0000')) {
      const a = c.codePointAt(0)!;
      const b = chars[i + 2].codePointAt(0)!;
      if (b < a) return null;
      for (let x = a; x <= b; x++) out.push(String.fromCodePoint(x));
      i += 2;
      continue;
    }
    out.push(c);
  }
  return out;
}

defineCommand({
  name: 'tr',
  pkg: 'coreutils',
  size: 51272,
  doc: {
    category: 'text',
    summary: 'translate or delete characters',
    synopsis: ['tr [OPTION]... STRING1 [STRING2]'],
    description: 'Translate, squeeze, and/or delete characters from standard input, writing to standard output. STRING1 and STRING2 specify arrays of characters ARRAY1 and ARRAY2 that control the action.\n\ntr only reads standard input, so use it in a pipeline or with < file.',
    options: [
      { flags: '-c, -C, --complement', desc: 'use the complement of ARRAY1' },
      { flags: '-d, --delete', desc: 'delete characters in ARRAY1, do not translate' },
      { flags: '-s, --squeeze-repeats', desc: 'replace each sequence of a repeated character that is listed in the last specified ARRAY, with a single occurrence of that character' },
    ],
    examples: [
      { cmd: "echo hello | tr a-z A-Z", desc: 'Convert to upper case.' },
      { cmd: "tr -d '0-9' < file.txt", desc: 'Delete all digits.' },
      { cmd: "tr -s ' ' < file.txt", desc: 'Squeeze repeated spaces into one.' },
    ],
    seeAlso: ['sed'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'cCdst', long: { complement: 'c', delete: 'd', 'squeeze-repeats': 's', 'truncate-set1': 't' } });
    if (!opts) return 1;
    const del = opts.has('d');
    const squeeze = opts.has('s');
    const ops = opts.operands;
    if (ops.length === 0) return missing(ctx);
    if (!del && !squeeze && ops.length < 2) return missing(ctx, `missing operand after ${ql(ops[0])}\nTwo strings must be given when translating.`);
    const maxOps = del && squeeze ? 2 : del || (squeeze && ops.length === 1) ? 1 : 2;
    if (ops.length > maxOps) {
      await ctx.error(`extra operand ${ql(ops[maxOps])}`);
      if (del && ops.length === 2) await ctx.err('Only one string may be given when deleting without squeezing repeated characters.\n');
      await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
      return 1;
    }
    const set1 = expandTrSet(ops[0]);
    const set2raw = ops[1] !== undefined ? expandTrSet(ops[1]) : [];
    if (!set1 || !set2raw) {
      await ctx.error('invalid character class or range');
      return 1;
    }
    const complement = opts.has('c') || opts.has('C');
    const inSet1 = (ch: string) => (complement ? !set1.includes(ch) : set1.includes(ch));
    // expand [c*] repeats in set2
    let set2: string[] = [];
    for (const c of set2raw) {
      if (c.startsWith('\u0000REPEAT:')) {
        const [, n, ch] = c.split(':');
        const count = parseInt(n, 10) || Math.max(0, set1.length - (set2raw.length - 1));
        set2.push(...Array(count).fill(ch));
      } else set2.push(c);
    }
    if (set2.length && set2.length < set1.length && !opts.has('t')) set2 = [...set2, ...Array(set1.length - set2.length).fill(set2[set2.length - 1])];
    const map = new Map<string, string>();
    if (!del && set2.length) set1.forEach((c, i) => map.set(c, set2[Math.min(i, set2.length - 1)]));
    const squeezeSet = squeeze ? (del || ops.length === 1 ? (del ? set2 : set1) : set2) : [];
    let last = '';
    for (;;) {
      const chunk = await ctx.stdin.read();
      if (chunk === null) break;
      let out = '';
      for (const ch of chunk) {
        let c = ch;
        if (del && inSet1(c)) continue;
        if (!del && set2.length) {
          if (complement) {
            if (!set1.includes(c)) c = set2[set2.length - 1];
          } else if (map.has(c)) c = map.get(c)!;
        }
        if (squeeze && c === last && (squeezeSet.includes(c) || (complement && ops.length === 1 && inSet1(c)))) continue;
        out += c;
        last = c;
      }
      await ctx.out(out);
    }
    return 0;
  },
});

// ---------------------------------------------------------------------------
// grep

const GREP_COLORS = { ms: '01;31', fn: '35', ln: '32', se: '36' };

async function grepRun(ctx: CommandContext, flavor: 'G' | 'E' | 'F'): Promise<number> {
  const opts = await getopts(ctx, {
    short: 'A:B:C:cD:d:Ee:Ff:GHhIiLlm:noqRrsTUuVvwxyZz0123456789P',
    long: {
      'after-context': { key: 'A', arg: 'required' },
      'before-context': { key: 'B', arg: 'required' },
      context: { key: 'C', arg: 'required' },
      count: 'c',
      color: { key: 'color', arg: 'optional' },
      colour: { key: 'color', arg: 'optional' },
      'extended-regexp': 'E',
      regexp: { key: 'e', arg: 'required' },
      'fixed-strings': 'F',
      file: { key: 'f', arg: 'required' },
      'basic-regexp': 'G',
      'perl-regexp': 'P',
      'with-filename': 'H',
      'no-filename': 'h',
      'ignore-case': 'i',
      'no-ignore-case': 'no-i',
      'files-without-match': 'L',
      'files-with-matches': 'l',
      'max-count': { key: 'm', arg: 'required' },
      'line-number': 'n',
      'only-matching': 'o',
      quiet: 'q',
      silent: 'q',
      recursive: 'r',
      'dereference-recursive': 'R',
      'no-messages': 's',
      'invert-match': 'v',
      'word-regexp': 'w',
      'line-regexp': 'x',
      include: { key: 'include', arg: 'required' },
      exclude: { key: 'exclude', arg: 'required' },
      'exclude-dir': { key: 'exclude-dir', arg: 'required' },
      'null-data': 'z',
      'binary-files': { key: 'binary-files', arg: 'required' },
    },
  }, false);
  if (!opts) {
    await ctx.err(`Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n`);
    return 2;
  }
  let mode: 'G' | 'E' | 'F' | 'P' = flavor;
  for (const { key } of opts.list) {
    if (key === 'E' || key === 'F' || key === 'G' || key === 'P') mode = key;
  }
  const patterns: string[] = [];
  for (const { key, value } of opts.list) {
    if (key === 'e') patterns.push(...String(value).split('\n'));
    if (key === 'f') {
      try {
        patterns.push(...splitLines(ctx.fs.readFile(String(value))));
      } catch (e) {
        await ctx.error(`${value}: ${errText(e)}`);
        return 2;
      }
    }
  }
  let operands = opts.operands;
  if (patterns.length === 0) {
    if (operands.length === 0) {
      await ctx.err(`Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n`);
      return 2;
    }
    patterns.push(...operands[0].split('\n'));
    operands = operands.slice(1);
  }
  const ignoreCase = (opts.has('i') || opts.has('y')) && !opts.list.slice().reverse().find((x) => x.key === 'i' || x.key === 'no-i' || x.key === 'y')?.key.startsWith('no');
  let re: RegExp;
  try {
    re = buildMatcher(patterns, { extended: mode === 'E', fixed: mode === 'F', perl: mode === 'P', ignoreCase, word: opts.has('w'), line: opts.has('x') });
  } catch (e) {
    await ctx.error(e instanceof RegexError ? e.message : String(e));
    return 2;
  }
  const colorOpt = opts.flags.get('color');
  const color = colorOpt === undefined ? false : colorOpt === true || colorOpt === 'always' ? true : colorOpt === 'auto' ? ctx.stdout.isTTY : false;
  const invert = opts.has('v');
  const countOnly = opts.has('c');
  const listMatch = opts.has('l');
  const listNoMatch = opts.has('L');
  const quiet = opts.has('q');
  const onlyMatching = opts.has('o');
  const lineNumbers = opts.has('n');
  const noMessages = opts.has('s');
  const maxCount = opts.get('m') !== undefined ? parseInt(opts.get('m')!, 10) : Infinity;
  let after = 0;
  let before = 0;
  for (const { key, value } of opts.list) {
    const n = parseInt(String(value), 10);
    if (key === 'A') after = n;
    if (key === 'B') before = n;
    if (key === 'C') after = before = n;
    if (/^\d$/.test(key)) after = before = parseInt(key, 10);
  }
  const recursive = opts.has('r') || opts.has('R');
  if (operands.length === 0) operands = recursive ? ['.'] : ['-'];
  const implicitDot = recursive && opts.operands.length === (patterns.length && opts.list.some((x) => x.key === 'e' || x.key === 'f') ? 0 : 1);
  const includes = opts.list.filter((x) => x.key === 'include').map((x) => String(x.value));
  const excludes = opts.list.filter((x) => x.key === 'exclude').map((x) => String(x.value));
  const excludeDirs = opts.list.filter((x) => x.key === 'exclude-dir').map((x) => String(x.value));
  const globRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');

  // expand recursive operands into file list
  const files: string[] = [];
  let status = 1;
  let errors = false;
  for (const op of operands) {
    if (op === '-') {
      files.push(op);
      continue;
    }
    const node = ctx.fs.tryStat(op);
    if (node?.type === 'dir') {
      if (!recursive) {
        if (!noMessages) await ctx.error(`${op}: Is a directory`);
        errors = true;
        continue;
      }
      const walk = (dir: string) => {
        let entries: [string, Inode][] = [];
        try {
          entries = ctx.fs.readdirEntries(dir);
        } catch (e) {
          void ctx.error(`${dir}: ${errText(e)}`);
          errors = true;
          return;
        }
        entries.sort((a, b) => compareLocale(a[0], b[0]));
        for (const [name, child] of entries) {
          const p = dir === '.' && implicitDot ? name : dir.replace(/\/+$/, '') + '/' + name;
          if (child.type === 'dir') {
            if (excludeDirs.some((g) => globRe(g).test(name))) continue;
            walk(p);
          } else if (child.type === 'file' || (child.type === 'symlink' && opts.has('R'))) {
            if (includes.length && !includes.some((g) => globRe(g).test(name))) continue;
            if (excludes.some((g) => globRe(g).test(name))) continue;
            files.push(p);
          }
        }
      };
      walk(op);
      continue;
    }
    files.push(op);
  }
  const showNames = !opts.has('h') && (opts.has('H') || files.length > 1 || recursive);
  const paint = (s: string, code: string) => (color ? `\x1b[${code}m\x1b[K${s}\x1b[m\x1b[K` : s);
  const sepChar = (c: string) => (color ? `\x1b[${GREP_COLORS.se}m\x1b[K${c}\x1b[m\x1b[K` : c);
  let out = '';
  const flush = async () => {
    if (out) {
      await ctx.out(out);
      out = '';
    }
  };
  for (const f of files) {
    await ctx.checkpoint();
    let text: string;
    if (f === '-') {
      if (!countOnly && !listMatch && !listNoMatch && !quiet && before === 0 && after === 0) {
        // stream standard input line by line
        let n = 0;
        let matches = 0;
        for await (const { line } of readLines(ctx.stdin)) {
          n++;
          re.lastIndex = 0;
          const hit = re.test(line) !== invert;
          if (!hit) continue;
          matches++;
          status = 0;
          await ctx.out(formatLine(line, n, showNames ? '(standard input)' : null));
          if (matches >= maxCount) break;
        }
        continue;
      }
      text = await ctx.stdin.readAll();
    } else {
      try {
        const node = ctx.fs.stat(f);
        if (node.type === 'dir') throw new FsError('EISDIR', f);
        if (node.type === 'file' && typeof node.data !== 'string') {
          // binary file: report a match if the "strings" would match
          re.lastIndex = 0;
          if (re.test(node.data.kind === 'native' ? node.data.command : node.data.description) !== invert) {
            status = 0;
            if (quiet) return 0;
            if (listMatch) out += paint(f, GREP_COLORS.fn) + '\n';
            else if (countOnly) out += (showNames ? paint(f, GREP_COLORS.fn) + sepChar(':') : '') + '1\n';
            else out += `grep: ${f}: binary file matches\n`;
          } else if (countOnly) out += (showNames ? paint(f, GREP_COLORS.fn) + sepChar(':') : '') + '0\n';
          continue;
        }
        text = ctx.fs.readFile(f);
      } catch (e) {
        if (!noMessages) {
          await flush();
          await ctx.error(`${f}: ${errText(e)}`);
        }
        errors = true;
        continue;
      }
    }
    const lines = splitLines(text);
    let count = 0;
    let lastPrinted = -1;
    let pendingAfter = 0;
    const name = f === '-' ? '(standard input)' : f;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      const hit = re.test(line) !== invert;
      if (hit && count < maxCount) {
        count++;
        status = 0;
        if (quiet) return 0;
        if (listMatch || listNoMatch || countOnly) continue;
        if (before > 0 || after > 0) {
          const from = Math.max(lastPrinted + 1, i - before);
          if (lastPrinted >= 0 && from > lastPrinted + 1) out += sepChar('--') + '\n';
          for (let k = from; k < i; k++) out += formatContext(lines[k], k + 1, showNames ? name : null);
        }
        out += formatLine(line, i + 1, showNames ? name : null);
        lastPrinted = i;
        pendingAfter = after;
      } else if (pendingAfter > 0 && !listMatch && !countOnly) {
        out += formatContext(line, i + 1, showNames ? name : null);
        lastPrinted = i;
        pendingAfter--;
      } else if (count >= maxCount && pendingAfter === 0) break;
      if (out.length > 32768) await flush();
    }
    if (countOnly) out += (showNames ? paint(name, GREP_COLORS.fn) + sepChar(':') : '') + count + '\n';
    if (listMatch && count > 0) out += paint(name, GREP_COLORS.fn) + '\n';
    if (listNoMatch && count === 0) out += paint(name, GREP_COLORS.fn) + '\n';
  }
  await flush();
  if (listNoMatch) status = status === 0 ? 0 : 1;
  return errors && !(quiet && status === 0) ? 2 : status;

  function prefix(n: number, name: string | null, sep: string): string {
    let p = '';
    if (name !== null) p += paint(name, GREP_COLORS.fn) + sepChar(sep);
    if (lineNumbers) p += paint(String(n), GREP_COLORS.ln) + sepChar(sep);
    return p;
  }
  function formatContext(line: string, n: number, name: string | null): string {
    return prefix(n, name, '-') + line + '\n';
  }
  function formatLine(line: string, n: number, name: string | null): string {
    if (onlyMatching && !invert) {
      let s = '';
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        if (m[0] === '') {
          re.lastIndex++;
          continue;
        }
        s += prefix(n, name, ':') + paint(m[0], GREP_COLORS.ms) + '\n';
      }
      return s;
    }
    if (!color || invert) return prefix(n, name, ':') + line + '\n';
    re.lastIndex = 0;
    let s = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m[0] === '') {
        re.lastIndex++;
        continue;
      }
      s += line.slice(last, m.index) + paint(m[0], GREP_COLORS.ms);
      last = m.index + m[0].length;
    }
    s += line.slice(last);
    return prefix(n, name, ':') + s + '\n';
  }
}

const GREP_DOC = {
  category: 'search' as const,
  summary: 'print lines that match patterns',
  synopsis: ['grep [OPTION...] PATTERNS [FILE...]', 'grep [OPTION...] -e PATTERNS ... [FILE...]'],
  description:
    'grep searches for PATTERNS in each FILE. PATTERNS is one or more patterns separated by newline characters, and grep prints each line that matches a pattern. Typically PATTERNS should be quoted when grep is used in a shell command.\n\n' +
    'A FILE of "-" stands for standard input. If no FILE is given, recursive searches examine the working directory, and nonrecursive searches read standard input.',
  options: [
    { flags: '-E, --extended-regexp', desc: 'Interpret PATTERNS as extended regular expressions.' },
    { flags: '-F, --fixed-strings', desc: 'Interpret PATTERNS as fixed strings, not regular expressions.' },
    { flags: '-i, --ignore-case', desc: 'Ignore case distinctions in patterns and input data.' },
    { flags: '-v, --invert-match', desc: 'Invert the sense of matching, to select non-matching lines.' },
    { flags: '-w, --word-regexp', desc: 'Select only those lines containing matches that form whole words.' },
    { flags: '-x, --line-regexp', desc: 'Select only those matches that exactly match the whole line.' },
    { flags: '-c, --count', desc: 'Print a count of matching lines for each input file.' },
    { flags: '-l, --files-with-matches', desc: 'Print the name of each input file that contains a match.' },
    { flags: '-n, --line-number', desc: 'Prefix each line of output with the line number within its input file.' },
    { flags: '-o, --only-matching', desc: 'Print only the matched (non-empty) parts of a matching line.' },
    { flags: '-r, --recursive', desc: 'Read all files under each directory, recursively.' },
    { flags: '-A NUM, -B NUM, -C NUM', desc: 'Print NUM lines of context after, before, or around each match.' },
    { flags: '-q, --quiet', desc: 'Quiet; do not write anything to standard output. Exit immediately with zero status if any match is found.' },
  ],
  examples: [
    { cmd: 'grep apple fruit.txt', desc: 'Show lines containing "apple".' },
    { cmd: 'grep -i error log.txt', desc: 'Case-insensitive search.' },
    { cmd: 'grep -rn TODO .', desc: 'Find TODO in every file below here, with line numbers.' },
    { cmd: 'ps aux | grep bash', desc: 'Filter the output of another command.' },
  ],
  seeAlso: ['find', 'sed', 'awk'],
  tip: 'grep exits with status 0 if it found a match and 1 if it did not, which makes it handy in scripts.',
};

defineCommand({ name: 'grep', pkg: 'grep', size: 182752, doc: GREP_DOC, run: (ctx) => grepRun(ctx, 'G') });
defineCommand({ name: 'egrep', pkg: 'grep', size: 41, doc: { ...GREP_DOC, summary: 'print lines that match patterns (same as grep -E)' }, run: (ctx) => grepRun(ctx, 'E') });
defineCommand({ name: 'fgrep', pkg: 'grep', size: 41, doc: { ...GREP_DOC, summary: 'print lines that match fixed strings (same as grep -F)' }, run: (ctx) => grepRun(ctx, 'F') });

// ---------------------------------------------------------------------------
// tee

defineCommand({
  name: 'tee',
  pkg: 'coreutils',
  size: 39432,
  doc: {
    category: 'text',
    summary: 'read from standard input and write to standard output and files',
    synopsis: ['tee [OPTION]... [FILE]...'],
    description: 'Copy standard input to each FILE, and also to standard output.',
    options: [{ flags: '-a, --append', desc: 'append to the given FILEs, do not overwrite' }],
    examples: [
      { cmd: 'ls | tee files.txt', desc: 'Show the listing and save it to a file at the same time.' },
      { cmd: 'echo "127.0.0.1 test" | sudo tee -a /etc/hosts', desc: 'Append to a file that only root may write.' },
    ],
    seeAlso: ['cat'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'aip', long: { append: 'a', 'ignore-interrupts': 'i' } });
    if (!opts) return 1;
    let status = 0;
    const targets: string[] = [];
    for (const f of opts.operands) {
      try {
        const node = ctx.fs.tryStat(f);
        if (node?.type === 'dir') throw new FsError('EISDIR', f);
        if (!opts.has('a') || !node) ctx.fs.writeFile(f, '');
        targets.push(f);
      } catch (e) {
        await ctx.error(`${qf(f)}: ${errText(e)}`);
        status = 1;
      }
    }
    for (;;) {
      const chunk = await ctx.stdin.read();
      if (chunk === null) break;
      for (const f of targets) {
        try {
          ctx.fs.writeFile(f, chunk, { append: true });
        } catch (e) {
          await ctx.error(`${qf(f)}: ${errText(e)}`);
          status = 1;
        }
      }
      await ctx.out(chunk);
    }
    return status;
  },
});

// ---------------------------------------------------------------------------
// line utilities

defineCommand({
  name: 'nl',
  pkg: 'coreutils',
  size: 39432,
  doc: {
    category: 'text',
    summary: 'number lines of files',
    synopsis: ['nl [OPTION]... [FILE]...'],
    description: 'Write each FILE to standard output, with line numbers added. By default empty lines are not numbered.',
    options: [
      { flags: '-b, --body-numbering=STYLE', desc: "use STYLE for numbering body lines: a (all lines), t (non-empty lines), n (no lines)" },
      { flags: '-w, --number-width=NUMBER', desc: 'use NUMBER columns for line numbers' },
    ],
    seeAlso: ['cat'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'b:s:w:v:i:', long: { 'body-numbering': { key: 'b', arg: 'required' }, 'number-separator': { key: 's', arg: 'required' }, 'number-width': { key: 'w', arg: 'required' } } });
    if (!opts) return 1;
    const style = opts.get('b') ?? 't';
    const width = parseInt(opts.get('w') ?? '6', 10);
    const sep = opts.get('s') ?? '\t';
    let n = parseInt(opts.get('v') ?? '1', 10);
    const sources = await readSources(ctx, opts.operands);
    let out = '';
    for (const s of sources) {
      for (const line of splitLines(s.text)) {
        const number = style === 'a' || (style === 't' && line.trim() !== '');
        out += number ? String(n++).padStart(width) + sep + line + '\n' : ' '.repeat(width + sep.length) + line + '\n';
      }
    }
    await ctx.out(out);
    return sources.every((s) => s.ok) ? 0 : 1;
  },
});

defineCommand({
  name: 'tac',
  pkg: 'coreutils',
  size: 39432,
  doc: { category: 'text', summary: 'concatenate and print files in reverse', synopsis: ['tac [OPTION]... [FILE]...'], description: 'Write each FILE to standard output, last line first.', examples: [{ cmd: 'tac notes.txt', desc: 'Print the lines in reverse order.' }], seeAlso: ['cat', 'rev'] },
  run: async (ctx) => {
    const sources = await readSources(ctx, ctx.args.filter((a) => a !== '--'));
    let out = '';
    for (const s of sources) {
      const lines = splitLines(s.text);
      out += lines.reverse().map((l) => l + '\n').join('');
    }
    await ctx.out(out);
    return sources.every((s) => s.ok) ? 0 : 1;
  },
});

defineCommand({
  name: 'rev',
  pkg: 'util-linux',
  size: 14568,
  doc: { category: 'text', summary: 'reverse lines characterwise', synopsis: ['rev [option] [file...]'], description: 'The rev utility copies the specified files to standard output, reversing the order of characters in every line.', examples: [{ cmd: 'echo hello | rev', desc: 'Prints olleh' }], seeAlso: ['tac'] },
  run: async (ctx) => {
    const files = ctx.args.filter((a) => a !== '--');
    if (files.length === 0) {
      for await (const { line, nl } of readLines(ctx.stdin)) await ctx.out([...line].reverse().join('') + (nl ? '\n' : ''));
      return 0;
    }
    const sources = await readSources(ctx, files, { report: async (f, e) => ctx.error(`cannot open ${f}: ${errText(e)}`) });
    let out = '';
    for (const s of sources) for (const l of splitLines(s.text)) out += [...l].reverse().join('') + '\n';
    await ctx.out(out);
    return sources.every((s) => s.ok) ? 0 : 1;
  },
});

defineCommand({
  name: 'paste',
  pkg: 'coreutils',
  size: 39432,
  doc: { category: 'text', summary: 'merge lines of files', synopsis: ['paste [OPTION]... [FILE]...'], description: 'Write lines consisting of the sequentially corresponding lines from each FILE, separated by TABs, to standard output.', options: [{ flags: '-d, --delimiters=LIST', desc: 'reuse characters from LIST instead of TABs' }, { flags: '-s, --serial', desc: 'paste one file at a time instead of in parallel' }], examples: [{ cmd: 'paste names.txt ages.txt', desc: 'Join two files side by side.' }, { cmd: 'paste -sd, list.txt', desc: 'Join all lines with commas.' }], seeAlso: ['cut', 'join'] },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'd:sz', long: { delimiters: { key: 'd', arg: 'required' }, serial: 's' } });
    if (!opts) return 1;
    const delims = [...(opts.get('d') ?? '\t').replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\0/g, '')];
    const sources = await readSources(ctx, opts.operands);
    const columns = sources.map((s) => splitLines(s.text));
    let out = '';
    if (opts.has('s')) {
      for (const col of columns) out += col.reduce((acc, l, i) => (i === 0 ? l : acc + (delims.length ? delims[(i - 1) % delims.length] : '') + l), '') + '\n';
    } else {
      const rows = Math.max(0, ...columns.map((c) => c.length));
      for (let r = 0; r < rows; r++) {
        let line = '';
        columns.forEach((c, i) => {
          if (i > 0 && delims.length) line += delims[(i - 1) % delims.length];
          line += c[r] ?? '';
        });
        out += line + '\n';
      }
    }
    await ctx.out(out);
    return sources.every((s) => s.ok) ? 0 : 1;
  },
});

defineCommand({
  name: 'fold',
  pkg: 'coreutils',
  size: 39432,
  doc: { category: 'text', summary: 'wrap each input line to fit in specified width', synopsis: ['fold [OPTION]... [FILE]...'], description: 'Wrap input lines in each FILE, writing to standard output.', options: [{ flags: '-s, --spaces', desc: 'break at spaces' }, { flags: '-w, --width=WIDTH', desc: 'use WIDTH columns instead of 80' }], seeAlso: ['fmt'] },
  run: async (ctx) => {
    let opts;
    try {
      opts = parseOpts(ctx.args.map((a) => (/^-\d+$/.test(a) ? `-w${a.slice(1)}` : a)), { short: 'bsw:', long: { bytes: 'b', spaces: 's', width: { key: 'w', arg: 'required' } } });
    } catch (e) {
      if (e instanceof OptError) return missing(ctx, e.message);
      throw e;
    }
    const width = parseInt(opts.get('w') ?? '80', 10);
    const sources = await readSources(ctx, opts.operands);
    let out = '';
    for (const s of sources) {
      for (const line of splitLines(s.text)) {
        let rest = line;
        while ([...rest].length > width) {
          let cut = width;
          if (opts.has('s')) {
            const sp = rest.slice(0, width).lastIndexOf(' ');
            if (sp > 0) cut = sp + 1;
          }
          out += rest.slice(0, cut) + '\n';
          rest = rest.slice(cut);
        }
        out += rest + '\n';
      }
    }
    await ctx.out(out);
    return 0;
  },
});

defineCommand({
  name: 'seq',
  pkg: 'coreutils',
  size: 51136,
  doc: {
    category: 'text',
    summary: 'print a sequence of numbers',
    synopsis: ['seq [OPTION]... LAST', 'seq [OPTION]... FIRST LAST', 'seq [OPTION]... FIRST INCREMENT LAST'],
    description: 'Print numbers from FIRST to LAST, in steps of INCREMENT.',
    options: [
      { flags: '-s, --separator=STRING', desc: 'use STRING to separate numbers (default: \\n)' },
      { flags: '-w, --equal-width', desc: 'equalize width by padding with leading zeroes' },
    ],
    examples: [
      { cmd: 'seq 5', desc: 'Print 1 to 5.' },
      { cmd: 'seq 0 10 100', desc: 'Count from 0 to 100 in steps of 10.' },
    ],
    seeAlso: ['shuf'],
  },
  run: async (ctx) => {
    let opts;
    try {
      opts = parseOpts(ctx.args, { short: 'f:s:w', long: { format: { key: 'f', arg: 'required' }, separator: { key: 's', arg: 'required' }, 'equal-width': 'w' }, allowNegativeNumbers: true });
    } catch (e) {
      if (e instanceof OptError) return missing(ctx, e.message);
      throw e;
    }
    const nums = opts.operands.map((x) => ({ s: x, n: Number(x) }));
    if (nums.length === 0) return missing(ctx);
    if (nums.length > 3) {
      await ctx.error(`extra operand ${q(opts.operands[3])}`);
      await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
      return 1;
    }
    for (const x of nums) {
      if (Number.isNaN(x.n) || x.s.trim() === '') {
        await ctx.error(`invalid floating point argument: ${ql(x.s)}`);
        await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
        return 1;
      }
    }
    const first = nums.length > 1 ? nums[0].n : 1;
    const inc = nums.length === 3 ? nums[1].n : 1;
    const last = nums[nums.length - 1].n;
    if (inc === 0) {
      await ctx.error(`invalid Zero increment value: ${ql(nums[1].s)}`);
      return 1;
    }
    const decimals = Math.max(0, ...nums.map((x) => (x.s.includes('.') ? x.s.split('.')[1].length : 0)));
    const sep = opts.get('s') ?? '\n';
    const fmt = (v: number) => {
      let s = decimals ? v.toFixed(decimals) : String(Math.round(v));
      if (opts.get('f')) s = formatPrintf(opts.get('f')!, [String(v)]).output;
      return s;
    };
    const width = opts.has('w') ? Math.max(fmt(first).length, fmt(last).length) : 0;
    let out = '';
    let count = 0;
    for (let v = first; inc > 0 ? v <= last + 1e-10 : v >= last - 1e-10; v = first + inc * ++count) {
      let s = fmt(v);
      if (width) s = s.startsWith('-') ? '-' + s.slice(1).padStart(width - 1, '0') : s.padStart(width, '0');
      out += (count > 0 ? sep : '') + s;
      if (out.length > 65536) {
        await ctx.out(out);
        out = '';
        await ctx.checkpoint();
      }
    }
    if (count > 0) out += '\n';
    await ctx.out(out);
    return 0;
  },
});

defineCommand({
  name: 'yes',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'text', summary: 'output a string repeatedly until killed', synopsis: ['yes [STRING]...'], description: "Repeatedly output a line with all specified STRING(s), or 'y'. It never stops on its own: press Ctrl+C, or pipe it into a command like head.", examples: [{ cmd: 'yes | head -3', desc: 'Print three lines of "y".' }], seeAlso: ['seq'] },
  run: async (ctx) => {
    const line = (ctx.args.length ? ctx.args.join(' ') : 'y') + '\n';
    const chunk = line.repeat(Math.max(1, Math.floor(4096 / line.length)));
    for (;;) {
      await ctx.out(chunk);
    }
  },
});

defineCommand({
  name: 'echo',
  pkg: 'coreutils',
  size: 35464,
  doc: {
    category: 'shell',
    summary: 'display a line of text',
    synopsis: ['echo [SHORT-OPTION]... [STRING]...'],
    description: 'Echo the STRING(s) to standard output.\n\nNOTE: your shell has its own version of echo (a builtin), which is what normally runs when you type echo.',
    options: [
      { flags: '-n', desc: 'do not output the trailing newline' },
      { flags: '-e', desc: 'enable interpretation of backslash escapes' },
      { flags: '-E', desc: 'disable interpretation of backslash escapes (default)' },
    ],
    examples: [
      { cmd: 'echo Hello, world', desc: 'Print a message.' },
      { cmd: 'echo "Hello" > hello.txt', desc: 'Write a message into a file.' },
      { cmd: 'echo $HOME', desc: 'Print the value of a variable.' },
    ],
    seeAlso: ['printf'],
  },
  gnu: false,
  run: async (ctx) => {
    if (ctx.args.length === 1 && ctx.args[0] === '--help') {
      await ctx.out('Usage: echo [SHORT-OPTION]... [STRING]...\n  or:  echo LONG-OPTION\nEcho the STRING(s) to standard output.\n\n  -n             do not output the trailing newline\n  -e             enable interpretation of backslash escapes\n  -E             disable interpretation of backslash escapes (default)\n');
      return 0;
    }
    await ctx.out(echoText(ctx.args));
    return 0;
  },
});

defineCommand({
  name: 'printf',
  pkg: 'coreutils',
  size: 51272,
  doc: {
    category: 'shell',
    summary: 'format and print data',
    synopsis: ['printf FORMAT [ARGUMENT]...'],
    description: 'Print ARGUMENT(s) according to FORMAT. FORMAT controls the output as in C printf: %s for strings, %d for integers, %f for decimals, \\n for a newline.\n\nNOTE: your shell has its own version of printf (a builtin).',
    examples: [
      { cmd: 'printf "%s is %d years old\\n" Ava 12', desc: 'Fill values into a template.' },
      { cmd: 'printf "%05.2f\\n" 3.14159', desc: 'Format a number.' },
    ],
    seeAlso: ['echo'],
  },
  gnu: false,
  run: async (ctx) => {
    if (ctx.args.length === 0) return missing(ctx);
    const r = formatPrintf(ctx.args[0], ctx.args.slice(1));
    await ctx.out(r.output);
    for (const e of r.errors) await ctx.error(e);
    return r.errors.length ? 1 : 0;
  },
});

// ---------------------------------------------------------------------------
// encoders and checksums

defineCommand({
  name: 'base64',
  pkg: 'coreutils',
  size: 39432,
  doc: { category: 'text', summary: 'base64 encode/decode data and print to standard output', synopsis: ['base64 [OPTION]... [FILE]'], description: 'Base64 encode or decode FILE, or standard input, to standard output.', options: [{ flags: '-d, --decode', desc: 'decode data' }, { flags: '-w, --wrap=COLS', desc: 'wrap encoded lines after COLS character (default 76). Use 0 to disable line wrapping' }], examples: [{ cmd: 'echo hello | base64', desc: 'Encode text.' }, { cmd: 'echo aGVsbG8K | base64 -d', desc: 'Decode it again.' }], seeAlso: ['md5sum'] },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'diw:', long: { decode: 'd', 'ignore-garbage': 'i', wrap: { key: 'w', arg: 'required' } } });
    if (!opts) return 1;
    const sources = await readSources(ctx, opts.operands);
    if (!sources[0]?.ok) return 1;
    const text = sources[0].text;
    if (opts.has('d')) {
      try {
        await ctx.out(base64Decode(text));
        return 0;
      } catch {
        await ctx.error('invalid input');
        return 1;
      }
    }
    const enc = base64Encode(text);
    const wrap = parseInt(opts.get('w') ?? '76', 10);
    const lines = wrap > 0 ? enc.match(new RegExp(`.{1,${wrap}}`, 'g')) ?? [''] : [enc];
    await ctx.out(lines.join('\n') + '\n');
    return 0;
  },
});

for (const [name, fn, len] of [['md5sum', md5, 32], ['sha1sum', sha1, 40], ['sha256sum', sha256, 64]] as const) {
  defineCommand({
    name,
    pkg: 'coreutils',
    size: 47528,
    doc: { category: 'files', summary: `compute and check ${name.replace('sum', '').toUpperCase()} message digest`, synopsis: [`${name} [OPTION]... [FILE]...`], description: `Print or check ${name.replace('sum', '').toUpperCase()} checksums. A checksum is a fingerprint of a file: if even one byte changes, the checksum changes too.`, options: [{ flags: '-c, --check', desc: `read checksums from the FILEs and check them` }], examples: [{ cmd: `${name} file.iso`, desc: 'Compute a checksum to verify a download.' }], seeAlso: ['base64'] },
    run: async (ctx) => {
      const opts = await getopts(ctx, { short: 'bctwz', long: { binary: 'b', check: 'c', text: 't', warn: 'w', quiet: 'quiet', status: 'status' } });
      if (!opts) return 1;
      const files = opts.operands.length ? opts.operands : ['-'];
      let status = 0;
      if (opts.has('c')) {
        for (const f of files) {
          const src = await readSources(ctx, [f]);
          for (const line of splitLines(src[0].text)) {
            const m = new RegExp(`^([0-9a-f]{${len}}) [ *](.+)$`).exec(line);
            if (!m) continue;
            let ok = false;
            try {
              ok = fn(ctx.fs.readFile(m[2])) === m[1];
            } catch (e) {
              await ctx.error(`${m[2]}: ${errText(e)}`);
            }
            if (!ok) status = 1;
            if (!opts.has('status')) await ctx.out(`${m[2]}: ${ok ? 'OK' : 'FAILED'}\n`);
          }
        }
        if (status && !opts.has('status')) await ctx.error('WARNING: 1 computed checksum did NOT match');
        return status;
      }
      for (const f of files) {
        const src = await readSources(ctx, [f]);
        if (!src[0].ok) {
          status = 1;
          continue;
        }
        await ctx.out(`${fn(src[0].text)}  ${f}\n`);
      }
      return status;
    },
  });
}

// ---------------------------------------------------------------------------
// misc

defineCommand({
  name: 'shuf',
  pkg: 'coreutils',
  size: 51272,
  doc: { category: 'text', summary: 'generate random permutations', synopsis: ['shuf [OPTION]... [FILE]', 'shuf -e [OPTION]... [ARG]...', 'shuf -i LO-HI [OPTION]...'], description: 'Write a random permutation of the input lines to standard output.', options: [{ flags: '-e, --echo', desc: 'treat each ARG as an input line' }, { flags: '-i, --input-range=LO-HI', desc: 'treat each number LO through HI as an input line' }, { flags: '-n, --head-count=COUNT', desc: 'output at most COUNT lines' }], examples: [{ cmd: 'shuf -n 1 names.txt', desc: 'Pick a random line.' }, { cmd: 'shuf -i 1-6 -n 1', desc: 'Roll a die.' }], seeAlso: ['sort'] },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'ei:n:rz', long: { echo: 'e', 'input-range': { key: 'i', arg: 'required' }, 'head-count': { key: 'n', arg: 'required' }, repeat: 'r' } });
    if (!opts) return 1;
    let lines: string[];
    if (opts.has('e')) lines = opts.operands;
    else if (opts.get('i')) {
      const m = /^(\d+)-(\d+)$/.exec(opts.get('i')!);
      if (!m) {
        await ctx.error(`invalid input range: ${ql(opts.get('i')!)}`);
        return 1;
      }
      lines = [];
      for (let i = +m[1]; i <= +m[2]; i++) lines.push(String(i));
    } else {
      const src = await readSources(ctx, opts.operands);
      if (!src[0]?.ok) return 1;
      lines = splitLines(src[0].text);
    }
    const r = ctx.system.random;
    for (let i = lines.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [lines[i], lines[j]] = [lines[j], lines[i]];
    }
    const n = opts.get('n') !== undefined ? parseInt(opts.get('n')!, 10) : lines.length;
    await ctx.out(lines.slice(0, n).map((l) => l + '\n').join(''));
    return 0;
  },
});

defineCommand({
  name: 'comm',
  pkg: 'coreutils',
  size: 39432,
  doc: { category: 'text', summary: 'compare two sorted files line by line', synopsis: ['comm [OPTION]... FILE1 FILE2'], description: 'Compare sorted files FILE1 and FILE2 line by line. With no options, produce three-column output. Column one contains lines unique to FILE1, column two contains lines unique to FILE2, and column three contains lines common to both files.', options: [{ flags: '-1', desc: 'suppress column 1 (lines unique to FILE1)' }, { flags: '-2', desc: 'suppress column 2 (lines unique to FILE2)' }, { flags: '-3', desc: 'suppress column 3 (lines that appear in both files)' }], seeAlso: ['diff', 'uniq'] },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: '123', long: {} });
    if (!opts) return 1;
    if (opts.operands.length < 2) return missing(ctx, opts.operands.length === 0 ? 'missing operand' : `missing operand after ${q(opts.operands[0])}`);
    const [a, b] = await readSources(ctx, opts.operands.slice(0, 2));
    if (!a.ok || !b.ok) return 1;
    const la = splitLines(a.text);
    const lb = splitLines(b.text);
    let i = 0;
    let j = 0;
    let out = '';
    const col = (n: number, s: string) => {
      if (opts.has(String(n))) return;
      let indent = '';
      for (let k = 1; k < n; k++) if (!opts.has(String(k))) indent += '\t';
      out += indent + s + '\n';
    };
    while (i < la.length || j < lb.length) {
      if (j >= lb.length || (i < la.length && compareLocale(la[i], lb[j]) < 0)) col(1, la[i++]);
      else if (i >= la.length || compareLocale(la[i], lb[j]) > 0) col(2, lb[j++]);
      else {
        col(3, la[i]);
        i++;
        j++;
      }
    }
    await ctx.out(out);
    return 0;
  },
});

defineCommand({
  name: 'column',
  pkg: 'util-linux',
  size: 43320,
  doc: { category: 'text', summary: 'columnate lists', synopsis: ['column [options] [file ...]'], description: 'The column utility formats its input into multiple columns. With -t it lines up a table.', options: [{ flags: '-t, --table', desc: 'Determine the number of columns the input contains and create a table.' }, { flags: '-s, --separator separators', desc: 'Specify the possible input item delimiters (default is whitespace).' }], examples: [{ cmd: 'column -t -s, data.csv', desc: 'Show a CSV as an aligned table.' }, { cmd: 'mount | column -t', desc: 'Line up messy output.' }], seeAlso: ['paste'] },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'ts:o:c:x', long: { table: 't', separator: { key: 's', arg: 'required' }, 'output-separator': { key: 'o', arg: 'required' } } });
    if (!opts) return 1;
    const src = await readSources(ctx, opts.operands);
    const lines = src.flatMap((s) => splitLines(s.text));
    if (opts.has('t')) {
      const sep = opts.get('s');
      const rows = lines.filter((l) => l.trim() !== '').map((l) => (sep ? l.split(new RegExp(`[${sep.replace(/[\]\\^-]/g, '\\$&')}]`)) : l.trim().split(/\s+/)));
      const widths: number[] = [];
      for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, stringWidth(c))));
      const osep = opts.get('o') ?? '  ';
      await ctx.out(rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i] - stringWidth(c)) + osep)).join('')).join('\n') + (rows.length ? '\n' : ''));
      return 0;
    }
    const items = lines.filter((l) => l !== '');
    const width = Math.max(1, ...items.map((i) => stringWidth(i))) + 1;
    const totalWidth = ctx.tty?.cols ?? 80;
    const cols = Math.max(1, Math.floor(totalWidth / (Math.ceil(width / 8) * 8)));
    const rows = Math.ceil(items.length / cols);
    let out = '';
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        const it = items[c * rows + r];
        if (it === undefined) break;
        const colW = Math.ceil(width / 8) * 8;
        line += c * rows + r + rows < items.length ? it + ' '.repeat(colW - stringWidth(it)) : it;
      }
      out += line + '\n';
    }
    await ctx.out(out);
    return 0;
  },
});

defineCommand({
  name: 'expr',
  pkg: 'coreutils',
  size: 108784,
  doc: { category: 'shell', summary: 'evaluate expressions', synopsis: ['expr EXPRESSION'], description: 'Print the value of EXPRESSION to standard output. Operators like + - * / % must be separate arguments, and * must be quoted. Modern scripts usually use $(( )) instead.', examples: [{ cmd: 'expr 2 + 3', desc: 'Prints 5' }, { cmd: "expr 6 '*' 7", desc: 'Prints 42 (the * must be quoted).' }], seeAlso: ['test', 'bc'] },
  run: async (ctx) => {
    const t = ctx.args;
    if (t.length === 0) return missing(ctx);
    let i = 0;
    const isInt = (s: string) => /^[-+]?\d+$/.test(s);
    const fail = (msg: string): never => {
      throw new Error(msg);
    };
    const primary = (): string => {
      const v = t[i++];
      if (v === undefined) fail('syntax error: missing argument after ' + q(t[i - 2] ?? ''));
      if (v === '(') {
        const r = or();
        if (t[i++] !== ')') fail("syntax error: expecting ')'");
        return r;
      }
      if (v === 'length') return String([...primary()].length);
      return v;
    };
    const colon = (): string => {
      let l = primary();
      while (t[i] === ':') {
        i++;
        const re = primary();
        const m = new RegExp('^(?:' + re.replace(/\\\(/g, '(').replace(/\\\)/g, ')') + ')').exec(l);
        l = m ? (m[1] !== undefined ? m[1] : String(m[0].length)) : re.includes('\\(') ? '' : '0';
      }
      return l;
    };
    const mul = (): string => {
      let l = colon();
      while (t[i] === '*' || t[i] === '/' || t[i] === '%') {
        const op = t[i++];
        const r = colon();
        if (!isInt(l) || !isInt(r)) fail('non-integer argument');
        if ((op === '/' || op === '%') && Number(r) === 0) fail('division by zero');
        l = String(op === '*' ? Number(l) * Number(r) : op === '/' ? Math.trunc(Number(l) / Number(r)) : Number(l) % Number(r));
      }
      return l;
    };
    const add = (): string => {
      let l = mul();
      while (t[i] === '+' || t[i] === '-') {
        const op = t[i++];
        const r = mul();
        if (!isInt(l) || !isInt(r)) fail('non-integer argument');
        l = String(op === '+' ? Number(l) + Number(r) : Number(l) - Number(r));
      }
      return l;
    };
    const cmp = (): string => {
      let l = add();
      while (['<', '<=', '=', '==', '!=', '>=', '>'].includes(t[i])) {
        const op = t[i++];
        const r = add();
        const c = isInt(l) && isInt(r) ? Number(l) - Number(r) : compareLocale(l, r);
        const ok = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '=' || op === '==' ? c === 0 : op === '!=' ? c !== 0 : op === '>=' ? c >= 0 : c > 0;
        l = ok ? '1' : '0';
      }
      return l;
    };
    const and = (): string => {
      let l = cmp();
      while (t[i] === '&') {
        i++;
        const r = cmp();
        l = l !== '' && l !== '0' && r !== '' && r !== '0' ? l : '0';
      }
      return l;
    };
    const or = (): string => {
      let l = and();
      while (t[i] === '|') {
        i++;
        const r = and();
        l = l !== '' && l !== '0' ? l : r !== '' && r !== '0' ? r : '0';
      }
      return l;
    };
    try {
      const v = or();
      if (i < t.length) fail(`syntax error: unexpected argument ${q(t[i])}`);
      await ctx.out(v + '\n');
      return v === '' || v === '0' ? 1 : 0;
    } catch (e) {
      await ctx.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
  },
});

defineCommand({
  name: 'factor',
  pkg: 'coreutils',
  size: 72392,
  doc: { category: 'text', summary: 'factor numbers', synopsis: ['factor [NUMBER]...'], description: 'Print the prime factors of each specified integer NUMBER.', examples: [{ cmd: 'factor 360', desc: '360: 2 2 2 3 3 5' }], seeAlso: ['expr'] },
  run: async (ctx) => {
    const nums = ctx.args.length ? ctx.args : splitLines(await ctx.stdin.readAll()).flatMap((l) => l.trim().split(/\s+/)).filter(Boolean);
    let status = 0;
    for (const s of nums) {
      if (!/^\d+$/.test(s)) {
        await ctx.error(`${q(s)} is not a valid positive integer`);
        status = 1;
        continue;
      }
      let n = Number(s);
      const f: number[] = [];
      for (let p = 2; p * p <= n; p++) {
        while (n % p === 0) {
          f.push(p);
          n /= p;
        }
      }
      if (n > 1) f.push(n);
      await ctx.out(`${s}:${f.map((x) => ' ' + x).join('')}\n`);
    }
    return status;
  },
});
