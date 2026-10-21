// Core builtins: echo, printf, cd, pwd, exit, source, read, and friends.

import { evaluateArithmetic, ArithError } from '../arith';
import { BreakException, ContinueException, ExitException, ReturnException } from '../control';
import { IncompleteInputError, ParseError, isValidName, parse } from '../parser/parser';
import { SignalError } from '../streams';
import { FsError, VirtualFS } from '../vfs/fs';
import { normalize, resolvePath, tildify } from '../vfs/path';
import { formatPrintf, processEscapes } from '../util/printf';
import { defineBuiltin, type BuiltinContext } from './registry';
import { findInPath, spawnProgram } from '../exec';

// --- trivial ---------------------------------------------------------------

defineBuiltin(':', { usage: ': [arguments]', summary: 'Null command.', body: 'No effect; the command does nothing.\n\nExit Status:\nAlways succeeds.' }, async () => 0);
defineBuiltin('true', { usage: 'true', summary: 'Return a successful result.', body: 'Exit Status:\nAlways succeeds.' }, async () => 0);
defineBuiltin('false', { usage: 'false', summary: 'Return an unsuccessful result.', body: 'Exit Status:\nAlways fails.' }, async () => 1);

// --- echo / printf -----------------------------------------------------------

export function echoText(args: string[]): string {
  let newline = true;
  let escapes = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!/^-[neE]+$/.test(a)) break;
    for (const ch of a.slice(1)) {
      if (ch === 'n') newline = false;
      else if (ch === 'e') escapes = true;
      else if (ch === 'E') escapes = false;
    }
  }
  let text = args.slice(i).join(' ');
  if (escapes) {
    const r = processEscapes(text, 'echo');
    text = r.text;
    if (r.stopped) return text;
  }
  return newline ? text + '\n' : text;
}

defineBuiltin(
  'echo',
  {
    usage: 'echo [-neE] [arg ...]',
    summary: 'Write arguments to the standard output.',
    body:
      'Display the ARGs, separated by a single space character and followed by a\nnewline, on the standard output.\n\n' +
      'Options:\n  -n\tdo not append a newline\n  -e\tenable interpretation of the following backslash escapes\n  -E\texplicitly suppress interpretation of backslash escapes\n\n' +
      "`echo' interprets the following backslash-escaped characters:\n  \\n\tnew line\n  \\t\thorizontal tab\n  \\\\\tbackslash",
  },
  async (ctx) => {
    await ctx.out(echoText(ctx.args));
    return 0;
  },
);

defineBuiltin(
  'printf',
  {
    usage: 'printf [-v var] format [arguments]',
    summary: 'Formats and prints ARGUMENTS under control of the FORMAT.',
    body:
      'FORMAT is a character string which contains three types of objects: plain\ncharacters, which are simply copied to standard output; character escape\n' +
      'sequences, which are converted and copied to the standard output; and\nformat specifications, each of which causes printing of the next successive\nargument.\n\n' +
      'In addition to the standard format specifications described in printf(1),\nprintf interprets:\n\n  %b\texpand backslash escape sequences in the corresponding argument\n  %q\tquote the argument in a way that can be reused as shell input',
  },
  async (ctx) => {
    let args = ctx.args;
    let target: string | null = null;
    if (args[0] === '-v') {
      if (args.length < 2) {
        await ctx.error('-v: option requires an argument');
        await ctx.err('printf: usage: printf [-v var] format [arguments]\n');
        return 2;
      }
      target = args[1];
      args = args.slice(2);
    }
    if (args[0] === '--') args = args.slice(1);
    if (args.length === 0) {
      await ctx.err('printf: usage: printf [-v var] format [arguments]\n');
      return 2;
    }
    const r = formatPrintf(args[0], args.slice(1));
    for (const e of r.errors) await ctx.error(e);
    if (target) ctx.sh.setVar(target, r.output);
    else await ctx.out(r.output);
    return r.errors.length ? 1 : 0;
  },
);

// --- directories -------------------------------------------------------------

