// Processes and jobs. A Job is a process group (one command line or one
// `&` item); a Proc is one running program inside it. Both act as "gates":
// running code calls checkpoint() to notice kills and to pause while stopped.

import { SignalError, throwIfAborted, waitFor, type ProcessGate, type SignalName } from './streams';

const TERMINATING = new Set<SignalName>([
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGKILL',
  'SIGUSR1',
  'SIGUSR2',
  'SIGPIPE',
  'SIGALRM',
  'SIGTERM',
]);
const STOPPING = new Set<SignalName>(['SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU']);

export type JobState = 'running' | 'stopped' | 'done';

export class Job implements ProcessGate {
  /** Job number (%1). 0 until registered in a job table. */
  id = 0;
  readonly leaderPid: number;
  private leaderTaken = false;
  command: string;
  readonly procs = new Set<Proc>();
  state: JobState = 'running';
  status: number | null = null;
  /** Signal that terminated the job, if any. */
  termSignal: SignalName | null = null;
  stopSignal: SignalName | null = null;
  background = false;
  /** Last state that the shell has told the user about. */
  reportedState: JobState | null = null;
  done: Promise<number> = Promise.resolve(0);
  private readonly controller = new AbortController();
  private contWaiters: (() => void)[] = [];
  private listeners: ((job: Job) => void)[] = [];

  constructor(leaderPid: number, command: string) {
    this.leaderPid = leaderPid;
    this.command = command;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The first process started in the job gets the job's PID (like bash's pgid). */
  takeLeaderPid(): number | null {
    if (this.leaderTaken) return null;
    this.leaderTaken = true;
    return this.leaderPid;
  }

  async checkpoint(): Promise<void> {
    for (;;) {
      throwIfAborted(this.signal);
      if (this.state !== 'stopped') return;
      await waitFor(this.contWaiters, this.signal);
    }
  }

  waitForContinue(signal: AbortSignal): Promise<void> {
    return waitFor(this.contWaiters, signal);
  }

  /** Deliver a signal to the whole process group. */
  kill(sig: SignalName): void {
    if (this.state === 'done') return;
    if (STOPPING.has(sig)) {
      this.stop(sig);
      return;
    }
    if (sig === 'SIGCONT') {
      this.cont();
      return;
    }
    if (!TERMINATING.has(sig)) return;
    let handled = false;
    for (const p of this.procs) {
      if (sig !== 'SIGKILL' && p.handles(sig)) handled = true;
      p.kill(sig);
    }
    if (handled) return;
    this.termSignal = sig;
    this.controller.abort(new SignalError(sig));
    this.wakeContinue();
  }

  stop(sig: SignalName = 'SIGTSTP'): void {
    if (this.state !== 'running') return;
    this.state = 'stopped';
    this.stopSignal = sig;
    for (const p of this.procs) p.state = 'T';
    this.emit();
  }

  cont(): void {
    if (this.state !== 'stopped') return;
    this.state = 'running';
    this.stopSignal = null;
    for (const p of this.procs) p.state = 'S';
    this.wakeContinue();
    this.emit();
  }

  finish(status: number): void {
    this.state = 'done';
    this.status = status;
    this.emit();
  }

  private wakeContinue(): void {
    const fns = this.contWaiters.splice(0, this.contWaiters.length);
    for (const fn of fns) fn();
  }

  onChange(fn: (job: Job) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(): void {
    for (const l of [...this.listeners]) l(this);
  }
}

export interface ProcInit {
  pid: number;
  ppid: number;
  job: Job;
  argv: string[];
  uid: number;
  tty: string | null;
  startTime: number;
}

export class Proc implements ProcessGate {
  readonly pid: number;
  readonly ppid: number;
  readonly job: Job;
  argv: string[];
  readonly uid: number;
  readonly tty: string | null;
  readonly startTime: number;
  /** ps STAT letter: R running, S sleeping, T stopped. */
  state: 'R' | 'S' | 'T' | 'Z' = 'S';
  private readonly controller = new AbortController();
  private handlers = new Map<SignalName, (sig: SignalName) => void>();
  private stopped = false;
  private contWaiters: (() => void)[] = [];

  constructor(init: ProcInit) {
    this.pid = init.pid;
    this.ppid = init.ppid;
    this.job = init.job;
    this.argv = init.argv;
    this.uid = init.uid;
    this.tty = init.tty;
    this.startTime = init.startTime;
    const js = init.job.signal;
    if (js.aborted) this.controller.abort(js.reason);
    else js.addEventListener('abort', () => this.controller.abort(js.reason), { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get commandLine(): string {
    return this.argv.join(' ');
  }

  handles(sig: SignalName): boolean {
    return this.handlers.has(sig);
  }

  /** Install a handler; the signal will no longer kill the process. */
  onSignal(sig: SignalName, fn: (sig: SignalName) => void): () => void {
    this.handlers.set(sig, fn);
    return () => {
      if (this.handlers.get(sig) === fn) this.handlers.delete(sig);
    };
  }

  kill(sig: SignalName): void {
    if (STOPPING.has(sig)) {
      this.stopped = true;
      this.state = 'T';
      return;
    }
    if (sig === 'SIGCONT') {
      this.stopped = false;
      this.state = 'S';
      const fns = this.contWaiters.splice(0, this.contWaiters.length);
      for (const fn of fns) fn();
      return;
    }
    if (!TERMINATING.has(sig)) return;
    const handler = sig === 'SIGKILL' ? undefined : this.handlers.get(sig);
    if (handler) {
      handler(sig);
      return;
    }
    this.controller.abort(new SignalError(sig));
    const fns = this.contWaiters.splice(0, this.contWaiters.length);
    for (const fn of fns) fn();
  }

  async checkpoint(): Promise<void> {
    for (;;) {
      throwIfAborted(this.signal);
      if (this.stopped) {
        await waitFor(this.contWaiters, this.signal);
        continue;
      }
      if (this.job.state === 'stopped') {
        await this.job.waitForContinue(this.signal);
        continue;
      }
      return;
    }
  }
}

/** A long-lived process shown by `ps aux` (systemd, sshd, ...). */
export interface StaticProcess {
  pid: number;
  ppid: number;
  user: string;
  command: string;
  tty: string | null;
  vsz: number;
  rss: number;
  stat: string;
  start: number;
}

export class ProcessTable {
  private readonly live = new Map<number, Proc>();
  private nextPid: number;
  readonly staticProcs: StaticProcess[] = [];

  constructor(firstPid = 1200) {
    this.nextPid = firstPid;
  }

  allocPid(): number {
    const pid = this.nextPid++;
    if (this.nextPid > 4194304) this.nextPid = 300;
    return pid;
  }

  add(p: Proc): void {
    this.live.set(p.pid, p);
  }

  remove(p: Proc): void {
    if (this.live.get(p.pid) === p) this.live.delete(p.pid);
  }

  get(pid: number): Proc | undefined {
    return this.live.get(pid);
  }

  list(): Proc[] {
    return [...this.live.values()].sort((a, b) => a.pid - b.pid);
  }

  get size(): number {
    return this.live.size;
  }
}
