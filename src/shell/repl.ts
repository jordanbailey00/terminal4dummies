// The interactive read-eval-print loop: prompt, read a command (with
// continuation lines and history expansion), run it as a foreground job,
// handle Ctrl+C / Ctrl+Z, and report background job changes.

import { completeLine } from './complete';
import { ExitException } from './control';
import { expandToString } from './expand';
import { History, HistoryExpansionError, expandHistory } from './history';
import { IO } from './io';
import type { Shell } from './interpreter';
import { formatJobLine } from './jobs';
import { IncompleteInputError, ParseError, parse, parseExpandableText } from './parser/parser';
import { Job } from './process';
import { LineEditor } from './readline';
import { CaptureOutput, SignalError, TeeOutput } from './streams';
import type { ExecEvent, System } from './system';
import { TtyInput, TtyOutput, type TtyDriver } from './tty';
import { DAYS, MONTHS, pad2 } from './commands/util';
import { tildify } from './vfs/path';
import { stripAnsi } from './wcwidth';

export interface CommandEvent {
  line: string;
  status: number;
  /** Everything the command printed to the terminal (escape codes removed). */
  output: string;
  cwdBefore: string;
  cwdAfter: string;
  execs: ExecEvent[];
  /** The command ended because of Ctrl+C. */
  interrupted: boolean;
  /** The command was stopped with Ctrl+Z. */
  stopped: boolean;
  /** The line could not be parsed. */
  syntaxError: boolean;
  /** User the command ran as (changes inside `sudo -i`). */
  uid: number;
  /** Nesting level: 0 for the main shell, 1+ inside `bash`, `sudo -i`... */
  depth: number;
}

export class Repl {
  readonly system: System;
  readonly tty: TtyDriver;
  readonly shell: Shell;
  readonly history: History;
  readonly editor: LineEditor;
  readonly depth: number;
  private commandCount = 1;
  busy = false;
  stopped = false;

  constructor(opts: { system: System; tty: TtyDriver; shell: Shell; history: History; depth?: number }) {
    this.system = opts.system;
    this.tty = opts.tty;
    this.shell = opts.shell;
    this.history = opts.history;
    this.depth = opts.depth ?? 0;
    this.shell.history = this.history;
    this.editor = new LineEditor({
      tty: this.tty,
      history: this.history,
      complete: async (line, cursor) => completeLine(this.shell, line, cursor),
      onEvent: (e) => this.system.hooks.onEditorEvent?.(e),
    });
  }

  private async print(s: string): Promise<void> {
    await this.tty.write(s);
  }

  /** Source a file in the shell (like ~/.bashrc at startup). */
  async source(path: string): Promise<void> {
    const sh = this.shell;
    if (!this.system.fs.isFile(path, sh.opCtx())) return;
    const job = new Job(this.system.processes.allocPid(), `source ${path}`);
    const out = new TtyOutput(this.tty);
    const io = IO.of(job, new TtyInput(this.tty, job), out, out);
    const prevFg = this.tty.foreground;
    this.tty.foreground = job;
    try {
      sh.sourceDepth++;
      await sh.runSource(this.system.fs.readFile(path, sh.opCtx()), io);
    } catch (e) {
      if (!(e instanceof SignalError) && !(e instanceof ExitException)) console.error(e);
    } finally {
      sh.sourceDepth--;
      this.tty.foreground = prevFg;
    }
  }

  /** Run until the shell exits. Returns the exit status. */
  async run(): Promise<number> {
    while (!this.stopped) {
      await this.reportJobs();
      const input = await this.readCommand();
      if (this.stopped) break;
      if (input === null) {
        if (this.shell.jobs.stoppedCount() > 0 && !this.shell.warnedStoppedJobs) {
          this.shell.warnedStoppedJobs = true;
          await this.print('There are stopped jobs.\n');
          continue;
        }
        await this.print(this.depth > 0 ? 'logout\n' : 'exit\n');
        this.hangup();
        return this.shell.state.lastStatus;
      }
      if (input.trim() === '') continue;
      const exit = await this.execute(input);
      if (exit !== null) {
        this.hangup();
        return exit;
      }
    }
    return this.shell.state.lastStatus;
  }

  private hangup(): void {
    for (const j of this.shell.jobs.all()) j.kill('SIGHUP');
  }

