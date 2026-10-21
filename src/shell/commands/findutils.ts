// GNU findutils 4.9: find and xargs.

import { compareLocale } from '../collate';
import { matchPattern } from '../glob';
import { FileOutput, NullInput, NullOutput, StringInput, type InputStream, type OutputStream } from '../streams';
import { TtyInput, TtyOutput } from '../tty';
import type { CommandContext } from '../types';
import { FsError, inodeSize, type Inode } from '../vfs/fs';
import { parseMode } from './files';
import { lsDate, modeString } from './ls';
import { RegexError } from './regex';
import { convertPosixRegex } from './sed';
import { parseDateString, strftime } from './sysinfo';
import { MONTHS, DAYS, blocksFor, defineCommand, errText, gnuHelp, pad2, parseOpts, OptError, ql, tzOffset, type CommandDef } from './util';

// ---------------------------------------------------------------------------
// Shared helpers

/** Look a program up the way execvp() would, without running it. */
export function locateProgram(ctx: CommandContext, name: string): { path: string } | { error: string } {
  if (name === '') return { error: 'No such file or directory' };
  const path = name.includes('/') ? name : ctx.which(name);
  if (!path) return { error: 'No such file or directory' };
  const node = ctx.fs.tryStat(path);
  if (!node) return { error: 'No such file or directory' };
  if (node.type === 'dir') return { error: 'Permission denied' };
  if (!ctx.fs.canAccess(node, 1)) return { error: 'Permission denied' };
  return { path };
}

/** Open a file for writing by name, honouring /dev/stdout, /dev/stderr and /dev/null. */
export function openOutput(ctx: CommandContext, name: string, append: boolean): OutputStream {
  if (name === '/dev/stdout') return ctx.stdout;
  if (name === '/dev/stderr') return ctx.stderr;
  const node = ctx.fs.vfs.openForWrite(name, ctx.fs.ctx, { append });
  if (node.type === 'chardev') {
    switch (node.device) {
      case 'stdout':
        return ctx.stdout;
      case 'stderr':
        return ctx.stderr;
      case 'tty':
        return ctx.tty ? new TtyOutput(ctx.tty) : ctx.stdout;
      default:
        return new NullOutput();
    }
  }
  return new FileOutput(ctx.fs.vfs, node, ctx.fs.abs(name));
}

/** Buffered writer so programs can print many small pieces cheaply. */
export class OutBuf {
  private buf = '';
  private readonly stream: OutputStream;
  constructor(stream: OutputStream) {
    this.stream = stream;
  }
  write(s: string): void {
    this.buf += s;
  }
  get size(): number {
    return this.buf.length;
  }
  async flush(): Promise<void> {
    if (this.buf === '') return;
    const b = this.buf;
    this.buf = '';
    await this.stream.write(b);
  }
  async maybeFlush(limit = 16384): Promise<void> {
    if (this.buf.length >= limit) await this.flush();
  }
}

/** The answer to a yes/no question read from a stream (rpmatch). */
async function askYes(stream: InputStream): Promise<boolean> {
  const line = await stream.readLine();
  if (line === null) return false;
  return /^[yY]/.test(line);
}

// ---------------------------------------------------------------------------
// find

class FindUsage extends Error {}

/** Thrown to stop find immediately (-quit, fatal errors). */
class FindQuit extends Error {}

interface Entry {
  /** Path as printed. */
  path: string;
  /** The starting point this entry was found under. */
  start: string;
  depth: number;
  /** Inode used for tests: lstat() normally, stat() when following links. */
  node: Inode;
  /** lstat() result. */
  lnode: Inode;
  /** Directory that contains the entry (for -execdir). */
  dir: string;
  /** Base name as given to -execdir (no trailing slashes). */
  base: string;
}

type Pred = (e: Entry) => boolean | Promise<boolean>;

type Expr =
  | { k: 'and' | 'or' | 'comma'; l: Expr; r: Expr }
  | { k: 'not'; e: Expr }
  | { k: 'pred'; name: string; fn: Pred };

interface ExecSpec {
  name: string;
  argv: string[];
  plus: boolean;
  dir: boolean;
  batch: string[];
  batchDir: string | null;
  batchSize: number;
}

const BATCH_LIMIT = 128 * 1024;

const TYPE_LETTERS = 'bcdpflsD';

function typeLetter(node: Inode): string {
  switch (node.type) {
    case 'dir':
      return 'd';
    case 'symlink':
      return 'l';
    case 'chardev':
      return 'c';
    default:
      return 'f';
  }
}

/** Base name as find's -name sees it ("dir/" -> "dir", "/" -> "/"). */
function findBase(path: string): string {
  const s = path.replace(/\/+$/, '');
  if (s === '') return path.startsWith('/') ? '/' : path;
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

/** gnulib base_name(): last component, keeping trailing slashes. */
function baseNameKeep(path: string): string {
  if (/^\/+$/.test(path)) return '/';
  const m = /([^/]*\/*)$/.exec(path);
  return m ? m[1] : path;
}

function dirOfPath(path: string): string {
  const s = path.replace(/\/+$/, '');
  if (s === '') return '/';
  const i = s.lastIndexOf('/');
  if (i === -1) return '.';
  if (i === 0) return '/';
  return s.slice(0, i);
}

const REGEX_TYPES = ['findutils-default', 'ed', 'emacs', 'gnu-awk', 'grep', 'posix-awk', 'awk', 'posix-basic', 'posix-egrep', 'egrep', 'posix-extended', 'posix-minimal-basic', 'sed'];

function compileFindRegex(src: string, type: string, nocase: boolean): RegExp {
  let js: string;
  try {
    if (type === 'findutils-default' || type === 'emacs') js = convertPosixRegex(src, { extended: false, dialect: 'emacs' }).source;
    else if (['ed', 'grep', 'posix-basic', 'posix-minimal-basic', 'sed'].includes(type)) js = convertPosixRegex(src, { extended: false, dialect: 'sed' }).source;
    else js = convertPosixRegex(src, { extended: true, dialect: 'sed', rparenOrd: type === 'posix-extended' || type.includes('awk') }).source;
    return new RegExp('^(?:' + js + ')$', 's' + (nocase ? 'i' : ''));
  } catch (e) {
    const msg = e instanceof Error ? e.message.replace(/^Invalid regular expression: .*/, 'Invalid regular expression') : String(e);
    throw new RegexError(`failed to compile regular expression '${src}': ${msg}`);
  }
}

/** Parse "+N", "-N" or "N". */
function parseNumArg(s: string, allowFloat: boolean): { cmp: -1 | 0 | 1; n: number } | null {
  let cmp: -1 | 0 | 1 = 0;
  let t = s;
  if (t.startsWith('+')) {
    cmp = 1;
    t = t.slice(1);
  } else if (t.startsWith('-')) {
    cmp = -1;
    t = t.slice(1);
  }
  const re = allowFloat ? /^(\d+(\.\d*)?|\.\d+)$/ : /^\d+$/;
  if (!re.test(t)) return null;
  return { cmp, n: Number(t) };
}

function cmpNum(v: number, a: { cmp: -1 | 0 | 1; n: number }): boolean {
  return a.cmp === 1 ? v > a.n : a.cmp === -1 ? v < a.n : v === a.n;
}

/** Fake nanoseconds, matching what `stat` prints for the same file. */
function nanos(t: number): string {
  return String(((t % 1000) + 1000) % 1000 * 1000000 + 427611).padStart(9, '0').slice(0, 9);
}

