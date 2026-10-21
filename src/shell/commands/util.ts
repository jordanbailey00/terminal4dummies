// Helpers shared by the simulated GNU/Linux programs.

import { compareLocale } from '../collate';
import { deviceInput } from '../devices';
import type { InputStream } from '../streams';
import type { CommandContext, CommandDoc, NativeCommand } from '../types';
import { FsError, type Inode } from '../vfs/fs';

// ---------------------------------------------------------------------------
// Registry

export const COMMANDS: NativeCommand[] = [];

export interface CommandDef {
  name: string;
  pkg: string;
  dir?: string;
  size?: number;
  doc?: CommandDoc;
  run: (ctx: CommandContext) => Promise<number>;
  /** Handle --help/--version automatically (GNU style). Default true when doc is present. */
  gnu?: boolean;
  /** Version string for --version. */
  version?: string;
}

const PACKAGE_VERSIONS: Record<string, string> = {
  coreutils: 'GNU coreutils) 9.4',
  findutils: 'GNU findutils) 4.9.0',
  grep: 'GNU grep) 3.11',
  sed: 'GNU sed) 4.9',
  diffutils: 'GNU diffutils) 3.10',
  tar: 'GNU tar) 1.35',
  gzip: 'gzip) 1.12',
};

export function defineCommand(def: CommandDef): NativeCommand {
  const useGnu = def.gnu ?? !!def.doc;
  const run = useGnu
    ? async (ctx: CommandContext) => {
        const a = ctx.args;
        // GNU tools honour --help/--version anywhere before "--"
        const end = a.indexOf('--');
        const scan = end === -1 ? a : a.slice(0, end);
        if (scan.includes('--help')) {
          await ctx.out(gnuHelp(def));
          return 0;
        }
        if (scan.includes('--version')) {
          await ctx.out(gnuVersion(def));
          return 0;
        }
        return def.run(ctx);
      }
    : def.run;
  const cmd: NativeCommand = { name: def.name, pkg: def.pkg, dir: def.dir, size: def.size, doc: def.doc, run };
  COMMANDS.push(cmd);
  return cmd;
}

function wrap(text: string, width: number, indent: number, firstIndent = indent): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = ' '.repeat(firstIndent);
  let empty = true;
  for (const w of words) {
    if (!empty && line.length + 1 + w.length > width) {
      lines.push(line);
      line = ' '.repeat(indent) + w;
      continue;
    }
    line += (empty ? '' : ' ') + w;
    empty = false;
  }
  if (!empty || lines.length === 0) lines.push(line);
  return lines;
}

export function gnuHelp(def: CommandDef): string {
  const doc = def.doc;
  if (!doc) return `Usage: ${def.name}\n`;
  let out = '';
  doc.synopsis.forEach((s, i) => {
    out += (i === 0 ? 'Usage: ' : '  or:  ') + s + '\n';
  });
  const firstPara = doc.description.split(/\n\s*\n/)[0];
  out += firstPara.replace(/\s+/g, ' ').trim() + '\n';
  if (doc.options && doc.options.length) {
    out += '\n';
    if (def.pkg === 'coreutils') out += 'Mandatory arguments to long options are mandatory for short options too.\n';
    for (const o of doc.options) {
      const flags = o.flags.startsWith('-') && !o.flags.startsWith('--') ? '  ' + o.flags : '      ' + o.flags;
      if (flags.length >= 28) {
        out += flags + '\n';
        out += wrap(o.desc, 79, 29).join('\n') + '\n';
      } else {
        const lines = wrap(o.desc, 79, 29, 0);
        out += flags.padEnd(29) + lines[0].trimStart() + '\n';
        for (const l of lines.slice(1)) out += l + '\n';
      }
    }
    out += '      --help        display this help and exit\n';
    out += '      --version     output version information and exit\n';
  }
  if (def.pkg === 'coreutils') {
    out += `\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nFull documentation <https://www.gnu.org/software/coreutils/${def.name}>\nor available locally via: info '(coreutils) ${def.name} invocation'\n`;
  } else {
    out += `\nFor more details, run: man ${def.name}\n`;
  }
  return out;
}

function gnuVersion(def: CommandDef): string {
  const ver = def.version ?? PACKAGE_VERSIONS[def.pkg];
  if (ver) {
    return `${def.name} (${ver}\nCopyright (C) 2023 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n`;
  }
  return `${def.name} 1.0 (terminal4dummies simulator)\n`;
}

