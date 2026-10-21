// Builtins that describe commands: type, command, builtin, hash, help, history.

import { findInPath, spawnProgram } from '../exec';
import { BUILTINS, BUILTIN_HELP, KEYWORDS, defineBuiltin, type BuiltinContext } from './registry';

type Kind = 'alias' | 'keyword' | 'function' | 'builtin' | 'file';

interface Found {
  kind: Kind;
  text: string;
  path?: string;
}

function describe(ctx: BuiltinContext, name: string, all: boolean): Found[] {
  const sh = ctx.sh;
  const st = sh.state;
  const found: Found[] = [];
  const alias = st.aliases.get(name);
  if (alias !== undefined) found.push({ kind: 'alias', text: `${name} is aliased to \`${alias}'` });
  if (KEYWORDS.has(name)) found.push({ kind: 'keyword', text: `${name} is a shell keyword` });
  const fn = st.functions.get(name);
  if (fn) found.push({ kind: 'function', text: `${name} is a function\n${fn.source}` });
  if (BUILTINS.has(name)) found.push({ kind: 'builtin', text: `${name} is a shell builtin` });
  if (!all && found.length) return found.slice(0, 1);
  const hashed = st.hash.get(name);
  if (hashed && !all) {
    found.push({ kind: 'file', text: `${name} is hashed (${hashed})`, path: hashed });
    return found;
  }
  const pathVar = st.get('PATH') ?? '';
  if (name.includes('/')) {
    const node = sh.system.fs.tryStat(name, sh.opCtx());
    if (node && node.type !== 'dir') found.push({ kind: 'file', text: `${name} is ${name}`, path: name });
    return found;
  }
  if (all) {
    for (const dir of pathVar.split(':')) {
      const p = (dir || '.') + '/' + name;
      const node = sh.system.fs.tryStat(p, sh.opCtx());
      if (node && node.type === 'file') found.push({ kind: 'file', text: `${name} is ${p}`, path: p });
    }
  } else {
    const p = findInPath(sh.system.fs, name, pathVar, sh.opCtx());
    if (p) found.push({ kind: 'file', text: `${name} is ${p}`, path: p });
  }
  return found;
}

defineBuiltin(
  'type',
  {
    usage: 'type [-afptP] name [name ...]',
    summary: 'Display information about command type.',
    body: 'For each NAME, indicate how it would be interpreted if used as a\ncommand name.\n\nOptions:\n  -a\tdisplay all locations containing an executable named NAME;\n\t\tincludes aliases, builtins, and functions\n  -p\treturns either the name of the disk file that would be executed,\n\t\tor nothing if `type -t NAME\' would not return `file\'\n  -t\toutput a single word which is one of `alias\', `keyword\',\n\t\t`function\', `builtin\', `file\' or `\', if NAME is an alias,\n\t\tshell reserved word, shell function, shell builtin, disk file,\n\t\tor not found, respectively',
  },
  async (ctx) => {
    let all = false;
    let terse = false;
    let pathOnly = false;
    const names: string[] = [];
    for (const a of ctx.args) {
      if (/^-[afptP]+$/.test(a) && names.length === 0) {
        if (a.includes('a')) all = true;
        if (a.includes('t')) terse = true;
        if (a.includes('p') || a.includes('P')) pathOnly = true;
      } else names.push(a);
    }
    let status = 0;
    for (const n of names) {
      const found = describe(ctx, n, all);
      if (found.length === 0) {
        if (!terse && !pathOnly) await ctx.error(`${n}: not found`);
        status = 1;
        continue;
      }
      for (const f of found) {
        if (terse) await ctx.out(f.kind + '\n');
        else if (pathOnly) {
          if (f.path) await ctx.out(f.path + '\n');
        } else await ctx.out(f.text + '\n');
        if (!all) break;
      }
    }
    return status;
  },
);