/** ctime(3)-style time with fractional seconds, as find's %t prints it. */
function findCtime(t: number): string {
  const d = new Date(t);
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${nanos(t)}0 ${d.getFullYear()}`;
}

function timeDirective(c: string, t: number): string {
  const d = new Date(t);
  switch (c) {
    case '@':
      return `${Math.floor(t / 1000)}.${nanos(t)}0`;
    case 'S':
      return `${pad2(d.getSeconds())}.${nanos(t)}0`;
    case 'T':
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${nanos(t)}0`;
    case '+':
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}+${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${nanos(t)}0`;
    case 'c':
      return strftime('%a %d %b %Y %I:%M:%S %p %Z', t);
    case 'z':
      return tzOffset(d);
    default:
      if (c === '%') return '%';
      if ('aAbBdDeFgGhHIjklmMnprRstuUVwWxXyYZ'.includes(c)) {
        if (c === 'x') return strftime('%m/%d/%y', t);
        if (c === 'X') return strftime('%H:%M:%S', t);
        if (c === 'U' || c === 'W') {
          const start = new Date(d.getFullYear(), 0, 1).getTime();
          const yday = Math.floor((t - start) / 86400000);
          const wd = d.getDay();
          const v = c === 'U' ? Math.floor((yday + 7 - wd) / 7) : Math.floor((yday + 7 - ((wd + 6) % 7)) / 7);
          return pad2(v);
        }
        return strftime('%' + c, t);
      }
      return '%' + c;
  }
}

/** Process the escapes find accepts in -printf formats. */
interface FmtPiece {
  lit?: string;
  dir?: string;
  flags?: string;
  stop?: boolean;
}

async function compileFormat(ctx: CommandContext, fmt: string): Promise<FmtPiece[]> {
  const pieces: FmtPiece[] = [];
  let lit = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === '\\') {
      const n = fmt[i + 1];
      if (n === undefined) {
        lit += '\\';
        break;
      }
      i++;
      const simple: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
      if (n in simple) lit += simple[n];
      else if (n === 'c') {
        if (lit) pieces.push({ lit });
        lit = '';
        pieces.push({ stop: true });
      } else if (/[0-7]/.test(n)) {
        const m = /^[0-7]{1,3}/.exec(fmt.slice(i))!;
        lit += String.fromCharCode(parseInt(m[0], 8) & 255);
        i += m[0].length - 1;
      } else {
        await ctx.error(`warning: unrecognized escape \`\\${n}'`);
        lit += '\\' + n;
      }
      continue;
    }
    if (c === '%') {
      if (i + 1 >= fmt.length) throw new FindUsage('error: % at end of format string');
      if (fmt[i + 1] === '%') {
        lit += '%';
        i++;
        continue;
      }
      const m = /^%([-+ #0]*)(\d*)(?:\.(\d*))?/.exec(fmt.slice(i))!;
      let j = i + m[0].length;
      const flags = m[0].slice(1);
      const d = fmt[j];
      if (d === undefined) throw new FindUsage('error: % at end of format string');
      let dir = d;
      if (d === 'A' || d === 'C' || d === 'T') {
        const k = fmt[j + 1];
        if (k === undefined) throw new FindUsage(`error: format directive \`%${d}' requires a following letter`);
        dir = d + k;
        j++;
      } else if (!'abcdDfFgGhHiklmMnpPsStuUyYZ'.includes(d)) {
        await ctx.error(`warning: unrecognized format directive \`%${d}'`);
        lit += '%' + d;
        i = j;
        continue;
      }
      if (lit) pieces.push({ lit });
      lit = '';
      pieces.push({ dir, flags });
      i = j;
      continue;
    }
    lit += c;
  }
  if (lit) pieces.push({ lit });
  return pieces;
}

