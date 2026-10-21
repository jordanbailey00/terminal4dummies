// tree — list contents of directories in a tree-like format (tree 2.1.1).

import { compareLocale } from '../collate';
import type { CommandContext, CommandDoc } from '../types';
import { inodeSize, type Inode } from '../vfs/fs';
import { modeString } from './ls';
import { colorFor, parseLsColors, type ColorDb } from './lscolors';
import { strftime } from './sysinfo';
import { defineCommand } from './util';

// ---------------------------------------------------------------------------
// Options

type SortKey = 'name' | 'version' | 'size' | 'mtime' | 'ctime' | 'none';

interface TreeOptions {
  all: boolean;
  dirsOnly: boolean;
  follow: boolean;
  fullPath: boolean;
  /** Deepest level listed (1 = only the root's entries). */
  level: number;
  pattern: Pattern | null;
  ignore: Pattern | null;
  ignoreCase: boolean;
  matchDirs: boolean;
  prune: boolean;
  noReport: boolean;
  quote: boolean;
  printable: 'escape' | 'question' | 'raw';
  perms: boolean;
  user: boolean;
  group: boolean;
  size: boolean;
  human: boolean;
  si: boolean;
  date: boolean;
  ctime: boolean;
  timefmt: string | null;
  inode: boolean;
  device: boolean;
  classify: boolean;
  sort: SortKey;
  reverse: boolean;
  dirsFirst: boolean;
  filesFirst: boolean;
  noIndent: boolean;
  ansiLines: boolean;
  charset: string | null;
  colorOn: boolean;
  colorOff: boolean;
  json: boolean;
  fileLimit: number;
  metaFirst: boolean;
  output: string | null;
}

function defaultOptions(): TreeOptions {
  return {
    all: false,
    dirsOnly: false,
    follow: false,
    fullPath: false,
    level: Infinity,
    pattern: null,
    ignore: null,
    ignoreCase: false,
    matchDirs: false,
    prune: false,
    noReport: false,
    quote: false,
    printable: 'escape',
    perms: false,
    user: false,
    group: false,
    size: false,
    human: false,
    si: false,
    date: false,
    ctime: false,
    timefmt: null,
    inode: false,
    device: false,
    classify: false,
    sort: 'name',
    reverse: false,
    dirsFirst: false,
    filesFirst: false,
    noIndent: false,
    ansiLines: false,
    charset: null,
    colorOn: false,
    colorOff: false,
    json: false,
    fileLimit: Infinity,
    metaFirst: false,
    output: null,
  };
}

// ---------------------------------------------------------------------------
// Wildcard patterns (-P / -I): "*.txt|*.md", a trailing "/" only matches directories.

interface Pattern {
  source: string;
  alternatives: { re: RegExp; dirOnly: boolean }[];
}

function globToRegex(glob: string, ignoreCase: boolean): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += glob[i + 1] === '*' ? (i++, '.*') : '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) {
        re += '\\[';
        continue;
      }
      let body = glob.slice(i + 1, end);
      if (body.startsWith('!') || body.startsWith('^')) body = '^' + body.slice(1);
      re += '[' + body.replace(/\\/g, '\\\\') + ']';
      i = end;
    } else if (c === '\\' && i + 1 < glob.length) {
      re += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', ignoreCase ? 'i' : '');
}

function makePattern(src: string, ignoreCase: boolean): Pattern {
  return {
    source: src,
    alternatives: src.split('|').map((alt) => {
      const dirOnly = alt.length > 1 && alt.endsWith('/');
      return { re: globToRegex(dirOnly ? alt.slice(0, -1) : alt, ignoreCase), dirOnly };
    }),
  };
}

function patMatch(p: Pattern, name: string, isDir: boolean): boolean {
  return p.alternatives.some((a) => (!a.dirOnly || isDir) && a.re.test(name));
}

// ---------------------------------------------------------------------------
// The tree being listed