defineBuiltin(
  'command',
  {
    usage: 'command [-pVv] command [arg ...]',
    summary: 'Execute a simple command or display information about commands.',
    body: 'Runs COMMAND with ARGS suppressing  shell function lookup, or display\ninformation about the specified COMMANDs.\n\nOptions:\n  -v\tprint a single word indicating the command or filename that\n\t\tinvokes COMMAND\n  -V\tprint a more verbose description of each COMMAND',
  },
  async (ctx) => {
    let args = ctx.args;
    let mode: 'run' | 'v' | 'V' = 'run';
    while (args.length && /^-[pvV]+$/.test(args[0])) {
      if (args[0].includes('v')) mode = 'v';
      if (args[0].includes('V')) mode = 'V';
      args = args.slice(1);
    }
    if (args.length === 0) return 0;
    if (mode !== 'run') {
      let status = 0;
      for (const n of args) {
        const f = describe(ctx, n, false)[0];
        if (!f) {
          if (mode === 'V') await ctx.error(`${n}: not found`);
          status = 1;
          continue;
        }
        if (mode === 'V') await ctx.out(f.text + '\n');
        else if (f.kind === 'alias') await ctx.out(`alias ${n}='${ctx.sh.state.aliases.get(n)}'\n`);
        else if (f.kind === 'file') await ctx.out(f.path + '\n');
        else await ctx.out(n + '\n');
      }
      return status;
    }
    const name = args[0];
    const builtin = BUILTINS.get(name);
    if (builtin) {
      return builtin({ ...ctx, argv: args, args: args.slice(1), name });
    }
    const sh = ctx.sh;
    const path = sh.findCommand(name);
    if (!path) {
      await ctx.error(`${name}: command not found`);
      return 127;
    }
    return spawnProgram(sh, { path, argv: args, env: sh.state.exportedEnv(), io: ctx.io, creds: sh.state.creds, cwd: sh.state.cwd, umask: sh.state.umask });
  },
);

defineBuiltin(
  'builtin',
  { usage: 'builtin [shell-builtin [arg ...]]', summary: 'Execute shell builtins.', body: 'Execute SHELL-BUILTIN with arguments ARGs without performing command\nlookup.' },
  async (ctx) => {
    if (ctx.args.length === 0) return 0;
    const name = ctx.args[0];
    const b = BUILTINS.get(name);
    if (!b) {
      await ctx.error(`${name}: not a shell builtin`);
      return 1;
    }
    return b({ ...ctx, argv: ctx.args, args: ctx.args.slice(1), name });
  },
);

defineBuiltin(
  'hash',
  { usage: 'hash [-lr] [-p pathname] [-dt] [name ...]', summary: 'Remember or display program locations.', body: 'Determine and remember the full pathname of each command NAME.  If\nno arguments are given, information about remembered commands is displayed.\n\nOptions:\n  -r\tforget all remembered locations' },
  async (ctx) => {
    const st = ctx.sh.state;
    if (ctx.args.includes('-r')) {
      st.hash.clear();
      return 0;
    }
    const names = ctx.args.filter((a) => !a.startsWith('-'));
    if (names.length === 0) {
      if (st.hash.size === 0) {
        await ctx.out('hash: hash table empty\n');
        return 0;
      }
      let out = 'hits\tcommand\n';
      for (const [, path] of st.hash) out += `   1\t${path}\n`;
      await ctx.out(out);
      return 0;
    }
    let status = 0;
    for (const n of names) {
      const p = findInPath(ctx.sh.system.fs, n, st.get('PATH') ?? '', ctx.sh.opCtx());
      if (p) st.hash.set(n, p);
      else {
        await ctx.error(`${n}: not found`);
        status = 1;
      }
    }
    return status;
  },
);