function padField(s: string, flags: string): string {
  const m = /^([-+ #0]*)(\d*)(?:\.(\d*))?$/.exec(flags);
  if (!m) return s;
  let v = s;
  if (m[3] !== undefined) v = v.slice(0, m[3] === '' ? 0 : parseInt(m[3], 10));
  const width = m[2] ? parseInt(m[2], 10) : 0;
  if (v.length >= width) return v;
  return m[1].includes('-') ? v.padEnd(width) : v.padStart(width);
}

function lsLine(ctx: CommandContext, e: Entry, now: number): string {
  const n = e.lnode;
  const blocks = n.type === 'dir' ? 4 : n.type === 'file' ? blocksFor(inodeSize(n)) : 0;
  const user = ctx.system.userName(n.uid);
  const group = ctx.system.groupName(n.gid);
  const size = n.type === 'chardev' ? '  1,   3' : String(inodeSize(n));
  let line = `${String(n.ino).padStart(9)} ${String(blocks).padStart(6)} ${modeString(n)} ${String(n.nlink).padStart(3)} ${user.padEnd(8)} ${group.padEnd(8)} ${size.padStart(8)} ${lsDate(n.mtime, now)} ${e.path}`;
  if (n.type === 'symlink') line += ` -> ${n.target}`;
  return line + '\n';
}

const FIND_DOC: CommandDef['doc'] = {
  category: 'search',
  summary: 'search for files in a directory hierarchy',
  synopsis: ['find [-H] [-L] [-P] [-Olevel] [-D debugopts] [path...] [expression]'],
  description:
    'find searches the directory tree rooted at each given starting-point by evaluating the given expression from left to right for each file it finds. With no starting-point, find searches the current directory (.). With no expression it prints every name it finds.\n\n' +
    'The expression is made of tests (such as -name or -type), actions (such as -print or -delete) and operators. Tests and actions next to each other are joined by an implied -and, so "find . -name \'*.txt\' -type f" means "named *.txt AND a regular file". Use -o for "or", ! for "not" and \\( \\) to group (the backslashes stop the shell from treating the parentheses specially).\n\n' +
    'Numeric arguments can be written as +N (more than N), -N (less than N) or N (exactly N). Sizes take a unit suffix: c (bytes), k (kibibytes), M (mebibytes) or G (gibibytes); without one the unit is 512-byte blocks. If the expression has no action other than -prune, -print is applied to every file for which the expression is true.\n\n' +
    'Always quote patterns such as \'*.txt\'. Otherwise the shell expands them before find runs, and find either searches for the wrong name or complains that "paths must precede expression".',
  options: [
    { flags: '-name PATTERN', desc: 'base of the file name matches the shell PATTERN (*, ?, [...])' },
    { flags: '-iname PATTERN', desc: 'like -name, but ignoring upper/lower case' },
    { flags: '-path PATTERN', desc: 'whole path (as printed) matches PATTERN; * also matches /' },
    { flags: '-regex REGEX', desc: 'whole path matches the regular expression (see -regextype)' },
    { flags: '-type C', desc: 'file is of type C: f regular file, d directory, l symbolic link, c character device (several can be given: -type f,d)' },
    { flags: '-size [+-]N[ckMG]', desc: 'file uses N units of space, rounding up (for example -size +1M)' },
    { flags: '-mtime [+-]N', desc: 'contents were last modified N*24 hours ago (also -atime, -ctime)' },
    { flags: '-mmin [+-]N', desc: 'contents were last modified N minutes ago (also -amin, -cmin)' },
    { flags: '-newer FILE', desc: 'modified more recently than FILE' },
    { flags: '-perm MODE', desc: 'permission bits are exactly MODE; -MODE: all of these bits are set; /MODE: any of them is set' },
    { flags: '-user NAME, -group NAME', desc: 'file is owned by user (or group) NAME' },
    { flags: '-empty', desc: 'file is an empty regular file or an empty directory' },
    { flags: '-readable, -writable, -executable', desc: 'you have permission to read/write/execute the file' },
    { flags: '-maxdepth N, -mindepth N', desc: 'descend at most N levels / ignore files above level N' },
    { flags: '! EXPR, -not EXPR', desc: 'true if EXPR is false' },
    { flags: 'EXPR1 -o EXPR2', desc: 'or: EXPR2 is not evaluated if EXPR1 is true (also -or)' },
    { flags: 'EXPR1 -a EXPR2', desc: 'and (the default when two tests are next to each other)' },
    { flags: '-print, -print0', desc: 'print the full file name followed by a newline (or a NUL character)' },
    { flags: '-printf FORMAT', desc: 'print using FORMAT: %p path, %f name, %s size, %m mode, %u owner, %t time, %d depth, \\n newline' },
    { flags: '-ls', desc: 'list the file in ls -dils format' },
    { flags: '-delete', desc: 'delete the file (be careful: put it last, after your tests)' },
    { flags: '-exec CMD {} ;', desc: 'run CMD for each file; {} is replaced by the file name and the command ends with \\;' },
    { flags: '-exec CMD {} +', desc: 'run CMD once with many file names at the end' },
    { flags: '-ok CMD {} ;', desc: 'like -exec but ask first' },
    { flags: '-prune', desc: 'do not descend into this directory' },
    { flags: '-quit', desc: 'exit immediately' },
  ],
  examples: [
    { cmd: "find . -name '*.txt'", desc: 'Find every .txt file under the current directory.' },
    { cmd: "find ~ -iname 'notes*'", desc: 'Find files starting with "notes" in any letter case.' },
    { cmd: 'find . -type d', desc: 'List only directories.' },
    { cmd: 'find . -type f -size +1M', desc: 'Find files bigger than 1 MiB.' },
    { cmd: 'find . -mtime -1', desc: 'Files changed in the last 24 hours.' },
    { cmd: "find . -name '*.log' -exec rm {} \\;", desc: 'Delete every .log file (run it with -print first to check!).' },
    { cmd: "find /var/log -name '*.log' 2>/dev/null", desc: 'Search somewhere you cannot fully read, hiding "Permission denied" errors.' },
    { cmd: "find . -name '*.txt' | xargs wc -l", desc: 'Count the lines of every .txt file.' },
  ],
  seeAlso: ['xargs', 'locate', 'ls', 'grep'],
  tip: "Quote your patterns: find . -name '*.txt'. Without quotes the shell expands *.txt first, so find only sees the names that happen to be in the current directory.",
};

const FIND_VERSION =
  'find (GNU findutils) 4.9.0\nCopyright (C) 2022 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by Eric B. Decker, James Youngman, and Kevin Dalley.\nFeatures enabled: D_TYPE O_NOFOLLOW(enabled) LEAF_OPTIMISATION FTS(FTS_CWDFD) CBO(level=2)\n';

const BINARY_OPS = new Set(['-o', '-or', '-a', '-and', ',']);

function looksLikeExpression(arg: string, leading: boolean): boolean {
  const c = arg[0];
  if (c === '-') return arg.length > 1;
  if (c === ')' || c === ',') return arg.length > 1 ? false : !leading;
  if (c === '(' || c === '!') return arg.length === 1;
  return false;
}

async function findMain(ctx: CommandContext, def: CommandDef): Promise<number> {
  const args = ctx.args;
  const fs = ctx.fs;
  const out = new OutBuf(ctx.stdout);
  let status = 0;
  const err = async (msg: string) => {
    await out.flush();
    await ctx.error(msg);
  };

  // --- leading options -H -L -P -D -O
  let follow: 'P' | 'L' | 'H' = 'P';
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-H' || a === '-L' || a === '-P') {
      follow = a[1] as 'P' | 'L' | 'H';
      i++;
    } else if (a === '-D') {
      i += 2;
    } else if (/^-O\d*$/.test(a)) {
      i++;
    } else if (a === '--') {
      i++;
      break;
    } else break;
  }
  if (args[i] === '--help' || args[i] === '-help') {
    await ctx.out(gnuHelp(def));
    return 0;
  }
  if (args[i] === '--version' || args[i] === '-version') {
    await ctx.out(FIND_VERSION);
    return 0;
  }
  const paths: string[] = [];
  while (i < args.length && !looksLikeExpression(args[i], true)) paths.push(args[i++]);
  const exprArgs = args.slice(i);

  // --- global state set by options
  const startTime = ctx.system.now();
  let maxdepth = Infinity;
  let mindepth = 0;
  let depthFirst = false;
  let explicitDepth = false;
  let warn = ctx.stdin.isTTY;
  let regexType = 'findutils-default';
  let curDayStart = startTime - 86400000;
  let hasAction = false;
  let hasDelete = false;
  let hasPrune = false;
  const execs: ExecSpec[] = [];
  let seenNonOption = false;
  let lastPred = '';
  let lastNonOption = '';
  const fileOutputs = new Map<string, OutBuf>();

  const getFileOut = (name: string): OutBuf => {
    let o = fileOutputs.get(name);
    if (!o) {
      try {
        o = new OutBuf(openOutput(ctx, name, false));
      } catch (e) {
        throw new FindUsage(`${ql(name)}: ${errText(e)}`);
      }
      fileOutputs.set(name, o);
    }
    return o;
  };

  const userId = (s: string, kind: 'user' | 'group'): number => {
    if (kind === 'user') {
      const u = ctx.system.userByName(s);
      if (u) return u.uid;
      if (/^\d+$/.test(s)) return parseInt(s, 10);
      throw new FindUsage(`${ql(s)} is not the name of a known user`);
    }
    const g = ctx.system.groupByName(s);
    if (g) return g.gid;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    throw new FindUsage(`${ql(s)} is not the name of an existing group`);
  };

  const statRef = (name: string): Inode => {
    const node = follow === 'P' ? fs.tryStat(name, false) : fs.tryStat(name, true) ?? fs.tryStat(name, false);
    if (!node) {
      let reason = 'No such file or directory';
      try {
        fs.lstat(name);
      } catch (e) {
        reason = errText(e);
      }
      throw new FindUsage(`${ql(name)}: ${reason}`);
    }
    return node;
  };

  /** -mtime style tests (days). */
  const timeTest = (name: string, arg: string, field: 'atime' | 'mtime' | 'ctime', minutes: boolean): Pred => {
    const v = parseNumArg(arg, true);
    if (!v) throw new FindUsage(`invalid argument \`${arg}' to \`${name}'`);
    const unit = minutes ? 60000 : 86400000;
    let origin = minutes ? curDayStart + 86400000 : curDayStart;
    if (!minutes && v.cmp === -1) origin += 86400000 - 1000;
    const ref = origin - v.n * unit;
    const window = unit;
    return (e) => {
      const delta = e.node[field] - ref;
      if (v.cmp === 1) return delta < 0;
      if (v.cmp === -1) return delta > 0;
      return delta > 0 && delta <= window;
    };
  };

  // --- expression parser
  let pos = 0;
  const peek = () => exprArgs[pos];
  const fail = (msg: string): never => {
    throw new FindUsage(msg);
  };
  const needArg = (name: string): string => {
    if (pos >= exprArgs.length) fail(`missing argument to \`${name}'`);
    return exprArgs[pos++];
  };
  const globalWarn = async (name: string) => {
    if (warn && seenNonOption) {
      await ctx.error(
        `warning: you have specified the global option ${name} after the argument ${lastNonOption}, but global options are not positional, i.e., ${name} affects tests specified before it as well as those specified after it.  Please specify global options before other arguments.`,
      );
    }
  };
  const T: Pred = () => true;

  const parsePredicate = async (tok: string): Promise<Expr> => {
    const name = tok;
    const mk = (fn: Pred): Expr => ({ k: 'pred', name, fn });
    const p = name.startsWith('--') ? name.slice(1) : name;
    switch (p) {
      // ---- options (always true)
      case '-maxdepth':
      case '-mindepth': {
        const a = needArg(name);
        if (!/^\d+$/.test(a)) fail(`Expected a positive decimal integer argument to ${name}, but got ${ql(a)}`);
        await globalWarn(name);
        if (p === '-maxdepth') maxdepth = parseInt(a, 10);
        else mindepth = parseInt(a, 10);
        return mk(T);
      }
      case '-depth':
      case '-d':
        await globalWarn(name);
        depthFirst = true;
        explicitDepth = true;
        return mk(T);
      case '-xdev':
      case '-mount':
      case '-noleaf':
      case '-ignore_readdir_race':
      case '-noignore_readdir_race':
        await globalWarn(name);
        return mk(T);
      case '-follow':
        follow = 'L';
        return mk(T);
      case '-daystart': {
        const d = new Date(startTime);
        curDayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        return mk(T);
      }
      case '-warn':
        warn = true;
        return mk(T);
      case '-nowarn':
        warn = false;
        return mk(T);
      case '-regextype': {
        const a = needArg(name);
        if (!REGEX_TYPES.includes(a)) fail(`Unknown regular expression type ${ql(a)}; valid types are ${REGEX_TYPES.map((r) => ql(r)).join(', ')}.`);
        regexType = a;
        return mk(T);
      }
      case '-help':
        await out.flush();
        await ctx.out(gnuHelp(def));
        throw new FindQuit('help');
      case '-version':
        await out.flush();
        await ctx.out(FIND_VERSION);
        throw new FindQuit('help');
      // ---- tests
      case '-true':
        return mk(T);
      case '-false':
        return mk(() => false);
      case '-name':
      case '-iname': {
        const pat = needArg(name);
        if (warn && pat.includes('/')) {
          await ctx.error(
            `warning: ${ql(name)} matches against basenames only, but the given pattern contains a directory separator (${ql('/')}), thus the expression will evaluate to false all the time.  Did you mean ${ql(p === '-iname' ? '-iwholename' : '-wholename')}?`,
          );
        }
        const nocase = p === '-iname';
        return mk((e) => matchPattern(pat, findBase(e.path), { nocase }));
      }
      case '-path':
      case '-wholename':
      case '-ipath':
      case '-iwholename': {
        const pat = needArg(name);
        const nocase = p.startsWith('-i');
        return mk((e) => matchPattern(pat, e.path, { nocase }));
      }
      case '-lname':
      case '-ilname': {
        const pat = needArg(name);
        const nocase = p === '-ilname';
        return mk((e) => e.lnode.type === 'symlink' && matchPattern(pat, e.lnode.target, { nocase }));
      }
      case '-regex':
      case '-iregex': {
        const src = needArg(name);
        let re: RegExp;
        try {
          re = compileFindRegex(src, regexType, p === '-iregex');
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
          throw e;
        }
        return mk((e) => re.test(e.path));
      }
      case '-type':
      case '-xtype': {
        const a = needArg(name);
        if (a === '') fail('Arguments to -type should contain at least one letter');
        const set = new Set<string>();
        for (let k = 0; k < a.length; k++) {
          const c = a[k];
          if (!TYPE_LETTERS.includes(c)) fail(`Unknown argument to ${p}: ${c}`);
          if (set.has(c)) fail(`Duplicate file type '${c}' in the argument list to ${p}.`);
          set.add(c);
          if (k + 1 < a.length) {
            if (a[k + 1] !== ',') fail(`Must separate multiple arguments to ${p} using: ','`);
            k++;
            if (k + 1 >= a.length) fail(`Last file type in list argument to ${p} is missing, i.e., list is ending on: ','`);
          }
        }
        if (p === '-type') return mk((e) => set.has(typeLetter(e.node)));
        return mk((e) => {
          let n: Inode | null;
          if (follow === 'L') n = e.lnode;
          else n = e.lnode.type === 'symlink' ? fs.tryStat(e.path, true) ?? e.lnode : e.lnode;
          return set.has(typeLetter(n));
        });
      }
      case '-size': {
        const a = needArg(name);
        const m = /^([+-]?)(\d+)(.?)$/.exec(a);
        if (!m) {
          if (/^[+-]?\d+/.test(a)) fail(`invalid -size type \`${a.replace(/^[+-]?\d+/, '')[0]}'`);
          fail(`Invalid argument \`${a}' to -size`);
        }
        const units: Record<string, number> = { '': 512, b: 512, c: 1, w: 2, k: 1024, M: 1048576, G: 1073741824 };
        const unit = units[m![3]];
        if (unit === undefined) fail(`invalid -size type \`${m![3]}'`);
        const cmp = m![1] === '+' ? 1 : m![1] === '-' ? -1 : 0;
        const n = parseInt(m![2], 10);
        return mk((e) => {
          const size = inodeSize(e.node);
          const units = Math.ceil(size / unit);
          return cmp === 1 ? units > n : cmp === -1 ? units < n : units === n;
        });
      }
      case '-empty':
        return mk((e) => {
          if (e.node.type === 'dir') return e.node.entries.size === 0;
          if (e.node.type === 'file') return inodeSize(e.node) === 0;
          return false;
        });
      case '-perm': {
        const a = needArg(name);
        let kind: 'exact' | 'all' | 'any' = 'exact';
        let spec = a;
        if (a.startsWith('-')) {
          kind = 'all';
          spec = a.slice(1);
        } else if (a.startsWith('/')) {
          kind = 'any';
          spec = a.slice(1);
        }
        const mode = spec === '' ? null : parseMode(spec, 0, 0, false);
        if (mode === null || (a[0] === '+' && /[0-7]/.test(a[1] ?? ''))) fail(`invalid mode ${ql(a)}`);
        const bits = mode! & 0o7777;
        return mk((e) => {
          const m2 = e.node.mode & 0o7777;
          if (kind === 'exact') return m2 === bits;
          if (kind === 'all') return (m2 & bits) === bits;
          return bits === 0 || (m2 & bits) !== 0;
        });
      }
      case '-user': {
        const uid = userId(needArg(name), 'user');
        return mk((e) => e.node.uid === uid);
      }
      case '-group': {
        const gid = userId(needArg(name), 'group');
        return mk((e) => e.node.gid === gid);
      }
      case '-uid':
      case '-gid':
      case '-links':
      case '-inum': {
        const a = needArg(name);
        const v = parseNumArg(a, false);
        if (!v) fail(`invalid argument \`${a}' to \`${name}'`);
        const field = p === '-uid' ? 'uid' : p === '-gid' ? 'gid' : p === '-links' ? 'nlink' : 'ino';
        return mk((e) => cmpNum(e.node[field], v!));
      }
      case '-nouser':
        return mk((e) => !ctx.system.userByUid(e.node.uid));
      case '-nogroup':
        return mk((e) => !ctx.system.groupByGid(e.node.gid));
      case '-readable':
        return mk((e) => {
          const n = e.lnode.type === 'symlink' ? fs.tryStat(e.path, true) : e.node;
          return !!n && fs.canAccess(n, 4);
        });
      case '-writable':
        return mk((e) => {
          const n = e.lnode.type === 'symlink' ? fs.tryStat(e.path, true) : e.node;
          return !!n && fs.canAccess(n, 2);
        });
      case '-executable':
        return mk((e) => {
          const n = e.lnode.type === 'symlink' ? fs.tryStat(e.path, true) : e.node;
          return !!n && fs.canAccess(n, 1);
        });
      case '-mtime':
      case '-atime':
      case '-ctime':
        return mk(timeTest(name, needArg(name), (p.slice(1, 2) + 'time') as 'atime' | 'mtime' | 'ctime', false));
      case '-mmin':
      case '-amin':
      case '-cmin':
        return mk(timeTest(name, needArg(name), (p.slice(1, 2) + 'time') as 'atime' | 'mtime' | 'ctime', true));
      case '-newer':
      case '-anewer':
      case '-cnewer': {
        const ref = statRef(needArg(name)).mtime;
        const field = p === '-newer' ? 'mtime' : p === '-anewer' ? 'atime' : 'ctime';
        return mk((e) => e.node[field] > ref);
      }
      case '-samefile': {
        const ref = statRef(needArg(name));
        return mk((e) => e.node === ref || e.lnode === ref);
      }
      default:
        break;
    }
    if (/^-newer[aBcm][aBcmt]$/.test(p)) {
      const a = needArg(name);
      const x = p[6];
      const y = p[7];
      let ref: number;
      if (y === 't') {
        const t = parseDateString(a, startTime);
        if (t === null) fail(`I cannot figure out how to interpret ${ql(a)} as a date or time`);
        ref = t!;
      } else {
        const n = statRef(a);
        ref = y === 'a' ? n.atime : y === 'm' ? n.mtime : n.ctime;
      }
      const field = x === 'a' ? 'atime' : x === 'm' ? 'mtime' : 'ctime';
      return mk((e) => e.node[field] > ref);
    }
    // ---- actions
    switch (p) {
      case '-print':
        hasAction = true;
        return mk((e) => {
          out.write(e.path + '\n');
          return true;
        });
      case '-print0':
        hasAction = true;
        return mk((e) => {
          out.write(e.path + '\0');
          return true;
        });
      case '-fprint':
      case '-fprint0': {
        hasAction = true;
        const o = getFileOut(needArg(name));
        const end = p === '-fprint' ? '\n' : '\0';
        return mk((e) => {
          o.write(e.path + end);
          return true;
        });
      }
      case '-ls':
        hasAction = true;
        return mk((e) => {
          out.write(lsLine(ctx, e, startTime));
          return true;
        });
      case '-fls': {
        hasAction = true;
        const o = getFileOut(needArg(name));
        return mk((e) => {
          o.write(lsLine(ctx, e, startTime));
          return true;
        });
      }
      case '-printf':
      case '-fprintf': {
        hasAction = true;
        const o = p === '-fprintf' ? getFileOut(needArg(name)) : out;
        const fmt = await compileFormat(ctx, needArg(name));
        return mk((e) => {
          o.write(formatEntry(ctx, e, fmt));
          return true;
        });
      }
      case '-delete':
        hasAction = true;
        hasDelete = true;
        depthFirst = true;
        return mk((e) => {
          if (e.path === '.') return true;
          try {
            if (e.lnode.type === 'dir') fs.rmdir(e.path);
            else fs.unlink(e.path);
            return true;
          } catch (ex) {
            return err(`cannot delete ${ql(e.path)}: ${errText(ex)}`).then(() => {
              status = 1;
              return false;
            });
          }
        });
      case '-prune':
        hasPrune = true;
        return mk((e) => {
          if (!depthFirst && e.node.type === 'dir') pruned = true;
          return true;
        });
      case '-quit':
        return mk(() => {
          throw new FindQuit('quit');
        });
      case '-exec':
      case '-execdir':
      case '-ok':
      case '-okdir': {
        hasAction = true;
        const allowPlus = p === '-exec' || p === '-execdir';
        const start = pos;
        let end = pos;
        let plus = false;
        let prevBraces = false;
        let braceArg: string | null = null;
        let numBraces = 0;
        for (; end < exprArgs.length; end++) {
          const a = exprArgs[end];
          if (a === ';') break;
          if (a === '+' && allowPlus) {
            if (prevBraces) {
              plus = true;
              break;
            }
            if (braceArg !== null && braceArg !== '{}') {
              fail(`In ${ql(`${p} ... {} +`)} the ${ql('{}')} must appear by itself, but you specified ${ql(braceArg)}`);
            }
          }
          prevBraces = a === '{}';
          if (a.includes('{}')) {
            numBraces++;
            if (braceArg === null || a !== '{}') braceArg = a;
          }
        }
        if (end >= exprArgs.length) fail(`missing argument to \`${name}'`);
        if (end === start) fail(`invalid argument \`${exprArgs[end]}' to \`${name}'`);
        const argv = exprArgs.slice(start, plus ? end - 1 : end);
        pos = end + 1;
        if (plus && numBraces > 1) fail(`Only one instance of {} is supported with ${p} ... +`);
        const spec: ExecSpec = { name: p, argv, plus, dir: p.endsWith('dir'), batch: [], batchDir: null, batchSize: 0 };
        execs.push(spec);
        if (plus) {
          return mk(async (e) => {
            const arg = spec.dir ? './' + e.base : e.path;
            if (spec.dir && spec.batchDir !== null && spec.batchDir !== e.dir) await runBatch(spec);
            if (spec.batchSize + arg.length + 1 > BATCH_LIMIT) await runBatch(spec);
            spec.batch.push(arg);
            spec.batchDir = e.dir;
            spec.batchSize += arg.length + 1;
            return true;
          });
        }
        const ask = p.startsWith('-ok');
        return mk(async (e) => {
          const target = spec.dir ? './' + e.base : e.path;
          const cmd = argv.map((a) => a.split('{}').join(target));
          if (ask) {
            await out.flush();
            await ctx.err(`< ${argv[0]} ... ${e.path} > ? `);
            if (!(await askYes(ctx.stdin))) return false;
          }
          const st = await runCommand(cmd, spec.dir ? e.dir : null, ask);
          return st === 0;
        });
      }
      default:
        break;
    }
    if (looksLikeExpression(tok, false) || tok.startsWith('-')) fail(`unknown predicate \`${tok}'`);
    return fail(`paths must precede expression: \`${tok}'`);
  };

  let pruned = false;

  const runCommand = async (argv: string[], dir: string | null, nullStdin: boolean): Promise<number> => {
    await out.flush();
    for (const o of fileOutputs.values()) await o.flush();
    const loc = locateProgram(ctx, argv[0]);
    if ('error' in loc) {
      await ctx.error(`${ql(argv[0])}: ${loc.error}`);
      return loc.error.startsWith('No such') ? 127 : 126;
    }
    const cwd = dir === null ? undefined : fs.abs(dir);
    return ctx.exec(argv, { cwd, stdin: nullStdin ? new NullInput() : undefined });
  };

  const runBatch = async (spec: ExecSpec): Promise<void> => {
    if (spec.batch.length === 0) return;
    const argv = [...spec.argv, ...spec.batch];
    const dir = spec.dir ? spec.batchDir : null;
    spec.batch = [];
    spec.batchSize = 0;
    const st = await runCommand(argv, dir, false);
    if (st !== 0) status = 1;
  };

  const parseUnary = async (): Promise<Expr> => {
    const tok = peek();
    if (tok === '!' || tok === '-not') {
      pos++;
      lastPred = tok;
      seenNonOption = true;
      if (pos >= exprArgs.length) fail(`expected an expression after '${tok}'`);
      if (peek() === ')') fail(`expected an expression between '${tok}' and ')'`);
      return { k: 'not', e: await parseUnary() };
    }
    return parsePrimary();
  };

  const parsePrimary = async (): Promise<Expr> => {
    const tok = peek();
    if (tok === '(') {
      pos++;
      lastPred = '(';
      if (peek() === ')') fail('invalid expression; empty parentheses are not allowed.');
      if (pos >= exprArgs.length) fail("invalid expression; I was expecting to find a ')' somewhere but did not see one.");
      const e = await parseList();
      if (peek() !== ')') fail("invalid expression; I was expecting to find a ')' somewhere but did not see one.");
      pos++;
      lastPred = ')';
      return e;
    }
    if (BINARY_OPS.has(tok)) fail(`invalid expression; you have used a binary operator '${tok}' with nothing before it.`);
    if (tok === ')') fail("you have too many ')'");
    if (!looksLikeExpression(tok, false)) {
      const hint = fs.tryStat(tok, true) !== null;
      await err(`paths must precede expression: \`${tok}'`);
      if (hint && lastPred) await ctx.error(`possible unquoted pattern after predicate \`${lastPred}'?`);
      throw new FindQuit('usage');
    }
    pos++;
    const isOption = ['-maxdepth', '-mindepth', '-depth', '-d', '-xdev', '-mount', '-noleaf', '-follow', '-daystart', '-warn', '-nowarn', '-regextype', '-ignore_readdir_race', '-noignore_readdir_race'].includes(tok);
    const e = await parsePredicate(tok);
    if (!isOption) {
      seenNonOption = true;
      lastNonOption = tok;
    }
    lastPred = tok;
    return e;
  };

  const parseAnd = async (): Promise<Expr> => {
    let left = await parseUnary();
    for (;;) {
      const tok = peek();
      if (tok === undefined || tok === ')' || tok === '-o' || tok === '-or' || tok === ',') return left;
      if (tok === '-a' || tok === '-and') {
        pos++;
        lastPred = tok;
        if (pos >= exprArgs.length) fail(`expected an expression after '${tok}'`);
        if (peek() === ')') fail(`expected an expression between '${tok}' and ')'`);
      }
      const right = await parseUnary();
      left = { k: 'and', l: left, r: right };
    }
  };

  const parseOr = async (): Promise<Expr> => {
    let left = await parseAnd();
    while (peek() === '-o' || peek() === '-or') {
      const tok = exprArgs[pos++];
      lastPred = tok;
      if (pos >= exprArgs.length) fail(`expected an expression after '${tok}'`);
      if (peek() === ')') fail(`expected an expression between '${tok}' and ')'`);
      left = { k: 'or', l: left, r: await parseAnd() };
    }
    return left;
  };

  const parseList = async (): Promise<Expr> => {
    let left = await parseOr();
    while (peek() === ',') {
      pos++;
      lastPred = ',';
      if (pos >= exprArgs.length) fail(`expected an expression after ','`);
      if (peek() === ')') fail(`expected an expression between ',' and ')'`);
      left = { k: 'comma', l: left, r: await parseOr() };
    }
    return left;
  };

  let expr: Expr | null = null;
  try {
    if (exprArgs.length > 0) {
      expr = await parseList();
      if (pos < exprArgs.length) {
        if (exprArgs[pos] === ')') fail("you have too many ')'");
        fail(`unexpected extra predicate '${exprArgs[pos]}'`);
      }
    }
    if (hasDelete && hasPrune && !explicitDepth) {
      fail('The -delete action automatically turns on -depth, but -prune does nothing when -depth is in effect.  If you want to carry on anyway, just explicitly use the -depth option.');
    }
  } catch (e) {
    if (e instanceof FindQuit) {
      await out.flush();
      return e.message === 'help' ? 0 : 1;
    }
    if (e instanceof FindUsage) {
      await err(e.message);
      return 1;
    }
    throw e;
  }
  const printPred: Expr = {
    k: 'pred',
    name: '-print',
    fn: (e) => {
      out.write(e.path + '\n');
      return true;
    },
  };
  if (!expr) expr = printPred;
  else if (!hasAction) expr = { k: 'and', l: expr, r: printPred };

  const evaluate = async (x: Expr, e: Entry): Promise<boolean> => {
    switch (x.k) {
      case 'and':
        return (await evaluate(x.l, e)) && evaluate(x.r, e);
      case 'or':
        return (await evaluate(x.l, e)) || evaluate(x.r, e);
      case 'comma':
        await evaluate(x.l, e);
        return evaluate(x.r, e);
      case 'not':
        return !(await evaluate(x.e, e));
      case 'pred': {
        const r = x.fn(e);
        return typeof r === 'boolean' ? r : await r;
      }
    }
  };

  // --- traversal
  let visited = 0;
  const visit = async (e: Entry, ancestors: { node: Inode; path: string }[]): Promise<void> => {
    if (++visited % 64 === 0) {
      await ctx.checkpoint();
      await out.maybeFlush();
    }
    const isDir = e.node.type === 'dir';
    const process = async () => {
      if (e.depth >= mindepth) {
        pruned = false;
        await evaluate(expr!, e);
      }
    };
    if (!depthFirst) {
      pruned = false;
      await process();
      if (pruned) return;
    }
    if (isDir && e.depth < maxdepth) {
      let entries: [string, Inode][] | null = null;
      try {
        entries = fs.readdirEntries(e.path);
      } catch (ex) {
        await err(`${ql(e.path)}: ${errText(ex)}`);
        status = 1;
      }
      if (entries) {
        entries.sort((a, b) => compareLocale(a[0], b[0]));
        const nextAncestors = [...ancestors, { node: e.node, path: e.path }];
        for (const [name, child] of entries) {
          const path = e.path.endsWith('/') ? e.path + name : e.path + '/' + name;
          let node: Inode = child;
          if (follow === 'L' && child.type === 'symlink') {
            const t = fs.tryStat(path, true);
            if (t) node = t;
          }
          const loop = node.type === 'dir' ? nextAncestors.find((x) => x.node === node) : undefined;
          if (loop) {
            await err(`File system loop detected; ${ql(path)} is part of the same file system loop as ${ql(loop.path)}.`);
            status = 1;
            continue;
          }
          await visit({ path, start: e.start, depth: e.depth + 1, node, lnode: child, dir: e.path, base: name }, nextAncestors);
        }
      }
    }
    if (depthFirst) await process();
  };

  const starts = paths.length ? paths : ['.'];
  try {
    for (const start of starts) {
      await ctx.checkpoint();
      let lnode: Inode;
      try {
        if (start === '') throw new FsError('ENOENT', start);
        lnode = fs.lstat(start);
        if (start.endsWith('/') && lnode.type === 'symlink') lnode = fs.stat(start);
        if (start.endsWith('/') && lnode.type !== 'dir') throw new FsError('ENOTDIR', start);
      } catch (ex) {
        await err(`${ql(start)}: ${errText(ex)}`);
        status = 1;
        continue;
      }
      let node = lnode;
      if (follow !== 'P' && lnode.type === 'symlink') {
        const t = fs.tryStat(start, true);
        if (t) node = t;
      }
      const base = findBase(start);
      await visit({ path: start, start, depth: 0, node, lnode, dir: dirOfPath(start), base }, []);
    }
  } catch (e) {
    if (!(e instanceof FindQuit)) throw e;
  }
  for (const spec of execs) if (spec.plus) await runBatch(spec);
  await out.flush();
  for (const o of fileOutputs.values()) await o.flush();
  return status;
}

