// The terminal device ("tty") and its line discipline.
//
// In canonical mode (the default) the tty itself echoes what you type,
// handles Backspace/Ctrl+U, turns Ctrl+C into SIGINT and Ctrl+D into
// end-of-file, and hands complete lines to the program. Full-screen programs
// and the shell's line editor switch to raw mode and see every key.

import type { Job } from './process';
import { InputStream, OutputStream, waitFor, type SignalName } from './streams';
import { charWidth } from './wcwidth';

export interface TerminalBackend {
  write(data: string, done?: () => void): void;
  onData(cb: (data: string) => void): () => void;
  readonly cols: number;
  readonly rows: number;
  onResize(cb: (cols: number, rows: number) => void): () => void;
}

export interface TtyModes {
  /** Line-at-a-time input with editing (cooked mode). */
  icanon: boolean;
  /** Echo typed characters. */
  echo: boolean;
  /** Ctrl+C / Ctrl+Z / Ctrl+\ send signals. */
  isig: boolean;
  /** Translate "\n" to "\r\n" on output. */
  opost: boolean;
}

const HIGH_WATER = 256 * 1024;
const LOW_WATER = 32 * 1024;

export class TtyDriver {
  readonly name = 'pts/0';
  modes: TtyModes = { icanon: true, echo: true, isig: true, opost: true };
  /** Process group that receives keyboard signals. */
  foreground: Job | null = null;
  /** Called for keyboard-generated signals (set by the session). */
  onSignal: ((sig: SignalName) => void) | null = null;
  /** Observers of raw input (used by the lesson UI to notice key usage). */
  inputObservers: ((data: string) => void)[] = [];

  private readonly backend: TerminalBackend;
  private lineBuf = '';
  private cooked: (string | null)[] = [];
  private raw: string[] = [];
  private readWaiters: (() => void)[] = [];
  private pendingBytes = 0;
  private drainWaiters: (() => void)[] = [];
  private resizeListeners: ((cols: number, rows: number) => void)[] = [];
  private disposers: (() => void)[] = [];

