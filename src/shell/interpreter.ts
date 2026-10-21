// The interpreter: walks the AST and runs commands the way bash does.

import { ArithError, evaluateArithmetic } from './arith';
import { BUILTINS, type BuiltinContext } from './builtins/registry';
import { commandNotFoundMessage } from './cnf';
import { ExpansionError, expandRedirectTarget, expandToPattern, expandToString, expandWords } from './expand';
import { spawnProgram, findInPath } from './exec';
import { matchPattern } from './glob';
import { JobTable } from './jobs';
import type { History } from './history';
import { IncompleteInputError, ParseError, parse, parseExpandableText } from './parser/parser';
import type {
  AndOr,
  Assignment,
  Command,
  CondExpr,
  FunctionDef,
  ListItem,
  Pipeline,
  Redirect,
  Script,
  SimpleCommand,
} from './parser/ast';
import { Job } from './process';
import { IO } from './io';

export { IO };
import { ReadonlyError, ShellState } from './state';
import {
  BrokenPipeError,
  CaptureOutput,
  FileOutput,
  InputStream,
  NullInput,
  NullOutput,
  OutputStream,
  Pipe,
  SignalError,
  StringInput,
  WriteError,
  yieldToEventLoop,
} from './streams';
import type { System } from './system';
import { TtyInput, TtyOutput } from './tty';
import { binaryTest, unaryTest } from './builtins/test';
import { FsError, type OpContext } from './vfs/fs';
import { resolvePath } from './vfs/path';

export { ExitException, ReturnException, BreakException, ContinueException, RedirectError } from './control';
import { ExitException, ReturnException, BreakException, ContinueException, RedirectError } from './control';

export const MAX_FUNC_NEST = 1000;