interface TNode {
  /** Name as printed (basename, or the full path with -f). */
  label: string;
  /** Basename, used for sorting and colors. */
  name: string;
  path: string;
  node: Inode | null;
  /** Symlink target inode (null = dangling). */
  target?: Inode | null;
  linkText?: string;
  isDir: boolean;
  /** Listed children; undefined when the directory was not descended. */
  children?: TNode[];
  error?: string;
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

function sortNodes(list: TNode[], o: TreeOptions): TNode[] {
  if (o.sort === 'none') return list;
  const time = (n: TNode) => (n.node ? (o.sort === 'ctime' ? n.node.ctime : n.node.mtime) : 0);
  const size = (n: TNode) => (n.node ? inodeSize(n.node) : 0);
  const cmp = (a: TNode, b: TNode): number => {
    let v = 0;
    if (o.sort === 'version') v = versionCompare(a.name, b.name);
    else if (o.sort === 'mtime' || o.sort === 'ctime') v = time(a) - time(b);
    else if (o.sort === 'size') v = size(a) - size(b);
    if (v === 0) v = compareLocale(a.name, b.name);
    return o.reverse ? -v : v;
  };
  const sorted = [...list].sort(cmp);
  if (o.dirsFirst) return [...sorted.filter((n) => n.isDir), ...sorted.filter((n) => !n.isDir)];
  if (o.filesFirst) return [...sorted.filter((n) => !n.isDir), ...sorted.filter((n) => n.isDir)];
  return sorted;
}

class TreeBuilder {
  private visits = 0;
  private readonly ctx: CommandContext;
  private readonly o: TreeOptions;
  constructor(ctx: CommandContext, o: TreeOptions) {
    this.ctx = ctx;
    this.o = o;
  }

  /** Entry for a path given on the command line. */
  root(arg: string): TNode {
    const fs = this.ctx.fs;
    let label = arg;
    if (this.o.fullPath && label.length > 1 && label.endsWith('/')) label = label.replace(/\/+$/, '') || '/';
    let node: Inode | null = null;
    try {
      node = fs.lstat(arg);
    } catch {
      node = null;
    }
    const t: TNode = { label, name: arg, path: arg, node, isDir: false };
    if (node?.type === 'symlink') {
      // The directories named on the command line are always followed.
      t.target = fs.tryStat(arg, true);
      if (t.target) t.node = t.target;
      t.target = undefined;
    }
    t.isDir = t.node?.type === 'dir';
    return t;
  }

  async fill(dir: TNode, depth: number, ancestors: Set<number>, unfiltered = false): Promise<void> {
    const o = this.o;
    const fs = this.ctx.fs;
    if (++this.visits % 64 === 0) await this.ctx.checkpoint();
    let entries: [string, Inode][];
    try {
      entries = fs.readdirEntries(dir.path);
    } catch {
      dir.error = 'error opening dir';
      return;
    }
    const visible = entries.filter(([name]) => o.all || !name.startsWith('.'));
    if (visible.length > o.fileLimit) {
      dir.error = `${visible.length} entries exceeds filelimit, not opening dir`;
      return;
    }
    const base = dir.path === '/' ? '' : dir.path.replace(/\/+$/, '');
    const labelBase = dir.label === '/' ? '' : dir.label.replace(/\/+$/, '');
    const kids: TNode[] = [];
    for (const [name, node] of visible) {
      const path = base + '/' + name;
      const t: TNode = { label: o.fullPath ? labelBase + '/' + name : name, name, path, node, isDir: node.type === 'dir' };
      if (node.type === 'symlink') {
        t.target = fs.tryStat(path, true);
        t.linkText = node.target;
        t.isDir = t.target?.type === 'dir';
      }
      if (o.ignore && patMatch(o.ignore, name, t.isDir)) continue;
      let matchedDir = false;
      if (o.pattern && !unfiltered) {
        if (t.isDir) {
          matchedDir = o.matchDirs && patMatch(o.pattern, name, true);
        } else if (!patMatch(o.pattern, name, false)) continue;
      }
      if (o.dirsOnly && !t.isDir) continue;
      kids.push(t);
      if (t.isDir && depth < o.level && (t.node?.type !== 'symlink' || o.follow)) {
        const target = t.node?.type === 'symlink' ? t.target : t.node;
        if (target && ancestors.has(target.ino)) {
          t.error = 'recursive, not followed';
          continue;
        }
        const next = new Set(ancestors);
        if (target) next.add(target.ino);
        t.children = [];
        await this.fill(t, depth + 1, next, unfiltered || matchedDir);
      }
    }
    dir.children = sortNodes(kids, o);
  }
}

/** --prune: drop directories that end up with nothing listed in them (and directory links that were not followed). */
function prune(n: TNode): boolean {
  if (!n.children) return n.node?.type === 'symlink';
  n.children = n.children.filter((c) => !(c.isDir && !c.error && prune(c)));
  return n.children.length === 0;
}

function countNodes(n: TNode, tot: { dirs: number; files: number }): void {
  for (const c of n.children ?? []) {
    if (c.isDir) tot.dirs++;
    else tot.files++;
    countNodes(c, tot);
  }
}

// ---------------------------------------------------------------------------
// Output

interface LineDraw {
  vert: string;
  vertLeft: string;
  corner: string;
}

const UTF8_LINES: LineDraw = { vert: '│  ', vertLeft: '├──', corner: '└──' };
const ASCII_LINES: LineDraw = { vert: '|  ', vertLeft: '|--', corner: '`--' };

function psize(size: number, o: TreeOptions): string {
  if (o.human || o.si) {
    const usize = o.si ? 1000 : 1024;
    const units = o.si ? 'BkMGTPEZY' : 'BKMGTPEZY';
    let idx = size < usize ? 0 : 1;
    let s = size;
    while (s >= usize * usize) {
      idx++;
      s = Math.floor(s / usize);
    }
    if (!idx) return ' ' + String(s).padStart(4);
    const v = s / usize;
    return ' ' + (Math.floor(s / usize) >= 10 ? v.toFixed(0) : v.toFixed(1)).padStart(3) + units[idx];
  }
  return ' ' + String(size).padStart(11);
}

class TreePrinter {
  private readonly ctx: CommandContext;
  private readonly o: TreeOptions;
  private readonly lines: LineDraw;
  private readonly utf8: boolean;
  private readonly colors: ColorDb | null;
  private readonly now: number;
  private chunks: string[] = [];
  private size = 0;
  private readonly sink: (s: string) => Promise<void>;

