// Helpers for writing step checks. A check looks at what the learner just
// did (the command event) and/or the state of the simulated computer.

import type { EditorEvent } from '../shell/readline';
import type { ExecEvent } from '../shell/system';
import { resolvePath } from '../shell/vfs/path';
import type { Inode } from '../shell/vfs/fs';
import type { CheckContext } from './types';

type Check = (c: CheckContext) => boolean;

const HOME = '/home/learner';

/** Expand ~ and make a path absolute (relative paths are relative to home). */
export function abs(path: string): string {
  if (path === '~') return HOME;
  if (path.startsWith('~/')) return HOME + path.slice(1);
  return resolvePath(HOME, path);
}

function node(c: CheckContext, path: string, follow = true): Inode | null {
  return c.sys.fs.tryStat(abs(path), { cwd: '/', creds: { uid: 0, gid: 0, groups: [0] } }, follow);
}

/** Long option spellings that count as short flags. */
const LONG_FLAGS: Record<string, Record<string, string>> = {
  ls: { all: 'a', 'almost-all': 'A', 'human-readable': 'h', recursive: 'R', reverse: 'r', classify: 'F', directory: 'd', inode: 'i' },
  rm: { recursive: 'r', force: 'f', interactive: 'i', verbose: 'v', dir: 'd' },
  cp: { recursive: 'r', interactive: 'i', verbose: 'v', archive: 'a' },
  mv: { interactive: 'i', verbose: 'v', 'no-clobber': 'n' },
  mkdir: { parents: 'p', verbose: 'v' },
  grep: { 'ignore-case': 'i', 'line-number': 'n', 'invert-match': 'v', count: 'c', recursive: 'r', 'word-regexp': 'w', 'files-with-matches': 'l', 'extended-regexp': 'E' },
  head: { lines: 'n' },
  tail: { lines: 'n', follow: 'f' },
  wc: { lines: 'l', words: 'w', bytes: 'c', chars: 'm' },
  sort: { reverse: 'r', 'numeric-sort': 'n', unique: 'u' },
  uniq: { count: 'c' },
  cat: { number: 'n' },
  chmod: { recursive: 'R', verbose: 'v' },
};

/** Short flags used in an exec (e.g. ls -la --human-readable → {l, a, h}). */
export function flagsOf(e: ExecEvent): Set<string> {
  const flags = new Set<string>();
  const cmd = e.argv[0]?.split('/').pop() ?? '';
  for (const a of e.argv.slice(1)) {
    if (a === '--') break;
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0];
      const short = LONG_FLAGS[cmd]?.[name];
      if (short) flags.add(short);
      flags.add('--' + name);
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      for (const ch of a.slice(1)) flags.add(ch);
    }
  }
  return flags;
}

/** Non-option arguments of an exec. */
export function operandsOf(e: ExecEvent): string[] {
  const out: string[] = [];
  let end = false;
  for (const a of e.argv.slice(1)) {
    if (!end && a === '--') {
      end = true;
      continue;
    }
    if (!end && a.startsWith('-') && a.length > 1) continue;
    out.push(a);
  }
  return out;
}

export interface RanOptions {
  /** Every one of these short flags must be present ("la" = -l and -a). */
  flags?: string;
  /** Each of these must appear among the arguments (after expansion). */
  args?: (string | RegExp)[];
  /** Exact exit status required (default: any). */
  status?: number;
  /** Also accept these command names. */
  aliases?: string[];
  /** Require it to have run as root (e.g. via sudo). */
  root?: boolean;
}

function execMatches(e: ExecEvent, name: string, o: RanOptions): boolean {
  if (e.kind === 'not-found') return false;
  const cmd = e.argv[0]?.split('/').pop();
  if (cmd !== name && !(o.aliases ?? []).includes(cmd ?? '')) return false;
  if (o.status !== undefined && e.status !== o.status) return false;
  if (o.root && e.uid !== 0) return false;
  if (o.flags) {
    const f = flagsOf(e);
    for (const ch of o.flags) if (!f.has(ch)) return false;
  }
  if (o.args) {
    const ops = e.argv.slice(1);
    for (const want of o.args) {
      const ok = ops.some((a) => (typeof want === 'string' ? a === want || a.replace(/\/+$/, '') === want.replace(/\/+$/, '') : want.test(a)));
      if (!ok) return false;
    }
  }
  return true;
}