  async reportJobs(): Promise<void> {
    const jobs = this.shell.jobs;
    for (const job of jobs.all()) {
      if (job.state === 'done' && job.reportedState !== 'done') {
        job.reportedState = 'done';
        await this.print(formatJobLine(job, jobs.marker(job)) + '\n');
        jobs.remove(job);
      } else if (job.state === 'stopped' && job.reportedState !== 'stopped') {
        job.reportedState = 'stopped';
        await this.print(formatJobLine(job, jobs.marker(job)) + '\n');
      } else if (job.state === 'done') {
        jobs.remove(job);
      }
    }
  }

  /** Expand PS1/PS2 the way bash does: backslash escapes, then $-expansions. */
  async expandPrompt(ps: string): Promise<string> {
    const sh = this.shell;
    const st = sh.state;
    const now = new Date(this.system.now());
    const home = st.get('HOME') ?? '';
    const pwd = st.get('PWD') ?? st.cwd;
    let out = '';
    for (let i = 0; i < ps.length; i++) {
      const c = ps[i];
      if (c !== '\\' || i + 1 >= ps.length) {
        out += c;
        continue;
      }
      const n = ps[++i];
      switch (n) {
        case 'u':
          out += this.system.userName(st.creds.uid);
          break;
        case 'h':
          out += this.system.hostname.split('.')[0];
          break;
        case 'H':
          out += this.system.hostname;
          break;
        case 'w':
          out += tildify(pwd, home);
          break;
        case 'W': {
          const t = tildify(pwd, home);
          out += t === '~' || t === '/' ? t : t.slice(t.lastIndexOf('/') + 1);
          break;
        }
        case '$':
          out += st.creds.uid === 0 ? '#' : '$';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 'a':
          out += '\x07';
          break;
        case 'e':
          out += '\x1b';
          break;
        case 'd':
          out += `${DAYS[now.getDay()]} ${MONTHS[now.getMonth()]} ${pad2(now.getDate())}`;
          break;
        case 't':
          out += `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
          break;
        case 'T':
          out += `${pad2(now.getHours() % 12 || 12)}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
          break;
        case '@':
          out += `${pad2(now.getHours() % 12 || 12)}:${pad2(now.getMinutes())} ${now.getHours() < 12 ? 'AM' : 'PM'}`;
          break;
        case 'A':
          out += `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
          break;
        case 's':
          out += 'bash';
          break;
        case 'v':
          out += '5.2';
          break;
        case 'V':
          out += '5.2.21';
          break;
        case 'j':
          out += String(sh.jobs.size);
          break;
        case 'l':
          out += '0';
          break;
        case '!':
          out += String(this.history.last + 1);
          break;
        case '#':
          out += String(this.commandCount);
          break;
        case '[':
        case ']':
          break;
        case '\\':
          out += '\\';
          break;
        default:
          if (/[0-7]/.test(n)) {
            const m = /^[0-7]{1,3}/.exec(ps.slice(i))!;
            out += String.fromCharCode(parseInt(m[0], 8));
            i += m[0].length - 1;
          } else {
            out += '\\' + n;
          }
      }
    }
    if (out.includes('$') || out.includes('`')) {
      try {
        const job = new Job(0, 'prompt');
        const io = IO.of(job, new TtyInput(this.tty, job), new CaptureOutput(), new CaptureOutput());
        out = await expandToString(sh, parseExpandableText(out, false), io);
      } catch {
        // leave the prompt unexpanded on errors
      }
    }
    const title = /\x1b\]0;([^\x07]*)\x07/.exec(out);
    if (title) this.system.hooks.onTitle?.(title[1]);
    return out;
  }

  /** Read a complete command, using PS2 for continuation lines. Null means EOF. */
  async readCommand(): Promise<string | null> {
    const st = this.shell.state;
    let buffer: string | null = null;
    for (;;) {
      const ps = buffer === null ? st.get('PS1') ?? '$ ' : st.get('PS2') ?? '> ';
      const prompt = await this.expandPrompt(ps);
      this.system.hooks.onPrompt?.(buffer === null);
      const r = await this.editor.readLine(prompt);
      if (this.stopped) return '';
      if (r.kind === 'interrupt') {
        st.lastStatus = 130;
        return '';
      }
      if (r.kind === 'eof') {
        if (buffer !== null) {
          await this.print(`bash: syntax error: unexpected end of file\n`);
          st.lastStatus = 2;
          return '';
        }
        return null;
      }
      let line = r.line;
      if (st.options.histexpand) {
        try {
          const ex = expandHistory(line, this.history);
          if (ex.changed) {
            line = ex.line;
            await this.print(line + '\n');
          }
        } catch (e) {
          if (e instanceof HistoryExpansionError) {
            await this.print(`bash: ${e.message}\n`);
            return '';
          }
          throw e;
        }
      }
      buffer = buffer === null ? line : buffer + '\n' + line;
      try {
        parse(buffer, { aliases: st.aliases });
        return buffer;
      } catch (e) {
        if (e instanceof IncompleteInputError) continue;
        if (e instanceof ParseError) return buffer;
        throw e;
      }
    }
  }

