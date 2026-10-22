// The interpreter: walks the AST and runs commands the way bash does.

import { ArithError, evaluateArithmetic, type ArithEnv } from './arith';
import { BUILTINS, BUILTIN_HELP, NO_HELP_OPTION, formatBuiltinHelp, type BuiltinContext } from './builtins/registry';
import { commandNotFoundMessage } from './cnf';
import { ExpansionError, expandArrayElements, expandRedirectTarget, expandToPattern, expandToString, expandWords, type ArrayItem } from './expand';
import { spawnProgram, findInPath } from './exec';
import { matchPattern } from './glob';
import { JobTable } from './jobs';
import type { History } from './history';
import { IncompleteInputError, ParseError, parse, parseExpandableText, parseInnerWord } from './parser/parser';
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
import { BadSubscriptError, ReadonlyError, ShellState, cloneVar } from './state';
import {
  BrokenPipeError,
  CaptureOutput,
  FileOutput,
  InputStream,
  NullOutput,
  OutputStream,
  Pipe,
  SignalError,
  StringInput,
  WriteError,
  yieldToEventLoop,
} from './streams';
import type { System } from './system';
import { deviceInput } from './devices';
import { TtyInput, TtyOutput } from './tty';
import { binaryTest, unaryTest } from './builtins/test';
import { encodeBinaryStream } from './vfs/binstream';
import { FsError, type OpContext } from './vfs/fs';
import { resolvePath } from './vfs/path';