function formatEntry(ctx: CommandContext, e: Entry, fmt: FmtPiece[]): string {
  let s = '';
  for (const p of fmt) {
    if (p.stop) break;
    if (p.lit !== undefined) {
      s += p.lit;
      continue;
    }
    const d = p.dir!;
    const n = e.node;
    let v: string;
    switch (d[0]) {
      case 'p':
        v = e.path;
        break;
      case 'f':
        v = baseNameKeep(e.path);
        break;
      case 'h': {
        const t = e.path.replace(/(.)\/+$/, '$1');
        const i = t.lastIndexOf('/');
        v = i === -1 ? '.' : t.slice(0, i);
        break;
      }
      case 'P': {
        const st = e.start;
        v = e.path === st ? '' : e.path.slice(st.endsWith('/') ? st.length : st.length + 1);
        break;
      }
      case 'H':
        v = e.start;
        break;
      case 'd':
        v = String(e.depth);
        break;
      case 's':
        v = String(inodeSize(n));
        break;
      case 'k':
        v = String(n.type === 'dir' ? 4 : n.type === 'file' ? blocksFor(inodeSize(n)) : 0);
        break;
      case 'b':
        v = String((n.type === 'dir' ? 4 : n.type === 'file' ? blocksFor(inodeSize(n)) : 0) * 2);
        break;
      case 'S': {
        const size = inodeSize(n);
        const blocks = (n.type === 'dir' ? 4 : n.type === 'file' ? blocksFor(size) : 0) * 1024;
        v = size === 0 ? '1' : String(Number((blocks / size).toPrecision(6)));
        break;
      }
      case 'm':
        v = (n.mode & 0o7777).toString(8);
        break;
      case 'M':
        v = modeString(n);
        break;
      case 'u':
        v = ctx.system.userName(n.uid);
        break;
      case 'U':
        v = String(n.uid);
        break;
      case 'g':
        v = ctx.system.groupName(n.gid);
        break;
      case 'G':
        v = String(n.gid);
        break;
      case 'i':
        v = String(n.ino);
        break;
      case 'n':
        v = String(n.nlink);
        break;
      case 'D':
        v = '2049';
        break;
      case 'F':
        v = 'ext4';
        break;
      case 'Z':
        v = '?';
        break;
      case 'l':
        v = e.lnode.type === 'symlink' ? e.lnode.target : '';
        break;
      case 'y':
        v = typeLetter(n);
        break;
      case 'Y': {
        if (e.lnode.type === 'symlink') {
          const t = ctx.fs.tryStat(e.path, true);
          v = t ? typeLetter(t) : 'N';
        } else v = typeLetter(n);
        break;
      }
      case 'a':
        v = findCtime(n.atime);
        break;
      case 'c':
        v = findCtime(n.ctime);
        break;
      case 't':
        v = findCtime(n.mtime);
        break;
      case 'A':
      case 'C':
      case 'T': {
        const t = d[0] === 'A' ? n.atime : d[0] === 'C' ? n.ctime : n.mtime;
        v = timeDirective(d[1], t);
        break;
      }
      default:
        v = '';
    }
    s += p.flags ? padField(v, p.flags) : v;
  }
  return s;
}