export async function changeDirectory(ctx: BuiltinContext, target: string, opts: { physical?: boolean; print?: boolean; label?: string } = {}): Promise<number> {
  const sh = ctx.sh;
  const st = sh.state;
  const fs = sh.system.fs;
  const label = opts.label ?? target;
  const oldPwd = st.get('PWD') ?? st.cwd;
  let newPath = opts.physical ? resolvePath(st.cwd, target) : normalize(target.startsWith('/') ? target : (oldPwd || st.cwd) + '/' + target);
  const ctxOp = sh.opCtx();
  let node = fs.tryStat(newPath, ctxOp);
  if (!node || node.type !== 'dir') {
    // logical path failed: fall back to the physical meaning (bash does this too)
    const physical = resolvePath(st.cwd, target);
    const pnode = fs.tryStat(physical, ctxOp);
    if (pnode?.type === 'dir') {
      newPath = physical;
      node = pnode;
    }
  }
  try {
    const n = fs.stat(newPath, ctxOp);
    if (n.type !== 'dir') throw new FsError('ENOTDIR', newPath);
    if (!VirtualFS.canAccess(n, st.creds, 1)) throw new FsError('EACCES', newPath);
  } catch (e) {
    if (e instanceof FsError) {
      await ctx.error(`${label}: ${e.reason}`);
      return 1;
    }
    throw e;
  }
  if (opts.physical) newPath = fs.realpath(newPath, ctxOp);
  st.cwd = newPath;
  st.set('OLDPWD', oldPwd, { exported: st.getVar('OLDPWD')?.exported ?? true });
  st.set('PWD', newPath);
  if (opts.print) await ctx.out(newPath + '\n');
  return 0;
}

defineBuiltin(
  'cd',
  {
    usage: 'cd [-L|[-P [-e]] [-@]] [dir]',
    summary: 'Change the shell working directory.',
    body:
      'Change the current directory to DIR.  The default DIR is the value of the\nHOME shell variable. If DIR is "-", it is converted to $OLDPWD.\n\n' +
      'Options:\n  -L\tforce symbolic links to be followed: resolve symbolic\n\t\tlinks in DIR after processing instances of `..\'\n' +
      '  -P\tuse the physical directory structure without following\n\t\tsymbolic links: resolve symbolic links in DIR before\n\t\tprocessing instances of `..\'\n\n' +
      'Exit Status:\nReturns 0 if the directory is changed, and if $PWD is set successfully when\n-P is used; non-zero otherwise.',
  },
  async (ctx) => {
    let args = ctx.args;
    let physical = false;
    while (args.length && /^-[LPe@]+$/.test(args[0])) {
      if (args[0].includes('P')) physical = true;
      if (args[0].includes('L')) physical = false;
      args = args.slice(1);
    }
    if (args[0] === '--') args = args.slice(1);
    if (args.length > 1) {
      await ctx.error('too many arguments');
      return 1;
    }
    const st = ctx.sh.state;
    if (args.length === 0 || args[0] === '') {
      if (args.length === 1) return 0;
      const home = st.get('HOME');
      if (home === undefined) {
        await ctx.error('HOME not set');
        return 1;
      }
      return changeDirectory(ctx, home, { physical });
    }
    if (args[0] === '-') {
      const old = st.get('OLDPWD');
      if (old === undefined) {
        await ctx.error('OLDPWD not set');
        return 1;
      }
      return changeDirectory(ctx, old, { physical, print: true });
    }
    return changeDirectory(ctx, args[0], { physical });
  },
);

defineBuiltin(
  'pwd',
  {
    usage: 'pwd [-LP]',
    summary: 'Print the name of the current working directory.',
    body:
      'Options:\n  -L\tprint the value of $PWD if it names the current working\n\t\tdirectory\n  -P\tprint the physical directory, without any symbolic links\n\n' +
      'By default, `pwd\' behaves as if `-L\' were specified.',
  },
  async (ctx) => {
    const physical = ctx.args.some((a) => /^-[LP]*P[LP]*$/.test(a));
    const st = ctx.sh.state;
    let p = st.cwd;
    if (physical) {
      try {
        p = ctx.sh.system.fs.realpath(st.cwd, ctx.sh.opCtx());
      } catch {
        await ctx.error('error retrieving current directory: getcwd: cannot access parent directories: No such file or directory');
        return 1;
      }
    }
    await ctx.out(p + '\n');
    return 0;
  },
);

