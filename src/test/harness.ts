// Test helpers: run commands against a fresh simulated system without a UI.

import { Terminal } from '@xterm/headless';
import { createSystem } from '../shell';
import { CaptureOutput, NullInput, StringInput, type InputStream } from '../shell/streams';
import { IO } from '../shell/io';
import { Job } from '../shell/process';
import { createLoginShell, Session } from '../shell/session';
import type { Shell } from '../shell/interpreter';
import type { System } from '../shell/system';
import type { TerminalBackend } from '../shell/tty';

export const FIXED_NOW = Date.UTC(2026, 9, 21, 15, 30, 0);

export function makeSystem(opts: { samples?: boolean; realTime?: boolean } = {}): System {
  let t = FIXED_NOW;
  return createSystem({
    now: () => t++,
    delay: opts.realTime
      ? undefined
      : async (_ms, signal) => {
          if (signal.aborted) throw signal.reason;
          await new Promise((r) => setTimeout(r, 0));
        },
    random: (() => {
      let s = 12345;
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x80000000;
      };
    })(),
    samples: opts.samples,
  });
}

export interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** A non-interactive shell (like a script) on a fresh or given system. */
export function makeShell(sys: System = makeSystem(), interactive = false): Shell {
  const sh = createLoginShell(sys, 'learner', { interactive });
  return sh;
}

export async function run(sh: Shell, src: string, stdin: InputStream | string = new NullInput()): Promise<RunResult> {
  const out = new CaptureOutput();
  const err = new CaptureOutput();
  const job = new Job(sh.system.processes.allocPid(), src);
  const input = typeof stdin === 'string' ? new StringInput(stdin) : stdin;
  const io = IO.of(job, input, out, err);
  let status: number;
  try {
    status = await sh.runSource(src, io);
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) status = (e as { status: number }).status;
    else throw e;
  }
  return { stdout: out.text(), stderr: err.text(), status };
}

/** One-shot: run a command line on a fresh system. */
export async function sh1(src: string, stdin?: string): Promise<RunResult> {
  return run(makeShell(), src, stdin);
}

/** A headless xterm attached to a full interactive session. */
export class HeadlessTerminal implements TerminalBackend {
  readonly term: Terminal;
  private dataListeners: ((d: string) => void)[] = [];
  private resizeListeners: ((c: number, r: number) => void)[] = [];
  constructor(cols = 80, rows = 24) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  }
  get cols(): number {
    return this.term.cols;
  }
  get rows(): number {
    return this.term.rows;
  }
  write(data: string, done?: () => void): void {
    this.term.write(data, done);
  }
  onData(cb: (d: string) => void): () => void {
    this.dataListeners.push(cb);
    return () => {
      this.dataListeners = this.dataListeners.filter((l) => l !== cb);
    };
  }
  onResize(cb: (c: number, r: number) => void): () => void {
    this.resizeListeners.push(cb);
    return () => {
      this.resizeListeners = this.resizeListeners.filter((l) => l !== cb);
    };
  }
  type(data: string): void {
    for (const l of this.dataListeners) l(data);
  }
  /** Visible screen lines (trailing spaces trimmed). */
  screen(): string[] {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i++) {
      lines.push((buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '').trimEnd());
    }
    return lines;
  }
  /** Entire buffer including scrollback. */
  allText(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push((buf.getLine(i)?.translateToString(true) ?? '').trimEnd());
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }
  cursor(): { x: number; y: number } {
    const buf = this.term.buffer.active;
    return { x: buf.cursorX, y: buf.cursorY };
  }
}

export async function settle(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Wait until a condition holds (polling), failing after a timeout. */
export async function waitFor(cond: () => boolean, timeout = 3000, describe?: () => string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out' + (describe ? ':\n' + describe() : ''));
    await settle(5);
  }
}

export async function startSession(opts: { cols?: number; rows?: number; sys?: System } = {}) {
  const sys = opts.sys ?? makeSystem({ realTime: true });
  const term = new HeadlessTerminal(opts.cols ?? 80, opts.rows ?? 24);
  const session = new Session({ system: sys, backend: term, banner: 'none' });
  void session.start();
  await waitFor(() => /\$\s*$/.test(term.allText()));
  return { sys, term, session };
}