const findDef: CommandDef = {
  name: 'find',
  pkg: 'findutils',
  size: 224848,
  doc: FIND_DOC,
  gnu: false,
  run: (ctx) => findMain(ctx, findDef),
};
defineCommand(findDef);

// ---------------------------------------------------------------------------
// xargs

const XARGS_DOC: CommandDef['doc'] = {
  category: 'shell',
  summary: 'build and execute command lines from standard input',
  synopsis: ['xargs [OPTION]... COMMAND [INITIAL-ARGS]...'],
  description:
    'Run COMMAND with arguments INITIAL-ARGS and more arguments read from standard input. xargs reads items separated by blanks or newlines (quotes and backslashes protect blanks inside an item) and runs COMMAND as few times as possible with as many items as fit. With no COMMAND it uses echo.\n\n' +
    'This turns the output of one program into the arguments of another. For example "find . -name \'*.txt\' | xargs grep hello" searches every .txt file that find printed.\n\n' +
    'Exit status: 0 if all went well, 123 if any command exited with status 1-125, 124 if a command exited with status 255, 125 if a command was killed by a signal, 126 if the command cannot be run, 127 if it was not found, and 1 for other errors.',
  options: [
    { flags: '-0, --null', desc: 'items are separated by a null, not whitespace; disables quote and backslash processing (pairs with find -print0)' },
    { flags: '-a, --arg-file=FILE', desc: 'read arguments from FILE, not standard input' },
    { flags: '-d, --delimiter=CHARACTER', desc: 'items in input stream are separated by CHARACTER, not by whitespace' },
    { flags: '-E END', desc: 'set logical EOF string; if END occurs as a line of input, the rest of the input is ignored' },
    { flags: '-I R', desc: 'replace R in INITIAL-ARGS with each input line (implies -L 1); -i is the same as -I {}' },
    { flags: '-L, --max-lines=MAX-LINES', desc: 'use at most MAX-LINES non-blank input lines per command line' },
    { flags: '-n, --max-args=MAX-ARGS', desc: 'use at most MAX-ARGS arguments per command line' },
    { flags: '-P, --max-procs=MAX-PROCS', desc: 'run at most MAX-PROCS processes at a time' },
    { flags: '-p, --interactive', desc: 'prompt before running commands' },
    { flags: '-r, --no-run-if-empty', desc: 'if there are no arguments, then do not run COMMAND' },
    { flags: '-s, --max-chars=MAX-CHARS', desc: 'limit length of command line to MAX-CHARS' },
    { flags: '-t, --verbose', desc: 'print commands before executing them' },
    { flags: '-x, --exit', desc: 'exit if the size (see -s) is exceeded' },
  ],
  examples: [
    { cmd: "find . -name '*.txt' | xargs wc -l", desc: 'Count lines in every .txt file found.' },
    { cmd: 'echo a b c d | xargs -n 2', desc: 'Run echo with two arguments at a time.' },
    { cmd: "find . -name '*.tmp' -print0 | xargs -0 rm", desc: 'Safely delete files whose names contain spaces.' },
    { cmd: 'cat names.txt | xargs -I {} mkdir {}', desc: 'Make one directory for each line of names.txt.' },
    { cmd: 'ls *.log | xargs -t gzip', desc: 'Show each command before running it.' },
  ],
  seeAlso: ['find', 'echo', 'sh'],
  tip: 'Add -t to see exactly which commands xargs runs. Use find -print0 | xargs -0 when file names may contain spaces.',
};