function dirsLine(ctx: BuiltinContext): string {
  const st = ctx.sh.state;
  const home = st.get('HOME') ?? '';
  return [st.cwd, ...st.dirStack].map((d) => tildify(d, home)).join(' ');
}

defineBuiltin(
  'dirs',
  { usage: 'dirs [-clpv] [+N] [-N]', summary: 'Display directory stack.', body: 'Display the list of currently remembered directories.  Directories\nfind their way onto the list with the `pushd\' command; you can get\nback up through the list with the `popd\' command.\n\nOptions:\n  -c\tclear the directory stack by deleting all of the elements\n  -v\tprint the directory stack with one entry per line, prefixing\n\t\tthe entry with its position in the stack' },
  async (ctx) => {
    const st = ctx.sh.state;
    if (ctx.args.includes('-c')) {
      st.dirStack = [];
      return 0;
    }
    if (ctx.args.includes('-v')) {
      const home = st.get('HOME') ?? '';
      const all = [st.cwd, ...st.dirStack];
      await ctx.out(all.map((d, i) => ` ${i}  ${tildify(d, home)}`).join('\n') + '\n');
      return 0;
    }
    await ctx.out(dirsLine(ctx) + '\n');
    return 0;
  },
);

defineBuiltin(
  'pushd',
  { usage: 'pushd [-n] [+N | -N | dir]', summary: 'Add directories to stack.', body: 'Adds a directory to the top of the directory stack, or rotates\nthe stack, making the new top of the stack the current working\ndirectory.  With no arguments, exchanges the top two directories.' },
  async (ctx) => {
    const st = ctx.sh.state;
    const cur = st.cwd;
    if (ctx.args.length === 0) {
      if (st.dirStack.length === 0) {
        await ctx.error('no other directory');
        return 1;
      }
      const top = st.dirStack.shift()!;
      const r = await changeDirectory(ctx, top);
      if (r !== 0) {
        st.dirStack.unshift(top);
        return r;
      }
      st.dirStack.unshift(cur);
    } else {
      const r = await changeDirectory(ctx, ctx.args[0]);
      if (r !== 0) return r;
      st.dirStack.unshift(cur);
    }
    await ctx.out(dirsLine(ctx) + '\n');
    return 0;
  },
);

defineBuiltin(
  'popd',
  { usage: 'popd [-n] [+N | -N]', summary: 'Remove directories from stack.', body: 'Removes entries from the directory stack.  With no arguments, removes\nthe top directory from the stack, and changes to the new top directory.' },
  async (ctx) => {
    const st = ctx.sh.state;
    if (st.dirStack.length === 0) {
      await ctx.error('directory stack empty');
      return 1;
    }
    const next = st.dirStack.shift()!;
    const r = await changeDirectory(ctx, next);
    if (r !== 0) return r;
    await ctx.out(dirsLine(ctx) + '\n');
    return 0;
  },
);

// --- control flow --------------------------------------------------------------