/** The last command line ran `name` (anywhere in it, e.g. inside a pipeline). */
export function ran(name: string, o: RanOptions = {}): Check {
  return (c) => !!c.ev && c.ev.execs.some((e) => execMatches(e, name, o));
}

/** Like ran(), but over every command in the lesson so far. */
export function everRan(name: string, o: RanOptions = {}): Check {
  return (c) => c.commands.some((ev) => ev.execs.some((e) => execMatches(e, name, o)));
}

/** The raw command line typed matches. */
export function lineMatches(re: RegExp): Check {
  return (c) => !!c.ev && re.test(c.ev.line.trim());
}

/** The last command produced output containing the text. */
export function outputIncludes(text: string | RegExp): Check {
  return (c) => !!c.ev && (typeof text === 'string' ? c.ev.output.includes(text) : text.test(c.ev.output));
}

export function succeeded(): Check {
  return (c) => !!c.ev && c.ev.status === 0 && !c.ev.interrupted;
}

export function cwdIs(path: string): Check {
  return (c) => c.sh.state.cwd === abs(path);
}

export function exists(path: string): Check {
  return (c) => node(c, path) !== null;
}

export function missing(path: string): Check {
  return (c) => node(c, path, false) === null;
}

export function isDir(path: string): Check {
  return (c) => node(c, path)?.type === 'dir';
}

export function isFile(path: string): Check {
  return (c) => node(c, path)?.type === 'file';
}

export function isSymlink(path: string): Check {
  return (c) => node(c, path, false)?.type === 'symlink';
}

export function fileText(c: CheckContext, path: string): string | null {
  const n = node(c, path);
  if (!n || n.type !== 'file' || typeof n.data !== 'string') return null;
  return n.data;
}

export function fileContains(path: string, text: string | RegExp): Check {
  return (c) => {
    const t = fileText(c, path);
    if (t === null) return false;
    return typeof text === 'string' ? t.includes(text) : text.test(t);
  };
}

export function fileLineCount(path: string, atLeast: number): Check {
  return (c) => {
    const t = fileText(c, path);
    if (t === null) return false;
    return t.split('\n').filter((l) => l.trim() !== '').length >= atLeast;
  };
}

export function modeIs(path: string, mode: number): Check {
  return (c) => ((node(c, path)?.mode ?? -1) & 0o7777) === mode;
}

export function isExecutable(path: string): Check {
  return (c) => {
    const n = node(c, path);
    return !!n && (n.mode & 0o100) !== 0;
  };
}

export function ownerIs(path: string, uid: number): Check {
  return (c) => node(c, path)?.uid === uid;
}

export function varIs(name: string, value?: string | RegExp): Check {
  return (c) => {
    const v = c.sh.state.get(name);
    if (v === undefined) return false;
    if (value === undefined) return true;
    return typeof value === 'string' ? v === value : value.test(v);
  };
}

export function aliasIs(name: string, value?: string | RegExp): Check {
  return (c) => {
    const v = c.sh.state.aliases.get(name);
    if (v === undefined) return false;
    if (value === undefined) return true;
    return typeof value === 'string' ? v === value : value.test(v);
  };
}

export function keyUsed(e: EditorEvent): Check {
  return (c) => c.key === e || c.keys.includes(e);
}

/** The last command was stopped with Ctrl+C. */
export function interrupted(): Check {
  return (c) => !!c.ev && c.ev.interrupted;
}

export function stoppedJob(): Check {
  return (c) => !!c.ev && c.ev.stopped;
}

export function jobCount(n: number): Check {
  return (c) => c.sh.jobs.size === n;
}

export function packageInstalled(name: string): Check {
  return (c) => c.sys.fs.exists(`/var/lib/dpkg/info/${name}.list`, { cwd: '/', creds: { uid: 0, gid: 0, groups: [0] } });
}

export function all(...checks: Check[]): Check {
  return (c) => checks.every((k) => k(c));
}

export function any(...checks: Check[]): Check {
  return (c) => checks.some((k) => k(c));
}

export function not(check: Check): Check {
  return (c) => !check(c);
}
