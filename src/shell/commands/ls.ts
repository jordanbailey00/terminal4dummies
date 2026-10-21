// ls — list directory contents (GNU coreutils behaviour).

import { compareLocale } from '../collate';
import { stringWidth } from '../wcwidth';
import { inodeSize, type Inode } from '../vfs/fs';
import type { CommandContext } from '../types';
import { colorFor, paint, parseLsColors, type ColorDb } from './lscolors';
import { MONTHS, blocksFor, defineCommand, errText, getopts, humanSize, pad2, q } from './util';

export function modeString(node: Inode): string {
  const t = node.type === 'dir' ? 'd' : node.type === 'symlink' ? 'l' : node.type === 'chardev' ? 'c' : '-';
  const m = node.mode;
  const rwx = (shift: number, special: number, ch: string) => {
    const r = m & (4 << shift) ? 'r' : '-';
    const w = m & (2 << shift) ? 'w' : '-';
    const xBit = m & (1 << shift);
    let x = xBit ? 'x' : '-';
    if (m & special) x = xBit ? ch : ch.toUpperCase();
    return r + w + x;
  };
  return t + rwx(6, 0o4000, 's') + rwx(3, 0o2000, 's') + rwx(0, 0o1000, 't');
}

const SIX_MONTHS = 182.5 * 24 * 3600 * 1000;