function parseCount(s: string | undefined): number | null {
  if (s === undefined) return 1;
  if (!/^-?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

defineBuiltin(
  'exit',
  { usage: 'exit [n]', summary: 'Exit the shell.', body: 'Exits the shell with a status of N.  If N is omitted, the exit status\nis that of the last command executed.' },
  async (ctx) => {
    const st = ctx.sh.state;
    let status = st.lastStatus;
    if (ctx.args.length > 0) {
      const a = ctx.args[0];
      if (!/^[-+]?\d+$/.test(a.trim())) {
        if (st.interactive) await ctx.err('exit\n');
        await ctx.error(`${a}: numeric argument required`);
        throw new ExitException(2);
      }
      if (ctx.args.length > 1) {
        if (st.interactive) await ctx.err('exit\n');
        await ctx.error('too many arguments');
        return 1;
      }
      status = parseInt(a, 10) & 255;
    }
    if (st.interactive) {
      const stopped = ctx.sh.jobs.stoppedCount();
      if (stopped > 0 && !ctx.sh.warnedStoppedJobs) {
        ctx.sh.warnedStoppedJobs = true;
        await ctx.err('There are stopped jobs.\n');
        return 1;
      }
      await ctx.err(st.loginShell ? 'logout\n' : 'exit\n');
    }
    throw new ExitException(status);
  },
);

defineBuiltin(
  'logout',
  { usage: 'logout [n]', summary: 'Exit a login shell.', body: 'Exits a login shell with exit status N.  Returns an error if not executed\nin a login shell.' },
  async (ctx) => {
    const st = ctx.sh.state;
    if (!st.loginShell) {
      await ctx.error('not login shell: use `exit\'');
      return 1;
    }
    const a = ctx.args[0];
    const status = a !== undefined && /^[-+]?\d+$/.test(a.trim()) ? parseInt(a, 10) & 255 : st.lastStatus;
    if (st.interactive) await ctx.err('logout\n');
    throw new ExitException(status);
  },
);

defineBuiltin(
  'return',
  { usage: 'return [n]', summary: 'Return from a shell function.', body: 'Causes a function or sourced script to exit with the return value\nspecified by N.  If N is omitted, the return status is that of the\nlast command executed within the function or script.' },
  async (ctx) => {
    const st = ctx.sh.state;
    if (st.funcNest === 0 && ctx.sh.sourceDepth === 0) {
      await ctx.error("can only `return' from a function or sourced script");
      return 1;
    }
    let status = st.lastStatus;
    if (ctx.args.length > 0) {
      if (!/^[-+]?\d+$/.test(ctx.args[0])) {
        await ctx.error(`${ctx.args[0]}: numeric argument required`);
        status = 2;
      } else status = parseInt(ctx.args[0], 10) & 255;
    }
    throw new ReturnException(status);
  },
);

for (const name of ['break', 'continue'] as const) {
  defineBuiltin(
    name,
    {
      usage: `${name} [n]`,
      summary: name === 'break' ? 'Exit for, while, or until loops.' : 'Resume for, while, or until loops.',
      body: name === 'break' ? 'Exit a FOR, WHILE or UNTIL loop.  If N is specified, break N enclosing\nloops.' : 'Resumes the next iteration of the enclosing FOR, WHILE or UNTIL loop.\nIf N is specified, resumes the Nth enclosing loop.',
    },
    async (ctx) => {
      const n = parseCount(ctx.args[0]);
      if (n === null) {
        await ctx.error(`${ctx.args[0]}: numeric argument required`);
        return 1;
      }
      if (n < 1) {
        await ctx.error(`${n}: loop count out of range`);
        return 1;
      }
      if (ctx.sh.loopDepth === 0) {
        await ctx.error("only meaningful in a `for', `while', or `until' loop");
        return 0;
      }
      throw name === 'break' ? new BreakException(Math.min(n, ctx.sh.loopDepth)) : new ContinueException(Math.min(n, ctx.sh.loopDepth));
    },
  );
}

defineBuiltin(
  'shift',
  { usage: 'shift [n]', summary: 'Shift positional parameters.', body: 'Rename the positional parameters $N+1,$N+2 ... to $1,$2 ...  If N is\nnot given, it is assumed to be 1.' },
  async (ctx) => {
    const n = parseCount(ctx.args[0]);
    if (n === null) {
      await ctx.error(`${ctx.args[0]}: numeric argument required`);
      return 1;
    }
    const st = ctx.sh.state;
    if (n > st.positional.length || n < 0) return 1;
    st.positional = st.positional.slice(n);
    return 0;
  },
);

// --- running code ----------------------------------------------------------------

defineBuiltin(
  'eval',
  { usage: 'eval [arg ...]', summary: 'Execute arguments as a shell command.', body: 'Combine ARGs into a single string, use the result as input to the shell,\nand execute the resulting commands.' },
  async (ctx) => {
    const src = ctx.args.join(' ');
    if (src.trim() === '') return 0;
    return ctx.sh.runSource(src, ctx.io);
  },
);

async function sourceFile(ctx: BuiltinContext): Promise<number> {
  const sh = ctx.sh;
  if (ctx.args.length === 0) {
    await ctx.error('filename argument required');
    await ctx.err(`${ctx.name}: usage: ${ctx.name} filename [arguments]\n`);
    return 2;
  }
  const file = ctx.args[0];
  const fs = sh.system.fs;
  const opCtx = sh.opCtx();
  let path = file;
  if (!file.includes('/')) {
    const found = findInPath(fs, file, sh.state.get('PATH') ?? '', opCtx);
    const foundNode = found ? fs.tryStat(found, opCtx) : null;
    if (found && foundNode?.type === 'file' && typeof foundNode.data === 'string') path = found;
  }
  let text: string;
  try {
    const node = fs.stat(path, opCtx);
    if (node.type === 'dir') throw new FsError('EISDIR', path);
    text = fs.readFile(path, opCtx);
  } catch (e) {
    if (e instanceof FsError) {
      await sh.printError(ctx.io, `${file}: ${e.reason}`);
      return 1;
    }
    throw e;
  }
  const st = sh.state;
  const savedPositional = st.positional;
  if (ctx.args.length > 1) st.positional = ctx.args.slice(1);
  sh.sourceDepth++;
  try {
    return await sh.runSource(text, ctx.io, { perLine: true });
  } catch (e) {
    if (e instanceof ReturnException) return e.status;
    throw e;
  } finally {
    sh.sourceDepth--;
    if (ctx.args.length > 1) st.positional = savedPositional;
  }
}

const SOURCE_HELP = {
  usage: 'source filename [arguments]',
  summary: 'Execute commands from a file in the current shell.',
  body: 'Read and execute commands from FILENAME in the current shell.  The\nentries in $PATH are used to find the directory containing FILENAME.\nIf any ARGUMENTS are supplied, they become the positional parameters\nwhen FILENAME is executed.',
};
defineBuiltin('source', SOURCE_HELP, sourceFile);
defineBuiltin('.', { ...SOURCE_HELP, usage: '. filename [arguments]' }, sourceFile);

defineBuiltin(
  'exec',
  { usage: 'exec [-cl] [-a name] [command [argument ...]] [redirection ...]', summary: 'Replace the shell with the given command.', body: 'Execute COMMAND, replacing this shell with the specified program.\nARGUMENTS become the arguments to COMMAND.  If COMMAND is not specified,\nany redirections take effect in the current shell.' },
  async (ctx) => {
    if (ctx.args.length === 0) return 0;
    const sh = ctx.sh;
    const name = ctx.args[0];
    const path = sh.findCommand(name);
    if (!path) {
      await ctx.error(`${name}: not found`);
      return 127;
    }
    const status = await spawnProgram(sh, {
      path,
      argv: ctx.args,
      env: sh.state.exportedEnv(),
      io: ctx.io,
      creds: sh.state.creds,
      cwd: sh.state.cwd,
      umask: sh.state.umask,
    });
    throw new ExitException(status);
  },
);

// --- read ------------------------------------------------------------------------

defineBuiltin(
  'read',
  {
    usage: 'read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]',
    summary: 'Read a line from the standard input and split it into fields.',
    body:
      'Reads a single line from the standard input.  The line is split\ninto fields as with word splitting, and the first word is assigned to the\nfirst NAME, the second word to the second NAME, and so on, with any\nleftover words assigned to the last NAME.\n\n' +
      'If no NAMEs are supplied, the line read is stored in the REPLY variable.\n\nOptions:\n  -p prompt\toutput the string PROMPT without a trailing newline before\n\t\tattempting to read\n  -r\tdo not allow backslashes to escape any characters\n  -s\tdo not echo input coming from a terminal\n  -n nchars\treturn after reading NCHARS characters rather than waiting\n\t\tfor a newline',
  },
  async (ctx) => {
    const sh = ctx.sh;
    let raw = false;
    let silent = false;
    let prompt: string | null = null;
    let nchars: number | null = null;
    let delim = '\n';
    let arrayName: string | null = null;
    const names: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (names.length === 0 && /^-[a-zA-Z]/.test(a)) {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          const takeArg = () => {
            const rest = a.slice(j + 1);
            j = a.length;
            if (rest) return rest;
            return args[++i];
          };
          if (ch === 'r') raw = true;
          else if (ch === 's') silent = true;
          else if (ch === 'p') prompt = takeArg() ?? '';
          else if (ch === 'n' || ch === 'N') nchars = parseInt(takeArg() ?? '0', 10);
          else if (ch === 'd') delim = (takeArg() ?? '\n').slice(0, 1) || '\0';
          else if (ch === 'a') arrayName = takeArg() ?? null;
          else if (ch === 't' || ch === 'u' || ch === 'i') takeArg();
          else if (ch === 'e') {
            /* readline editing: ignored */
          } else {
            await ctx.error(`-${ch}: invalid option`);
            await ctx.err('read: usage: read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]\n');
            return 2;
          }
        }
        continue;
      }
      names.push(a);
    }
    const stdin = ctx.stdin;
    const tty = stdin.isTTY ? sh.system.tty : null;
    if (prompt !== null && tty) await ctx.err(prompt);
    const signal = ctx.io.job.signal;
    const savedModes = tty?.getModes();
    if (tty && (silent || nchars !== null)) tty.setModes({ echo: !silent, ...(nchars !== null ? { icanon: false } : {}) });
    let line = '';
    let eof = false;
    try {
      if (nchars !== null) {
        while ([...line].length < nchars) {
          const chunk = await stdin.read(signal);
          if (chunk === null) {
            eof = true;
            break;
          }
          const chars = [...chunk];
          const need = nchars - [...line].length;
          line += chars.slice(0, need).join('');
          if (chars.length > need) stdin.unread(chars.slice(need).join(''));
          if (line.includes(delim)) {
            line = line.slice(0, line.indexOf(delim));
            break;
          }
        }
        if (tty && silent === false) {
          /* echo handled by tty */
        }
      } else {
        for (;;) {
          const l = await readUntil(stdin, delim, signal);
          if (l === null) {
            eof = true;
            break;
          }
          let text = l.text;
          if (!raw && text.endsWith('\\') && !l.eof) {
            line += text.slice(0, -1);
            continue;
          }
          line += text;
          text = '';
          if (l.eof) eof = true;
          break;
        }
      }
    } catch (e) {
      if (e instanceof SignalError) {
        if (tty && savedModes) tty.setModes(savedModes);
        throw e;
      }
      throw e;
    } finally {
      if (tty && savedModes) tty.setModes(savedModes);
    }
    if (tty && silent) await ctx.err('\n').catch(() => {});
    if (!raw) line = line.replace(/\\(.)/g, '$1');
    const ifs = sh.state.get('IFS') ?? ' \t\n';
    if (arrayName !== null) {
      // read -a: every field becomes an element
      const fields = line.trim() === '' && ifs.includes(' ') ? [] : splitForRead(line, ifs, Infinity);
      try {
        if (sh.state.isAssoc(arrayName)) {
          await ctx.error(`${arrayName}: cannot convert associative to indexed array`);
          return 1;
        }
        sh.state.setArray(arrayName, fields.map((f, i) => [i, f]));
      } catch (e) {
        await ctx.error(e instanceof Error ? e.message : String(e));
        return 1;
      }
    } else if (names.length === 0) {
      sh.setVar('REPLY', line);
    } else {
      const fields = splitForRead(line, ifs, names.length);
      for (let k = 0; k < names.length; k++) {
        try {
          sh.setVar(names[k], fields[k] ?? '');
        } catch (e) {
          await ctx.error(e instanceof Error ? e.message : String(e));
          return 1;
        }
      }
    }
    return eof ? 1 : 0;
  },
);