  constructor(backend: TerminalBackend) {
    this.backend = backend;
    this.disposers.push(backend.onData((d) => this.input(d)));
    this.disposers.push(
      backend.onResize((c, r) => {
        for (const l of [...this.resizeListeners]) l(c, r);
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  get cols(): number {
    return Math.max(10, this.backend.cols);
  }

  get rows(): number {
    return Math.max(4, this.backend.rows);
  }

  onResize(cb: (cols: number, rows: number) => void): () => void {
    this.resizeListeners.push(cb);
    return () => {
      this.resizeListeners = this.resizeListeners.filter((l) => l !== cb);
    };
  }

  getModes(): TtyModes {
    return { ...this.modes };
  }

  setModes(m: Partial<TtyModes>): void {
    const wasCanon = this.modes.icanon;
    this.modes = { ...this.modes, ...m };
    if (wasCanon && !this.modes.icanon) {
      // Typeahead that was being collected as lines becomes raw input.
      for (const l of this.cooked) this.raw.push(l === null ? '\x04' : l);
      if (this.lineBuf) this.raw.push(this.lineBuf);
      this.cooked = [];
      this.lineBuf = '';
    } else if (!wasCanon && this.modes.icanon && this.raw.length > 0) {
      const pending = this.raw.join('');
      this.raw = [];
      this.processCanonical(pending, false);
    }
    this.wakeReaders();
  }

  /** Has the user typed anything that hasn't been read yet? */
  hasPendingInput(): boolean {
    return this.raw.length > 0 || this.cooked.length > 0 || this.lineBuf.length > 0;
  }

  /** Put unconsumed input back at the front of the queue (for typeahead). */
  pushBack(data: string): void {
    if (!data) return;
    if (this.modes.icanon) this.processCanonical(data, false);
    else this.raw.unshift(data);
    this.wakeReaders();
  }

  /** Drop unread input (like tcflush). */
  flushInput(): void {
    this.raw = [];
    this.cooked = [];
    this.lineBuf = '';
  }

  // -------------------------------------------------------------------------
  // Input side

  input(data: string): void {
    for (const o of this.inputObservers) o(data);
    if (!this.modes.icanon) {
      if (this.modes.isig) {
        let rest = '';
        for (const ch of data) {
          const sig = ch === '\x03' ? 'SIGINT' : ch === '\x1a' ? 'SIGTSTP' : ch === '\x1c' ? 'SIGQUIT' : null;
          if (sig) {
            if (rest) this.raw.push(rest);
            rest = '';
            this.raw = [];
            this.signal(sig);
          } else {
            rest += ch;
          }
        }
        if (rest) this.raw.push(rest);
      } else {
        this.raw.push(data);
      }
      this.wakeReaders();
      return;
    }
    this.processCanonical(data, true);
    this.wakeReaders();
  }

  private echo(s: string): void {
    if (this.modes.echo) this.backend.write(s);
  }

  private processCanonical(data: string, live: boolean): void {
    const chars = [...data];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (this.modes.isig && (c === '\x03' || c === '\x1a' || c === '\x1c')) {
        if (live) {
          this.echo(c === '\x03' ? '^C' : c === '\x1a' ? '^Z' : '^\\');
          this.lineBuf = '';
          this.cooked = [];
          this.signal(c === '\x03' ? 'SIGINT' : c === '\x1a' ? 'SIGTSTP' : 'SIGQUIT');
        }
        continue;
      }
      if (c === '\x04') {
        if (this.lineBuf === '') this.cooked.push(null);
        else {
          this.cooked.push(this.lineBuf);
          this.lineBuf = '';
        }
        continue;
      }
      if (c === '\r' || c === '\n') {
        // ICRNL: a typed Return arrives as "\r" and becomes "\n"
        if (c === '\r' && chars[i + 1] === '\n') i++;
        this.echo('\r\n');
        this.cooked.push(this.lineBuf + '\n');
        this.lineBuf = '';
        continue;
      }
      if (c === '\x7f' || c === '\b') {
        if (this.lineBuf.length > 0) {
          const cps = [...this.lineBuf];
          const last = cps.pop()!;
          this.lineBuf = cps.join('');
          const w = displayWidthOfEcho(last);
          this.echo('\b \b'.repeat(w));
        }
        continue;
      }
      if (c === '\x15') {
        // Ctrl+U: kill the line
        const w = [...this.lineBuf].reduce((n, ch) => n + displayWidthOfEcho(ch), 0);
        this.echo('\b \b'.repeat(w));
        this.lineBuf = '';
        continue;
      }
      if (c === '\x17') {
        // Ctrl+W: erase a word
        const m = /(\s*\S+\s*|\s+)$/.exec(this.lineBuf);
        if (m) {
          const w = [...m[0]].reduce((n, ch) => n + displayWidthOfEcho(ch), 0);
          this.echo('\b \b'.repeat(w));
          this.lineBuf = this.lineBuf.slice(0, this.lineBuf.length - m[0].length);
        }
        continue;
      }
      this.lineBuf += c;
      if (live) this.echo(echoForm(c));
    }
  }

  private signal(sig: SignalName): void {
    this.onSignal?.(sig);
  }

  private wakeReaders(): void {
    const fns = this.readWaiters.splice(0, this.readWaiters.length);
    for (const fn of fns) fn();
  }

  /** Canonical read: a line ending in "\n", a partial line (Ctrl+D), or null for EOF. */
  async readLine(signal?: AbortSignal): Promise<string | null> {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      if (!this.modes.icanon) {
        const chunk = await this.readRaw(signal);
        return chunk;
      }
      if (this.cooked.length > 0) return this.cooked.shift()!;
      await waitFor(this.readWaiters, signal);
    }
  }

  /** Raw read: everything typed since the last read. */
  async readRaw(signal?: AbortSignal): Promise<string> {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      if (this.raw.length > 0) {
        const s = this.raw.join('');
        this.raw = [];
        return s;
      }
      await waitFor(this.readWaiters, signal);
    }
  }

  // -------------------------------------------------------------------------
  // Output side

  write(data: string): Promise<void> {
    if (data === '') return Promise.resolve();
    const out = this.modes.opost ? data.replace(/\r?\n/g, '\r\n') : data;
    this.pendingBytes += out.length;
    this.backend.write(out, () => {
      this.pendingBytes -= out.length;
      if (this.pendingBytes <= LOW_WATER) {
        const fns = this.drainWaiters.splice(0, this.drainWaiters.length);
        for (const fn of fns) fn();
      }
    });
    if (this.pendingBytes > HIGH_WATER) {
      return new Promise((resolve) => this.drainWaiters.push(resolve));
    }
    return Promise.resolve();
  }

  /** Write bypassing output translation (for full-screen programs). */
  writeRaw(data: string): Promise<void> {
    const saved = this.modes.opost;
    this.modes.opost = false;
    const p = this.write(data);
    this.modes.opost = saved;
    return p;
  }
}

function echoForm(c: string): string {
  const code = c.codePointAt(0)!;
  if (c === '\t') return c;
  if (code < 0x20) return '^' + String.fromCharCode(code + 64);
  if (code === 0x7f) return '^?';
  return c;
}

function displayWidthOfEcho(c: string): number {
  const code = c.codePointAt(0)!;
  if (code < 0x20 || code === 0x7f) return c === '\t' ? 1 : 2;
  return Math.max(1, charWidth(code));
}

/** stdin attached to the terminal. Background jobs that read it get stopped (SIGTTIN). */
export class TtyInput extends InputStream {
  readonly isTTY = true;
  readonly tty: TtyDriver;
  private readonly job: Job | null;
  constructor(tty: TtyDriver, job: Job | null) {
    super();
    this.tty = tty;
    this.job = job;
  }
  protected async pull(signal?: AbortSignal): Promise<string | null> {
    if (this.job && this.tty.foreground !== this.job) {
      this.job.stop('SIGTTIN');
      await this.job.checkpoint();
    }
    return this.tty.readLine(signal);
  }
}

export class TtyOutput extends OutputStream {
  readonly isTTY = true;
  readonly tty: TtyDriver;
  constructor(tty: TtyDriver) {
    super();
    this.tty = tty;
  }
  async write(data: string): Promise<void> {
    await this.tty.write(data);
  }
}