// ---------------------------------------------------------------------------
// Quoting used in GNU diagnostics

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** 'name' — always quoted (shell-escape-always style). */
export function q(name: string): string {
  if (/[\x00-\x1f\x7f]/.test(name)) {
    return "'" + name.replace(/[\x00-\x1f\x7f]/g, (c) => `'$'\\${ctrlName(c)}''`) + "'";
  }
  if (!name.includes("'")) return `'${name}'`;
  if (!/["$`\\!]/.test(name)) return `"${name}"`;
  return "'" + name.replace(/'/g, "'\\''") + "'";
}

/** name, quoted only when it contains special characters. */
export function qf(name: string): string {
  if (name !== '' && SAFE.test(name)) return name;
  return q(name);
}

/** ‘name’ — locale quotes (used by mkdir, chmod and some others). */
export function ql(name: string): string {
  return `‘${name}’`;
}

function ctrlName(c: string): string {
  switch (c) {
    case '\n':
      return 'n';
    case '\t':
      return 't';
    case '\r':
      return 'r';
    default:
      return c.charCodeAt(0).toString(8).padStart(3, '0');
  }
}

export function errText(e: unknown): string {
  if (e instanceof FsError) return e.reason;
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---------------------------------------------------------------------------
// getopt_long

export interface LongOpt {
  key: string;
  arg?: 'none' | 'required' | 'optional';
}

export interface OptSpec {
  /** Short options; a letter followed by ':' takes an argument, '::' an optional one. */
  short?: string;
  long?: Record<string, LongOpt | string>;
  /** Stop at the first operand (POSIXLY_CORRECT / commands like env, sudo, xargs). */
  stopAtOperand?: boolean;
  /** Treat "-5" style arguments as operands (e.g. for numbers). */
  allowNegativeNumbers?: boolean;
}

export interface ParsedOpts {
  /** key -> last value (true for flags). */
  flags: Map<string, string | true>;
  /** All options in order (for repeatable options like grep -e). */
  list: { key: string; value: string | true }[];
  operands: string[];
  has(key: string): boolean;
  get(key: string): string | undefined;
  count(key: string): number;
}

export class OptError extends Error {}

export function parseOpts(args: string[], spec: OptSpec): ParsedOpts {
  const flags = new Map<string, string | true>();
  const list: { key: string; value: string | true }[] = [];
  const operands: string[] = [];
  const shortSpec = spec.short ?? '';
  const longSpec: Record<string, LongOpt> = {};
  for (const [k, v] of Object.entries(spec.long ?? {})) longSpec[k] = typeof v === 'string' ? { key: v } : v;
  const shortArg = (c: string): 'none' | 'required' | 'optional' | null => {
    const i = shortSpec.indexOf(c);
    if (i === -1 || c === ':') return null;
    if (shortSpec[i + 1] === ':') return shortSpec[i + 2] === ':' ? 'optional' : 'required';
    return 'none';
  };
  const set = (key: string, value: string | true) => {
    flags.set(key, value);
    list.push({ key, value });
  };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let opt = longSpec[name];
      let fullName = name;
      if (!opt) {
        const matches = Object.keys(longSpec).filter((k) => k.startsWith(name));
        const distinct = [...new Set(matches.map((m) => longSpec[m].key + ':' + (longSpec[m].arg ?? 'none')))];
        if (matches.length === 0) throw new OptError(`unrecognized option '${a.slice(0, eq === -1 ? undefined : eq)}'`);
        if (distinct.length > 1) {
          throw new OptError(`option '${a}' is ambiguous; possibilities:${matches.map((m) => ` '--${m}'`).join('')}`);
        }
        fullName = matches[0];
        opt = longSpec[fullName];
      }
      const kind = opt.arg ?? 'none';
      if (kind === 'none') {
        if (eq !== -1) throw new OptError(`option '--${fullName}' doesn't allow an argument`);
        set(opt.key, true);
      } else if (kind === 'optional') {
        set(opt.key, eq === -1 ? true : a.slice(eq + 1));
      } else {
        if (eq !== -1) set(opt.key, a.slice(eq + 1));
        else if (i + 1 < args.length) set(opt.key, args[++i]);
        else throw new OptError(`option '--${fullName}' requires an argument`);
      }
      continue;
    }
    if (a.startsWith('-') && a !== '-' && !(spec.allowNegativeNumbers && /^-\d+(\.\d+)?$/.test(a))) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        const kind = shortArg(c);
        if (kind === null) throw new OptError(`invalid option -- '${c}'`);
        if (kind === 'none') {
          set(c, true);
          continue;
        }
        const rest = a.slice(j + 1);
        if (rest !== '') set(c, rest);
        else if (kind === 'optional') set(c, true);
        else if (i + 1 < args.length) set(c, args[++i]);
        else throw new OptError(`option requires an argument -- '${c}'`);
        break;
      }
      continue;
    }
    if (spec.stopAtOperand) {
      operands.push(...args.slice(i));
      break;
    }
    operands.push(a);
  }
  return {
    flags,
    list,
    operands,
    has: (k: string) => flags.has(k),
    get: (k: string) => {
      const v = flags.get(k);
      return v === true || v === undefined ? undefined : v;
    },
    count: (k: string) => list.filter((x) => x.key === k).length,
  };
}