function helpListing(cols: number): string {
  const entries: string[] = [];
  const extra = ['job_spec [&]', '(( expression ))', '[[ expression ]]', 'case WORD in [PATTERN [| PATTERN]...) COMMANDS ;;]... esac', 'for NAME [in WORDS ... ] ; do COMMANDS; done', 'for (( exp1; exp2; exp3 )); do COMMANDS; done', 'function name { COMMANDS ; } or name () { COMMANDS ; }', 'if COMMANDS; then COMMANDS; [ elif COMMANDS; then COMMANDS; ]... [ else COMMANDS; ] fi', 'until COMMANDS; do COMMANDS-2; done', 'while COMMANDS; do COMMANDS-2; done', '{ COMMANDS ; }', 'time [-p] pipeline', '! PIPELINE'];
  for (const [, h] of BUILTIN_HELP) entries.push(h.usage);
  entries.push(...extra);
  entries.sort((a, b) => a.replace(/^[^a-z]+/, '').localeCompare(b.replace(/^[^a-z]+/, '')));
  const colWidth = Math.max(20, Math.floor(cols / 2));
  const fit = (s: string) => (s.length > colWidth - 2 ? s.slice(0, colWidth - 3) + '>' : s);
  const half = Math.ceil(entries.length / 2);
  let out =
    'GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)\n' +
    "These shell commands are defined internally.  Type `help' to see this list.\n" +
    "Type `help name' to find out more about the function `name'.\n" +
    "Use `info bash' to find out more about the shell in general.\n" +
    "Use `man -k' or `info' to find out more about commands not in this list.\n\n" +
    'A star (*) next to a name means that the command is disabled.\n\n';
  for (let i = 0; i < half; i++) {
    const left = ' ' + fit(entries[i]);
    const right = entries[i + half] !== undefined ? ' ' + fit(entries[i + half]) : '';
    out += (right ? left.padEnd(colWidth) + right : left) + '\n';
  }
  return out;
}

defineBuiltin(
  'help',
  { usage: 'help [-dms] [pattern ...]', summary: 'Display information about builtin commands.', body: 'Displays brief summaries of builtin commands.  If PATTERN is\nspecified, gives detailed help on all commands matching PATTERN,\notherwise the list of help topics is printed.\n\nOptions:\n  -d\toutput short description for each topic\n  -s\toutput only a short usage synopsis for each topic matching\n\t\tPATTERN' },
  async (ctx) => {
    const short = ctx.args.includes('-s');
    const desc = ctx.args.includes('-d');
    const names = ctx.args.filter((a) => !/^-[dms]+$/.test(a));
    if (names.length === 0) {
      await ctx.out(helpListing(ctx.sh.system.tty?.cols ?? 80));
      return 0;
    }
    let status = 0;
    for (const pattern of names) {
      const re = new RegExp('^' + pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      const matches = [...BUILTIN_HELP.entries()].filter(([n]) => re.test(n) || n === pattern);
      if (matches.length === 0) {
        await ctx.error(`no help topics match \`${pattern}'.  Try \`help help' or \`man -k ${pattern}' or \`info ${pattern}'.`);
        status = 1;
        continue;
      }
      for (const [n, h] of matches) {
        if (short) await ctx.out(`${n}: ${h.usage}\n`);
        else if (desc) await ctx.out(`${n} - ${h.summary}\n`);
        else {
          const body = h.body ? '\n' + h.body.split('\n').map((l) => (l ? '    ' + l : '    ')).join('\n') + '\n' : '\n';
          await ctx.out(`${n}: ${h.usage}\n    ${h.summary}\n${body}`);
        }
      }
    }
    return status;
  },
);

defineBuiltin(
  'history',
  {
    usage: 'history [-c] [-d offset] [n] or history -anrw [filename] or history -ps arg [arg...]',
    summary: 'Display or manipulate the history list.',
    body: 'Display the history list with line numbers, prefixing each modified\nentry with a `*\'.  An argument of N lists only the last N entries.\n\nOptions:\n  -c\tclear the history list by deleting all of the entries\n  -d offset\tdelete the history entry at position OFFSET.',
  },
  async (ctx) => {
    const h = ctx.sh.history;
    if (!h) return 0;
    const args = ctx.args;
    if (args[0] === '-c') {
      h.clear();
      return 0;
    }
    if (args[0] === '-d') {
      const n = parseInt(args[1] ?? '', 10);
      if (Number.isNaN(n) || !h.delete(n < 0 ? h.last + 1 + n : n)) {
        await ctx.error(`${args[1] ?? ''}: history position out of range`);
        return 1;
      }
      return 0;
    }
    if (args[0] && /^-[anrwps]+$/.test(args[0])) return 0;
    let count = h.length;
    if (args[0] !== undefined) {
      if (!/^\d+$/.test(args[0])) {
        await ctx.error(`${args[0]}: numeric argument required`);
        return 1;
      }
      count = Math.min(h.length, parseInt(args[0], 10));
    }
    let out = '';
    const start = h.length - count;
    for (let i = start; i < h.length; i++) {
      out += `${String(h.base + i).padStart(5)}  ${h.entries[i]}\n`;
    }
    await ctx.out(out);
    return 0;
  },
);