function shellQuoteForTrace(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export interface ShellInit {
  system: System;
  state: ShellState;
  jobs?: JobTable;
  /** Errors are reported as "bash: ..." instead of "script: line N: ...". */
  interactiveTree?: boolean;
}

export class Shell {
  readonly system: System;
  state: ShellState;
  readonly jobs: JobTable;
  /** True for the interactive shell and its subshells (affects messages). */
  readonly interactiveTree: boolean;
  private steps = 0;
  condDepth = 0;
  loopDepth = 0;
  lastCmdSubStatus: number | null = null;
  /** Command history (interactive shells; shared with subshells). */
  history: History | null = null;
  warnedStoppedJobs = false;
  /** Nesting depth of `source` (so `return` works in sourced files). */
  sourceDepth = 0;
  /** trap handlers by condition name (EXIT, INT, ...). */
  traps = new Map<string, string>();

  constructor(init: ShellInit) {
    this.system = init.system;
    this.state = init.state;
    this.jobs = init.jobs ?? new JobTable();
    this.interactiveTree = init.interactiveTree ?? init.state.interactive;
  }

  /** A child shell with a copy of this shell's state. */
  subshell(): Shell {
    const child = new Shell({
      system: this.system,
      state: this.state.fork(this.system.processes.allocPid()),
      interactiveTree: this.interactiveTree,
    });
    child.loopDepth = 0;
    child.history = this.history;
    return child;
  }

  opCtx(): OpContext {
    return { cwd: this.state.cwd, creds: this.state.creds, umask: this.state.umask };
  }

  resolve(path: string): string {
    return resolvePath(this.state.cwd, path);
  }

  errorPrefix(): string {
    if (this.interactiveTree) return 'bash: ';
    return `${this.state.arg0}: line ${this.state.lineno}: `;
  }

  async printError(io: IO, message: string): Promise<void> {
    try {
      await io.stderr.write(`${this.errorPrefix()}${message}\n`);
    } catch {
      // stderr is gone; nothing to do
    }
  }

  // ---------------------------------------------------------------------------
  // Parameters

  getParam(name: string): string | undefined {
    const st = this.state;
    switch (name) {
      case '?':
        return String(st.lastStatus);
      case '$':
        return String(st.pid);
      case '!':
        return st.lastBgPid === null ? undefined : String(st.lastBgPid);
      case '#':
        return String(st.positional.length);
      case '@':
      case '*':
        return st.positional.join(' ');
      case '-':
        return (st.interactive ? 'himBH' : 'hB') + (st.options.errexit ? 'e' : '') + (st.options.xtrace ? 'x' : '') + (st.options.nounset ? 'u' : '') + (st.interactive ? 's' : '');
      case '0':
        return st.arg0;
      case 'RANDOM':
        return String(Math.floor(this.system.random() * 32768));
      case 'SECONDS':
        return String(Math.floor((this.system.now() - st.startTime) / 1000));
      case 'EPOCHSECONDS':
        return String(Math.floor(this.system.now() / 1000));
      case 'LINENO':
        return String(st.lineno);
      case 'BASHPID':
        return String(st.bashPid);
      case 'PPID':
        return String(st.ppid);
      case 'UID':
        return st.vars.get('UID')?.value ?? String(st.creds.uid);
      case 'EUID':
        return st.vars.get('EUID')?.value ?? String(st.creds.uid);
    }
    if (/^[0-9]+$/.test(name)) {
      const n = parseInt(name, 10);
      return st.positional[n - 1];
    }
    return st.get(name);
  }

  /** Assign a variable (throws ReadonlyError). */
  setVar(name: string, value: string): void {
    const v = this.state.getVar(name);
    if (v?.integer) {
      value = String(evaluateArithmetic(value, this.arithEnv()));
    }
    this.state.set(name, value);
    if (name === 'PWD' || name === 'OLDPWD') return;
  }

  arithEnv() {
    return {
      get: (n: string) => this.getParam(n),
      set: (n: string, v: string) => this.setVar(n, v),
    };
  }

  expandTilde(user: string): string | null {
    if (user === '') {
      const home = this.state.get('HOME');
      if (home !== undefined) return home;
      return this.system.userByUid(this.state.creds.uid)?.home ?? '/';
    }
    if (user === '+') return this.state.get('PWD') ?? this.state.cwd;
    if (user === '-') return this.state.get('OLDPWD') ?? null;
    const u = this.system.userByName(user);
    return u ? u.home : null;
  }

  // ---------------------------------------------------------------------------
  // Running source text

  /** Parse and run a string (used by -c, eval, source and scripts). */
  async runSource(src: string, io: IO, opts: { lineOffset?: number } = {}): Promise<number> {
    let script: Script;
    try {
      script = parse(src, { aliases: this.state.options.expand_aliases ? this.state.aliases : undefined });
    } catch (e) {
      if (e instanceof ParseError) {
        this.state.lineno = (opts.lineOffset ?? 0) + e.line;
        await this.printError(io, e.message);
        if (!this.interactiveTree) {
          const lines = src.split('\n');
          const bad = lines[e.line - 1];
          if (bad !== undefined && e.token) await this.printError(io, `\`${bad.trim()}'`);
        }
        return 2;
      }
      if (e instanceof IncompleteInputError) {
        this.state.lineno = src.split('\n').length;
        await this.printError(io, `syntax error: unexpected end of file`);
        return 2;
      }
      throw e;
    }
    return this.execScript(script, io);
  }

  async tick(io: IO): Promise<void> {
    if (++this.steps % 256 === 0) await yieldToEventLoop();
    await io.job.checkpoint();
  }

  // ---------------------------------------------------------------------------
  // Lists, and-or lists, pipelines

  async execScript(script: Script, io: IO): Promise<number> {
    let status = 0;
    for (const item of script.items) {
      await this.tick(io);
      if (item.background) {
        status = this.launchBackground(item, io);
      } else {
        status = await this.execAndOr(item.node, io);
      }
      this.state.lastStatus = status;
      if (this.state.options.errexit && status !== 0 && this.condDepth === 0 && !item.background) {
        throw new ExitException(status);
      }
    }
    return status;
  }

  async execAndOr(node: AndOr, io: IO): Promise<number> {
    if (node.rest.length === 0) return this.execPipeline(node.first, io);
    this.condDepth++;
    let status: number;
    try {
      status = await this.execPipeline(node.first, io);
    } finally {
      this.condDepth--;
    }
    for (let i = 0; i < node.rest.length; i++) {
      const { op, pipeline } = node.rest[i];
      this.state.lastStatus = status;
      if (op === '&&' && status !== 0) continue;
      if (op === '||' && status === 0) continue;
      const last = i === node.rest.length - 1;
      if (!last) this.condDepth++;
      try {
        status = await this.execPipeline(pipeline, io);
      } finally {
        if (!last) this.condDepth--;
      }
    }
    return status;
  }

  private launchBackground(item: ListItem, io: IO): number {
    const pid = this.system.processes.allocPid();
    const job = new Job(pid, item.source);
    job.background = true;
    const child = this.subshell();
    const bio = io.clone(job);
    const stdin = bio.fds.get(0);
    if (stdin instanceof TtyInput) bio.fds.set(0, new TtyInput(stdin.tty, job));
    job.done = (async () => {
      let status: number;
      try {
        status = await child.execAndOr(item.node, bio);
      } catch (e) {
        if (e instanceof ExitException) status = e.status;
        else if (e instanceof SignalError) {
          status = e.status;
          if (!job.termSignal && !(e instanceof BrokenPipeError)) job.termSignal = e.signal;
        } else {
          console.error(e);
          status = 1;
        }
      }
      job.finish(status);
      return status;
    })();
    this.jobs.add(job);
    this.state.lastBgPid = pid;
    if (this.state.interactive) {
      void io.stderr.write(`[${job.id}] ${pid}\n`).catch(() => {});
    }
    return 0;
  }

  async execPipeline(p: Pipeline, io: IO): Promise<number> {
    const start = this.system.now();
    let status: number;
    if (p.negate) this.condDepth++;
    try {
      if (p.commands.length === 1) {
        status = await this.execCommand(p.commands[0], io);
      } else {
        status = await this.execMulti(p, io);
      }
    } finally {
      if (p.negate) this.condDepth--;
    }
    if (p.negate) status = status === 0 ? 1 : 0;
    if (p.timed) {
      const secs = (this.system.now() - start) / 1000;
      const m = Math.floor(secs / 60);
      const s = (secs - m * 60).toFixed(3);
      await io.stderr.write(`\nreal\t${m}m${s}s\nuser\t0m0.001s\nsys\t0m0.000s\n`).catch(() => {});
    }
    return status;
  }

  private async execMulti(p: Pipeline, io: IO): Promise<number> {
    const n = p.commands.length;
    const pipes: Pipe[] = [];
    for (let i = 0; i < n - 1; i++) pipes.push(new Pipe());
    const runs = p.commands.map(async (cmd, i) => {
      const cio = io.clone();
      if (i > 0) cio.fds.set(0, pipes[i - 1].reader);
      if (i < n - 1) {
        cio.fds.set(1, pipes[i].writer);
        if (p.pipeStderr[i]) cio.fds.set(2, pipes[i].writer);
      }
      const child = this.subshell();
      try {
        return await child.execCommand(cmd, cio);
      } catch (e) {
        if (e instanceof ExitException) return e.status;
        if (e instanceof SignalError) {
          if (io.job.signal.aborted) throw e;
          return e.status;
        }
        throw e;
      } finally {
        if (i > 0) pipes[i - 1].reader.close();
        if (i < n - 1) pipes[i].writer.close();
      }
    });
    const settled = await Promise.allSettled(runs);
    const statuses: number[] = [];
    for (const r of settled) {
      if (r.status === 'rejected') throw r.reason;
      statuses.push(r.value);
    }
    this.state.set('PIPESTATUS', statuses.join(' '));
    if (this.state.options.pipefail) {
      for (let i = statuses.length - 1; i >= 0; i--) if (statuses[i] !== 0) return statuses[i];
      return 0;
    }
    return statuses[statuses.length - 1];
  }

  // ---------------------------------------------------------------------------
  // Commands

  async execCommand(cmd: Command, io: IO): Promise<number> {
    if (cmd.type === 'simple') return this.execSimple(cmd, io);
    if (cmd.type === 'function') {
      this.state.functions.set(cmd.name, cmd);
      return 0;
    }
    let rio: IO;
    try {
      rio = await this.applyRedirects(cmd.redirects, io);
    } catch (e) {
      return this.reportRedirectFailure(e, io);
    }
    switch (cmd.type) {
      case 'group':
        return this.execScript(cmd.body, rio);
      case 'subshell': {
        const child = this.subshell();
        try {
          return await child.execScript(cmd.body, rio);
        } catch (e) {
          if (e instanceof ExitException) return e.status;
          throw e;
        }
      }
      case 'if': {
        for (const clause of cmd.clauses) {
          this.condDepth++;
          let c: number;
          try {
            c = await this.execScript(clause.cond, rio);
          } finally {
            this.condDepth--;
          }
          if (c === 0) return this.execScript(clause.body, rio);
        }
        if (cmd.elseBody) return this.execScript(cmd.elseBody, rio);
        return 0;
      }
      case 'while':
        return this.execWhile(cmd.cond, cmd.body, cmd.until, rio);
      case 'for': {
        let items: string[];
        try {
          items = cmd.words ? await expandWords(this, cmd.words, rio) : [...this.state.positional];
        } catch (e) {
          return this.reportExpansionError(e, rio);
        }
        let status = 0;
        this.loopDepth++;
        try {
          for (const item of items) {
            await this.tick(rio);
            try {
              this.setVar(cmd.name, item);
            } catch (e) {
              if (e instanceof ReadonlyError) {
                await this.printError(rio, e.message);
                return 1;
              }
              throw e;
            }
            try {
              status = await this.execScript(cmd.body, rio);
            } catch (e) {
              if (e instanceof BreakException) {
                if (e.levels > 1) {
                  e.levels--;
                  throw e;
                }
                break;
              }
              if (e instanceof ContinueException) {
                if (e.levels > 1) {
                  e.levels--;
                  throw e;
                }
                continue;
              }
              throw e;
            }
          }
        } finally {
          this.loopDepth--;
        }
        return status;
      }
      case 'arith-for': {
        let status = 0;
        this.loopDepth++;
        try {
          if (cmd.init) await this.arithmetic(cmd.init, rio);
          for (;;) {
            await this.tick(rio);
            if (cmd.cond && (await this.arithmetic(cmd.cond, rio)) === 0) break;
            try {
              status = await this.execScript(cmd.body, rio);
            } catch (e) {
              if (e instanceof BreakException) {
                if (e.levels > 1) {
                  e.levels--;
                  throw e;
                }
                break;
              }
              if (!(e instanceof ContinueException)) throw e;
              if (e.levels > 1) {
                e.levels--;
                throw e;
              }
            }
            if (cmd.step) await this.arithmetic(cmd.step, rio);
          }
        } catch (e) {
          if (e instanceof ExpansionError) return this.reportExpansionError(e, rio);
          throw e;
        } finally {
          this.loopDepth--;
        }
        return status;
      }
      case 'case': {
        let word: string;
        try {
          word = await expandToString(this, cmd.word, rio);
        } catch (e) {
          return this.reportExpansionError(e, rio);
        }
        let status = 0;
        let fallthrough = false;
        for (let i = 0; i < cmd.items.length; i++) {
          const item = cmd.items[i];
          let matched = fallthrough;
          if (!matched) {
            for (const pw of item.patterns) {
              const pat = await expandToPattern(this, pw, rio);
              if (matchPattern(pat, word)) {
                matched = true;
                break;
              }
            }
          }
          if (!matched) continue;
          status = await this.execScript(item.body, rio);
          if (item.terminator === ';;') return status;
          fallthrough = item.terminator === ';&';
        }
        return status;
      }
      case 'arith-cmd': {
        try {
          const v = await this.arithmetic(cmd.expr, rio);
          return v !== 0 ? 0 : 1;
        } catch (e) {
          return this.reportExpansionError(e, rio);
        }
      }
      case 'cond': {
        try {
          return (await this.evalCond(cmd.expr, rio)) ? 0 : 1;
        } catch (e) {
          if (e instanceof ExpansionError) return this.reportExpansionError(e, rio);
          throw e;
        }
      }
    }
  }

  private async execWhile(cond: Script, body: Script, until: boolean, io: IO): Promise<number> {
    let status = 0;
    this.loopDepth++;
    try {
      for (;;) {
        await this.tick(io);
        this.condDepth++;
        let c: number;
        try {
          c = await this.execScript(cond, io);
        } finally {
          this.condDepth--;
        }
        if (until ? c === 0 : c !== 0) break;
        try {
          status = await this.execScript(body, io);
        } catch (e) {
          if (e instanceof BreakException) {
            if (e.levels > 1) {
              e.levels--;
              throw e;
            }
            break;
          }
          if (e instanceof ContinueException) {
            if (e.levels > 1) {
              e.levels--;
              throw e;
            }
            continue;
          }
          throw e;
        }
      }
    } finally {
      this.loopDepth--;
    }
    return status;
  }

  private async reportExpansionError(e: unknown, io: IO): Promise<number> {
    if (e instanceof ExpansionError) {
      await this.printError(io, e.message);
      if (e.fatal && !this.state.interactive) throw new ExitException(1);
      return 1;
    }
    if (e instanceof ReadonlyError) {
      await this.printError(io, e.message);
      return 1;
    }
    if (e instanceof ParseError) {
      await this.printError(io, e.message);
      return 1;
    }
    if (e instanceof IncompleteInputError) {
      await this.printError(io, `unexpected EOF while looking for matching \`${e.reason}'`);
      return 1;
    }
    throw e;
  }

  private async reportRedirectFailure(e: unknown, io: IO): Promise<number> {
    if (e instanceof RedirectError) {
      await this.printError(io, e.message);
      return 1;
    }
    return this.reportExpansionError(e, io);
  }

  private async assignmentValue(a: Assignment, io: IO): Promise<string> {
    if (a.array) {
      const items = await expandWords(this, a.array, io);
      return items.join(' ');
    }
    return a.value ? await expandToString(this, a.value, io) : '';
  }

  private assign(name: string, value: string, append: boolean): void {
    if (append) {
      const v = this.state.getVar(name);
      if (v?.integer) {
        value = String(evaluateArithmetic(`${v.value || 0}+(${value})`, this.arithEnv()));
        this.state.set(name, value);
        return;
      }
      value = (this.getParam(name) ?? '') + value;
    }
    this.setVar(name, value);
  }

  async execSimple(cmd: SimpleCommand, io: IO): Promise<number> {
    await this.tick(io);
    this.state.lineno = cmd.line;
    this.lastCmdSubStatus = null;
    let argv: string[];
    try {
      argv = await expandWords(this, cmd.words, io);
    } catch (e) {
      return this.reportExpansionError(e, io);
    }

    if (argv.length === 0) {
      const shown: string[] = [];
      for (const a of cmd.assignments) {
        try {
          const v = await this.assignmentValue(a, io);
          this.assign(a.name, v, a.append);
          shown.push(`${a.name}${a.append ? '+' : ''}=${v}`);
          if (this.state.options.xtrace) await this.trace(io, [`${a.name}=${shellQuoteForTrace(v)}`]);
        } catch (e) {
          if (e instanceof ArithError) {
            await this.printError(io, `${a.value?.raw ?? ''}: ${e.message}`);
            return 1;
          }
          return this.reportExpansionError(e, io);
        }
      }
      if (cmd.redirects.length > 0) {
        try {
          await this.applyRedirects(cmd.redirects, io);
        } catch (e) {
          return this.reportRedirectFailure(e, io);
        }
      }
      const status = this.lastCmdSubStatus ?? 0;
      this.system.emitExec({ argv: shown, kind: 'assignment', status, uid: this.state.creds.uid, cwd: this.state.cwd });
      return status;
    }

    const temp: [string, string][] = [];
    try {
      for (const a of cmd.assignments) temp.push([a.name, await this.assignmentValue(a, io)]);
    } catch (e) {
      return this.reportExpansionError(e, io);
    }

    if (this.state.options.xtrace) {
      await this.trace(io, [...temp.map(([k, v]) => `${k}=${shellQuoteForTrace(v)}`), ...argv.map(shellQuoteForTrace)]);
    }

    let rio: IO;
    try {
      rio = await this.applyRedirects(cmd.redirects, io);
    } catch (e) {
      const status = await this.reportRedirectFailure(e, io);
      this.system.emitExec({ argv, kind: 'builtin', status, uid: this.state.creds.uid, cwd: this.state.cwd });
      return status;
    }

    const name = argv[0];
    let status: number;
    let kind: 'builtin' | 'function' | 'external' | 'not-found';
    let path: string | undefined;
    const cwdBefore = this.state.cwd;
    const fn = name.includes('/') ? undefined : this.state.functions.get(name);
    const builtin = name.includes('/') ? undefined : BUILTINS.get(name);
    if (fn) {
      kind = 'function';
      status = await this.callFunction(fn, argv, temp, rio);
    } else if (builtin) {
      kind = 'builtin';
      status = await this.runBuiltin(builtin, argv, temp, rio);
    } else {
      const found = this.findCommand(name);
      if (!found) {
        kind = 'not-found';
        status = await this.commandNotFound(name, rio);
      } else {
        kind = 'external';
        path = found;
        const env = this.state.exportedEnv();
        for (const [k, v] of temp) env.set(k, v);
        status = await spawnProgram(this, { path: found, argv, env, io: rio, creds: this.state.creds, cwd: this.state.cwd, umask: this.state.umask });
      }
    }
    try {
      this.state.set('_', argv[argv.length - 1]);
    } catch {
      // ignore
    }
    this.system.emitExec({ argv, kind, status, path, uid: this.state.creds.uid, cwd: kind === 'builtin' ? cwdBefore : this.state.cwd });
    return status;
  }

  private async trace(io: IO, words: string[]): Promise<void> {
    const ps4 = this.state.get('PS4') ?? '+ ';
    await io.stderr.write(`${ps4}${words.join(' ')}\n`).catch(() => {});
  }

  /** Locate a command on $PATH (using and filling the hash table). */
  findCommand(name: string): string | null {
    if (name.includes('/')) return name;
    const hashed = this.state.hash.get(name);
    if (hashed) return hashed;
    const found = findInPath(this.system.fs, name, this.state.get('PATH') ?? '', this.opCtx());
    if (found) this.state.hash.set(name, found);
    return found;
  }

  private async commandNotFound(name: string, io: IO): Promise<number> {
    if (this.interactiveTree) {
      const msg = commandNotFoundMessage(this.system, name);
      await io.stderr.write(msg).catch(() => {});
    } else {
      await this.printError(io, `${name}: command not found`);
    }
    return 127;
  }

  async callFunction(fn: FunctionDef, argv: string[], temp: [string, string][], io: IO): Promise<number> {
    const st = this.state;
    if (st.funcNest >= MAX_FUNC_NEST) {
      await this.printError(io, `${fn.name}: maximum function nesting level exceeded (${MAX_FUNC_NEST})`);
      throw new ReturnException(1);
    }
    const savedPositional = st.positional;
    st.positional = argv.slice(1);
    st.funcNest++;
    st.pushScope();
    for (const [k, v] of temp) {
      st.makeLocal(k);
      st.set(k, v, { exported: true });
    }
    const savedLoop = this.loopDepth;
    this.loopDepth = 0;
    try {
      return await this.execCommand(fn.body, io);
    } catch (e) {
      if (e instanceof ReturnException) return e.status;
      throw e;
    } finally {
      this.loopDepth = savedLoop;
      st.popScope();
      st.funcNest--;
      st.positional = savedPositional;
    }
  }

  private async runBuiltin(
    impl: (ctx: BuiltinContext) => Promise<number>,
    argv: string[],
    temp: [string, string][],
    io: IO,
  ): Promise<number> {
    const st = this.state;
    const saved: [string, ReturnType<ShellState['getVar']>][] = [];
    for (const [k, v] of temp) {
      saved.push([k, st.getVar(k) ? { ...st.getVar(k)! } : undefined]);
      try {
        st.set(k, v);
      } catch (e) {
        if (e instanceof ReadonlyError) {
          await this.printError(io, e.message);
          return 1;
        }
        throw e;
      }
    }
    const name = argv[0];
    const ctx: BuiltinContext = {
      sh: this,
      argv,
      args: argv.slice(1),
      name,
      io,
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      out: (s: string) => io.stdout.write(s),
      err: (s: string) => io.stderr.write(s),
      error: (m: string) => this.printError(io, `${name}: ${m}`),
    };
    try {
      return await impl(ctx);
    } catch (e) {
      if (e instanceof WriteError) {
        await this.printError(io, `${name}: write error: ${e.message}`);
        return 1;
      }
      if (e instanceof BrokenPipeError) return 141;
      if (e instanceof ExpansionError || e instanceof ReadonlyError) return this.reportExpansionError(e, io);
      throw e;
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) st.vars.delete(k);
        else st.vars.set(k, v);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Expansion helpers used by expand.ts

  async commandSubstitution(body: Script, io: IO): Promise<string> {
    const child = this.subshell();
    const cap = new CaptureOutput();
    const cio = io.clone();
    cio.fds.set(1, cap);
    let status: number;
    try {
      status = await child.execScript(body, cio);
    } catch (e) {
      if (e instanceof ExitException) status = e.status;
      else throw e;
    }
    this.lastCmdSubStatus = status;
    this.state.lastStatus = status;
    return cap.text().replace(/\n+$/, '');
  }

  async arithmetic(expr: string, io: IO): Promise<number> {
    let text = expr;
    if (/[$`]/.test(expr)) {
      text = await expandToString(this, parseExpandableText(expr, false), io);
    }
    try {
      return evaluateArithmetic(text, this.arithEnv());
    } catch (e) {
      if (e instanceof ArithError) throw new ExpansionError(`${text.trim()}: ${e.message}`);
      if (e instanceof ReadonlyError) throw new ExpansionError(e.message);
      throw e;
    }
  }

  async evalCond(e: CondExpr, io: IO): Promise<boolean> {
    switch (e.type) {
      case 'and':
        return (await this.evalCond(e.left, io)) && (await this.evalCond(e.right, io));
      case 'or':
        return (await this.evalCond(e.left, io)) || (await this.evalCond(e.right, io));
      case 'not':
        return !(await this.evalCond(e.expr, io));
      case 'word':
        return (await expandToString(this, e.word, io)) !== '';
      case 'unary': {
        const arg = await expandToString(this, e.arg, io);
        return unaryTest(this, e.op, arg);
      }
      case 'binary': {
        const left = await expandToString(this, e.left, io);
        if (e.op === '==' || e.op === '=' || e.op === '!=') {
          const pat = await expandToPattern(this, e.right, io);
          const m = matchPattern(pat, left);
          return e.op === '!=' ? !m : m;
        }
        if (e.op === '=~') {
          const src = await expandToPattern(this, e.right, io);
          let re: RegExp;
          try {
            re = new RegExp(posixEreToJs(src));
          } catch {
            return false;
          }
          const m = re.exec(left);
          if (m) this.state.set('BASH_REMATCH', m[0]);
          return m !== null;
        }
        const right = await expandToString(this, e.right, io);
        if (e.op === '<') return left < right;
        if (e.op === '>') return left > right;
        return binaryTest(this, e.op, left, right);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Redirections

  async applyRedirects(redirects: Redirect[], io: IO): Promise<IO> {
    if (redirects.length === 0) return io;
    const out = io.clone();
    for (const r of redirects) {
      if (r.heredoc) {
        const text = r.heredoc.parsed ? await expandToString(this, r.heredoc.parsed, out) : r.heredoc.body;
        out.fds.set(r.fd ?? 0, new StringInput(text));
        continue;
      }
      if (r.op === '<<<') {
        const t = await expandToString(this, r.target, out);
        out.fds.set(r.fd ?? 0, new StringInput(t + '\n'));
        continue;
      }
      const target = await expandRedirectTarget(this, r.target, out);
      if (r.op === '>&' || r.op === '<&') {
        const fd = r.fd ?? (r.op === '>&' ? 1 : 0);
        if (target === '-') {
          out.fds.delete(fd);
          continue;
        }
        if (/^\d+$/.test(target)) {
          const src = out.fds.get(parseInt(target, 10));
          if (!src) throw new RedirectError(`${target}: Bad file descriptor`);
          out.fds.set(fd, src);
          continue;
        }
        if (r.op === '>&' && r.fd === null) {
          const s = this.openOutput(target, false, out);
          out.fds.set(1, s);
          out.fds.set(2, s);
          continue;
        }
        throw new RedirectError(`${target}: ambiguous redirect`);
      }
      switch (r.op) {
        case '<':
        case '<>':
          out.fds.set(r.fd ?? 0, this.openInput(target, out));
          break;
        case '>':
        case '>|':
          out.fds.set(r.fd ?? 1, this.openOutput(target, false, out, r.op === '>' && this.state.options.noclobber));
          break;
        case '>>':
          out.fds.set(r.fd ?? 1, this.openOutput(target, true, out));
          break;
        case '&>':
        case '&>>': {
          const s = this.openOutput(target, r.op === '&>>', out);
          out.fds.set(1, s);
          out.fds.set(2, s);
          break;
        }
        default:
          break;
      }
    }
    return out;
  }

  private openInput(path: string, io: IO): InputStream {
    const fs = this.system.fs;
    const ctx = this.opCtx();
    const node = fs.tryStat(path, ctx);
    if (node?.type === 'chardev') {
      switch (node.device) {
        case 'tty':
          return this.system.tty ? new TtyInput(this.system.tty, io.job) : new NullInput();
        case 'stdin':
          return io.stdin;
        case 'random':
          return new RandomInput(this.system.random);
        default:
          return new NullInput();
      }
    }
    try {
      return new StringInput(fs.readFile(path, ctx));
    } catch (e) {
      if (e instanceof FsError) throw new RedirectError(`${path}: ${e.reason}`);
      throw e;
    }
  }

  private openOutput(path: string, append: boolean, io: IO, noclobber = false): OutputStream {
    const fs = this.system.fs;
    const ctx = this.opCtx();
    try {
      const node = fs.openForWrite(path, ctx, { append, noclobber });
      if (node.type === 'chardev') {
        switch (node.device) {
          case 'tty':
            return this.system.tty ? new TtyOutput(this.system.tty) : new NullOutput();
          case 'stdout':
            return io.stdout;
          case 'stderr':
            return io.stderr;
          default:
            return new NullOutput();
        }
      }
      return new FileOutput(fs, node, this.resolve(path));
    } catch (e) {
      if (e instanceof FsError) {
        if (e.code === 'EEXIST' && noclobber) throw new RedirectError(`${path}: cannot overwrite existing file`);
        throw new RedirectError(`${path}: ${e.reason}`);
      }
      throw e;
    }
  }
}

/** Endless random bytes for /dev/urandom. */
class RandomInput extends InputStream {
  readonly isTTY = false;
  private readonly random: () => number;
  constructor(random: () => number) {
    super();
    this.random = random;
  }
  protected async pull(signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) throw signal.reason;
    await yieldToEventLoop();
    let s = '';
    for (let i = 0; i < 512; i++) s += String.fromCharCode(Math.floor(this.random() * 256));
    return s;
  }
}

/** Convert a POSIX extended regex to a JavaScript one (character classes, word edges). */
export function posixEreToJs(src: string): string {
  return src
    .replace(/\[\[:alpha:\]\]/g, '[A-Za-z]')
    .replace(/\[\[:digit:\]\]/g, '[0-9]')
    .replace(/\[\[:alnum:\]\]/g, '[A-Za-z0-9]')
    .replace(/\[\[:upper:\]\]/g, '[A-Z]')
    .replace(/\[\[:lower:\]\]/g, '[a-z]')
    .replace(/\[\[:space:\]\]/g, '\\s')
    .replace(/\[\[:punct:\]\]/g, '[!-\\/:-@\\[-`{-~]')
    .replace(/\[:alpha:\]/g, 'A-Za-z')
    .replace(/\[:digit:\]/g, '0-9')
    .replace(/\[:alnum:\]/g, 'A-Za-z0-9')
    .replace(/\[:upper:\]/g, 'A-Z')
    .replace(/\[:lower:\]/g, 'a-z')
    .replace(/\[:space:\]/g, '\\s')
    .replace(/\\</g, '\\b')
    .replace(/\\>/g, '\\b');
}