async function readUntil(stdin: BuiltinContext['stdin'], delim: string, signal: AbortSignal): Promise<{ text: string; eof: boolean } | null> {
  let buf = '';
  for (;;) {
    const chunk = await stdin.read(signal);
    if (chunk === null) return buf === '' ? null : { text: buf, eof: true };
    const idx = chunk.indexOf(delim);
    if (idx === -1) {
      buf += chunk;
      if (stdin.isTTY && delim === '\n') return { text: buf, eof: true };
      continue;
    }
    buf += chunk.slice(0, idx);
    stdin.unread(chunk.slice(idx + 1));
    return { text: buf, eof: false };
  }
}

const MAPFILE_HELP = {
  usage: 'mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]',
  summary: 'Read lines from the standard input into an indexed array variable.',
  body:
    'Read lines from the standard input into the indexed array variable ARRAY.\nThe variable MAPFILE is the default ARRAY.\n\nOptions:\n' +
    '  -d delim\tUse DELIM to terminate lines, instead of newline\n  -n count\tCopy at most COUNT lines.  If COUNT is 0, all lines are copied\n' +
    '  -O origin\tBegin assigning to ARRAY at index ORIGIN.  The default index is 0\n  -s count\tDiscard the first COUNT lines read\n' +
    '  -t\tRemove a trailing DELIM from each line read (default newline)',
};