  constructor(ctx: CommandContext, o: TreeOptions, colors: ColorDb | null, sink: (s: string) => Promise<void>) {
    this.ctx = ctx;
    this.o = o;
    this.colors = colors;
    this.sink = sink;
    const loc = ctx.env.get('LC_ALL') || ctx.env.get('LC_CTYPE') || ctx.env.get('LANG') || '';
    this.utf8 = /utf-?8/i.test(loc);
    const lineUtf8 = o.charset !== null ? /^utf-?8$/i.test(o.charset) : this.utf8;
    this.lines = lineUtf8 ? UTF8_LINES : ASCII_LINES;
    this.now = ctx.system.now();
  }

  async emit(s: string): Promise<void> {
    this.chunks.push(s);
    this.size += s.length;
    if (this.size > 16384) await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.chunks.length) return;
    const s = this.chunks.join('');
    this.chunks = [];
    this.size = 0;
    await this.sink(s);
    await this.ctx.checkpoint();
  }

  /** printit(): non-printable characters as \ooo (or ? with -q), optional "quotes". */
  printable(s: string): string {
    const o = this.o;
    if (o.printable === 'raw') return o.quote ? `"${s}"` : s;
    let out = '';
    if (this.utf8) {
      for (const ch of s) {
        const cp = ch.codePointAt(0)!;
        if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) out += o.printable === 'question' ? '?' : '\\' + cp.toString(8).padStart(3, '0');
        else out += ch;
      }
    } else {
      for (const ch of s) {
        const c = ch.codePointAt(0)!;
        if ((c >= 7 && c <= 13) || ch === '\\' || (ch === '"' && o.quote) || (ch === ' ' && !o.quote)) {
          out += '\\' + (c > 13 ? ch : 'abtnvfr'[c - 7]);
        } else if (c >= 0x20 && c < 0x7f) out += ch;
        else if (o.printable === 'question') out += c > 127 ? ch : '?';
        else out += '\\' + c.toString(8).padStart(3, '0');
      }
    }
    return o.quote ? `"${out}"` : out;
  }

  private paint(text: string, code: string | null): string {
    if (!this.colors || !code) return text;
    return `\x1b[${code}m${text}\x1b[00m`;
  }

  private indicator(node: Inode | null | undefined): string {
    if (!node) return '';
    if (node.type === 'dir') return this.o.dirsOnly ? '' : '/';
    if (node.type === 'symlink') return '@';
    if (node.type === 'file' && node.mode & 0o111) return '*';
    return '';
  }

  /** The name part of a line: colored name, -F indicator, symlink target. */
  nameText(t: TNode): string {
    const o = this.o;
    const db = this.colors;
    let s: string;
    if (t.node?.type === 'symlink') {
      const linkColor = db ? colorFor(db, t.name, t.node, t.target === null ? null : t.target) : null;
      s = this.paint(this.printable(t.label), linkColor);
      s += ' -> ';
      const tcode = db ? (t.target ? colorFor(db, t.linkText ?? '', t.target, undefined) : (db.types.get('mi') ?? db.types.get('or') ?? null)) : null;
      s += this.paint(this.printable(t.linkText ?? ''), tcode);
      if (o.classify && t.target) s += this.indicator(t.target);
      return s;
    }
    const code = db && t.node ? colorFor(db, t.name, t.node, undefined) : null;
    s = this.paint(this.printable(t.label), code);
    if (o.classify) s += this.indicator(t.node);
    return s;
  }

  dateText(t: number): string {
    if (this.o.timefmt !== null) return strftime(this.o.timefmt, t);
    const sixMonths = 6 * 31 * 24 * 3600 * 1000;
    if (t > this.now || t + sixMonths < this.now) return strftime('%b %e  %Y', t);
    return strftime('%b %e %R', t);
  }

  /** fillinfo(): "[drwxr-xr-x learner  4.0K]" or "" when no meta-data was asked for. */
  info(t: TNode): string {
    const o = this.o;
    const n = t.node;
    if (!n) return '';
    const sys = this.ctx.system;
    let buf = '';
    if (o.inode) buf += ' ' + String(n.ino).padStart(7);
    if (o.device) buf += ' ' + String(2049).padStart(3);
    if (o.perms) buf += ' ' + modeString(n);
    if (o.user) buf += ' ' + sys.userName(n.uid).slice(0, 32).padEnd(8);
    if (o.group) buf += ' ' + sys.groupName(n.gid).slice(0, 32).padEnd(8);
    if (o.size) buf += psize(inodeSize(n), o);
    if (o.date) buf += ' ' + this.dateText(o.ctime ? n.ctime : n.mtime);
    if (!buf) return '';
    return '[' + buf.slice(1) + ']';
  }

  private line(prefix: string, t: TNode): string {
    const info = this.info(t);
    const meta = info ? info + '  ' : '';
    const head = this.o.metaFirst ? meta + prefix : prefix + meta;
    return head + this.nameText(t) + (t.error ? `  [${t.error}]` : '') + '\n';
  }

  /** Indentation for an entry at `levels.length` deep; levels[i] is true when that ancestor has later siblings. */
  private indent(levels: boolean[]): string {
    if (this.o.noIndent) return '';
    const d = levels.length;
    if (this.o.ansiLines) {
      if (d === 0) return '';
      let s = '\x1b(0';
      for (let i = 0; i < d; i++) {
        if (i < d - 1) s += levels[i] ? 'x   ' : '    ';
        else s += levels[i] ? 'tqq ' : 'mqq ';
      }
      return s + '\x1b(B';
    }
    let s = '';
    for (let i = 0; i < d; i++) {
      if (i < d - 1) s += (levels[i] ? this.lines.vert : '   ') + ' ';
      else s += (levels[i] ? this.lines.vertLeft : this.lines.corner) + ' ';
    }
    return s;
  }

  async text(root: TNode): Promise<void> {
    await this.emit(this.line('', root));
    await this.children(root, []);
  }

  private async children(dir: TNode, levels: boolean[]): Promise<void> {
    const kids = dir.children ?? [];
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const lv = [...levels, i < kids.length - 1];
      await this.emit(this.line(this.indent(lv), k));
      if (k.children) await this.children(k, lv);
    }
  }

  report(tot: { dirs: number; files: number }): string {
    const d = `${tot.dirs} director${tot.dirs === 1 ? 'y' : 'ies'}`;
    if (this.o.dirsOnly) return `\n${d}\n`;
    return `\n${d}, ${tot.files} file${tot.files === 1 ? '' : 's'}\n`;
  }

  // ----- JSON -----

  private jsonString(s: string): string {
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (ch === '"' || ch === '\\') out += '\\' + ch;
      else if (ch === '\b') out += '\\b';
      else if (ch === '\f') out += '\\f';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (c < 0x20 || c === 0x7f) out += '\\u' + c.toString(16).padStart(4, '0');
      else out += ch;
    }
    return out;
  }

  private jsonInfo(t: TNode): string {
    const o = this.o;
    const n = t.node;
    if (!n) return '';
    const sys = this.ctx.system;
    let s = '';
    if (o.inode) s += `,"inode":${n.ino}`;
    if (o.device) s += `,"dev":2049`;
    if (o.perms) s += `,"mode":"${(n.mode & 0o7777).toString(8).padStart(4, '0')}","prot":"${modeString(n)}"`;
    if (o.user) s += `,"user":"${this.jsonString(sys.userName(n.uid))}"`;
    if (o.group) s += `,"group":"${this.jsonString(sys.groupName(n.gid))}"`;
    if (o.size) s += o.human || o.si ? `,"size":"${psize(inodeSize(n), o).trim()}"` : `,"size":${inodeSize(n)}`;
    if (o.date) s += `,"time":"${this.jsonString(this.dateText(o.ctime ? n.ctime : n.mtime))}"`;
    return s;
  }

  private jsonType(t: TNode): string {
    switch (t.node?.type) {
      case 'dir':
        return 'directory';
      case 'symlink':
        return 'link';
      case 'chardev':
        return 'char';
      case 'file':
        return 'file';
      default:
        return t.isDir ? 'directory' : 'unknown';
    }
  }

  private async jsonEntry(t: TNode, level: number, comma: boolean): Promise<void> {
    const pad = '  '.repeat(level + 1);
    let s = `${pad}{"type":"${this.jsonType(t)}","name":"${this.jsonString(t.label)}"`;
    if (t.node?.type === 'symlink') s += `,"target":"${this.jsonString(t.linkText ?? '')}"`;
    s += this.jsonInfo(t);
    if (t.error) {
      await this.emit(s + `,"contents":[{"error": "${this.jsonString(t.error.replace(/^error /, ''))}"}]}${comma ? ',' : ''}\n`);
      return;
    }
    if (!t.children) {
      await this.emit(s + '}' + (comma ? ',' : '') + '\n');
      return;
    }
    await this.emit(s + ',"contents":[\n');
    for (let i = 0; i < t.children.length; i++) await this.jsonEntry(t.children[i], level + 1, i < t.children.length - 1);
    await this.emit(`${pad}]}${comma ? ',' : ''}\n`);
  }

  async json(roots: TNode[], tot: { dirs: number; files: number }): Promise<void> {
    await this.emit('[\n');
    for (let i = 0; i < roots.length; i++) await this.jsonEntry(roots[i], 0, i < roots.length - 1);
    if (!this.o.noReport) {
      let r = `,\n  {"type":"report","directories":${tot.dirs}`;
      if (!this.o.dirsOnly) r += `,"files":${tot.files}`;
      await this.emit(r + '}\n');
    }
    await this.emit(']\n');
  }
}

