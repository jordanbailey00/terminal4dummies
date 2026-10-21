// Byte streams between processes: pipes, files, the terminal, captures.
//
// Everything is async so that a pipeline like `yes | head -3` behaves like
// Unix: the writer blocks when the pipe is full and dies with SIGPIPE when
// the reader goes away.

import { FsError, type FileInode, type VirtualFS } from './vfs/fs';

export type SignalName =
  | 'SIGHUP'
  | 'SIGINT'
  | 'SIGQUIT'
  | 'SIGKILL'
  | 'SIGUSR1'
  | 'SIGUSR2'
  | 'SIGPIPE'
  | 'SIGALRM'
  | 'SIGTERM'
  | 'SIGCHLD'
  | 'SIGCONT'
  | 'SIGSTOP'
  | 'SIGTSTP'
  | 'SIGTTIN'
  | 'SIGTTOU'
  | 'SIGWINCH';

export const SIGNAL_NUMBERS: Record<SignalName, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGWINCH: 28,
};

/** Text bash prints when a job dies from a signal. */
export const SIGNAL_DESCRIPTIONS: Partial<Record<SignalName, string>> = {
  SIGHUP: 'Hangup',
  SIGINT: 'Interrupt',
  SIGQUIT: 'Quit',
  SIGKILL: 'Killed',
  SIGUSR1: 'User defined signal 1',
  SIGUSR2: 'User defined signal 2',
  SIGPIPE: 'Broken pipe',
  SIGALRM: 'Alarm clock',
  SIGTERM: 'Terminated',
  SIGSTOP: 'Stopped (signal)',
  SIGTSTP: 'Stopped',
  SIGTTIN: 'Stopped (tty input)',
  SIGTTOU: 'Stopped (tty output)',
};

export function signalByNumber(n: number): SignalName | null {
  for (const [name, num] of Object.entries(SIGNAL_NUMBERS)) if (num === n) return name as SignalName;
  return null;
}

/** Thrown inside a process that has been killed by a signal. */
export class SignalError extends Error {
  readonly signal: SignalName;
  constructor(signal: SignalName) {
    super(signal);
    this.signal = signal;
  }
  get status(): number {
    return 128 + SIGNAL_NUMBERS[this.signal];
  }
}

/** Writing to a pipe nobody reads any more. */
export class BrokenPipeError extends SignalError {
  constructor() {
    super('SIGPIPE');
  }
}

/** A write to a file failed (disk full, permission revoked...). */
export class WriteError extends Error {
  readonly cause: FsError;
  constructor(cause: FsError) {
    super(cause.reason);
    this.cause = cause;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new SignalError('SIGINT');
}

/** Wait until `register`'s callback fires, or reject if the signal aborts. */
export function waitFor(list: (() => void)[], signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      const i = list.indexOf(wake);
      if (i >= 0) list.splice(i, 1);
      reject(signal!.reason);
    };
    const wake = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    list.push(wake);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function wakeAll(list: (() => void)[]): void {
  const fns = list.splice(0, list.length);
  for (const fn of fns) fn();
}

export abstract class InputStream {
  abstract readonly isTTY: boolean;
  private pending = '';

  /** Fetch the next chunk from the underlying source; null at EOF. */
  protected abstract pull(signal?: AbortSignal): Promise<string | null>;

  async read(signal?: AbortSignal): Promise<string | null> {
    if (this.pending) {
      const p = this.pending;
      this.pending = '';
      return p;
    }
    return this.pull(signal);
  }

  /** Push data back so the next read returns it first. */
  unread(data: string): void {
    if (data) this.pending = data + this.pending;
  }

  /** Read one line. Returns it including the trailing "\n" if there was one; null at EOF. */
  async readLine(signal?: AbortSignal): Promise<string | null> {
    let buf = '';
    for (;;) {
      const chunk = await this.read(signal);
      if (chunk === null) return buf === '' ? null : buf;
      const nl = chunk.indexOf('\n');
      if (nl === -1) {
        buf += chunk;
        if (this.isTTY) return buf; // a tty delivers whole lines (or partial on ^D)
        continue;
      }
      buf += chunk.slice(0, nl + 1);
      this.unread(chunk.slice(nl + 1));
      return buf;
    }
  }

  async readAll(signal?: AbortSignal): Promise<string> {
    let out = '';
    for (;;) {
      const chunk = await this.read(signal);
      if (chunk === null) return out;
      out += chunk;
    }
  }

  close(): void {}
}

export abstract class OutputStream {
  abstract readonly isTTY: boolean;
  abstract write(data: string, signal?: AbortSignal): Promise<void>;
  close(): void {}
}

// ---------------------------------------------------------------------------

export class NullInput extends InputStream {
  readonly isTTY = false;
  protected async pull(): Promise<string | null> {
    return null;
  }
}

export class StringInput extends InputStream {
  readonly isTTY = false;
  private data: string | null;
  constructor(data: string) {
    super();
    this.data = data;
  }
  protected async pull(signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal);
    const d = this.data;
    this.data = null;
    return d === '' ? null : d;
  }
}

export class NullOutput extends OutputStream {
  readonly isTTY = false;
  async write(): Promise<void> {}
}

/** Collects everything written (command substitution, tests). */
export class CaptureOutput extends OutputStream {
  readonly isTTY: boolean;
  private chunks: string[] = [];
  private size = 0;
  readonly limit: number;
  constructor(opts: { isTTY?: boolean; limit?: number } = {}) {
    super();
    this.isTTY = opts.isTTY ?? false;
    this.limit = opts.limit ?? 32 * 1024 * 1024;
  }
  async write(data: string): Promise<void> {
    if (this.size + data.length > this.limit) {
      throw new WriteError(new FsError('ENOSPC', 'capture'));
    }
    this.chunks.push(data);
    this.size += data.length;
  }
  text(): string {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join('')];
    return this.chunks[0] ?? '';
  }
}