async function mapfileImpl(ctx: BuiltinContext): Promise<number> {
  const sh = ctx.sh;
  let delim = '\n';
  let count = 0;
  let origin: number | null = null;
  let skip = 0;
  let trim = false;
  let name = 'MAPFILE';
  const args = ctx.args;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-[dnOsuCct]/.test(a)) {
      const opt = a[1];
      const val = () => (a.length > 2 ? a.slice(2) : args[++i]);
      if (opt === 't') trim = true;
      else if (opt === 'd') delim = (val() ?? '\n').slice(0, 1) || '\0';
      else if (opt === 'n' || opt === 'O' || opt === 's' || opt === 'c') {
        const v = val();
        if (v === undefined || !/^[0-9]+$/.test(v)) {
          await ctx.error(`${v ?? ''}: invalid ${opt === 'O' ? 'array origin' : opt === 'n' ? 'line count' : 'number'}`);
          return 1;
        }
        const n = parseInt(v, 10);
        if (opt === 'n') count = n;
        else if (opt === 'O') origin = n;
        else if (opt === 's') skip = n;
      } else val();
      continue;
    }
    name = a;
  }
  if (!isValidName(name)) {
    await ctx.error(`${name}: invalid array name`);
    return 1;
  }
  if (sh.state.isAssoc(name)) {
    await ctx.error(`${name}: not an indexed array`);
    return 1;
  }
  const items: [number, string][] = [];
  let index = origin ?? 0;
  let seen = 0;
  for (;;) {
    if (count > 0 && items.length >= count) break;
    const l = await readUntil(ctx.stdin, delim, ctx.io.job.signal);
    if (l === null) break;
    if (seen++ < skip) continue;
    items.push([index++, trim || l.eof ? l.text : l.text + delim]);
    if (l.eof) break;
  }
  try {
    // without -O the array is emptied first
    if (origin === null) sh.state.setArray(name, items);
    else sh.state.setArray(name, items, true);
  } catch (e) {
    await ctx.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  return 0;
}