// ---------------------------------------------------------------------------
// Command line

const USAGE =
  'usage: tree [-acdfghilnpqrstuvxACDFJNQU] [-L level] [-P pattern] [-I pattern]\n' +
  '\t[-o filename] [--dirsfirst] [--filesfirst] [--noreport] [--inodes]\n' +
  '\t[--device] [--prune] [--si] [--matchdirs] [--ignore-case] [--metafirst]\n' +
  '\t[--charset[=]X] [--filelimit[=]#] [--sort[=]<name>] [--timefmt[=]<f>]\n' +
  '\t[--version] [--help] [--] [directory ...]\n';

const HELP =
  USAGE +
  '  ------- Listing options -------\n' +
  '  -a            All files are listed.\n' +
  '  -d            List directories only.\n' +
  '  -l            Follow symbolic links like directories.\n' +
  '  -f            Print the full path prefix for each file.\n' +
  '  -x            Stay on current filesystem only.\n' +
  '  -L level      Descend only level directories deep.\n' +
  '  -P pattern    List only those files that match the pattern given.\n' +
  '  -I pattern    Do not list files that match the given pattern.\n' +
  '  --ignore-case Ignore case when pattern matching.\n' +
  '  --matchdirs   Include directory names in -P pattern matching.\n' +
  '  --metafirst   Print meta-data at the beginning of each line.\n' +
  '  --prune       Prune empty directories from the output.\n' +
  '  --noreport    Turn off file/directory count at end of tree listing.\n' +
  '  --charset X   Use charset X for terminal/HTML and indentation line output.\n' +
  '  --filelimit # Do not descend dirs with more than # files in them.\n' +
  '  -o filename   Output to file instead of stdout.\n' +
  '  ------- File options -------\n' +
  "  -q            Print non-printable characters as '?'.\n" +
  '  -N            Print non-printable characters as is.\n' +
  '  -Q            Quote filenames with double quotes.\n' +
  '  -p            Print the protections for each file.\n' +
  '  -u            Displays file owner or UID number.\n' +
  '  -g            Displays file group owner or GID number.\n' +
  '  -s            Print the size in bytes of each file.\n' +
  '  -h            Print the size in a more human readable way.\n' +
  '  --si          Like -h, but use in SI units (powers of 1000).\n' +
  '  -D            Print the date of last modification or (-c) status change.\n' +
  '  --timefmt <f> Print and format time according to the format <f>.\n' +
  "  -F            Appends '/', '=', '*', '@', '|' or '>' as per ls -F.\n" +
  '  --inodes      Print inode number of each file.\n' +
  '  --device      Print device ID number to which each file belongs.\n' +
  '  ------- Sorting options -------\n' +
  '  -v            Sort files alphanumerically by version.\n' +
  '  -t            Sort files by last modification time.\n' +
  '  -c            Sort files by last status change time.\n' +
  '  -U            Leave files unsorted.\n' +
  '  -r            Reverse the order of the sort.\n' +
  '  --dirsfirst   List directories before files (-U disables).\n' +
  '  --filesfirst  List files before directories (-U disables).\n' +
  '  --sort X      Select sort: name,version,size,mtime,ctime.\n' +
  '  ------- Graphics options -------\n' +
  "  -i            Don't print indentation lines.\n" +
  '  -A            Print ANSI lines graphic indentation lines.\n' +
  '  -n            Turn colorization off always (-C overrides).\n' +
  '  -C            Turn colorization on always.\n' +
  '  ------- JSON options -------\n' +
  '  -J            Prints out a JSON representation of the tree.\n' +
  '  ------- Miscellaneous options -------\n' +
  '  --version     Print version and exit.\n' +
  '  --help        Print usage and this help message and exit.\n' +
  '  --            Options processing terminator.\n';