const XARGS_VERSION =
  'xargs (GNU findutils) 4.9.0\nCopyright (C) 2022 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by Eric B. Decker, James Youngman, and Kevin Dalley.\n';

class XargsAbort extends Error {
  readonly status: number;
  constructor(status: number) {
    super('abort');
    this.status = status;
  }
}

function parseDelimiter(s: string): string | null {
  if (s.length === 1) return s;
  if (s[0] !== '\\') return null;
  const simple: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
  if (s.length === 2 && s[1] in simple) return simple[s[1]];
  if (/^\\x[0-9a-fA-F]{1,2}$/.test(s)) return String.fromCharCode(parseInt(s.slice(2), 16));
  if (/^\\[0-7]{1,3}$/.test(s)) return String.fromCharCode(parseInt(s.slice(1), 8));
  return null;
}

async function xargsMain(ctx: CommandContext, def: CommandDef): Promise<number> {
  let opts;
  try {
    opts = parseOpts(ctx.args, {
      short: '0a:d:E:e::I:i::L:l::n:opP:rs:tx',
      stopAtOperand: true,
      long: {
        null: '0',
        'arg-file': { key: 'a', arg: 'required' },
        delimiter: { key: 'd', arg: 'required' },
        eof: { key: 'e', arg: 'optional' },
        replace: { key: 'i', arg: 'optional' },
        'max-lines': { key: 'l', arg: 'optional' },
        'max-args': { key: 'n', arg: 'required' },
        'open-tty': 'o',
        interactive: 'p',
        'max-procs': { key: 'P', arg: 'required' },
        'no-run-if-empty': 'r',
        'max-chars': { key: 's', arg: 'required' },
        verbose: 't',
        exit: 'x',
        'show-limits': 'show-limits',
        'process-slot-var': { key: 'slot', arg: 'required' },
        help: 'help',
        version: 'version',
      },
    });
  } catch (e) {
    if (e instanceof OptError) {
      await ctx.error(e.message);
      await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
      return 1;
    }
    throw e;
  }
  if (opts.has('help')) {
    await ctx.out(gnuHelp(def));
    return 0;
  }
  if (opts.has('version')) {
    await ctx.out(XARGS_VERSION);
    return 0;
  }
  let nullSep = false;
  let delim: string | null = null;
  let eofStr: string | null = null;
  let replace: string | null = null;
  let maxLines = 0;
  let maxArgs = 0;
  let maxChars = 131072;
  const badNumber = async (v: string, o: string) => {
    await ctx.error(`invalid number "${v}" for -${o} option`);
    await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
    return 1;
  };
  const tooSmall = async (v: number, o: string, min: number) => {
    await ctx.error(`value ${v} for -${o} option should be >= ${min}`);
    await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
    return 1;
  };
  for (const { key, value } of opts.list) {
    const v = value === true ? '' : value;
    switch (key) {
      case '0':
        nullSep = true;
        delim = null;
        break;
      case 'd': {
        const d = parseDelimiter(v);
        if (d === null) {
          await ctx.error(`Invalid input delimiter specification ${v}: the delimiter must be either a single character or an escape sequence starting with \\.`);
          return 1;
        }
        delim = d;
        nullSep = false;
        break;
      }
      case 'E':
        eofStr = v;
        break;
      case 'e':
        eofStr = value === true ? null : v;
        break;
      case 'I':
        replace = v;
        maxLines = 1;
        maxArgs = 0;
        break;
      case 'i':
        replace = value === true ? '{}' : v;
        maxLines = 1;
        maxArgs = 0;
        break;
      case 'L':
      case 'l': {
        if (key === 'l' && value === true) {
          maxLines = 1;
          break;
        }
        if (!/^\d+$/.test(v)) return badNumber(v, 'L');
        const n = parseInt(v, 10);
        if (n < 1) return tooSmall(n, 'L', 1);
        maxLines = n;
        maxArgs = 0;
        replace = null;
        break;
      }
      case 'n': {
        if (!/^\d+$/.test(v)) return badNumber(v, 'n');
        const n = parseInt(v, 10);
        if (n < 1) return tooSmall(n, 'n', 1);
        maxArgs = n;
        if (replace === null) maxLines = 0;
        break;
      }
      case 's': {
        if (!/^\d+$/.test(v)) return badNumber(v, 's');
        const n = parseInt(v, 10);
        if (n < 1) return tooSmall(n, 's', 1);
        maxChars = n;
        break;
      }
      case 'P':
        if (!/^\d+$/.test(v)) return badNumber(v, 'P');
        break;
      default:
        break;
    }
  }
  const verbose = opts.has('t');
  const interactive = opts.has('p');
  const noRunIfEmpty = opts.has('r');
  const command = opts.operands.length ? opts.operands : ['echo'];

  if (opts.has('show-limits')) {
    await ctx.err(
      'Your environment variables take up 1872 bytes\nPOSIX upper limit on argument length (this system): 2093232\nPOSIX smallest allowable upper limit on argument length (all systems): 4096\nMaximum length of command we could actually use: 2091360\nSize of command buffer we are actually using: 131072\nMaximum parallelism (--max-procs must be no greater): 2147483647\n',
    );
  }

  // input source
  let input: InputStream = ctx.stdin;
  let childStdin: InputStream | undefined = new NullInput();
  if (opts.has('a')) {
    const file = opts.get('a')!;
    if (file === '-') input = ctx.stdin;
    else {
      try {
        const node = ctx.fs.stat(file);
        if (node.type === 'dir') throw new FsError('EISDIR', file);
        input = new StringInput(ctx.fs.readFile(file));
      } catch (e) {
        await ctx.error(`Cannot open input file ${ql(file)}: ${errText(e)}`);
        return 1;
      }
      childStdin = undefined;
    }
  }
  if (opts.has('o')) childStdin = undefined;

  let ttyIn: InputStream | null = null;
  const confirm = async (line: string): Promise<boolean> => {
    if (!ctx.tty) {
      await ctx.err(line);
      await ctx.error('failed to open /dev/tty for reading: No such device or address');
      throw new XargsAbort(1);
    }
    await ctx.err(line + ' ?...');
    ttyIn ??= new TtyInput(ctx.tty, ctx.proc.job);
    return askYes(ttyIn);
  };

  let status = 0;
  const run = async (items: string[]): Promise<void> => {
    let argv: string[];
    if (replace !== null) {
      const item = items[0] ?? '';
      argv = command.map((a) => a.split(replace!).join(item));
    } else argv = [...command, ...items];
    const line = argv.join(' ');
    if (interactive) {
      if (!(await confirm(line))) return;
    } else if (verbose) await ctx.err(line + '\n');
    await ctx.checkpoint();
    const loc = locateProgram(ctx, argv[0]);
    if ('error' in loc) {
      await ctx.error(`${argv[0]}: ${loc.error}`);
      throw new XargsAbort(loc.error.startsWith('No such') ? 127 : 126);
    }
    const st = await ctx.exec(argv, { stdin: childStdin });
    if (st === 255) {
      await ctx.error(`${argv[0]}: exited with status 255; aborting`);
      throw new XargsAbort(124);
    }
    if (st > 128 && st < 128 + 65) {
      await ctx.error(`${argv[0]}: terminated by signal ${st - 128}`);
      throw new XargsAbort(125);
    }
    if (st !== 0) status = 123;
  };

  // --- read items
  let pending = '';
  let eof = false;
  const fill = async (): Promise<boolean> => {
    if (eof) return false;
    const chunk = await input.read();
    if (chunk === null) {
      eof = true;
      return false;
    }
    pending += chunk;
    return true;
  };

  const baseLen = command.reduce((n, a) => n + a.length + 1, 0);
  let items: string[] = [];
  let itemLen = 0;
  let linesInBatch = 0;
  let ranAny = false;
  const flushBatch = async () => {
    if (items.length === 0) return;
    const batch = items;
    items = [];
    itemLen = 0;
    linesInBatch = 0;
    ranAny = true;
    await run(batch);
  };
  const addItem = async (item: string, endsLine: boolean) => {
    if (replace !== null) {
      items = [item];
      await flushBatch();
      return;
    }
    if (maxChars && items.length > 0 && baseLen + itemLen + item.length + 1 > maxChars) await flushBatch();
    items.push(item);
    itemLen += item.length + 1;
    if (maxArgs && items.length >= maxArgs) await flushBatch();
    else if (maxLines && endsLine && ++linesInBatch >= maxLines) await flushBatch();
  };

  try {
    if (nullSep || delim !== null) {
      const sep = nullSep ? '\0' : delim!;
      for (;;) {
        const idx = pending.indexOf(sep);
        if (idx === -1) {
          if (await fill()) continue;
          if (pending !== '') {
            const item = pending;
            pending = '';
            await addItem(item, true);
          }
          break;
        }
        const item = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (replace !== null || item !== '' || delim !== null) await addItem(item, true);
      }
    } else {
      // Default: blanks separate items, quotes and backslashes are special.
      let item = '';
      let inItem = false;
      let quote: string | null = null;
      let lineItems: string[] = [];
      let stop = false;
      const endItem = async (): Promise<void> => {
        if (!inItem) return;
        const it = item;
        item = '';
        inItem = false;
        if (eofStr !== null && eofStr !== '' && it === eofStr && quote === null) {
          stop = true;
          return;
        }
        if (maxLines || replace !== null) lineItems.push(it);
        else await addItem(it, false);
      };
      const endLine = async (): Promise<void> => {
        if (replace !== null) {
          // -I: the whole line (leading blanks removed) is one item
          if (lineItems.length) await addItem(lineItems.join(''), true);
          lineItems = [];
          return;
        }
        if (maxLines) {
          const li = lineItems;
          lineItems = [];
          for (let k = 0; k < li.length; k++) await addItem(li[k], k === li.length - 1);
        }
      };
      let lastWasBlankBeforeNl = false;
      outer: for (;;) {
        if (pending === '' && !(await fill())) break;
        const text = pending;
        pending = '';
        for (let k = 0; k < text.length; k++) {
          const c = text[k];
          if (quote !== null) {
            if (c === quote) {
              quote = null;
              continue;
            }
            if (c === '\n') {
              await ctx.error(`unmatched ${quote === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option`);
              await flushBatch();
              throw new XargsAbort(1);
            }
            item += c;
            continue;
          }
          if (c === '\\') {
            if (k + 1 >= text.length) {
              if (await fill()) {
                pending = text.slice(k) + pending;
                continue outer;
              }
              item += '\\';
              inItem = true;
              continue;
            }
            item += text[++k];
            inItem = true;
            lastWasBlankBeforeNl = false;
            continue;
          }
          if (c === "'" || c === '"') {
            quote = c;
            inItem = true;
            lastWasBlankBeforeNl = false;
            continue;
          }
          if (c === '\n') {
            if (replace !== null) {
              await endItem();
              await endLine();
            } else {
              await endItem();
              if (stop) break outer;
              if (maxLines && !lastWasBlankBeforeNl) await endLine();
            }
            lastWasBlankBeforeNl = false;
            if (stop) break outer;
            continue;
          }
          if (c === ' ' || c === '\t') {
            if (replace !== null) {
              if (inItem) item += c;
              continue;
            }
            await endItem();
            if (stop) break outer;
            lastWasBlankBeforeNl = true;
            continue;
          }
          item += c;
          inItem = true;
          lastWasBlankBeforeNl = false;
        }
        if (stop) break;
      }
      if (quote !== null) {
        await ctx.error(`unmatched ${quote === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option`);
        await flushBatch();
        throw new XargsAbort(1);
      }
      if (!stop) {
        await endItem();
        await endLine();
      } else if (lineItems.length) await endLine();
    }
    await flushBatch();
    if (!ranAny && !noRunIfEmpty && replace === null) await run([]);
  } catch (e) {
    if (e instanceof XargsAbort) return e.status;
    throw e;
  }
  return status;
}

const xargsDef: CommandDef = {
  name: 'xargs',
  pkg: 'findutils',
  size: 64016,
  doc: XARGS_DOC,
  gnu: false,
  run: (ctx) => xargsMain(ctx, xargsDef),
};
defineCommand(xargsDef);