/** Parse options, printing GNU-style errors. Returns null after reporting an error. */
export async function getopts(ctx: CommandContext, spec: OptSpec, exitHint = true): Promise<ParsedOpts | null> {
  try {
    return parseOpts(ctx.args, spec);
  } catch (e) {
    if (e instanceof OptError) {
      await ctx.error(e.message);
      if (exitHint) await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
      return null;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Input helpers

/** Iterate lines of a stream (each without its trailing newline). */
export async function* readLines(stream: InputStream, signal?: AbortSignal): AsyncGenerator<{ line: string; nl: boolean }> {
  for (;;) {
    const l = await stream.readLine(signal);
    if (l === null) return;
    if (l.endsWith('\n')) yield { line: l.slice(0, -1), nl: true };
    else yield { line: l, nl: false };
  }
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** For a character device (/dev/zero, /dev/urandom, /dev/tty...), a stream to read it; null for anything else. */
export function deviceStream(ctx: CommandContext, path: string): InputStream | null {
  let node: Inode;
  try {
    node = ctx.fs.stat(path);
  } catch {
    return null;
  }
  if (node.type !== 'chardev') return null;
  return deviceInput(node.device, { stdin: ctx.stdin, tty: ctx.tty, job: ctx.proc.job, random: ctx.system.random });
}

/** Read at most `max` characters from a stream (endless devices are cut off). */
export async function readUpTo(input: InputStream, max: number, signal?: AbortSignal): Promise<string> {
  let out = '';
  while (out.length < max) {
    const chunk = await input.read(signal);
    if (chunk === null) break;
    out += chunk;
  }
  if (out.length > max) {
    input.unread(out.slice(max));
    out = out.slice(0, max);
  }
  return out;
}

/**
 * Read the whole content of each operand ("-" or none means stdin).
 * Errors are reported as "name: file: reason" and the entry is skipped.
 */
export async function readSources(
  ctx: CommandContext,
  files: string[],
  opts: { report?: (file: string, e: unknown) => Promise<void> } = {},
): Promise<{ name: string; text: string; ok: boolean }[]> {
  const list = files.length === 0 ? ['-'] : files;
  const out: { name: string; text: string; ok: boolean }[] = [];
  for (const f of list) {
    if (f === '-') {
      out.push({ name: '-', text: await ctx.stdin.readAll(), ok: true });
      continue;
    }
    try {
      const node = ctx.fs.stat(f);
      if (node.type === 'dir') throw new FsError('EISDIR', f);
      const dev = deviceStream(ctx, f);
      // an endless device is cut off rather than read forever
      out.push({ name: f, text: dev ? await readUpTo(dev, 65536, ctx.signal) : ctx.fs.readFile(f), ok: true });
    } catch (e) {
      if (opts.report) await opts.report(f, e);
      else await ctx.error(`${qf(f)}: ${errText(e)}`);
      out.push({ name: f, text: '', ok: false });
    }
  }
  return out;
}

export function sortNames(names: string[]): string[] {
  return [...names].sort(compareLocale);
}

/** Parse a GNU-style size/number with optional suffix (K, M, G, KB...). */
export function parseSize(s: string): number | null {
  const m = /^(\d+)([KMGTP]?)(i?B)?$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toUpperCase();
  const base = m[3] && m[3].toUpperCase() === 'B' ? 1000 : 1024;
  const pow = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5 }[unit] ?? 0;
  return n * base ** pow;
}

/** GNU "human readable" sizes: 4.0K, 12K, 1.5M (rounded up like ls -h). */
export function humanSize(bytes: number, si = false): string {
  const base = si ? 1000 : 1024;
  if (bytes < base) return String(bytes);
  const units = ['K', 'M', 'G', 'T', 'P'];
  let v = bytes;
  let u = -1;
  while (v >= base && u < units.length - 1) {
    v /= base;
    u++;
  }
  if (v < 10) {
    const r = Math.ceil(v * 10) / 10;
    if (r >= 10) return `${Math.ceil(r)}${units[u]}`;
    return `${r.toFixed(1)}${units[u]}`;
  }
  const r = Math.ceil(v);
  if (r >= base && u < units.length - 1) return `1.0${units[u + 1]}`;
  return `${r}${units[u]}`;
}

/** Disk blocks (1 KiB units) used by a file of the given size on a 4 KiB-block filesystem. */
export function blocksFor(size: number, isDir = false): number {
  if (isDir) return 4;
  if (size === 0) return 0;
  return Math.ceil(size / 4096) * 4;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Time zone abbreviation for a date in the viewer's locale ("PDT", "UTC", "GMT+2"). */
export function tzAbbrev(d: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d);
    const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'UTC';
    return tz === 'GMT' ? 'UTC' : tz;
  } catch {
    return 'UTC';
  }
}

export function tzOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${sign}${pad2(Math.floor(a / 60))}${pad2(a % 60)}`;
}