/** Duplicates writes to two streams (used to record what a command printed). */
export class TeeOutput extends OutputStream {
  readonly isTTY: boolean;
  private readonly a: OutputStream;
  private readonly b: OutputStream;
  constructor(a: OutputStream, b: OutputStream) {
    super();
    this.a = a;
    this.b = b;
    this.isTTY = a.isTTY;
  }
  async write(data: string, signal?: AbortSignal): Promise<void> {
    await this.b.write(data).catch(() => {});
    await this.a.write(data, signal);
  }
}

/** Appends to an open file, like a shell `>`/`>>` redirection. */
export class FileOutput extends OutputStream {
  readonly isTTY = false;
  private readonly fs: VirtualFS;
  private readonly node: FileInode;
  private readonly path: string;
  constructor(fs: VirtualFS, node: FileInode, path: string) {
    super();
    this.fs = fs;
    this.node = node;
    this.path = path;
  }
  async write(data: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    try {
      this.fs.appendToInode(this.node, data, this.path);
    } catch (e) {
      if (e instanceof FsError) throw new WriteError(e);
      throw e;
    }
  }
}

/** A Unix pipe with a bounded buffer. */
export class Pipe {
  static readonly CAPACITY = 64 * 1024;
  chunks: string[] = [];
  size = 0;
  writerClosed = false;
  readerClosed = false;
  readWaiters: (() => void)[] = [];
  writeWaiters: (() => void)[] = [];
  readonly reader: PipeReader;
  readonly writer: PipeWriter;

  constructor() {
    this.reader = new PipeReader(this);
    this.writer = new PipeWriter(this);
  }

  wakeReaders(): void {
    wakeAll(this.readWaiters);
  }
  wakeWriters(): void {
    wakeAll(this.writeWaiters);
  }
}

export class PipeReader extends InputStream {
  readonly isTTY = false;
  private readonly pipe: Pipe;
  constructor(pipe: Pipe) {
    super();
    this.pipe = pipe;
  }
  protected async pull(signal?: AbortSignal): Promise<string | null> {
    const p = this.pipe;
    for (;;) {
      throwIfAborted(signal);
      if (p.chunks.length > 0) {
        const s = p.chunks.length === 1 ? p.chunks[0] : p.chunks.join('');
        p.chunks = [];
        p.size = 0;
        p.wakeWriters();
        return s;
      }
      if (p.writerClosed || p.readerClosed) return null;
      await waitFor(p.readWaiters, signal);
    }
  }
  close(): void {
    const p = this.pipe;
    if (p.readerClosed) return;
    p.readerClosed = true;
    p.chunks = [];
    p.size = 0;
    p.wakeWriters();
    p.wakeReaders();
  }
}

export class PipeWriter extends OutputStream {
  readonly isTTY = false;
  private readonly pipe: Pipe;
  constructor(pipe: Pipe) {
    super();
    this.pipe = pipe;
  }
  async write(data: string, signal?: AbortSignal): Promise<void> {
    const p = this.pipe;
    throwIfAborted(signal);
    if (p.readerClosed) throw new BrokenPipeError();
    if (data === '') return;
    p.chunks.push(data);
    p.size += data.length;
    p.wakeReaders();
    while (p.size > Pipe.CAPACITY && !p.readerClosed) {
      await waitFor(p.writeWaiters, signal);
    }
    if (p.readerClosed) throw new BrokenPipeError();
  }
  close(): void {
    const p = this.pipe;
    if (p.writerClosed) return;
    p.writerClosed = true;
    p.wakeReaders();
  }
}

/**
 * Binds a stream to one process: reads/writes honour the process's kill
 * signal and pause while it is stopped (Ctrl+Z).
 */
export interface ProcessGate {
  readonly signal: AbortSignal;
  checkpoint(): Promise<void>;
}

export class GatedInput extends InputStream {
  readonly inner: InputStream;
  private readonly gate: ProcessGate;
  constructor(inner: InputStream, gate: ProcessGate) {
    super();
    this.inner = inner instanceof GatedInput ? inner.inner : inner;
    this.gate = gate;
  }
  get isTTY(): boolean {
    return this.inner.isTTY;
  }
  protected async pull(): Promise<string | null> {
    return null; // never used: read() is overridden
  }
  async read(): Promise<string | null> {
    await this.gate.checkpoint();
    const r = await this.inner.read(this.gate.signal);
    await this.gate.checkpoint();
    return r;
  }
  unread(data: string): void {
    this.inner.unread(data);
  }
  close(): void {
    this.inner.close();
  }
}

export class GatedOutput extends OutputStream {
  readonly inner: OutputStream;
  private readonly gate: ProcessGate;
  constructor(inner: OutputStream, gate: ProcessGate) {
    super();
    this.inner = inner instanceof GatedOutput ? inner.inner : inner;
    this.gate = gate;
  }
  get isTTY(): boolean {
    return this.inner.isTTY;
  }
  async write(data: string): Promise<void> {
    await this.gate.checkpoint();
    await this.inner.write(data, this.gate.signal);
  }
  close(): void {
    this.inner.close();
  }
}

/** Yield to the browser's event loop so input (Ctrl+C) and rendering can happen. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'undefined') {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(null);
    } else {
      setTimeout(resolve, 0);
    }
  });
}