defineBuiltin('mapfile', MAPFILE_HELP, mapfileImpl);
defineBuiltin('readarray', { ...MAPFILE_HELP, usage: MAPFILE_HELP.usage.replace('mapfile', 'readarray'), summary: 'Read lines from a file into an array variable.' }, mapfileImpl);

function splitForRead(line: string, ifs: string, count: number): string[] {
  const ws = [...ifs].filter((c) => c === ' ' || c === '\t' || c === '\n').join('');
  const isWs = (c: string) => ws.includes(c);
  const isIfs = (c: string) => ifs.includes(c);
  let s = line;
  // trim leading/trailing IFS whitespace
  let a = 0;
  while (a < s.length && isWs(s[a])) a++;
  let b = s.length;
  while (b > a && isWs(s[b - 1])) b--;
  s = s.slice(a, b);
  const out: string[] = [];
  let i = 0;
  while (out.length < count - 1 && i <= s.length) {
    let j = i;
    while (j < s.length && !isIfs(s[j])) j++;
    if (j >= s.length) {
      out.push(s.slice(i));
      return out;
    }
    out.push(s.slice(i, j));
    // skip delimiter: whitespace run, optional single non-ws IFS char, whitespace run
    while (j < s.length && isWs(s[j])) j++;
    if (j < s.length && isIfs(s[j]) && !isWs(s[j])) {
      j++;
      while (j < s.length && isWs(s[j])) j++;
    }
    i = j;
  }
  if (i <= s.length) out.push(s.slice(i));
  return out;
}