const VERSION = 'tree v2.1.1 © 1996 - 2023 by Steve Baker, Thomas Moore, Francesc Rocher, Florian Sesser, Kyosuke Tokoro\n';

class UsageError extends Error {}

function parseArgs(args: string[]): { o: TreeOptions; dirs: string[]; action: 'run' | 'help' | 'version' } {
  const o = defaultOptions();
  const dirs: string[] = [];
  let patternSrc: string | null = null;
  let ignoreSrc: string | null = null;
  let optsDone = false;
  let i = 0;
  const next = (what: string): string => {
    if (i + 1 >= args.length) throw new UsageError(`tree: Missing argument to ${what} option.\n`);
    return args[++i];
  };
  const longArg = (a: string, name: string): string | null => {
    if (a === name) {
      if (i + 1 >= args.length) throw new UsageError(`tree: Missing argument to ${name}\n`);
      return args[++i];
    }
    if (a.startsWith(name + '=')) {
      const v = a.slice(name.length + 1);
      if (!v) throw new UsageError(`tree: Missing argument to ${name}=\n`);
      return v;
    }
    return null;
  };
  for (; i < args.length; i++) {
    const a = args[i];
    if (optsDone || !a.startsWith('-') || a === '-') {
      dirs.push(a);
      continue;
    }
    if (a.startsWith('--')) {
      if (a === '--') {
        optsDone = true;
        continue;
      }
      if (a === '--help') return { o, dirs, action: 'help' };
      if (a === '--version') return { o, dirs, action: 'version' };
      let v: string | null;
      if (a === '--inodes') o.inode = true;
      else if (a === '--device') o.device = true;
      else if (a === '--noreport') o.noReport = true;
      else if (a === '--nolinks') continue;
      else if (a === '--dirsfirst') o.dirsFirst = true;
      else if (a === '--filesfirst') o.filesFirst = true;
      else if (a === '--si') o.si = o.size = true;
      else if (a === '--prune') o.prune = true;
      else if (a === '--ignore-case') o.ignoreCase = true;
      else if (a === '--matchdirs') o.matchDirs = true;
      else if (a === '--metafirst') o.metaFirst = true;
      else if ((v = longArg(a, '--charset')) !== null) o.charset = v;
      else if ((v = longArg(a, '--filelimit')) !== null) o.fileLimit = parseInt(v, 10) || 0;
      else if ((v = longArg(a, '--timefmt')) !== null) {
        o.timefmt = v;
        o.date = true;
      } else if ((v = longArg(a, '--sort')) !== null) {
        const map: Record<string, SortKey> = { name: 'name', version: 'version', size: 'size', mtime: 'mtime', ctime: 'ctime', none: 'none' };
        if (!map[v]) throw new UsageError(`tree: Sort type '${v}' not valid, should be one of: name,version,size,mtime,ctime,none\n`);
        o.sort = map[v];
      } else throw new UsageError(`tree: Invalid argument \`${a}'.\n${USAGE}`);
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      switch (c) {
        case 'a': o.all = true; break;
        case 'd': o.dirsOnly = true; break;
        case 'l': o.follow = true; break;
        case 'f': o.fullPath = true; break;
        case 'x': break;
        case 'L': {
          const v = next('-L');
          const n = /^\s*[+-]?\d+/.test(v) ? parseInt(v, 10) : 0;
          if (n < 1) throw new UsageError('tree: Invalid level, must be greater than 0.\n');
          o.level = n;
          break;
        }
        case 'P': patternSrc = next('-P'); break;
        case 'I': ignoreSrc = next('-I'); break;
        case 'o': o.output = next('-o'); break;
        case 'q': o.printable = 'question'; break;
        case 'N': o.printable = 'raw'; break;
        case 'Q': o.quote = true; break;
        case 'p': o.perms = true; break;
        case 'u': o.user = true; break;
        case 'g': o.group = true; break;
        case 's': o.size = true; break;
        case 'h': o.human = o.size = true; break;
        case 'D': o.date = true; break;
        case 'F': o.classify = true; break;
        case 'v': o.sort = 'version'; break;
        case 't': o.sort = 'mtime'; break;
        case 'c': o.sort = 'ctime'; o.ctime = true; break;
        case 'U': o.sort = 'none'; break;
        case 'r': o.reverse = true; break;
        case 'i': o.noIndent = true; break;
        case 'A': o.ansiLines = true; break;
        case 'n': o.colorOff = true; break;
        case 'C': o.colorOn = true; break;
        case 'J': o.json = true; break;
        default:
          throw new UsageError(`tree: Invalid argument -\`${c}'.\n${USAGE}`);
      }
    }
  }
  if (patternSrc !== null) o.pattern = makePattern(patternSrc, o.ignoreCase);
  if (ignoreSrc !== null) o.ignore = makePattern(ignoreSrc, o.ignoreCase);
  return { o, dirs, action: 'run' };
}

