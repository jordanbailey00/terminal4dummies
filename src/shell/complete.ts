// Tab completion: commands, file names, variables.

import { BUILTINS, KEYWORDS } from './builtins/registry';
import { compareLocale } from './collate';
import type { Shell } from './interpreter';
import type { Completion } from './readline';
import { VirtualFS } from './vfs/fs';

const COMMAND_PREFIXES = new Set(['sudo', 'time', 'xargs', 'which', 'man', 'type', 'command', 'builtin', 'exec', 'env', 'nohup', 'watch', 'whatis', 'whereis', 'info', 'help', 'apropos', 'timeout', 'nice']);
const DIR_ONLY = new Set(['cd', 'pushd', 'rmdir']);

/** Escape a file name for the command line (like readline's filename quoting). */
export function escapeForShell(s: string): string {
  const out = s.replace(/([ \t\n'"\\|&;()<>$`!*?[\]{}#])/g, '\\$1');
  return out.startsWith('~') ? '\\' + out : out;
}

interface WordInfo {
  start: number;
  /** The raw text of the word up to the cursor. */
  raw: string;
  /** The word with quotes/escapes removed. */
  value: string;
  /** Quote character still open at the cursor, if any. */
  openQuote: string | null;
  /** Words before this one in the current simple command. */
  previous: string[];
}

function analyze(line: string, cursor: number): WordInfo {
  const text = line.slice(0, cursor);
  let start = 0;
  let quote: string | null = null;
  let previous: string[] = [];
  let current = '';
  let currentStart = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) {
        current += text[++i];
        continue;
      } else current += c;
      continue;
    }
    if (c === "'" || c === '"') {
      if (current === '' && start !== i) currentStart = i;
      quote = c;
      continue;
    }
    if (c === '\\' && i + 1 < text.length) {
      current += text[++i];
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      if (current !== '' || i > currentStart) {
        if (text.slice(currentStart, i).trim() !== '') previous.push(current);
      }
      current = '';
      currentStart = i + 1;
      continue;
    }
    if ('|&;()<>'.includes(c)) {
      if (current !== '') previous.push(current);
      current = '';
      currentStart = i + 1;
      if (c === '|' || c === '&' || c === ';' || c === '(') previous = [];
      continue;
    }
    if (current === '') currentStart = i;
    current += c;
  }
  start = currentStart;
  // skip leading quote char in start position
  return { start, raw: text.slice(start), value: current, openQuote: quote, previous };
}

export function completeLine(sh: Shell, line: string, cursor: number): Completion | null {
  const info = analyze(line, cursor);
  const prev = info.previous.filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || info.previous.indexOf(w) > 0);
  const commandPosition = prev.length === 0 || (prev.length >= 1 && COMMAND_PREFIXES.has(prev[prev.length - 1]) && prev[prev.length - 1] !== 'man');
  const word = info.value;
  const quote = info.openQuote;

  // $VARIABLE completion
  const dollar = /\$\{?([A-Za-z_][A-Za-z0-9_]*)?$/.exec(info.raw);
  if (dollar && !quote) {
    const prefix = dollar[1] ?? '';
    const brace = dollar[0].startsWith('${');
    const names = [...sh.state.vars.keys()].filter((n) => n.startsWith(prefix)).sort();
    const start = info.start + info.raw.length - dollar[0].length;
    return {
      start,
      candidates: names.map((n) => (brace ? '${' + n : '$' + n)),
      display: names,
      suffixes: names.map(() => (brace ? '}' : ' ')),
    };
  }

  const cmdName = prev[0] ?? '';
  if (commandPosition && !word.includes('/') && !word.startsWith('~') && !word.startsWith('.')) {
    const names = new Set<string>();
    for (const a of sh.state.aliases.keys()) names.add(a);
    for (const f of sh.state.functions.keys()) names.add(f);
    for (const b of BUILTINS.keys()) names.add(b);
    for (const k of KEYWORDS) if (/^[a-z]/.test(k)) names.add(k);
    const fs = sh.system.fs;
    const ctx = sh.opCtx();
    for (const dir of (sh.state.get('PATH') ?? '').split(':')) {
      try {
        for (const [name, node] of fs.readdirEntries(dir || '.', ctx)) {
          const target = node.type === 'symlink' ? fs.tryStat(`${dir}/${name}`, ctx) : node;
          if (target && target.type === 'file' && VirtualFS.canAccess(target, ctx.creds, 1)) names.add(name);
        }
      } catch {
        // unreadable PATH entry
      }
    }
    const matches = [...names].filter((n) => n.startsWith(word)).sort();
    return { start: info.start, candidates: matches.map(escapeForShell), display: matches, suffixes: matches.map(() => ' ') };
  }

  // file name completion
  const dirOnly = DIR_ONLY.has(cmdName);
  const raw = info.raw;
  const rawSlash = raw.lastIndexOf('/');
  const rawDir = rawSlash === -1 ? (quote && raw.startsWith(quote) ? quote : '') : raw.slice(0, rawSlash + 1);
  const slash = word.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : word.slice(0, slash + 1);
  const base = slash === -1 ? word : word.slice(slash + 1);
  if (slash === -1 && /^~[^/]*$/.test(word) && !quote) {
    const users = sh.system.users.filter((u) => ('~' + u.name).startsWith(word) && u.home.startsWith('/home') || u.name === 'root').map((u) => '~' + u.name);
    const matching = users.filter((u) => u.startsWith(word));
    return { start: info.start, candidates: matching, suffixes: matching.map(() => '/') };
  }
  let lookupDir = dirPart === '' ? '.' : dirPart;
  if (lookupDir.startsWith('~')) {
    const m = /^~([^/]*)/.exec(lookupDir)!;
    const home = sh.expandTilde(m[1]);
    if (home !== null) lookupDir = home + lookupDir.slice(m[0].length);
  }
  const fs = sh.system.fs;
  const ctx = sh.opCtx();
  let entries: [string, ReturnType<VirtualFS['tryStat']>][] = [];
  try {
    entries = fs.readdirEntries(lookupDir, ctx).map(([n, node]) => [n, node.type === 'symlink' ? fs.tryStat(`${lookupDir}/${n}`, ctx) ?? node : node]);
  } catch {
    return null;
  }
  if (base === '..') return { start: info.start, candidates: [rawDir + '..'], suffixes: ['/'] };
  const showHidden = base.startsWith('.');
  const matches = entries
    .filter(([n]) => n.startsWith(base) && (showHidden || !n.startsWith('.')))
    .filter(([, node]) => !dirOnly || node?.type === 'dir')
    .sort((a, b) => compareLocale(a[0], b[0]));
  const candidates = matches.map(([n]) => rawDir + escapeQuoted(n, quote));
  const suffixes = matches.map(([, node]) => (node?.type === 'dir' ? '/' : quote ? quote + ' ' : ' '));
  const display = matches.map(([n, node]) => n + (node?.type === 'dir' ? '/' : ''));
  return { start: info.start, candidates, display, suffixes };
}

function escapeQuoted(s: string, quote: string | null): string {
  if (quote === "'") return s.replace(/'/g, "'\\''");
  if (quote === '"') return s.replace(/(["\\$`])/g, '\\$1');
  return escapeForShell(s);
}