// --- arithmetic / misc -------------------------------------------------------------

defineBuiltin(
  'let',
  { usage: 'let arg [arg ...]', summary: 'Evaluate arithmetic expressions.', body: 'Evaluate each ARG as an arithmetic expression.  If the last ARG evaluates\nto 0, let returns 1; let returns 0 otherwise.' },
  async (ctx) => {
    if (ctx.args.length === 0) {
      await ctx.error('expression expected');
      return 1;
    }
    let v = 0;
    for (const a of ctx.args) {
      try {
        v = evaluateArithmetic(a, ctx.sh.arithEnv());
      } catch (e) {
        if (e instanceof ArithError) {
          await ctx.error(`${a}: ${e.message}`);
          return 1;
        }
        throw e;
      }
    }
    return v !== 0 ? 0 : 1;
  },
);

defineBuiltin(
  'umask',
  { usage: 'umask [-p] [-S] [mode]', summary: 'Display or set file mode mask.', body: 'Sets the user file-creation mask to MODE.  If MODE is omitted, prints\nthe current value of the mask.\n\nOptions:\n  -S\tmakes the output symbolic; otherwise an octal number is output' },
  async (ctx) => {
    const st = ctx.sh.state;
    const symbolic = ctx.args.includes('-S');
    const rest = ctx.args.filter((a) => a !== '-S' && a !== '-p');
    if (rest.length === 0) {
      if (symbolic) {
        const perms = (shift: number) => {
          const bits = (~st.umask >> shift) & 7;
          return (bits & 4 ? 'r' : '') + (bits & 2 ? 'w' : '') + (bits & 1 ? 'x' : '');
        };
        await ctx.out(`u=${perms(6)},g=${perms(3)},o=${perms(0)}\n`);
      } else {
        await ctx.out(st.umask.toString(8).padStart(4, '0') + '\n');
      }
      return 0;
    }
    const m = rest[0];
    if (/^[0-7]{1,4}$/.test(m)) {
      st.umask = parseInt(m, 8) & 0o777;
      return 0;
    }
    await ctx.error(`${m}: octal number out of range`);
    return 1;
  },
);

defineBuiltin(
  'times',
  { usage: 'times', summary: 'Display process times.', body: 'Prints the accumulated user and system times for the shell and all of its\nchild processes.' },
  async (ctx) => {
    await ctx.out('0m0.051s 0m0.024s\n0m0.010s 0m0.006s\n');
    return 0;
  },
);

defineBuiltin(
  'trap',
  { usage: 'trap [-lp] [[arg] signal_spec ...]', summary: 'Trap signals and other events.', body: 'Defines and activates handlers to be run when the shell receives signals\nor other conditions.' },
  async (ctx) => {
    const sh = ctx.sh;
    if (ctx.args.length === 0 || ctx.args[0] === '-p') {
      for (const [sig, cmd] of sh.traps) await ctx.out(`trap -- '${cmd.replace(/'/g, "'\\''")}' ${sig}\n`);
      return 0;
    }
    if (ctx.args[0] === '-l') {
      await ctx.out(' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 9) SIGKILL\t15) SIGTERM\n');
      return 0;
    }
    const [cmd, ...sigs] = ctx.args;
    for (const s0 of sigs) {
      const s = s0.toUpperCase().replace(/^SIG/, '');
      const key = s === '0' ? 'EXIT' : s;
      if (cmd === '-' || cmd === '') sh.traps.delete(key);
      else sh.traps.set(key, cmd);
    }
    return 0;
  },
);

/** Used by the parser-aware `type` builtin and by tests. */
export function isCompleteCommand(src: string): boolean {
  try {
    parse(src);
    return true;
  } catch (e) {
    if (e instanceof IncompleteInputError) return false;
    if (e instanceof ParseError) return true;
    throw e;
  }
}