  /** Run one command line. Returns the exit status if the shell exited, else null. */
  async execute(src: string): Promise<number | null> {
    const sys = this.system;
    const sh = this.shell;
    const control = sh.state.get('HISTCONTROL') ?? '';
    this.history.add(src, control);
    this.saveHistoryFile();
    this.commandCount++;
    const job = new Job(sys.processes.allocPid(), src.trim());
    const capture = new CaptureOutput({ limit: 512 * 1024 });
    const out = new TeeOutput(new TtyOutput(this.tty), capture);
    const io = IO.of(job, new TtyInput(this.tty, job), out, out);
    const execs: ExecEvent[] = [];
    const listener = (e: ExecEvent) => {
      if (execs.length < 500) execs.push(e);
    };
    sys.execListeners.push(listener);
    const cwdBefore = sh.state.cwd;
    const prevFg = this.tty.foreground;
    this.tty.foreground = job;
    this.busy = true;
    let status = 0;
    let exited: number | null = null;
    let stopped = false;
    let syntaxError = false;
    try {
      parse(src, { aliases: sh.state.aliases });
    } catch (e) {
      if (e instanceof ParseError) syntaxError = true;
    }
    const run = (async () => {
      try {
        return await sh.runSource(src, io);
      } catch (e) {
        if (e instanceof SignalError) return e.status;
        throw e;
      }
    })();
    let offStop: () => void = () => {};
    const stoppedPromise = new Promise<'stopped'>((resolve) => {
      offStop = job.onChange((j) => {
        if (j.state === 'stopped') resolve('stopped');
      });
    });
    try {
      const outcome = await Promise.race([run.then((s) => ({ s })), stoppedPromise]);
      if (outcome === 'stopped') {
        stopped = true;
        status = 148;
        sh.jobs.add(job);
        job.reportedState = 'stopped';
        await this.print('\n' + formatJobLine(job, sh.jobs.marker(job)) + '\n');
        job.done = run.then(
          (s) => {
            job.finish(s);
            return s;
          },
          (e) => {
            const s = e instanceof ExitException ? e.status : 1;
            job.finish(s);
            return s;
          },
        );
      } else {
        status = outcome.s;
        job.finish(status);
      }
    } catch (e) {
      if (e instanceof ExitException) {
        exited = e.status;
        status = e.status;
      } else {
        console.error(e);
        await this.print(`bash: internal error: ${e instanceof Error ? e.message : String(e)}\n`);
        status = 1;
      }
      job.finish(status);
    } finally {
      offStop();
      this.busy = false;
      if (this.tty.foreground === job) this.tty.foreground = prevFg;
      const idx = sys.execListeners.indexOf(listener);
      if (idx >= 0) sys.execListeners.splice(idx, 1);
    }
    const interrupted = job.termSignal === 'SIGINT';
    if (!stopped) {
      if (interrupted) await this.print('\n');
      else if (job.termSignal === 'SIGTERM') await this.print('Terminated\n');
      else if (job.termSignal === 'SIGKILL') await this.print('Killed\n');
      else if (job.termSignal === 'SIGQUIT') await this.print('Quit (core dumped)\n');
    }
    sh.state.lastStatus = status;
    sys.hooks.onCommand?.({
      line: src,
      status,
      output: stripAnsi(capture.text()),
      cwdBefore,
      cwdAfter: sh.state.cwd,
      execs,
      interrupted,
      stopped,
      syntaxError,
      uid: sh.state.creds.uid,
      depth: this.depth,
    });
    return exited;
  }

  private saveHistoryFile(): void {
    const sh = this.shell;
    const file = sh.state.get('HISTFILE');
    if (!file) return;
    try {
      this.system.fs.writeFile(file, this.history.entries.map((l) => l.replace(/\n/g, ' ')).join('\n') + '\n', sh.opCtx(), { mode: 0o600 });
    } catch {
      // ignore (e.g. read-only home)
    }
  }
}