export function lsDate(time: number, now: number): string {
  const d = new Date(time);
  const mon = MONTHS[d.getMonth()];
  const day = String(d.getDate()).padStart(2, ' ');
  if (now - time < SIX_MONTHS && time - now < 60 * 60 * 1000) {
    return `${mon} ${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return `${mon} ${day}  ${d.getFullYear()}`;
}

function fullTime(time: number): string {
  const d = new Date(time);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const ns = String((time % 1000) * 1000000 + 123456).padStart(9, '0').slice(0, 9);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${ns} ${sign}${pad2(Math.floor(a / 60))}${pad2(a % 60)}`;
}

const NEEDS_QUOTE = /[^A-Za-z0-9_@%+=:,./\- -￿]/;

/** Quote a file name the way ls does on a terminal (shell-escape style). */
export function lsQuote(name: string): { text: string; quoted: boolean } {
  if (name === '' || !NEEDS_QUOTE.test(name)) return { text: name, quoted: false };
  if (/[\x00-\x1f\x7f]/.test(name)) {
    let out = '';
    for (const ch of name) {
      if (/[\x00-\x1f\x7f]/.test(ch)) {
        const esc = ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ch === '\r' ? '\\r' : '\\' + ch.charCodeAt(0).toString(8).padStart(3, '0');
        out += `'$'${esc}''`;
      } else out += ch;
    }
    return { text: `'${out}'`.replace(/^''/, '').replace(/''$/, ''), quoted: true };
  }
  if (!name.includes("'")) return { text: `'${name}'`, quoted: true };
  if (!/["$`\\!]/.test(name)) return { text: `"${name}"`, quoted: true };
  return { text: "'" + name.replace(/'/g, "'\\''") + "'", quoted: true };
}

interface Entry {
  /** Name as displayed (path for operands, basename inside directories). */
  name: string;
  /** Path used for lookups. */
  path: string;
  node: Inode | null;
  /** Target of a symlink (null = dangling, undefined = not a link). */
  target?: Inode | null;
  linkText?: string;
}

interface LsOptions {
  all: boolean;
  almostAll: boolean;
  long: boolean;
  human: boolean;
  si: boolean;
  sort: 'name' | 'time' | 'size' | 'extension' | 'version' | 'none';
  reverse: boolean;
  recursive: boolean;
  format: 'long' | 'single' | 'columns' | 'across' | 'commas';
  directory: boolean;
  classify: 'none' | 'slash' | 'classify' | 'file-type';
  inode: boolean;
  size: boolean;
  numeric: boolean;
  showOwner: boolean;
  showGroup: boolean;
  color: boolean;
  quote: boolean;
  width: number;
  timeField: 'mtime' | 'ctime' | 'atime';
  groupDirsFirst: boolean;
  fullTime: boolean;
  dereference: boolean;
  ignoreBackups: boolean;
  ignore: RegExp[];
}

function versionCompare(a: string, b: string): number {
  const re = /(\d+|\D+)/g;
  const pa = a.match(re) ?? [];
  const pb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return d;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

function sortEntries(entries: Entry[], o: LsOptions): Entry[] {
  if (o.sort === 'none') return o.reverse ? [...entries].reverse() : entries;
  const time = (e: Entry) => (e.node ? (o.timeField === 'ctime' ? e.node.ctime : o.timeField === 'atime' ? e.node.atime : e.node.mtime) : 0);
  const cmp = (a: Entry, b: Entry): number => {
    let r = 0;
    switch (o.sort) {
      case 'time':
        r = time(b) - time(a);
        break;
      case 'size':
        r = (b.node ? inodeSize(b.node) : 0) - (a.node ? inodeSize(a.node) : 0);
        break;
      case 'extension': {
        const ea = a.name.includes('.') ? a.name.slice(a.name.lastIndexOf('.')) : '';
        const eb = b.name.includes('.') ? b.name.slice(b.name.lastIndexOf('.')) : '';
        r = compareLocale(ea, eb);
        break;
      }
      case 'version':
        r = versionCompare(a.name, b.name);
        break;
      default:
        break;
    }
    if (r === 0) r = compareLocale(a.name, b.name);
    return o.reverse ? -r : r;
  };
  const sorted = [...entries].sort(cmp);
  if (o.groupDirsFirst) {
    const isDir = (e: Entry) => e.node?.type === 'dir' || (e.node?.type === 'symlink' && e.target?.type === 'dir');
    return [...sorted.filter(isDir), ...sorted.filter((e) => !isDir(e))];
  }
  return sorted;
}

function indicator(e: Entry, o: LsOptions): string {
  if (o.classify === 'none' || !e.node) return '';
  const n = e.node;
  if (n.type === 'dir') return '/';
  if (o.classify === 'slash') return '';
  if (n.type === 'symlink') return o.format === 'long' ? '' : '@';
  if (o.classify === 'classify' && n.type === 'file' && n.mode & 0o111) return '*';
  return '';
}

class Lister {
  private readonly ctx: CommandContext;
  private readonly o: LsOptions;
  private readonly colors: ColorDb;
  private out: string[] = [];
  status = 0;
  private firstColor = true;

  constructor(ctx: CommandContext, o: LsOptions) {
    this.ctx = ctx;
    this.o = o;
    this.colors = parseLsColors(ctx.env.get('LS_COLORS'));
  }

  private flushText(): string {
    const s = this.out.join('');
    this.out = [];
    return s;
  }

  async flush(): Promise<void> {
    const s = this.flushText();
    if (s) await this.ctx.out(s);
  }

  push(s: string): void {
    this.out.push(s);
  }

  private displayName(e: Entry, anyQuoted: boolean): { text: string; width: number } {
    let label = e.name;
    let width: number;
    if (this.o.quote) {
      const qn = lsQuote(label);
      label = qn.text;
      if (!qn.quoted && anyQuoted) label = ' ' + label;
    }
    width = stringWidth(label);
    let text = label;
    if (this.o.color) {
      const code = colorFor(this.colors, e.name, e.node, e.target);
      if (code && code !== '0' && code !== '00') {
        const lead = label.startsWith(' ') && !e.name.startsWith(' ') ? ' ' : '';
        const body = lead ? label.slice(1) : label;
        text = lead + (this.firstColor ? '\x1b[0m' : '') + `\x1b[${code}m${body}\x1b[0m`;
        this.firstColor = false;
      }
    }
    const ind = indicator(e, this.o);
    text += ind;
    width += ind.length;
    return { text, width };
  }

  private anyQuoted(entries: Entry[]): boolean {
    return this.o.quote && entries.some((e) => lsQuote(e.name).quoted);
  }

  formatEntries(entries: Entry[]): void {
    if (entries.length === 0) return;
    const o = this.o;
    if (o.format === 'long') {
      this.formatLong(entries);
      return;
    }
    const anyQuoted = this.anyQuoted(entries);
    const items = entries.map((e) => {
      const d = this.displayName(e, anyQuoted);
      let prefix = '';
      if (o.inode) prefix += String(e.node?.ino ?? '?') + ' ';
      if (o.size) prefix += this.blockText(e) + ' ';
      return { text: prefix + d.text, width: d.width + prefix.length };
    });
    if (o.inode || o.size) {
      // align prefixes
      const iw = o.inode ? Math.max(...entries.map((e) => String(e.node?.ino ?? '?').length)) : 0;
      const sw = o.size ? Math.max(...entries.map((e) => this.blockText(e).length)) : 0;
      entries.forEach((e, i) => {
        const d = this.displayName(e, anyQuoted);
        let prefix = '';
        if (o.inode) prefix += String(e.node?.ino ?? '?').padStart(iw) + ' ';
        if (o.size) prefix += this.blockText(e).padStart(sw) + ' ';
        items[i] = { text: prefix + d.text, width: d.width + prefix.length };
      });
    }
    if (o.format === 'single') {
      for (const it of items) this.push(it.text + '\n');
      return;
    }
    if (o.format === 'commas') {
      let line = '';
      let lineWidth = 0;
      items.forEach((it, i) => {
        const sep = i < items.length - 1 ? ',' : '';
        const w = it.width + sep.length;
        if (lineWidth > 0 && lineWidth + 1 + w > o.width) {
          this.push(line + '\n');
          line = '';
          lineWidth = 0;
        }
        if (lineWidth > 0) {
          line += ' ';
          lineWidth++;
        }
        line += it.text + sep;
        lineWidth += w;
      });
      if (line) this.push(line + '\n');
      return;
    }
    this.formatColumns(items, o.format === 'across');
  }

  private formatColumns(items: { text: string; width: number }[], across: boolean): void {
    const n = items.length;
    const width = this.o.width;
    let best = { cols: 1, rows: n, widths: [Math.max(...items.map((i) => i.width))] };
    const maxCols = Math.min(n, Math.max(1, Math.floor(width / 3)));
    for (let cols = maxCols; cols >= 1; cols--) {
      const rows = Math.ceil(n / cols);
      const used = Math.ceil(n / rows);
      const widths = new Array(used).fill(0);
      for (let i = 0; i < n; i++) {
        const c = across ? i % cols : Math.floor(i / rows);
        if (c >= used) continue;
        widths[c] = Math.max(widths[c], items[i].width);
      }
      const total = widths.reduce((a, b) => a + b, 0) + 2 * (used - 1);
      if (total < width || cols === 1) {
        best = { cols: across ? cols : used, rows, widths };
        break;
      }
    }
    const { rows, widths } = best;
    const cols = widths.length;
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        const idx = across ? r * best.cols + c : c * rows + r;
        if (idx >= n) break;
        const it = items[idx];
        const nextIdx = across ? r * best.cols + c + 1 : (c + 1) * rows + r;
        const isLast = c === cols - 1 || nextIdx >= n;
        line += it.text;
        if (!isLast) line += ' '.repeat(widths[c] - it.width + 2);
      }
      this.push(line + '\n');
    }
  }

  private blockText(e: Entry): string {
    if (!e.node) return '?';
    const blocks = blocksFor(inodeSize(e.node), e.node.type === 'dir');
    return this.o.human ? (blocks === 0 ? '0' : humanSize(blocks * 1024, this.o.si)) : String(blocks);
  }

  totalLine(entries: Entry[]): string {
    let blocks = 0;
    for (const e of entries) if (e.node) blocks += blocksFor(inodeSize(e.node), e.node.type === 'dir');
    return `total ${this.o.human ? (blocks === 0 ? '0' : humanSize(blocks * 1024, this.o.si)) : blocks}\n`;
  }

  private formatLong(entries: Entry[]): void {
    const o = this.o;
    const sys = this.ctx.system;
    const now = sys.now();
    const rows = entries.map((e) => {
      const n = e.node;
      if (!n) return null;
      const owner = o.numeric ? String(n.uid) : sys.userName(n.uid);
      const group = o.numeric ? String(n.gid) : sys.groupName(n.gid);
      let size: string;
      if (n.type === 'chardev') {
        const minor = { null: 3, zero: 5, tty: 0, random: 8, stdin: 0, stdout: 1, stderr: 2 }[n.device];
        const major = n.device === 'tty' ? 5 : 1;
        size = `${major}, ${minor}`;
      } else {
        const bytes = inodeSize(n);
        size = o.human ? humanSize(bytes, o.si) : String(bytes);
      }
      const t = o.timeField === 'ctime' ? n.ctime : o.timeField === 'atime' ? n.atime : n.mtime;
      return {
        e,
        inode: String(n.ino),
        blocks: this.blockText(e),
        mode: modeString(n),
        nlink: String(n.nlink),
        owner,
        group,
        size,
        date: o.fullTime ? fullTime(t) : lsDate(t, now),
      };
    });
    const valid = rows.filter((r): r is NonNullable<typeof r> => r !== null);
    const w = (k: 'inode' | 'blocks' | 'nlink' | 'owner' | 'group' | 'size') => Math.max(0, ...valid.map((r) => r[k].length));
    const wi = w('inode');
    const wb = w('blocks');
    const wl = w('nlink');
    const wo = w('owner');
    const wg = w('group');
    const ws = w('size');
    const anyQuoted = this.anyQuoted(entries);
    for (const r of valid) {
      let line = '';
      if (o.inode) line += r.inode.padStart(wi) + ' ';
      if (o.size) line += r.blocks.padStart(wb) + ' ';
      line += r.mode + ' ' + r.nlink.padStart(wl) + ' ';
      if (o.showOwner) line += r.owner.padEnd(wo) + ' ';
      if (o.showGroup) line += r.group.padEnd(wg) + ' ';
      line += r.size.padStart(ws) + ' ' + r.date + ' ';
      line += this.displayName(r.e, anyQuoted).text;
      if (r.e.node?.type === 'symlink' && r.e.linkText !== undefined) {
        let target = r.e.linkText;
        if (o.quote) target = lsQuote(target).text;
        if (o.color) {
          const code = r.e.target ? colorFor(this.colors, r.e.linkText, r.e.target, undefined) : this.colors.types.get('or') ?? null;
          target = paint(target, code);
        }
        line += ' -> ' + target;
        if (o.classify === 'classify' && r.e.target) {
          if (r.e.target.type === 'dir') line += '/';
          else if (r.e.target.type === 'file' && r.e.target.mode & 0o111) line += '*';
        }
      }
      this.push(line + '\n');
    }
  }
}

function makeEntry(ctx: CommandContext, name: string, path: string, follow: boolean): Entry {
  const fs = ctx.fs;
  let node: Inode | null = null;
  try {
    node = follow ? fs.stat(path) : fs.lstat(path);
  } catch {
    node = follow ? fs.tryStat(path, false) : null;
  }
  const e: Entry = { name, path, node };
  if (node?.type === 'symlink') {
    e.target = fs.tryStat(path, true);
    try {
      e.linkText = fs.readlink(path);
    } catch {
      e.linkText = '';
    }
  }
  return e;
}

export const lsCommand = defineCommand({
  name: 'ls',
  pkg: 'coreutils',
  size: 138216,
  doc: {
    category: 'navigation',
    summary: 'list directory contents',
    synopsis: ['ls [OPTION]... [FILE]...'],
    description:
      'List information about the FILEs (the current directory by default). Sort entries alphabetically if none of -cftuvSUX nor --sort is specified.\n\n' +
      'With -l, each line shows the file type and permissions, the number of links, the owner, the group, the size in bytes, the modification time and the name.',
    options: [
      { flags: '-a, --all', desc: 'do not ignore entries starting with .' },
      { flags: '-A, --almost-all', desc: 'do not list implied . and ..' },
      { flags: '--color[=WHEN]', desc: "color the output WHEN; more info below" },
      { flags: '-d, --directory', desc: 'list directories themselves, not their contents' },
      { flags: '-F, --classify', desc: 'append indicator (one of */=>@|) to entries' },
      { flags: '--group-directories-first', desc: 'group directories before files' },
      { flags: '-h, --human-readable', desc: 'with -l and -s, print sizes like 1K 234M 2G etc.' },
      { flags: '-i, --inode', desc: 'print the index number of each file' },
      { flags: '-l', desc: 'use a long listing format' },
      { flags: '-n, --numeric-uid-gid', desc: 'like -l, but list numeric user and group IDs' },
      { flags: '-r, --reverse', desc: 'reverse order while sorting' },
      { flags: '-R, --recursive', desc: 'list subdirectories recursively' },
      { flags: '-s, --size', desc: 'print the allocated size of each file, in blocks' },
      { flags: '-S', desc: 'sort by file size, largest first' },
      { flags: '-t', desc: 'sort by time, newest first' },
      { flags: '-X', desc: 'sort alphabetically by entry extension' },
      { flags: '-1', desc: 'list one file per line' },
    ],
    examples: [
      { cmd: 'ls', desc: 'List the files in the current directory.' },
      { cmd: 'ls -la', desc: 'Long listing including hidden files.' },
      { cmd: 'ls -lh /var/log', desc: 'Long listing with human-friendly sizes.' },
      { cmd: 'ls -lt', desc: 'Newest files first.' },
    ],
    seeAlso: ['dir', 'tree', 'stat', 'find'],
    tip: 'Files whose names start with a dot are hidden. Add -a to see them.',
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, {
      short: 'aAbBcCdfFgGhHiI:klLmnNopqQrRsStT:uUvw:xXZ1',
      long: {
        all: 'a',
        'almost-all': 'A',
        escape: 'b',
        'ignore-backups': 'B',
        color: { key: 'color', arg: 'optional' },
        colour: { key: 'color', arg: 'optional' },
        directory: 'd',
        classify: { key: 'F', arg: 'optional' },
        'file-type': 'file-type',
        'group-directories-first': 'gdf',
        'no-group': 'G',
        'human-readable': 'h',
        si: 'si',
        inode: 'i',
        ignore: { key: 'I', arg: 'required' },
        dereference: 'L',
        'numeric-uid-gid': 'n',
        literal: 'N',
        'quote-name': 'Q',
        reverse: 'r',
        recursive: 'R',
        size: 's',
        sort: { key: 'sort', arg: 'required' },
        time: { key: 'time', arg: 'required' },
        'full-time': 'full-time',
        width: { key: 'w', arg: 'required' },
        format: { key: 'format', arg: 'required' },
        'indicator-style': { key: 'indicator-style', arg: 'required' },
        'quoting-style': { key: 'quoting-style', arg: 'required' },
        'time-style': { key: 'time-style', arg: 'required' },
        'hide-control-chars': 'q',
        context: 'Z',
      },
    });
    if (!opts) return 2;
    const tty = ctx.stdout.isTTY;
    const colorArg = opts.flags.get('color');
    let color = false;
    if (colorArg !== undefined) {
      const v = colorArg === true ? 'always' : colorArg;
      if (['always', 'yes', 'force'].includes(v)) color = true;
      else if (['auto', 'tty', 'if-tty'].includes(v)) color = tty;
      else if (['never', 'no', 'none'].includes(v)) color = false;
      else {
        await ctx.error(`invalid argument ${q(v)} for '--color'\nValid arguments are:\n  - 'always', 'yes', 'force'\n  - 'never', 'no', 'none'\n  - 'auto', 'tty', 'if-tty'`);
        await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
        return 2;
      }
    }
    let width = 80;
    const colsEnv = ctx.env.get('COLUMNS');
    if (opts.get('w')) width = parseInt(opts.get('w')!, 10) || 80;
    else if (colsEnv && /^\d+$/.test(colsEnv)) width = parseInt(colsEnv, 10);
    else if (tty && ctx.tty) width = ctx.tty.cols;
    if (width <= 0) width = Infinity;

    const o: LsOptions = {
      all: false,
      almostAll: false,
      long: false,
      human: false,
      si: false,
      sort: 'name',
      reverse: false,
      recursive: false,
      format: tty ? 'columns' : 'single',
      directory: false,
      classify: 'none',
      inode: false,
      size: false,
      numeric: false,
      showOwner: true,
      showGroup: true,
      color,
      quote: tty,
      width,
      timeField: 'mtime',
      groupDirsFirst: false,
      fullTime: false,
      dereference: false,
      ignoreBackups: false,
      ignore: [],
    };
    for (const { key, value } of opts.list) {
      switch (key) {
        case 'a': o.all = true; o.almostAll = false; break;
        case 'A': o.almostAll = true; o.all = false; break;
        case 'B': o.ignoreBackups = true; break;
        case 'c': o.timeField = 'ctime'; break;
        case 'u': o.timeField = 'atime'; break;
        case 'C': o.format = 'columns'; break;
        case 'x': o.format = 'across'; break;
        case 'm': o.format = 'commas'; break;
        case '1': if (o.format !== 'long') o.format = 'single'; break;
        case 'd': o.directory = true; break;
        case 'f': o.all = true; o.sort = 'none'; o.color = false; break;
        case 'F': o.classify = 'classify'; break;
        case 'p': o.classify = 'slash'; break;
        case 'file-type': o.classify = 'file-type'; break;
        case 'g': o.format = 'long'; o.showOwner = false; break;
        case 'o': o.format = 'long'; o.showGroup = false; break;
        case 'G': o.showGroup = false; break;
        case 'gdf': o.groupDirsFirst = true; break;
        case 'h': o.human = true; break;
        case 'si': o.human = true; o.si = true; break;
        case 'i': o.inode = true; break;
        case 'I': o.ignore.push(new RegExp('^' + String(value).replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')); break;
        case 'l': o.format = 'long'; break;
        case 'n': o.format = 'long'; o.numeric = true; break;
        case 'L': o.dereference = true; break;
        case 'N': o.quote = false; break;
        case 'Q': o.quote = true; break;
        case 'r': o.reverse = true; break;
        case 'R': o.recursive = true; break;
        case 's': o.size = true; break;
        case 'S': o.sort = 'size'; break;
        case 't': o.sort = 'time'; break;
        case 'U': o.sort = 'none'; break;
        case 'v': o.sort = 'version'; break;
        case 'X': o.sort = 'extension'; break;
        case 'full-time': o.format = 'long'; o.fullTime = true; break;
        case 'sort': {
          const v = String(value);
          const map: Record<string, LsOptions['sort']> = { none: 'none', time: 'time', size: 'size', extension: 'extension', version: 'version', name: 'name' };
          if (!map[v]) {
            await ctx.error(`invalid argument ${q(v)} for '--sort'`);
            return 2;
          }
          o.sort = map[v];
          break;
        }
        case 'format': {
          const v = String(value);
          const map: Record<string, LsOptions['format']> = { long: 'long', verbose: 'long', single: 'single', 'single-column': 'single', vertical: 'columns', horizontal: 'across', across: 'across', commas: 'commas' };
          if (map[v]) o.format = map[v];
          break;
        }
        default:
          break;
      }
    }
    if (o.format !== 'long' && opts.list.some((x) => x.key === 'l')) o.format = 'long';
    // -1 after -l keeps long format; -l after -1 too.

    const lister = new Lister(ctx, o);
    const operands = opts.operands.length ? opts.operands : ['.'];
    const files: Entry[] = [];
    const dirs: Entry[] = [];
    const followArgs = o.dereference || !(o.format === 'long' || o.directory || o.classify !== 'none');
    for (const p of operands) {
      const e = makeEntry(ctx, p, p, o.dereference);
      if (!e.node) {
        await lister.flush();
        let reason = 'No such file or directory';
        try {
          ctx.fs.lstat(p);
        } catch (err) {
          reason = errText(err);
        }
        await ctx.error(`cannot access ${q(p)}: ${reason}`);
        lister.status = 2;
        continue;
      }
      let isDir = e.node.type === 'dir';
      if (e.node.type === 'symlink' && followArgs && e.target?.type === 'dir') isDir = true;
      if (isDir && !o.directory) dirs.push(e);
      else files.push(e);
    }
    const sortedFiles = sortEntries(files, o);
    lister.formatEntries(sortedFiles);
    const sortedDirs = sortEntries(dirs, { ...o, groupDirsFirst: false });
    const showHeaders = operands.length > 1 || o.recursive;
    let first = sortedFiles.length === 0;
    const visited = new Set<number>();

    const listDir = async (e: Entry, label: string): Promise<void> => {
      await ctx.checkpoint();
      const fs = ctx.fs;
      let names: string[];
      try {
        names = fs.readdir(e.path);
      } catch (err) {
        await lister.flush();
        await ctx.error(`cannot open directory ${q(label)}: ${errText(err)}`);
        lister.status = Math.max(lister.status, operands.includes(label) ? 2 : 1);
        return;
      }
      const dirNode = fs.stat(e.path);
      if (visited.has(dirNode.ino)) {
        await ctx.error(`${q(label)}: not listing already-listed directory`);
        lister.status = Math.max(lister.status, 1);
        return;
      }
      visited.add(dirNode.ino);
      if (showHeaders) {
        if (!first) lister.push('\n');
        lister.push(`${o.quote ? lsQuote(label).text : label}:\n`);
      }
      first = false;
      const entries: Entry[] = [];
      const base = e.path === '/' ? '' : e.path.replace(/\/+$/, '');
      if (o.all) {
        entries.push(makeEntry(ctx, '.', e.path, false));
        entries.push(makeEntry(ctx, '..', base + '/..', false));
      }
      for (const name of names) {
        if (name.startsWith('.') && !o.all && !o.almostAll) continue;
        if (o.ignoreBackups && name.endsWith('~')) continue;
        if (o.ignore.some((re) => re.test(name))) continue;
        entries.push(makeEntry(ctx, name, base + '/' + name, o.dereference));
      }
      const sorted = sortEntries(entries, o);
      if (o.format === 'long' || o.size) lister.push(lister.totalLine(sorted));
      lister.formatEntries(sorted);
      await lister.flush();
      if (o.recursive) {
        for (const child of sorted) {
          if (child.name === '.' || child.name === '..') continue;
          if (child.node?.type !== 'dir') continue;
          const childLabel = label === '/' ? '/' + child.name : label.replace(/\/+$/, '') + '/' + child.name;
          await listDir(child, childLabel);
        }
      }
    };

    for (const d of sortedDirs) {
      await listDir(d, d.name);
    }
    await lister.flush();
    return lister.status;
  },
});

// `dir` and `vdir` are ls with fixed formats.
defineCommand({
  name: 'dir',
  pkg: 'coreutils',
  size: 138216,
  gnu: false,
  run: async (ctx) => lsCommand.run({ ...ctx, argv: ['dir', '-C', '-b', ...ctx.args], args: ['-C', '-b', ...ctx.args], stdout: ctx.stdout }),
});
defineCommand({
  name: 'vdir',
  pkg: 'coreutils',
  size: 138216,
  gnu: false,
  run: async (ctx) => lsCommand.run({ ...ctx, argv: ['vdir', '-l', '-b', ...ctx.args], args: ['-l', '-b', ...ctx.args] }),
});