export { ExitException, ReturnException, BreakException, ContinueException, RedirectError } from './control';
import { AbortCommand, ExitException, ReturnException, BreakException, ContinueException, RedirectError } from './control';

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
  /** Open process substitutions, closed when the command using them ends. */
  private procSubs: { fd: number; finish: () => Promise<void> }[] = [];

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
    // like bash, a new PATH means remembered command locations are stale
    if (name === 'PATH') this.state.hash.clear();
  }

  arithEnv(): ArithEnv {
    const st = this.state;
    // inside $(( )), subscripts of indexed arrays are arithmetic too
    const key = (n: string, sub: string): string | number => (st.isAssoc(n) ? sub.trim() : evaluateArithmetic(sub, env));
    const env: ArithEnv = {
      get: (n: string) => this.getParam(n),
      set: (n: string, v: string) => this.setVar(n, v),
      getElement: (n: string, sub: string) => st.getElement(n, key(n, sub)) ?? undefined,
      setElement: (n: string, sub: string, v: string) => st.setElement(n, key(n, sub), v, sub),
    };
    return env;
  }

  /** name[sub]=value (and +=). */
  async assignElement(name: string, sub: string, value: string, append: boolean, io: IO): Promise<void> {
    const st = this.state;
    const key = st.isAssoc(name) ? await expandToString(this, parseInnerWord(sub), io) : await this.arithmetic(sub, io);
    const old = st.getElement(name, key) ?? '';
    let v = append ? old + value : value;
    if (st.getVar(name)?.integer) v = String(evaluateArithmetic(append ? `${old || 0}+(${value})` : value, this.arithEnv()));
    st.setElement(name, key, v, sub);
  }

  /** declare 'a=(x y)': assign the text inside the parentheses as an array literal. */
  async assignCompound(name: string, inner: string, append: boolean, io: IO): Promise<void> {
    const script = parse(`__t4d_array=(${inner})`);
    const first = script.items[0]?.node.first.commands[0];
    const a = first?.type === 'simple' ? first.assignments[0] : undefined;
    if (!a?.array || script.items.length !== 1) throw new ExpansionError(`${name}: cannot assign list to array member`);
    await this.assignArray(name, await expandArrayElements(this, a.array, io), append, io);
  }

  /** name=(...) and name+=(...): number the elements (or pair up keys) like bash. */
  async assignArray(name: string, items: ArrayItem[], append: boolean, io: IO): Promise<void> {
    const st = this.state;
    const integer = st.getVar(name)?.integer ?? false;
    const num = (v: string) => (integer ? String(evaluateArithmetic(v, this.arithEnv())) : v);
    if (st.isAssoc(name)) {
      const pairs = new Map<string, string>();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.key !== null) {
          const k = await expandToString(this, parseInnerWord(it.key), io);
          const prev = it.append ? (pairs.get(k) ?? (append ? st.getElement(name, k) : undefined) ?? '') : '';
          pairs.set(k, num(prev + it.value));
        } else {
          // m=(k1 v1 k2 v2): key/value pairs
          const next = items[i + 1];
          const v = next && next.key === null ? next.value : '';
          if (next && next.key === null) i++;
          pairs.set(it.value, num(v));
        }
      }
      st.setArray(name, [...pairs], append);
      return;
    }
    let next = append ? st.nextIndex(name) : 0;
    const pairs = new Map<number, string>();
    for (const it of items) {
      let idx = next;
      if (it.key !== null) {
        idx = await this.arithmetic(it.key, io);
        if (idx < 0) {
          const base = append ? st.nextIndex(name) : Math.max(-1, ...pairs.keys()) + 1;
          if (idx + base < 0) throw new BadSubscriptError(name, it.key);
          idx += base;
        }
      }
      const prev = it.append ? (pairs.get(idx) ?? (append ? st.getElement(name, idx) : undefined) ?? '') : '';
      pairs.set(idx, num(prev + it.value));
      next = idx + 1;
    }
    st.setArray(name, [...pairs], append);
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

  /**
   * Parse and run a string (used by -c, eval, source and scripts). An
   * expansion error abandons the whole string, or with `perLine` (scripts
   * and source) just the rest of that line.
   */
  async runSource(src: string, io: IO, opts: { lineOffset?: number; perLine?: boolean } = {}): Promise<number> {
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
    if (!opts.perLine) return this.abortable(() => this.execScript(script, io));
    let status = 0;
    for (let i = 0; i < script.items.length; ) {
      let j = i;
      while (j < script.items.length - 1 && !script.items[j].endsLine) j++;
      const line: Script = { type: 'script', items: script.items.slice(i, j + 1) };
      status = await this.abortable(() => this.execScript(line, io));
      i = j + 1;
    }
    return status;
  }

  /** Run something that an expansion error may abandon (status 1). */
  async abortable(run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof AbortCommand)) throw e;
      this.state.lastStatus = 1;
      return 1;
    }
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
        else if (e instanceof AbortCommand) status = 1;
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
        this.setPipeStatus([status]);
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

  private setPipeStatus(statuses: number[]): void {
    try {
      this.state.setArray('PIPESTATUS', statuses.map((s, i) => [i, String(s)]));
    } catch {
      // readonly PIPESTATUS: ignore, like bash
    }
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
        if (e instanceof AbortCommand) return 1;
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
    this.setPipeStatus(statuses);
    if (this.state.options.pipefail) {
      for (let i = statuses.length - 1; i >= 0; i--) if (statuses[i] !== 0) return statuses[i];
      return 0;
    }
    return statuses[statuses.length - 1];
  }

  // ---------------------------------------------------------------------------
  // Commands

  async execCommand(cmd: Command, io: IO): Promise<number> {
    const mark = this.procSubs.length;
    try {
      return await this.execCommandInner(cmd, io);
    } finally {
      // like bash, close <(...) files once the command that uses them is done
      while (this.procSubs.length > mark) await this.procSubs.pop()!.finish();
    }
  }

  private async execCommandInner(cmd: Command, io: IO): Promise<number> {
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
          if (e instanceof AbortCommand) return 1;
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
          return this.abortExpansion(e, rio);
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
          if (e instanceof ExpansionError) return this.reportExpansionError(e, rio, '((: ');
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
          return this.abortExpansion(e, rio);
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
          return this.reportExpansionError(e, rio, '((: ');
        }
      }
      case 'cond': {
        try {
          return (await this.evalCond(cmd.expr, rio)) ? 0 : 1;
        } catch (e) {
          if (e instanceof ExpansionError) return this.abortExpansion(e, rio);
          if (e instanceof CondFailed) return 1;
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

  private async reportExpansionError(e: unknown, io: IO, prefix = ''): Promise<number> {
    if (e instanceof ExpansionError) {
      await this.printError(io, prefix + e.message);
      if (e.fatal && !this.state.interactive) throw new ExitException(1, true);
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

  /** Report an error while expanding a command's words, then abandon the line. */
  private async abortExpansion(e: unknown, io: IO): Promise<never> {
    await this.reportExpansionError(e, io);
    throw new AbortCommand();
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
      const items = await expandArrayElements(this, a.array, io);
      return items.map((i) => i.value).join(' ');
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
      return this.abortExpansion(e, io);
    }

    if (argv.length === 0) {
      const shown: string[] = [];
      for (const a of cmd.assignments) {
        try {
          if (a.array) {
            const items = await expandArrayElements(this, a.array, io);
            await this.assignArray(a.name, items, a.append, io);
            shown.push(`${a.name}${a.append ? '+' : ''}=(${items.map((i) => i.value).join(' ')})`);
            if (this.state.options.xtrace) await this.trace(io, [`${a.name}=(${items.map((i) => shellQuoteForTrace(i.value)).join(' ')})`]);
            continue;
          }
          const v = await this.assignmentValue(a, io);
          if (a.index !== undefined) await this.assignElement(a.name, a.index, v, a.append, io);
          else this.assign(a.name, v, a.append);
          shown.push(`${a.name}${a.index !== undefined ? `[${a.index}]` : ''}${a.append ? '+' : ''}=${v}`);
          if (this.state.options.xtrace) await this.trace(io, [`${a.name}${a.index !== undefined ? `[${a.index}]` : ''}=${shellQuoteForTrace(v)}`]);
        } catch (e) {
          if (e instanceof ArithError) {
            await this.printError(io, `${a.value?.raw ?? ''}: ${e.message}`);
            throw new AbortCommand();
          }
          return this.abortExpansion(e, io);
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
      return this.abortExpansion(e, io);
    }

    if (this.state.options.xtrace) {
      await this.trace(io, [...temp.map(([k, v]) => `${k}=${shellQuoteForTrace(v)}`), ...argv.map(shellQuoteForTrace)]);
    }

    let rio: IO;
    try {
      rio = await this.applyRedirects(cmd.redirects, io);
    } catch (e) {
      // like bash, the command never runs (and lesson checks must not count it)
      return this.reportRedirectFailure(e, io);
    }

    if (argv.length === 1 && argv[0] === 'exec' && rio !== io && !this.state.functions.has('exec')) {
      // `exec 3>&1`, `exec > log`: the redirections stay for the commands that follow
      io.fds.clear();
      for (const [fd, stream] of rio.fds) io.fds.set(fd, stream);
      this.system.emitExec({ argv, kind: 'builtin', status: 0, uid: this.state.creds.uid, cwd: this.state.cwd });
      return 0;
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
        // bash hands each program its own path as $_
        env.set('_', found);
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
    const savedFuncname = st.getVar('FUNCNAME');
    // like bash, a script's outermost level is called "main"
    const stack = savedFuncname ? st.entries('FUNCNAME').map(([, v]) => v) : st.inScript ? ['main'] : [];
    st.vars.delete('FUNCNAME');
    st.setArray('FUNCNAME', [fn.name, ...stack].map((v, i) => [i, v]));
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
      if (savedFuncname) st.vars.set('FUNCNAME', cloneVar(savedFuncname));
      else st.vars.delete('FUNCNAME');
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
    const help = BUILTIN_HELP.get(name);
    if (argv[1] === '--help' && help && !NO_HELP_OPTION.has(name)) {
      // bash 5.2: `cd --help` shows the same text as `help cd` (status 2)
      await io.stdout.write(formatBuiltinHelp(name, help)).catch(() => {});
      return 2;
    }
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
      else if (e instanceof AbortCommand) status = 1;
      else throw e;
    }
    this.lastCmdSubStatus = status;
    this.state.lastStatus = status;
    return cap.text().replace(/\n+$/, '');
  }

  /**
   * <(cmd) runs cmd and makes its output readable at /dev/fd/N; >(cmd)
   * makes /dev/fd/N writable and feeds what was written to cmd afterwards.
   * Unlike bash the two sides take turns instead of running concurrently.
   */
  async processSubstitution(dir: '<' | '>', body: Script, io: IO): Promise<string> {
    const fs = this.system.fs;
    const root: OpContext = { cwd: '/', creds: { uid: 0, gid: 0, groups: [0] }, umask: 0o022 };
    const busy = activeProcSubFds(this.system);
    let fd = 63;
    while (busy.has(fd)) fd--;
    const path = `/dev/fd/${fd}`;
    const runChild = async (cio: IO) => {
      try {
        await this.subshell().execScript(body, cio);
      } catch (e) {
        if (!(e instanceof ExitException) && !(e instanceof AbortCommand)) throw e;
      }
    };
    let data = '';
    if (dir === '<') {
      const cap = new CaptureOutput();
      const cio = io.clone();
      cio.fds.set(1, cap);
      await runChild(cio);
      data = cap.text();
    }
    if (!fs.tryStat('/dev/fd', root)) fs.mkdir('/dev/fd', root, 0o755);
    fs.writeFile(path, data, root, { mode: 0o600 });
    fs.chown(path, this.state.creds.uid, this.state.creds.gid, root);
    busy.add(fd);
    this.procSubs.push({
      fd,
      finish: async () => {
        busy.delete(fd);
        let written = '';
        try {
          if (dir === '>') written = fs.readFile(path, root);
          fs.unlink(path, root);
        } catch {
          // already removed
        }
        if (dir === '>') {
          const cio = io.clone();
          cio.fds.set(0, new StringInput(written));
          await runChild(cio);
        }
      },
    });
    return path;
  }

  async arithmetic(expr: string, io: IO): Promise<number> {
    let text = expr;
    if (/[$`]/.test(expr)) {
      text = await expandToString(this, parseExpandableText(expr, false), io);
    }
    try {
      return evaluateArithmetic(text, this.arithEnv());
    } catch (e) {
      if (e instanceof ArithError) throw new ExpansionError(`${text.replace(/^\s+/, '')}: ${e.message}`);
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
          this.state.setArray('BASH_REMATCH', m ? [...m].map((g, i) => [i, g ?? '']) : []);
          return m !== null;
        }
        const right = await expandToString(this, e.right, io);
        if (e.op === '<') return left < right;
        if (e.op === '>') return left > right;
        if (INT_OPS.has(e.op)) {
          // inside [[ ]] both sides of -eq and friends are arithmetic expressions
          const env = this.arithEnv();
          let x: number;
          let y: number;
          let cur = left;
          try {
            x = evaluateArithmetic(left, env);
            cur = right;
            y = evaluateArithmetic(right, env);
          } catch (err) {
            if (!(err instanceof ArithError)) throw err;
            await this.printError(io, `[[: ${cur.replace(/^\s+/, '')}: ${err.message}`);
            throw new CondFailed();
          }
          return binaryTest(this, e.op, String(x), String(y));
        }
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
    if (node?.type === 'chardev') return deviceInput(node.device, { stdin: io.stdin, tty: this.system.tty, job: io.job, random: this.system.random });
    try {
      const data = fs.readData(path, ctx);
      // binary files are passed on encoded, so `gunzip < notes.gz` gets the real data
      return new StringInput(typeof data === 'string' ? data : encodeBinaryStream(data));
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

const INT_OPS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge']);

/** A [[ ]] test hit an arithmetic error (already reported): status 1. */
class CondFailed extends Error {}

const procSubFds = new WeakMap<System, Set<number>>();

/** /dev/fd numbers in use by process substitutions on this machine. */
function activeProcSubFds(system: System): Set<number> {
  let set = procSubFds.get(system);
  if (!set) procSubFds.set(system, (set = new Set()));
  return set;
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