const TREE_DOC: CommandDoc = {
  category: 'navigation',
  summary: 'list contents of directories in a tree-like format',
  synopsis: ['tree [-adfghilnpqrstuvxACDFJNQU] [-L level] [-P pattern] [-I pattern] [-o filename] [--dirsfirst] [--noreport] [directory ...]'],
  description:
    'Tree is a recursive directory listing program that produces a depth indented listing of files. With no arguments, tree lists the files in the current directory. When directory arguments are given, tree lists all the files and/or directories found in the given directories each in turn. Upon completion of listing all files/directories found, tree returns the total number of files and/or directories listed.\n\n' +
    'By default, when a symbolic link is encountered, the path that the symbolic link refers to is printed after the name of the link in the format: name -> real-path. Hidden files (names starting with a dot) are only listed with -a.\n\n' +
    'Output is colorized like ls when the LS_COLORS environment variable is set and the output is a terminal; -C forces colors and -n turns them off.',
  options: [
    { flags: '-a', desc: 'All files are printed. By default tree does not print hidden files (those beginning with a dot).' },
    { flags: '-d', desc: 'List directories only.' },
    { flags: '-f', desc: 'Prints the full path prefix for each file.' },
    { flags: '-i', desc: 'Makes tree not print the indentation lines, useful when used in conjunction with the -f option.' },
    { flags: '-l', desc: 'Follows symbolic links if they point to directories, as if they were directories.' },
    { flags: '-L level', desc: 'Max display depth of the directory tree.' },
    { flags: '-P pattern', desc: "List only those files that match the wild-card pattern. Use | to separate alternatives, e.g. -P '*.txt|*.md'." },
    { flags: '-I pattern', desc: 'Do not list those files that match the wild-card pattern.' },
    { flags: '--prune', desc: 'Makes tree prune empty directories from the output, useful together with -P.' },
    { flags: '--noreport', desc: 'Omits printing of the file and directory report at the end of the tree listing.' },
    { flags: '--dirsfirst', desc: 'List directories before files.' },
    { flags: '-p', desc: 'Print the file type and permissions for each file (as per ls -l).' },
    { flags: '-u', desc: 'Print the username, or UID # if no username is available, of the file.' },
    { flags: '-g', desc: 'Print the group name, or GID # if no group name is available, of the file.' },
    { flags: '-s', desc: 'Print the size of each file in bytes along with the name.' },
    { flags: '-h', desc: 'Print the size of each file but in a more human readable way, e.g. appending a size letter for kilobytes (K), megabytes (M)...' },
    { flags: '-D', desc: 'Print the date of the last modification time for the file listed.' },
    { flags: '-F', desc: "Append a '/' for directories, a '*' for executable files and '@' for symbolic links, as per ls -F." },
    { flags: '-t', desc: 'Sort the output by last modification time instead of alphabetically.' },
    { flags: '-r', desc: 'Sort the output in reverse order.' },
    { flags: '-C', desc: 'Turn colorization on always, using built-in color defaults if LS_COLORS is not set.' },
    { flags: '-n', desc: 'Turn colorization off always (-C overrides).' },
    { flags: '-J', desc: 'Turn on JSON output. Outputs the directory tree as a JSON formatted array.' },
    { flags: '-o filename', desc: 'Send output to filename.' },
  ],
  examples: [
    { cmd: 'tree', desc: 'Show everything below the current directory.' },
    { cmd: 'tree -L 1 /', desc: 'Just the top level of the filesystem.' },
    { cmd: 'tree -d', desc: 'Only folders, no files.' },
    { cmd: "tree -P '*.txt' --prune", desc: 'Only .txt files (and the folders that contain them).' },
    { cmd: 'tree -a -I .cache', desc: 'Include hidden files but skip the .cache folder.' },
    { cmd: 'tree -h -D Documents', desc: 'Show sizes and modification dates too.' },
  ],
  seeAlso: ['ls', 'find', 'du'],
  tip: 'tree is a great way to get a feel for how folders nest inside each other. Use -L 2 to stop it from printing too much.',
};

defineCommand({
  name: 'tree',
  pkg: 'tree',
  size: 85552,
  doc: TREE_DOC,
  gnu: false,
  run: async (ctx) => {
    let parsed;
    try {
      parsed = parseArgs(ctx.args);
    } catch (e) {
      if (e instanceof UsageError) {
        await ctx.err(e.message);
        return 1;
      }
      throw e;
    }
    const { o, dirs, action } = parsed;
    if (action === 'help') {
      await ctx.out(HELP);
      return 0;
    }
    if (action === 'version') {
      await ctx.out(VERSION);
      return 0;
    }
    const roots = dirs.length ? dirs : ['.'];
    const envColors = ctx.env.get('TREE_COLORS') ?? ctx.env.get('LS_COLORS');
    let colorize: boolean;
    if (o.colorOn) colorize = true;
    else if (o.colorOff) colorize = false;
    else colorize = !!envColors && ctx.stdout.isTTY && o.output === null;
    if (o.json) colorize = false;
    const colors = colorize ? parseLsColors(envColors || undefined) : null;

    let fileText = '';
    const sink = o.output !== null ? async (s: string) => void (fileText += s) : (s: string) => ctx.out(s);
    const printer = new TreePrinter(ctx, o, colors, sink);
    const builder = new TreeBuilder(ctx, o);
    const tot = { dirs: 0, files: 0 };
    let status = 0;
    const built: TNode[] = [];
    for (const arg of roots) {
      const r = builder.root(arg);
      if (!r.node) {
        r.error = 'error opening dir';
        status = 2;
      } else if (!r.isDir) {
        r.error = 'error opening dir';
        tot.files++;
      } else {
        const anc = new Set<number>([r.node.ino]);
        r.children = [];
        await builder.fill(r, 1, anc);
        if (r.error) r.children = undefined;
        else if (o.prune) prune(r);
        countNodes(r, tot);
      }
      if (o.json) built.push(r);
      else await printer.text(r);
    }
    if (o.json) await printer.json(built, tot);
    else if (!o.noReport) await printer.emit(printer.report(tot));
    await printer.flush();
    if (o.output !== null) {
      try {
        ctx.fs.writeFile(o.output, fileText);
      } catch {
        await ctx.err(`tree: invalid filename '${o.output}'\n`);
        return 1;
      }
    }
    return status;
  },
});
