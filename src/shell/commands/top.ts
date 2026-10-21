// top, htop and watch: live full-screen views of the simulated machine.

import { parseSignalName } from '../builtins/jobs';
import { parseKeys } from '../readline';
import { CaptureOutput, NullInput, SIGNAL_NUMBERS, type SignalName } from '../streams';
import type { TtyDriver, TtyModes } from '../tty';
import type { CommandContext } from '../types';
import { charWidth, stringWidth } from '../wcwidth';
import { processRows, strftime } from './sysinfo';
import { keyName, truncateAnsi, type TuiKey } from './tui';
import { defineCommand, pad2 } from './util';

// ---------------------------------------------------------------------------
// Numbers shared with free, uptime and /proc (keep them in sync).

export const MEM_KB = { total: 4022980, used: 1011204, free: 1825104, shared: 25308, buffers: 73468, cache: 1311484, avail: 3011776, swapTotal: 2097148, swapUsed: 0, swapFree: 2097148 };
export const LOAD_AVG: [number, number, number] = [0.08, 0.03, 0.01];
export const NCPU = 2;

/** "3:17" / "17 min" / "2 days,  3:17" exactly like uptime(1). */
export function uptimeText(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  let s = '';
  if (days) s += `${days} day${days > 1 ? 's' : ''}, `;
  if (hours) s += `${String(hours).padStart(2)}:${pad2(m)}`;
  else s += `${m} min`;
  return s;
}

// ---------------------------------------------------------------------------
// Full-screen helper: raw keys with timeouts, Ctrl+Z suspend/resume, resize.

export function splitKeys(keys: TuiKey[]): TuiKey[] {
  const out: TuiKey[] = [];
  for (const k of keys) {
    if (k.t === 'text') for (const ch of k.s) out.push({ t: 'text', s: ch });
    else out.push(k);
  }
  return out;
}

export interface FullScreenOptions {
  name: string;
  /** Use the alternate screen (like curses programs); top draws on the normal screen. */
  alt?: boolean;
  /** Raw key input (default). sl keeps the line discipline and only turns echo off. */
  raw?: boolean;
  hideCursor?: boolean;
}

export class FullScreen {
  readonly ctx: CommandContext;
  readonly tty: TtyDriver;
  private readonly o: Required<FullScreenOptions>;
  private saved: TtyModes | null = null;
  private shown = false;
  private suspended = false;
  private resized = false;
  private queue: TuiKey[] = [];
  private waiter: AbortController | null = null;
  private pendingWake = false;
  private offs: (() => void)[] = [];

  constructor(ctx: CommandContext, opts: FullScreenOptions) {
    this.ctx = ctx;
    this.tty = ctx.tty!;
    this.o = { alt: true, raw: true, hideCursor: true, ...opts };
  }

  get cols(): number {
    return this.tty.cols;
  }

  get rows(): number {
    return this.tty.rows;
  }

  private isForeground(): boolean {
    return !this.tty.foreground || this.tty.foreground === this.ctx.proc.job;
  }

  async start(): Promise<void> {
    const job = this.ctx.proc.job;
    // Started in the background: curses programs stop with SIGTTOU until `fg`.
    while (!this.isForeground()) {
      job.stop('SIGTTOU');
      await this.ctx.checkpoint();
    }
    this.saved = this.tty.getModes();
    this.offs.push(
      this.tty.onResize(() => {
        this.resized = true;
        this.wake();
      }),
    );
    this.offs.push(
      job.onChange((j) => {
        if (j.state === 'stopped' && this.shown) {
          this.hide();
          this.suspended = true;
          this.wake();
        }
      }),
    );
    this.show();
  }

  private show(): void {
    this.tty.setModes(this.o.raw ? { icanon: false, echo: false, isig: true, opost: false } : { echo: false });
    let s = '';
    if (this.o.alt) s += '\x1b[?1049h';
    if (this.o.hideCursor) s += '\x1b[?25l';
    void this.tty.writeRaw(s + '\x1b[H\x1b[2J');
    this.shown = true;
    this.ctx.system.hooks.onFullscreen?.(this.o.name);
  }

  private hide(): void {
    if (!this.shown) return;
    this.shown = false;
    let s = '\x1b[0m';
    if (this.o.alt) s += '\x1b[2J\x1b[?1049l';
    else s += `\x1b[${this.tty.rows};1H\r\x1b[K`;
    void this.tty.writeRaw(s + '\x1b[?25h');
    if (this.saved) this.tty.setModes(this.saved);
    this.ctx.system.hooks.onFullscreen?.(null);
  }

  /**
   * Call at the top of every loop iteration: waits while stopped (Ctrl+Z) and
   * takes the screen back after `fg`. True means "redraw everything".
   */
  async sync(): Promise<boolean> {
    let redraw = false;
    for (;;) {
      await this.ctx.checkpoint();
      if (!this.suspended) break;
      if (!this.isForeground()) {
        this.ctx.proc.job.stop('SIGTTOU');
        continue;
      }
      this.suspended = false;
      this.show();
      redraw = true;
    }
    if (this.resized) {
      this.resized = false;
      redraw = true;
    }
    return redraw;
  }

  async finish(): Promise<void> {
    for (const off of this.offs) off();
    this.offs = [];
    this.hide();
  }

  write(s: string): Promise<void> {
    if (!this.shown) return Promise.resolve();
    return this.tty.writeRaw(s);
  }

  /** Interrupt a pending key() (signal handlers, resize, suspend). */
  wake(): void {
    if (this.waiter) this.waiter.abort();
    else this.pendingWake = true;
  }

  /** A promise that settles after `ms` milliseconds (or as soon as the program is killed). */
  timer(ms: number): Promise<void> {
    return this.ctx.system.delay(Math.max(0, ms), this.ctx.signal).catch(() => {});
  }

  /**
   * The next key. 'timeout' once `until` (milliseconds, or a timer() promise
   * shared between calls) has passed; null when woken up early by a signal,
   * a resize or Ctrl+Z.
   */
  async key(until: number | Promise<void> | null): Promise<TuiKey | 'timeout' | null> {
    if (this.queue.length) return this.queue.shift()!;
    if (this.pendingWake || this.suspended) {
      this.pendingWake = false;
      return null;
    }
    const ctx = this.ctx;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    this.waiter = ac;
    let timedOut = false;
    try {
      const read = this.tty.readRaw(ac.signal).then(
        (data) => {
          this.queue.push(...splitKeys(parseKeys(data) as TuiKey[]));
        },
        () => {},
      );
      const timer = typeof until === 'number' ? ctx.system.delay(Math.max(0, until), ac.signal).catch(() => {}) : until;
      if (timer === null) await read;
      else
        await Promise.race([
          read,
          timer.then(() => {
            timedOut = true;
          }),
        ]);
      ac.abort();
      await read;
    } finally {
      this.waiter = null;
      ctx.signal.removeEventListener('abort', onAbort);
    }
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (this.queue.length) return this.queue.shift()!;
    return timedOut ? 'timeout' : null;
  }

  /** Line input (for prompts). Null when cancelled with Escape or interrupted. */
  async readLine(draw: (buf: string) => string, opts: { digitsOnly?: boolean } = {}): Promise<string | null> {
    let buf = '';
    for (;;) {
      await this.write(draw(buf) + '\x1b[?25h');
      const k = await this.key(null);
      if (k === null || k === 'timeout') {
        await this.write('\x1b[?25l');
        return null;
      }
      const name = keyName(k);
      if (name === 'enter') {
        await this.write('\x1b[?25l');
        return buf;
      }
      if (name === 'escape' || name === 'C-g') {
        await this.write('\x1b[?25l');
        return null;
      }
      if (name === 'backspace') buf = [...buf].slice(0, -1).join('');
      else if (name === 'C-u') buf = '';
      else if (k.t === 'text' && (!opts.digitsOnly || /[\d.-]/.test(k.s))) buf += k.s;
      else if (k.t === 'paste') buf += k.s.replace(/[\r\n]/g, '');
    }
  }
}

/** A line of styled text that never exceeds the screen width. */
class Line {
  private s = '';
  private w = 0;
  private readonly width: number;
  constructor(width: number) {
    this.width = width;
  }
  get used(): number {
    return this.w;
  }
  add(text: string, sgr = ''): this {
    if (this.w >= this.width || text === '') return this;
    const room = this.width - this.w;
    let t = text;
    if (stringWidth(t) > room) t = truncateAnsi(t, room);
    this.s += sgr ? `${sgr}${t}\x1b[0m` : t;
    this.w += stringWidth(t);
    return this;
  }
  pad(sgr = ''): this {
    if (this.w < this.width) this.add(' '.repeat(this.width - this.w), sgr);
    return this;
  }
  toString(): string {
    return this.s;
  }
}

// ---------------------------------------------------------------------------
// Process sampling shared by top and htop.

interface Task {
  pid: number;
  ppid: number;
  user: string;
  uid: number;
  tty: string;
  /** R, S, T, Z or I. */
  state: string;
  pr: number;
  ni: number;
  virt: number;
  res: number;
  shr: number;
  cpu: number;
  mem: number;
  /** CPU time in hundredths of a second. */
  time: number;
  comm: string;
  cmd: string;
  kernel: boolean;
  self: boolean;
  start: number;
}

interface CpuSample {
  us: number;
  sy: number;
  ni: number;
  id: number;
  wa: number;
  hi: number;
  si: number;
  st: number;
}

const niceValues = new WeakMap<object, Map<number, number>>();

function niceMap(ctx: CommandContext): Map<number, number> {
  let m = niceValues.get(ctx.system);
  if (!m) {
    m = new Map();
    niceValues.set(ctx.system, m);
  }
  return m;
}

/** Programs that keep a CPU busy when left running (yes > /dev/null &). */
const BUSY = new Set(['yes']);

class Sampler {
  private times = new Map<number, number>();
  private last = 0;
  tasks: Task[] = [];
  cpu: CpuSample = { us: 0, sy: 0, ni: 0, id: 100, wa: 0, hi: 0, si: 0, st: 0 };
  perCpu: CpuSample[] = [];
  private readonly ctx: CommandContext;
  private readonly selfCpu: [number, number];
  constructor(ctx: CommandContext, selfCpu: [number, number]) {
    this.ctx = ctx;
    this.selfCpu = selfCpu;
  }

  private rand(): number {
    return this.ctx.system.random();
  }

  sample(): void {
    const ctx = this.ctx;
    const now = ctx.system.now();
    const elapsed = this.last ? Math.max(0, now - this.last) : 0;
    this.last = now;
    const nice = niceMap(ctx);
    const rows = processRows(ctx, ctx.proc.ppid);
    const tasks: Task[] = [];
    for (const r of rows) {
      const kernel = r.vsz === 0 || /^\[.*\]$/.test(r.cmd);
      let state = r.stat[0] ?? 'S';
      if (kernel && state === 'S') state = 'I';
      const self = r.pid === ctx.proc.pid;
      let cpu = 0;
      if (self) cpu = this.selfCpu[0] + this.rand() * (this.selfCpu[1] - this.selfCpu[0]);
      else if (state !== 'T' && BUSY.has(r.comm)) cpu = 97 + this.rand() * 2.9;
      else if (state === 'S' && !kernel && this.rand() < 0.04) cpu = 0.3;
      if (state === 'T' || state === 'Z') cpu = 0;
      if (cpu >= 50 && state === 'S') state = 'R';
      let time = this.times.get(r.pid);
      if (time === undefined) {
        if (r.cmd === '-bash') time = 4 + (r.pid % 7);
        else if (r.pid < 1000) time = Math.floor(((ctx.system.now() - r.start) / 1000) * 0.02 * ((r.pid % 5) + 1));
        else time = Math.floor((cpu / 100) * Math.max(0, now - r.start) / 10);
      }
      time += Math.round(((cpu / 100) * elapsed) / 10);
      this.times.set(r.pid, time);
      const ni = nice.get(r.pid) ?? 0;
      tasks.push({
        pid: r.pid,
        ppid: r.ppid,
        user: r.user,
        uid: r.uid,
        tty: r.tty,
        state,
        pr: kernel && ni === 0 && r.pid < 1000 ? 20 : 20 + ni,
        ni,
        virt: r.vsz,
        res: r.rss,
        shr: kernel ? 0 : Math.floor((r.rss * 0.62) / 4) * 4,
        cpu,
        mem: (r.rss / MEM_KB.total) * 100,
        time,
        comm: r.comm,
        cmd: r.cmd,
        kernel,
        self,
        start: r.start,
      });
    }
    this.tasks = tasks;
    // Summary: per-process %CPU is relative to one CPU; the summary averages all CPUs.
    const per: CpuSample[] = [];
    for (let c = 0; c < NCPU; c++) {
      const busy = tasks.filter((t) => t.pid % NCPU === c).reduce((n, t) => n + t.cpu, 0);
      const us = Math.min(100, busy * 0.9 + this.rand() * 0.7);
      const sy = Math.min(100 - us, busy * 0.08 + this.rand() * 0.5);
      const si = this.rand() < 0.2 ? 0.1 : 0;
      per.push({ us, sy, ni: 0, id: Math.max(0, 100 - us - sy - si), wa: 0, hi: 0, si, st: 0 });
    }
    this.perCpu = per;
    const avg = (k: keyof CpuSample) => per.reduce((n, p) => n + p[k], 0) / per.length;
    this.cpu = { us: avg('us'), sy: avg('sy'), ni: 0, id: avg('id'), wa: 0, hi: 0, si: avg('si'), st: 0 };
  }
}

/** Deliver a signal the way kill(1) does (same permission rules). Returns an error text or null. */
function sendSignal(ctx: CommandContext, pid: number, sig: SignalName): string | null {
  const sys = ctx.system;
  const proc = sys.processes.get(pid);
  if (proc) {
    if (ctx.creds.uid !== 0 && proc.uid !== ctx.creds.uid) return 'Operation not permitted';
    if (proc.job.leaderPid === pid && proc.job.background) proc.job.kill(sig);
    else proc.kill(sig);
    return null;
  }
  const sp = sys.processes.staticProcs.find((p) => p.pid === pid);
  if (sp) return ctx.creds.uid !== 0 ? 'Operation not permitted' : null;
  if (pid === ctx.proc.ppid) return null;
  return 'No such process';
}

function canRenice(ctx: CommandContext, t: Task, value: number): string | null {
  if (ctx.creds.uid !== 0 && t.uid !== ctx.creds.uid) return 'Operation not permitted';
  if (ctx.creds.uid !== 0 && value < t.ni) return 'Permission denied';
  return null;
}

// ---------------------------------------------------------------------------
// top

type TopField = 'PID' | 'USER' | 'PR' | 'NI' | 'VIRT' | 'RES' | 'SHR' | 'S' | '%CPU' | '%MEM' | 'TIME+' | 'COMMAND';
const TOP_FIELDS: TopField[] = ['PID', 'USER', 'PR', 'NI', 'VIRT', 'RES', 'SHR', 'S', '%CPU', '%MEM', 'TIME+', 'COMMAND'];
const TOP_FIELD_NAMES = ['PID', 'PPID', 'UID', 'USER', 'RUID', 'RUSER', 'SUID', 'SUSER', 'GID', 'GROUP', 'PGRP', 'TTY', 'TPGID', 'SID', 'PR', 'NI', 'nTH', 'P', '%CPU', 'TIME', 'TIME+', '%MEM', 'VIRT', 'SWAP', 'RES', 'CODE', 'DATA', 'SHR', 'nMaj', 'nMin', 'nDRT', 'S', 'COMMAND', 'WCHAN', 'Flags', 'CGROUPS', 'SUPGIDS', 'SUPGRPS', 'TGID', 'OOMa', 'OOMs', 'ENVIRON', 'vMj', 'vMn', 'USED', 'nsIPC', 'nsMNT', 'nsNET', 'nsPID', 'nsUSER', 'nsUTS', 'LXC', 'RSan', 'RSfd', 'RSlk', 'RSsh', 'CGNAME', 'NU', 'LOGID', 'EXE', 'RSS', 'PSS', 'PSan', 'PSfd', 'PSsh', 'USS', 'ioR', 'ioRop', 'ioW', 'ioWop', 'AGID', 'AGNI', 'STARTED', 'ELAPSED', '%CUU', '%CUC', 'nsCGROUP', 'nsTIME'];

const TOP_USAGE = `
Usage:
 top [options]

Options:
 -b, --batch-mode                run in non-interactive batch mode
 -c, --cmdline-toggle            reverse last remembered 'c' state
 -d, --delay =SECS [.TENTHS]     iterative delay as SECS [.TENTHS]
 -E, --scale-summary-mem =SCALE  set mem as: k,m,g,t,p,e for SCALE
 -e, --scale-task-mem =SCALE     set mem with: k,m,g,t,p for SCALE
 -H, --threads-show              show tasks plus all their threads
 -i, --idle-toggle               reverse last remembered 'i' state
 -n, --iterations =NUMBER        exit on maximum iterations NUMBER
 -O, --list-fields               output all field names, then exit
 -o, --sort-override =FIELD      force sorting on this named FIELD
 -p, --pid =PIDLIST              monitor only the tasks in PIDLIST
 -S, --accum-time-toggle         reverse last remembered 'S' state
 -s, --secure-mode               run with secure mode restrictions
 -U, --filter-any-user =USER     show only processes owned by USER
 -u, --filter-only-euser =USER   show only processes owned by USER
 -w, --width [=COLUMNS]          change print width [,use COLUMNS]
 -1, --single-cpu-toggle         reverse last remembered '1' state

 -h, --help                      display this help text, then exit
 -V, --version                   output version information & exit

For more details see top(1).
`;

const SCALES = ['k', 'm', 'g', 't', 'p', 'e'];

interface TopOptions {
  batch: boolean;
  cmdline: boolean;
  delay: number;
  sumScale: number;
  taskScale: number;
  idle: boolean;
  iterations: number;
  sort: TopField;
  pids: number[] | null;
  user: string | null;
  secure: boolean;
  width: number | null;
  perCpu: boolean;
  threads: boolean;
  cumulative: boolean;
}

class TopError extends Error {}

function parseTopArgs(args: string[]): { o: TopOptions; action: 'run' | 'help' | 'version' | 'fields' } {
  const o: TopOptions = { batch: false, cmdline: false, delay: 3, sumScale: 1, taskScale: 0, idle: true, iterations: Infinity, sort: '%CPU', pids: null, user: null, secure: false, width: null, perCpu: false, threads: false, cumulative: false };
  const longs: Record<string, string> = {
    'batch-mode': 'b', 'cmdline-toggle': 'c', delay: 'd', 'scale-summary-mem': 'E', 'scale-task-mem': 'e', 'threads-show': 'H', 'idle-toggle': 'i', iterations: 'n', 'list-fields': 'O', 'sort-override': 'o', pid: 'p', 'accum-time-toggle': 'S', 'secure-mode': 's', 'filter-any-user': 'U', 'filter-only-euser': 'u', width: 'w', 'single-cpu-toggle': '1', help: 'h', version: 'V',
  };
  const withArg = new Set(['d', 'E', 'e', 'n', 'o', 'p', 'U', 'u']);
  let action: 'run' | 'help' | 'version' | 'fields' = 'run';
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    let inlineVal: string | null = null;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const hit = Object.keys(longs).filter((k) => k.startsWith(name));
      const exact = longs[name] ? name : hit.length === 1 ? hit[0] : null;
      if (!exact) throw new TopError(`top: unrecognized option '${a}'\n`);
      if (eq !== -1) inlineVal = a.slice(eq + 1);
      a = '-' + longs[exact];
    } else if (!a.startsWith('-') || a === '-') throw new TopError(`top: unknown option '${a}'\n`);
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      let val: string | null = null;
      if (withArg.has(c)) {
        val = inlineVal ?? (a.slice(j + 1) || null);
        if (val === null) {
          if (i + 1 >= args.length) throw new TopError(`top: option requires an argument -- '${c}'\n`);
          val = args[++i];
        }
        j = a.length;
      } else if (c === 'w') {
        const rest = inlineVal ?? a.slice(j + 1);
        if (rest) {
          o.width = parseInt(rest, 10);
          if (!(o.width > 0)) throw new TopError(`top: bad width arg '${rest}'\n`);
          j = a.length;
        } else if (i + 1 < args.length && /^\d+$/.test(args[i + 1])) o.width = parseInt(args[++i], 10);
        else o.width = 512;
        continue;
      }
      switch (c) {
        case 'b': o.batch = true; break;
        case 'c': o.cmdline = !o.cmdline; break;
        case 'H': o.threads = true; break;
        case 'i': o.idle = !o.idle; break;
        case 'S': o.cumulative = !o.cumulative; break;
        case 's': o.secure = true; break;
        case '1': o.perCpu = !o.perCpu; break;
        case 'h': action = 'help'; break;
        case 'V': action = 'version'; break;
        case 'O': action = 'fields'; break;
        case 'd': {
          const v = val!.replace(/^=/, '');
          const n = Number(v);
          if (!/^\d*\.?\d+$/.test(v) || !Number.isFinite(n)) throw new TopError(`top: bad delay interval '${val}'\n`);
          o.delay = n;
          break;
        }
        case 'n': {
          const v = val!.replace(/^=/, '');
          if (!/^\d+$/.test(v)) throw new TopError(`top: bad iterations argument '${val}'\n`);
          o.iterations = parseInt(v, 10) || Infinity;
          break;
        }
        case 'E':
        case 'e': {
          const idx = SCALES.indexOf((val ?? '').toLowerCase());
          if (idx === -1 || (c === 'e' && idx > 4)) throw new TopError(`top: bad memory scaling arg '${val}'\n`);
          if (c === 'E') o.sumScale = idx;
          else o.taskScale = idx;
          break;
        }
        case 'o': {
          const v = val!.replace(/^[+-]/, '');
          const f = TOP_FIELDS.find((x) => x.toLowerCase() === v.toLowerCase() || (x === 'TIME+' && v.toLowerCase() === 'time'));
          if (!f) throw new TopError(`top: unrecognized field name '${val}'\n`);
          o.sort = f;
          break;
        }
        case 'p': {
          const list = val!.split(',');
          if (list.some((p) => !/^\d+$/.test(p))) throw new TopError(`top: bad pid '${val}'\n`);
          o.pids = [...(o.pids ?? []), ...list.map(Number)];
          break;
        }
        case 'U':
        case 'u':
          o.user = val;
          break;
        default:
          throw new TopError(`top: invalid option -- '${c}'\n`);
      }
    }
  }
  return { o, action };
}

function f51(n: number): string {
  return n.toFixed(1).padStart(5);
}

function scaleMem(kib: number, width: number, minScale = 0): string {
  let v = kib;
  for (let i = 0; i < SCALES.length - 1; i++) {
    if (i >= minScale) {
      const s = i === 0 ? String(Math.round(v)) : v.toFixed(1) + SCALES[i];
      if (s.length <= width) return s.padStart(width);
    }
    v /= 1024;
  }
  return '?'.padStart(width);
}

function topTime(cs: number): string {
  const m = Math.floor(cs / 6000);
  const s = Math.floor(cs / 100) % 60;
  return `${m}:${pad2(s)}.${pad2(cs % 100)}`;
}

class TopView {
  readonly o: TopOptions;
  readonly ctx: CommandContext;
  readonly sampler: Sampler;
  reverse = false;
  showCpuLines = true;
  showMemLines = true;
  showLoad = true;
  highlightRunning = true;
  highlightSort = false;
  boldHighlight = true;
  color = false;
  forest = false;
  irix = true;
  zeroSuppress = false;
  maxTasks = 0;
  scroll = 0;
  locate: string | null = null;

  constructor(ctx: CommandContext, o: TopOptions) {
    this.ctx = ctx;
    this.o = o;
    this.sampler = new Sampler(ctx, [0.4, 1.2]);
  }

  visibleTasks(): Task[] {
    const o = this.o;
    let tasks = this.sampler.tasks;
    if (o.pids) tasks = tasks.filter((t) => o.pids!.includes(t.pid));
    if (o.user !== null) tasks = tasks.filter((t) => t.user === o.user || String(t.uid) === o.user);
    if (!o.idle) tasks = tasks.filter((t) => t.state === 'R' || t.cpu > 0);
    const key = (t: Task): number | string => {
      switch (o.sort) {
        case 'PID': return t.pid;
        case 'USER': return t.user;
        case 'PR': return t.pr;
        case 'NI': return t.ni;
        case 'VIRT': return t.virt;
        case 'RES': return t.res;
        case 'SHR': return t.shr;
        case 'S': return t.state;
        case '%CPU': return Math.round(t.cpu * 10);
        case '%MEM': return Math.round(t.mem * 10);
        case 'TIME+': return t.time;
        case 'COMMAND': return this.o.cmdline ? t.cmd : t.comm;
      }
    };
    const sorted = [...tasks].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      let c = typeof ka === 'number' && typeof kb === 'number' ? kb - ka : String(kb) < String(ka) ? -1 : String(kb) > String(ka) ? 1 : 0;
      if (this.reverse) c = -c;
      return c || a.pid - b.pid;
    });
    if (!this.forest) return sorted;
    // Forest view: children below their parents.
    const byParent = new Map<number, Task[]>();
    const pids = new Set(sorted.map((t) => t.pid));
    for (const t of sorted) {
      const p = pids.has(t.ppid) ? t.ppid : -1;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(t);
    }
    const out: Task[] = [];
    const walk = (p: number, level: number) => {
      for (const t of byParent.get(p) ?? []) {
        this.levels.set(t.pid, level);
        out.push(t);
        walk(t.pid, level + 1);
      }
    };
    this.levels.clear();
    walk(-1, 0);
    return out;
  }

  private levels = new Map<number, number>();

  commandText(t: Task): string {
    let c = this.o.cmdline ? t.cmd : t.comm;
    if (this.forest) {
      const lvl = this.levels.get(t.pid) ?? 0;
      if (lvl > 0) c = ' '.repeat(4 * (lvl - 1) + 1) + '`- ' + c;
    }
    return c;
  }

  summaryLines(interactive: boolean): string[] {
    const ctx = this.ctx;
    const s = this.sampler;
    const b = (v: string) => (interactive ? (this.color ? `\x1b[1;31m${v}\x1b[0m` : `\x1b[1m${v}\x1b[0m`) : v);
    const p4 = (n: number) => String(n).padStart(4) + ' ';
    const lines: string[] = [];
    const now = ctx.system.now();
    if (this.showLoad) {
      lines.push(`top - ${strftime('%H:%M:%S', now)} up ${uptimeText(now - ctx.system.bootTime)},  1 user,  load average: ${LOAD_AVG.map((x) => x.toFixed(2)).join(', ')}`);
    }
    if (this.showCpuLines) {
      const tasks = this.o.pids ? this.sampler.tasks.filter((t) => this.o.pids!.includes(t.pid)) : this.sampler.tasks;
      const count = (st: string) => tasks.filter((t) => (st === 'S' ? t.state === 'S' || t.state === 'I' : t.state === st)).length;
      lines.push(`${this.o.threads ? 'Threads' : 'Tasks'}:${b(p4(tasks.length))}total,${b(p4(count('R')))}running,${b(p4(count('S')))}sleeping,${b(p4(count('T')))}stopped,${b(p4(count('Z')))}zombie`);
      const cpuLine = (label: string, c: CpuSample) =>
        `${label}${b(f51(c.us) + ' ')}us,${b(f51(c.sy) + ' ')}sy,${b(f51(c.ni) + ' ')}ni,${b(f51(c.id) + ' ')}id,${b(f51(c.wa) + ' ')}wa,${b(f51(c.hi) + ' ')}hi,${b(f51(c.si) + ' ')}si,${b(f51(c.st) + ' ')}st `;
      if (this.o.perCpu) s.perCpu.forEach((c, i) => lines.push(cpuLine(`%Cpu${String(i).padEnd(3)}:`, c)));
      else lines.push(cpuLine('%Cpu(s):', s.cpu));
    }
    if (this.showMemLines) {
      const unit = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'][this.o.sumScale];
      const sc = (kb: number) => (kb / 1024 ** this.o.sumScale).toFixed(1).padStart(9) + ' ';
      lines.push(`${unit} Mem :${b(sc(MEM_KB.total))}total,${b(sc(MEM_KB.free))}free,${b(sc(MEM_KB.used))}used,${b(sc(MEM_KB.cache))}buff/cache     `);
      lines.push(`${unit} Swap:${b(sc(MEM_KB.swapTotal))}total,${b(sc(MEM_KB.swapFree))}free,${b(sc(MEM_KB.swapUsed))}used.${b(sc(MEM_KB.avail))}avail Mem `);
    }
    return lines;
  }

  header(): string {
    return `${'PID'.padStart(7)} ${'USER'.padEnd(8)} ${'PR'.padStart(3)} ${'NI'.padStart(3)} ${'VIRT'.padStart(7)} ${'RES'.padStart(6)} ${'SHR'.padStart(6)} S ${'%CPU'.padStart(5)} ${'%MEM'.padStart(5)} ${'TIME+'.padStart(9)} COMMAND`;
  }

  /** One task line, as plain text cells (so a column can be highlighted). */
  rowCells(t: Task, width: number): { cells: string[]; text: string } {
    const user = t.user.length > 8 ? t.user.slice(0, 7) + '+' : t.user.padEnd(8);
    const cpu = this.irix ? t.cpu : t.cpu / NCPU;
    const zero = (s: string, v: number) => (this.zeroSuppress && v === 0 ? ' '.repeat(s.length) : s);
    const cells = [
      String(t.pid).padStart(7),
      user,
      String(t.pr).padStart(3),
      String(t.ni).padStart(3),
      zero(scaleMem(t.virt, 7, this.o.taskScale), t.virt),
      zero(scaleMem(t.res, 6, this.o.taskScale), t.res),
      zero(scaleMem(t.shr, 6, this.o.taskScale), t.shr),
      t.state,
      zero(f51(cpu), cpu),
      zero(f51(t.mem), Math.round(t.mem * 10)),
      topTime(t.time).padStart(9),
    ];
    const prefix = cells.join(' ') + ' ';
    const cmdWidth = Math.max(0, width - prefix.length);
    let cmd = this.commandText(t);
    if (cmd.length > cmdWidth - 1) cmd = cmd.slice(0, Math.max(0, cmdWidth - 2)) + (cmdWidth >= 2 ? '+' : '');
    cells.push(cmd);
    return { cells, text: prefix + cmd };
  }

  batchFrame(width: number): string {
    const lines = this.summaryLines(false).map((l) => l.slice(0, width));
    lines.push('');
    lines.push(this.header().slice(0, width));
    let tasks = this.visibleTasks();
    if (this.maxTasks) tasks = tasks.slice(0, this.maxTasks);
    for (const t of tasks) lines.push(this.rowCells(t, width).text.slice(0, width).replace(/\s+$/, ''));
    return lines.join('\n') + '\n';
  }
}

const TOP_HELP_KEYS: [string, string][] = [
  ['z,E,e', "Global: 'z' color/mono; 'E'/'e' summary/task memory scale"],
  ['l,t,m', "Toggle summary: 'l' load avg; 't' task/cpu stats; 'm' memory info"],
  ['0,1,I', "Toggle: '0' zeros; '1' single/separate cpu states; 'I' Irix mode"],
  ['', ''],
  ['<,>', "Move sort field: '<' next col left; '>' next col right"],
  ['M,P,T,N', "Sort by: 'M' %MEM; 'P' %CPU; 'T' TIME+; 'N' PID"],
  ['R,H,V', "Toggle: 'R' normal/reverse sort; 'H' show threads; 'V' forest view"],
  ['c,i', "Toggle: 'c' cmd name/line; 'i' idle tasks"],
  ['x,y', "Toggle highlights: 'x' sort field; 'y' running tasks"],
  ['z,b', "Toggle: 'z' color/mono; 'b' bold/reverse (only if 'x' or 'y')"],
  ['u,U', "Filter by: 'u'/'U' effective/any user"],
  ['n,#,L', "Set: 'n'/'#' max tasks displayed; 'L' locate a string"],
  ['Up,Down', 'Scroll the task window (PgUp, PgDn, Home, End too)'],
  ['', ''],
  ['k,r', "Manipulate tasks: 'k' kill; 'r' renice"],
  ['d or s', 'Set update interval'],
  ['W', 'Write configuration file'],
  ['q', 'Quit'],
];

const UNIMPLEMENTED_TOP_KEYS = new Set(['f', 'F', 'X', 'Y', 'O', 'o', 'g', 'G', 'A', 'j', 'J', 'C', '2', '3', '4', 'v', 'Z', 'B', 'S', '!', '&', 'C-o', 'C-g', 'C-k', 'C-n', 'C-u', 'C-p', 'C-r']);

async function runTopInteractive(ctx: CommandContext, view: TopView): Promise<number> {
  const scr = new FullScreen(ctx, { name: 'top', alt: false, hideCursor: true });
  let quit = false;
  const offs = [ctx.onSignal('SIGINT', () => { quit = true; scr.wake(); }), ctx.onSignal('SIGTERM', () => { quit = true; scr.wake(); })];
  let message: string | null = null;
  let iterations = 0;
  let help = false;
  const o = view.o;

  const showMessage = (m: string) => {
    message = m;
  };

  const msgRow = () => view.summaryLines(true).length;

  const render = async (full: boolean) => {
    const cols = scr.cols;
    const rows = scr.rows;
    let out = full ? '\x1b[H\x1b[2J' : '\x1b[H';
    if (help) {
      const lines = [
        `\x1b[1mHelp for Interactive Commands\x1b[0m - procps-ng 4.0.4`,
        `Window \x1b[1m1:Def\x1b[0m: \x1b[1mCumulative mode ${o.cumulative ? 'On' : 'Off'}\x1b[0m.  \x1b[1mSystem\x1b[0m: \x1b[1mDelay ${o.delay.toFixed(1)} secs\x1b[0m; \x1b[1mSecure mode ${o.secure ? 'On' : 'Off'}\x1b[0m.`,
        '',
        ...TOP_HELP_KEYS.map(([k, d]) => (k ? `  \x1b[1m${k.padEnd(9)}\x1b[0m ${d}` : '')),
        '',
        'Type any key to continue ',
      ];
      for (let r = 0; r < rows; r++) out += `\x1b[${r + 1};1H` + truncateAnsi(lines[r] ?? '', cols) + '\x1b[K';
      await scr.write(out);
      return;
    }
    const summary = view.summaryLines(true);
    const lines: string[] = [...summary];
    lines.push(message ? `\x1b[7m ${message} \x1b[0m` : '');
    lines.push(`\x1b[7m${view.header().padEnd(cols).slice(0, cols)}\x1b[0m`);
    let tasks = view.visibleTasks();
    if (view.maxTasks) tasks = tasks.slice(0, view.maxTasks);
    const room = Math.max(0, rows - lines.length);
    view.scroll = Math.max(0, Math.min(view.scroll, Math.max(0, tasks.length - 1)));
    const shown = tasks.slice(view.scroll, view.scroll + room);
    const sortIdx = TOP_FIELDS.indexOf(o.sort);
    for (const t of shown) {
      const { cells } = view.rowCells(t, cols);
      const hl = view.highlightRunning && t.state === 'R';
      const rowSgr = hl ? (view.boldHighlight ? '\x1b[1m' : '\x1b[7m') : '';
      let text: string;
      if (view.highlightSort) {
        text = cells
          .map((c, i) => (i === sortIdx ? `${view.boldHighlight ? '\x1b[1m' : '\x1b[7m'}${c}\x1b[0m${rowSgr}` : c))
          .join(' ');
      } else text = cells.join(' ');
      const plainWidth = stringWidth(text);
      lines.push(rowSgr + text + ' '.repeat(Math.max(0, cols - plainWidth)) + '\x1b[0m');
    }
    for (let r = 0; r < rows; r++) {
      if (r >= lines.length) {
        out += `\x1b[${r + 1};1H\x1b[J`;
        break;
      }
      out += `\x1b[${r + 1};1H` + truncateAnsi(lines[r], cols) + '\x1b[0m\x1b[K';
    }
    await scr.write(out);
  };

  /** Prompt on the message line (bold, like top). */
  const ask = async (label: string): Promise<string | null> => {
    const row = msgRow();
    return scr.readLine((buf) => `\x1b[${row + 1};1H\x1b[1m${label}\x1b[0m${buf}\x1b[K`);
  };

  const firstTask = (): Task | undefined => view.visibleTasks()[view.scroll];

  await scr.start();
  try {
    view.sampler.sample();
    let full = true;
    for (;;) {
      if (await scr.sync()) full = true;
      if (quit) break;
      await render(full);
      full = false;
      if (!help && ++iterations >= o.iterations) break;
      // Messages stay up for about a second and a half, like top's show_msg().
      const k = await scr.key(help ? null : message ? Math.min(1500, o.delay * 1000) : o.delay * 1000);
      if (quit) break;
      if (k === 'timeout') {
        message = null;
        view.sampler.sample();
        continue;
      }
      if (k === null) continue;
      const name = keyName(k);
      if (help) {
        help = false;
        full = true;
        continue;
      }
      if (name === 'C-c') break;
      message = null;
      // Like top, every command is followed by a fresh look at the processes.
      const refreshNow = () => view.sampler.sample();
      refreshNow();
      switch (name) {
        case 'q':
          quit = true;
          break;
        case 'C-z':
          ctx.proc.job.kill('SIGTSTP');
          break;
        case 'h':
        case '?':
          help = true;
          full = true;
          break;
        case ' ':
        case 'enter':
        case 'C-l':
          refreshNow();
          full = name === 'C-l';
          break;
        case 'k': {
          if (o.secure) {
            showMessage('Unavailable in secure mode');
            break;
          }
          const def = firstTask()?.pid ?? ctx.proc.pid;
          const pidText = await ask(`PID to signal/kill [default pid = ${def}] `);
          if (pidText === null || quit) break;
          const t = pidText.trim();
          if (t !== '' && !/^\d+$/.test(t)) {
            showMessage('Unacceptable integer');
            break;
          }
          const pid = t === '' ? def : parseInt(t, 10);
          const sigText = await ask(`Send pid ${pid} signal [15/sigterm] `);
          if (sigText === null || quit) break;
          const sig = sigText.trim() === '' ? 'SIGTERM' : parseSignalName(sigText.trim());
          if (!sig) {
            showMessage('Invalid signal');
            break;
          }
          const err = sendSignal(ctx, pid, sig);
          if (err) showMessage(`Failed signal pid '${pid}' with '${SIGNAL_NUMBERS[sig]}': ${err}`);
          // Let the signalled program react before the next sample.
          await ctx.sleep(30);
          refreshNow();
          break;
        }
        case 'r': {
          if (o.secure) {
            showMessage('Unavailable in secure mode');
            break;
          }
          const def = firstTask()?.pid ?? ctx.proc.pid;
          const pidText = await ask(`PID to renice [default pid = ${def}] `);
          if (pidText === null || quit) break;
          const pid = pidText.trim() === '' ? def : parseInt(pidText.trim(), 10);
          if (!Number.isFinite(pid)) {
            showMessage('Unacceptable integer');
            break;
          }
          const valText = await ask(`Renice PID ${pid} to value `);
          if (valText === null || quit || valText.trim() === '') break;
          const val = parseInt(valText.trim(), 10);
          if (!/^-?\d+$/.test(valText.trim())) {
            showMessage('Unacceptable integer');
            break;
          }
          const task = view.sampler.tasks.find((x) => x.pid === pid);
          const clamped = Math.max(-20, Math.min(19, val));
          const err = task ? canRenice(ctx, task, clamped) : 'No such process';
          if (err) showMessage(`Failed renice of PID ${pid} to ${val}: ${err}`);
          else niceMap(ctx).set(pid, clamped);
          refreshNow();
          break;
        }
        case 'M':
          o.sort = '%MEM';
          break;
        case 'P':
          o.sort = '%CPU';
          break;
        case 'N':
          o.sort = 'PID';
          break;
        case 'T':
          o.sort = 'TIME+';
          break;
        case 'R':
          view.reverse = !view.reverse;
          break;
        case '<':
        case '>': {
          const i = TOP_FIELDS.indexOf(o.sort) + (name === '<' ? -1 : 1);
          if (i >= 0 && i < TOP_FIELDS.length) o.sort = TOP_FIELDS[i];
          break;
        }
        case 'c':
          o.cmdline = !o.cmdline;
          break;
        case 'i':
          o.idle = !o.idle;
          break;
        case 'H':
          o.threads = !o.threads;
          showMessage(`Show threads ${o.threads ? 'On' : 'Off'}`);
          break;
        case 'V':
          view.forest = !view.forest;
          showMessage(`Forest mode ${view.forest ? 'On' : 'Off'}`);
          break;
        case '1':
          o.perCpu = !o.perCpu;
          full = true;
          break;
        case 'l':
          view.showLoad = !view.showLoad;
          full = true;
          break;
        case 't':
          view.showCpuLines = !view.showCpuLines;
          full = true;
          break;
        case 'm':
          view.showMemLines = !view.showMemLines;
          full = true;
          break;
        case 'x':
          view.highlightSort = !view.highlightSort;
          break;
        case 'y':
          view.highlightRunning = !view.highlightRunning;
          break;
        case 'b':
          if (!view.highlightSort && !view.highlightRunning) showMessage("Nothing to highlight!");
          else view.boldHighlight = !view.boldHighlight;
          break;
        case 'z':
          view.color = !view.color;
          break;
        case '0':
          view.zeroSuppress = !view.zeroSuppress;
          break;
        case 'I':
          view.irix = !view.irix;
          showMessage(`Irix mode ${view.irix ? 'On' : 'Off'}`);
          break;
        case 'E':
          o.sumScale = (o.sumScale + 1) % SCALES.length;
          break;
        case 'e':
          o.taskScale = (o.taskScale + 1) % 5;
          break;
        case 'u':
        case 'U': {
          const u = await ask('Which user (blank for all) ');
          if (u === null || quit) break;
          const v = u.trim();
          if (v === '') o.user = null;
          else if (ctx.system.userByName(v) || (/^\d+$/.test(v) && ctx.system.userByUid(parseInt(v, 10)))) o.user = v;
          else showMessage('Invalid user');
          break;
        }
        case 'n':
        case '#': {
          const v = await ask(`Maximum tasks = ${view.maxTasks}, change to (0 is unlimited) `);
          if (v === null || quit || v.trim() === '') break;
          if (!/^\d+$/.test(v.trim())) showMessage('Unacceptable integer');
          else view.maxTasks = parseInt(v.trim(), 10);
          break;
        }
        case 'd':
        case 's': {
          if (o.secure) {
            showMessage('Unavailable in secure mode');
            break;
          }
          const v = await ask(`Change delay from ${o.delay.toFixed(1)} to `);
          if (v === null || quit || v.trim() === '') break;
          const n = Number(v.trim());
          if (!/^\d*\.?\d+$/.test(v.trim()) || !Number.isFinite(n)) showMessage('Unacceptable floating point');
          else o.delay = n;
          break;
        }
        case 'L':
        case '&': {
          const v = name === '&' ? view.locate : await ask('Locate string ');
          if (v === null || quit || v === '') break;
          view.locate = v;
          const tasks = view.visibleTasks();
          const start = name === '&' ? view.scroll + 1 : 0;
          const idx = tasks.findIndex((t, i) => i >= start && view.rowCells(t, 512).text.includes(v));
          if (idx === -1) showMessage(`Locate string '${v}' not found`);
          else view.scroll = idx;
          break;
        }
        case 'W': {
          const home = ctx.env.get('HOME') ?? '/';
          const path = `${home}/.config/procps/toprc`;
          try {
            if (!ctx.fs.exists(`${home}/.config/procps`)) {
              if (!ctx.fs.exists(`${home}/.config`)) ctx.fs.mkdir(`${home}/.config`);
              ctx.fs.mkdir(`${home}/.config/procps`);
            }
            ctx.fs.writeFile(path, `top's Config File (Linux processes with windows)\nId:k, Mode_altscr=0, Mode_irixps=${view.irix ? 1 : 0}, Delay_time=${o.delay.toFixed(3)}, Curwin=0\nDef\tfieldscur=PID,USER,PR,NI,VIRT,RES,SHR,S,%CPU,%MEM,TIME+,COMMAND\n\twinflags=${view.forest ? 161076 : 160564}, sortindx=${TOP_FIELDS.indexOf(o.sort)}, maxtasks=${view.maxTasks}, graph_cpus=0, graph_mems=0, double_up=0, combine_cpus=0, core_types=0\n\tsummclr=1, msgsclr=1, headclr=3, taskclr=1\n`);
            showMessage(`Wrote configuration to '${path}'`);
          } catch {
            showMessage(`Failed '${path}' open: Permission denied`);
          }
          break;
        }
        case 'up':
          view.scroll = Math.max(0, view.scroll - 1);
          break;
        case 'down':
          view.scroll++;
          break;
        case 'pgup':
          view.scroll = Math.max(0, view.scroll - (scr.rows - 7));
          break;
        case 'pgdn':
          view.scroll += scr.rows - 7;
          break;
        case 'home':
          view.scroll = 0;
          break;
        case 'end':
          view.scroll = Math.max(0, view.visibleTasks().length - 1);
          break;
        default:
          if (k.t === 'paste' || name === 'unknown' || name === 'escape') break;
          if (UNIMPLEMENTED_TOP_KEYS.has(name)) showMessage(`Command '${name}' is not available in this simulator`);
          else showMessage("Unknown command - try 'h' for help");
      }
      if (quit) break;
    }
  } finally {
    for (const off of offs) off();
    await scr.finish();
  }
  return 0;
}

defineCommand({
  name: 'top',
  pkg: 'procps',
  size: 133320,
  gnu: false,
  doc: {
    category: 'processes',
    summary: 'display Linux processes',
    synopsis: ['top [options]'],
    description:
      'The top program provides a dynamic real-time view of a running system. It displays system summary information (uptime, load average, number of tasks, CPU and memory usage) as well as a list of processes, sorted so that the busiest ones are at the top. The display refreshes every 3 seconds.\n\n' +
      'While top is running, press q to quit, h for help, k to kill a process (top asks for its PID and the signal to send), M to sort by memory use, P to sort by CPU use, c to show full command lines and the space bar to refresh at once.\n\n' +
      'With -b (batch mode) top prints plain text instead of drawing on the screen, which is handy for saving a snapshot to a file: top -b -n 1 > snapshot.txt',
    options: [
      { flags: '-b, --batch-mode', desc: 'Starts top in Batch mode: no screen control, output can be sent to a file or another program.' },
      { flags: '-c, --cmdline-toggle', desc: 'Show the full command line instead of just the program name.' },
      { flags: '-d, --delay=SECS', desc: 'Delay between screen updates, in seconds (default 3).' },
      { flags: '-n, --iterations=NUMBER', desc: 'Number of iterations (screen updates) before top ends.' },
      { flags: '-o, --sort-override=FIELD', desc: 'Sort the task list by FIELD, e.g. %MEM or PID.' },
      { flags: '-p, --pid=PIDLIST', desc: 'Monitor only the processes with the given process IDs (comma separated).' },
      { flags: '-u, --filter-only-euser=USER', desc: 'Display only processes owned by USER.' },
      { flags: '-1, --single-cpu-toggle', desc: 'Show a line for each CPU instead of one combined %Cpu(s) line.' },
      { flags: '-s, --secure-mode', desc: 'Starts top in secure mode: k, r and d are disabled.' },
      { flags: '-w, --width=COLUMNS', desc: 'In batch mode, set the output width.' },
    ],
    examples: [
      { cmd: 'top', desc: 'Watch the busiest processes (press q to quit).' },
      { cmd: 'top -b -n 1 | head -15', desc: 'One plain-text snapshot, first 15 lines.' },
      { cmd: 'top -u learner', desc: 'Only your own processes.' },
      { cmd: 'sleep 300 & top', desc: 'Start a background job, then press k and type its PID to stop it.' },
    ],
    seeAlso: ['htop', 'ps', 'kill', 'free', 'uptime'],
    tip: 'Press q to quit top. To stop a runaway program, press k, type its PID, then press Enter twice.',
  },
  run: async (ctx) => {
    let parsed;
    try {
      parsed = parseTopArgs(ctx.args);
    } catch (e) {
      if (e instanceof TopError) {
        await ctx.err(e.message);
        return 1;
      }
      throw e;
    }
    const { o, action } = parsed;
    if (action === 'help') {
      await ctx.out(TOP_USAGE);
      return 0;
    }
    if (action === 'version') {
      await ctx.out('top from procps-ng 4.0.4\n');
      return 0;
    }
    if (action === 'fields') {
      await ctx.out(TOP_FIELD_NAMES.join('\n') + '\n');
      return 0;
    }
    if (o.user !== null && !ctx.system.userByName(o.user) && !(/^\d+$/.test(o.user) && ctx.system.userByUid(parseInt(o.user, 10)))) {
      await ctx.err('top: Invalid user\n');
      return 1;
    }
    const view = new TopView(ctx, o);
    const interactive = !o.batch && !!ctx.tty && ctx.stdout.isTTY;
    if (interactive) {
      o.delay = Math.max(0.1, o.delay);
      return runTopInteractive(ctx, view);
    }
    // Batch mode (also used when the output is not a terminal).
    if (!o.batch && o.iterations === Infinity) o.iterations = 1;
    const colsEnv = ctx.env.get('COLUMNS');
    const width = Math.min(512, o.width ?? (colsEnv && /^\d+$/.test(colsEnv) ? parseInt(colsEnv, 10) : ctx.stdout.isTTY && ctx.tty ? ctx.tty.cols : 80));
    for (let i = 0; i < o.iterations; i++) {
      await ctx.checkpoint();
      if (i > 0) {
        await ctx.sleep(o.delay * 1000);
        await ctx.out('\n');
      }
      view.sampler.sample();
      await ctx.out(view.batchFrame(width));
    }
    return 0;
  },
});

// ---------------------------------------------------------------------------
// htop

const C = {
  reset: '\x1b[0m',
  bar: '\x1b[30;46m',
  fkey: '\x1b[0m',
  header: '\x1b[30;42m',
  sel: '\x1b[30;46m',
  unfocused: '\x1b[30;47m',
  text: '\x1b[36m',
  value: '\x1b[1;36m',
  shadow: '\x1b[90m',
  border: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  boldGreen: '\x1b[1;32m',
  bold: '\x1b[1m',
  tag: '\x1b[1;33m',
  failed: '\x1b[31;46m',
  paused: '\x1b[1;33;46m',
};

type HtopKey = 'PID' | 'USER' | 'PRIORITY' | 'NICE' | 'M_VIRT' | 'M_RESIDENT' | 'M_SHARE' | 'STATE' | 'PERCENT_CPU' | 'PERCENT_MEM' | 'TIME' | 'Command';
const HTOP_KEYS: HtopKey[] = ['PID', 'USER', 'PRIORITY', 'NICE', 'M_VIRT', 'M_RESIDENT', 'M_SHARE', 'STATE', 'PERCENT_CPU', 'PERCENT_MEM', 'TIME', 'Command'];
/** Columns htop sorts smallest-first by default (the others start with the biggest values). */
const HTOP_ASCENDING = new Set<HtopKey>(['PID', 'USER', 'PRIORITY', 'NICE', 'STATE', 'Command']);
const HTOP_TITLES: Record<HtopKey, string> = {
  PID: '    PID ',
  USER: 'USER       ',
  PRIORITY: 'PRI ',
  NICE: ' NI ',
  M_VIRT: ' VIRT ',
  M_RESIDENT: '  RES ',
  M_SHARE: '  SHR ',
  STATE: 'S ',
  PERCENT_CPU: ' CPU% ',
  PERCENT_MEM: 'MEM% ',
  TIME: '  TIME+  ',
  Command: 'Command ',
};
const HTOP_SIGNALS: [number, string][] = [
  [0, 'Cancel'], [1, 'SIGHUP'], [2, 'SIGINT'], [3, 'SIGQUIT'], [9, 'SIGKILL'], [10, 'SIGUSR1'], [12, 'SIGUSR2'], [13, 'SIGPIPE'], [14, 'SIGALRM'], [15, 'SIGTERM'], [17, 'SIGCHLD'], [18, 'SIGCONT'], [19, 'SIGSTOP'], [20, 'SIGTSTP'], [21, 'SIGTTIN'], [22, 'SIGTTOU'], [28, 'SIGWINCH'],
];

function humanKiB(kib: number): string {
  const units = 'KMGTPEZY';
  let v = kib;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  let precision = 0;
  if (i > 0) {
    precision = v <= 99.9 ? (v <= 9.99 ? 2 : 1) : 0;
    if (precision < 2) {
      const limit = precision === 1 ? 10 : 100;
      if (v < limit) v = limit;
    }
  }
  return v.toFixed(precision) + units[i];
}

interface HtopSettings {
  tree: boolean;
  shadowOthers: boolean;
  hideKernel: boolean;
  hideThreads: boolean;
  highlightBase: boolean;
  highlightMegabytes: boolean;
  cpusFromOne: boolean;
  headerMargin: boolean;
  showPath: boolean;
  monochrome: boolean;
}

type HtopMode = 'main' | 'help' | 'kill' | 'sort' | 'user' | 'search' | 'filter' | 'setup';

class Htop {
  readonly ctx: CommandContext;
  readonly sampler: Sampler;
  sort: HtopKey = 'PERCENT_CPU';
  ascending = false;
  sel = 0;
  top = 0;
  tagged = new Set<number>();
  filter = '';
  search = '';
  searchFailed = false;
  userFilter: string | null = null;
  paused = false;
  mode: HtopMode = 'main';
  menuSel = 0;
  menuTop = 0;
  setupPanel = 0;
  setupSel = 0;
  pidSearch = '';
  s: HtopSettings = { tree: false, shadowOthers: false, hideKernel: true, hideThreads: false, highlightBase: false, highlightMegabytes: true, cpusFromOne: false, headerMargin: true, showPath: true, monochrome: false };
  private treePrefix = new Map<number, string>();
  maxIterations = Infinity;
  pids: number[] | null = null;

  constructor(ctx: CommandContext) {
    this.ctx = ctx;
    this.sampler = new Sampler(ctx, [0.6, 2.0]);
  }

  col(sgr: string): string {
    if (!this.s.monochrome) return sgr;
    if (sgr === C.bar || sgr === C.header || sgr === C.sel || sgr === C.unfocused || sgr === C.failed || sgr === C.paused) return '\x1b[7m';
    if (sgr.includes('1;') || sgr === C.bold) return C.bold;
    return '';
  }

  list(): Task[] {
    let tasks = this.sampler.tasks;
    if (this.s.hideKernel) tasks = tasks.filter((t) => !t.kernel);
    if (this.pids) tasks = tasks.filter((t) => this.pids!.includes(t.pid));
    if (this.userFilter !== null) tasks = tasks.filter((t) => t.user === this.userFilter);
    if (this.filter) tasks = tasks.filter((t) => t.cmd.toLowerCase().includes(this.filter.toLowerCase()));
    if (this.s.tree) return this.treeOrder(tasks);
    const key = (t: Task): number | string => {
      switch (this.sort) {
        case 'PID': return t.pid;
        case 'USER': return t.user;
        case 'PRIORITY': return t.pr;
        case 'NICE': return t.ni;
        case 'M_VIRT': return t.virt;
        case 'M_RESIDENT': return t.res;
        case 'M_SHARE': return t.shr;
        case 'STATE': return t.state;
        case 'PERCENT_CPU': return Math.round(t.cpu * 10);
        case 'PERCENT_MEM': return Math.round(t.mem * 10);
        case 'TIME': return t.time;
        case 'Command': return t.cmd;
      }
    };
    return [...tasks].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      let c = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb));
      if (!this.ascending) c = -c;
      return c || a.pid - b.pid;
    });
  }

  private treeOrder(tasks: Task[]): Task[] {
    const pids = new Set(tasks.map((t) => t.pid));
    const kids = new Map<number, Task[]>();
    for (const t of [...tasks].sort((a, b) => a.pid - b.pid)) {
      const p = pids.has(t.ppid) && t.ppid !== t.pid ? t.ppid : -1;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p)!.push(t);
    }
    const out: Task[] = [];
    this.treePrefix.clear();
    const walk = (p: number, indent: string, depth: number) => {
      const list = kids.get(p) ?? [];
      list.forEach((t, i) => {
        const last = i === list.length - 1;
        this.treePrefix.set(t.pid, depth === 0 ? '' : indent + (last ? '└─ ' : '├─ '));
        out.push(t);
        walk(t.pid, depth === 0 ? '' : indent + (last ? '   ' : '│  '), depth + 1);
      });
    };
    walk(-1, '', 0);
    return out;
  }

  clampSelection(n: number, rows: number): void {
    if (n === 0) {
      this.sel = 0;
      this.top = 0;
      return;
    }
    this.sel = Math.max(0, Math.min(this.sel, n - 1));
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + rows) this.top = this.sel - rows + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, n - rows)));
  }

  // ----- header meters -----

  private bar(caption: string, w: number, values: [number, string][], total: number, text: string): Line {
    const line = new Line(w);
    line.add(caption.slice(0, 3).padStart(3), this.col(C.text));
    const inner = w - 5;
    line.add('[', this.col(C.border));
    if (inner < 1) return line.add(']', this.col(C.border));
    const barText = text.length > inner ? text.slice(0, inner) : text;
    const chars = (' '.repeat(inner - barText.length) + barText).split('');
    let offset = 0;
    const segs: [number, number, string][] = [];
    for (const [v, sgr] of values) {
      let size = v > 0 && total > 0 ? Math.ceil((Math.min(v, total) / total) * inner) : 0;
      size = Math.min(size, inner - offset);
      for (let j = offset; j < offset + size; j++) if (chars[j] === ' ') chars[j] = '|';
      segs.push([offset, size, sgr]);
      offset += size;
    }
    for (const [start, size, sgr] of segs) if (size) line.add(chars.slice(start, start + size).join(''), this.col(sgr));
    if (offset < inner) line.add(chars.slice(offset).join(''), this.col(C.shadow));
    return line.add(']', this.col(C.border));
  }

  headerLines(cols: number): string[] {
    const pad = this.s.headerMargin ? 2 : 0;
    // Header_draw(): two 50% columns with the rounding loss given to the second one.
    const width = cols - 2 * pad - 1;
    const colW = width / 2;
    const leftW = Math.floor(colW);
    const loss = 2 * (colW - leftW);
    const rightW = Math.floor(loss >= 1 ? colW + 1 : colW);
    const left: Line[] = [];
    this.sampler.perCpu.forEach((c, i) => {
      const pct = c.us + c.sy + c.ni;
      const id = this.s.cpusFromOne ? i + 1 : i;
      left.push(this.bar(String(id), leftW, [[c.ni, C.blue], [c.us, C.green], [c.sy + c.si, C.red]], 100, `${pct.toFixed(1).padStart(5)}%`));
    });
    const cacheOnly = MEM_KB.cache - MEM_KB.buffers;
    left.push(this.bar('Mem', leftW, [[MEM_KB.used, C.green], [MEM_KB.shared, C.magenta], [MEM_KB.buffers, C.blue], [cacheOnly, C.yellow]], MEM_KB.total, `${humanKiB(MEM_KB.used)}/${humanKiB(MEM_KB.total)}`));
    left.push(this.bar('Swp', leftW, [[MEM_KB.swapUsed, C.red]], MEM_KB.swapTotal, `${humanKiB(MEM_KB.swapUsed)}/${humanKiB(MEM_KB.swapTotal)}`));
    const tasks = this.sampler.tasks;
    const kthr = tasks.filter((t) => t.kernel).length;
    const user = tasks.filter((t) => !t.kernel);
    const running = tasks.filter((t) => t.state === 'R').length;
    const right: Line[] = [];
    right.push(
      new Line(rightW)
        .add('Tasks: ', this.col(C.text))
        .add(String(user.length), this.col(C.value))
        .add(', ', this.col(this.s.hideThreads ? C.shadow : C.text))
        .add('0', this.col(this.s.hideThreads ? C.shadow : C.boldGreen))
        .add(' thr', this.col(this.s.hideThreads ? C.shadow : C.text))
        .add(', ', this.col(this.s.hideKernel ? C.shadow : C.text))
        .add(String(kthr), this.col(this.s.hideKernel ? C.shadow : C.boldGreen))
        .add(' kthr', this.col(this.s.hideKernel ? C.shadow : C.text))
        .add('; ', this.col(C.text))
        .add(String(running), this.col(C.boldGreen))
        .add(' running', this.col(C.text)),
    );
    right.push(
      new Line(rightW)
        .add('Load average: ', this.col(C.text))
        .add(LOAD_AVG[0].toFixed(2) + ' ', this.col(C.bold))
        .add(LOAD_AVG[1].toFixed(2) + ' ', this.col(C.value))
        .add(LOAD_AVG[2].toFixed(2) + ' ', this.col(C.cyan)),
    );
    const up = Math.floor((this.ctx.system.now() - this.ctx.system.bootTime) / 1000);
    const days = Math.floor(up / 86400);
    const daysText = days > 100 ? `${days} days(!), ` : days > 1 ? `${days} days, ` : days === 1 ? '1 day, ' : '';
    right.push(new Line(rightW).add('Uptime: ', this.col(C.text)).add(`${daysText}${pad2(Math.floor(up / 3600) % 24)}:${pad2(Math.floor(up / 60) % 60)}:${pad2(up % 60)}`, this.col(C.value)));
    const meterRows = Math.max(left.length, right.length);
    const out: string[] = [];
    if (pad) out.push('');
    for (let r = 0; r < meterRows; r++) {
      const l = left[r];
      const rr = right[r];
      let s = ' '.repeat(pad);
      if (l) s += l.toString() + ' '.repeat(Math.max(0, leftW - l.used));
      else s += ' '.repeat(leftW);
      s += ' ';
      if (rr) s += rr.toString();
      out.push(s);
    }
    if (pad) out.push('');
    return out;
  }

  // ----- process table -----

  panelHeader(width: number): string {
    const line = new Line(width);
    for (const k of HTOP_KEYS) {
      let title = HTOP_TITLES[k];
      const sorted = !this.s.tree && k === this.sort;
      if (sorted && title.endsWith(' ')) title = title.slice(0, -1) + (this.ascending ? '△' : '▽');
      line.add(title, this.col(sorted ? C.sel : C.header));
    }
    return line.pad(this.col(C.header)).toString();
  }

  private kbytes(n: number, line: Line, color: boolean): void {
    if (n < 1000) {
      line.add(String(n).padStart(5) + ' ');
      return;
    }
    if (n < 100000) {
      line.add(String(Math.floor(n / 1000)).padStart(2), color ? this.col(C.cyan) : '');
      line.add(String(n % 1000).padStart(3, '0') + ' ');
      return;
    }
    let v = n / 1024;
    let unit = 'M';
    let sgr = C.cyan;
    if (v >= 1000) {
      v /= 1024;
      unit = 'G';
      sgr = C.green;
    }
    const txt = v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : String(Math.round(v));
    line.add(txt.padStart(4), color ? this.col(sgr) : '');
    line.add(unit + ' ', color ? this.col(sgr) : '');
  }

  row(t: Task, width: number, selected: boolean, focused = true): string {
    const line = new Line(width);
    const tagged = this.tagged.has(t.pid);
    const me = this.ctx.creds.uid;
    if (selected || tagged) {
      // A selected or tagged row is drawn in one color.
      const plain = new Line(512);
      this.cells(t, plain, false);
      const sgr = selected ? this.col(focused ? C.sel : C.unfocused) : this.col(C.tag);
      line.add(plain.toString(), sgr);
      return line.pad(selected ? sgr : '').toString();
    }
    this.cells(t, line, true, me);
    return line.toString();
  }

  private cells(t: Task, line: Line, color: boolean, me = -1): void {
    const c = (sgr: string) => (color ? this.col(sgr) : '');
    line.add(String(t.pid).padStart(7) + ' ');
    line.add(t.user.slice(0, 10).padEnd(10) + ' ', this.s.shadowOthers && t.uid !== me ? c(C.shadow) : '');
    line.add(String(t.pr).padStart(3) + ' ');
    line.add(String(t.ni).padStart(3) + ' ', t.ni < 0 ? c(C.red) : t.ni > 0 ? c(C.green) : c(C.shadow));
    this.kbytes(t.virt, line, color && this.s.highlightMegabytes);
    this.kbytes(t.res, line, color && this.s.highlightMegabytes);
    this.kbytes(t.shr, line, color && this.s.highlightMegabytes);
    line.add(t.state + ' ', t.state === 'R' ? c(C.green) : '');
    line.add(t.cpu.toFixed(1).padStart(5) + ' ', t.cpu < 0.05 ? c(C.shadow) : '');
    line.add(t.mem.toFixed(1).padStart(4) + ' ', t.mem < 0.05 ? c(C.shadow) : '');
    const secs = Math.floor(t.time / 100);
    const mins = Math.floor(secs / 60);
    if (mins < 60) line.add(`${String(mins).padStart(2)}:${pad2(secs % 60)}.${pad2(t.time % 100)} `);
    else {
      line.add(`${String(Math.floor(mins / 60)).padStart(2)}h`, c(C.cyan));
      line.add(`${pad2(mins % 60)}:${pad2(secs % 60)} `);
    }
    const prefix = this.s.tree ? this.treePrefix.get(t.pid) ?? '' : '';
    if (prefix) line.add(prefix, c(C.cyan));
    if (t.kernel) {
      line.add(t.cmd.replace(/^\[|\]$/g, ''), c(C.shadow));
      return;
    }
    const cmd = t.cmd;
    if (this.s.highlightBase) {
      const first = cmd.split(' ')[0];
      const base = first.slice(first.lastIndexOf('/') + 1);
      const at = first.length - base.length;
      line.add(cmd.slice(0, at));
      line.add(base, c(C.value));
      line.add(cmd.slice(first.length));
    } else line.add(cmd);
  }

  functionBar(width: number, keys: [string, string][], extra?: string, extraSgr?: string): string {
    const line = new Line(width);
    for (const [k, label] of keys) {
      line.add(k, this.col(C.fkey));
      line.add(label, this.col(C.bar));
    }
    if (extra !== undefined) line.add(extra, extraSgr ?? this.col(C.bar));
    if (this.paused && this.mode === 'main') {
      line.add(' '.repeat(Math.max(0, width - line.used - 6)), this.col(C.bar));
      line.add('PAUSED', this.col(C.paused));
    }
    return line.pad(this.col(C.bar)).toString();
  }

  mainBar(width: number): string {
    return this.functionBar(width, [
      ['F1', 'Help  '],
      ['F2', 'Setup '],
      ['F3', 'Search'],
      ['F4', this.filter ? 'FILTER' : 'Filter'],
      ['F5', this.s.tree ? 'List  ' : 'Tree  '],
      ['F6', 'SortBy'],
      ['F7', 'Nice -'],
      ['F8', 'Nice +'],
      ['F9', 'Kill  '],
      ['F10', 'Quit  '],
    ]);
  }

  menuItems(): string[] {
    if (this.mode === 'kill') return HTOP_SIGNALS.map(([n, s]) => `${String(n).padStart(2)} ${s}`);
    if (this.mode === 'sort') return HTOP_KEYS;
    if (this.mode === 'user') {
      const users = [...new Set(this.sampler.tasks.map((t) => t.user))].sort();
      return ['All users', ...users];
    }
    return [];
  }

  menuTitle(): string {
    return this.mode === 'kill' ? 'Send signal:' : this.mode === 'sort' ? 'Sort by' : 'Show processes of:';
  }

  render(cols: number, rows: number): string[] {
    if (this.mode === 'help') return this.helpScreen(cols, rows);
    if (this.mode === 'setup') return this.setupScreen(cols, rows);
    const lines = this.headerLines(cols);
    const tableTop = lines.length;
    const avail = Math.max(0, rows - tableTop - 2);
    const tasks = this.list();
    this.clampSelection(tasks.length, avail);
    const menu = this.mode === 'kill' || this.mode === 'sort' || this.mode === 'user';
    const menuW = menu ? (this.mode === 'user' ? 20 : 14) : 0;
    const x0 = menu ? menuW + 1 : 0;
    const tableW = Math.max(0, cols - x0);
    const items = menu ? this.menuItems() : [];
    if (menu) {
      if (this.menuSel < this.menuTop) this.menuTop = this.menuSel;
      if (this.menuSel >= this.menuTop + avail) this.menuTop = this.menuSel - avail + 1;
    }
    const menuCell = (r: number): string => {
      if (!menu) return '';
      if (r === -1) return new Line(menuW).add(this.menuTitle(), this.col(C.header)).pad(this.col(C.header)).toString() + ' ';
      const idx = this.menuTop + r;
      const text = items[idx] ?? '';
      const sel = idx === this.menuSel && idx < items.length;
      const l = new Line(menuW);
      if (sel) l.add(text, this.col(C.sel)).pad(this.col(C.sel));
      else l.add(text).pad();
      return l.toString() + ' ';
    };
    lines.push(menuCell(-1) + this.panelHeader(tableW));
    for (let r = 0; r < avail; r++) {
      const t = tasks[this.top + r];
      const cell = menuCell(r);
      if (!t) {
        lines.push(cell);
        continue;
      }
      lines.push(cell + this.row(t, tableW, this.top + r === this.sel, !menu));
    }
    let bar: string;
    if (this.mode === 'kill') bar = this.functionBar(cols, [['Enter', 'Send   '], ['Esc', 'Cancel ']]);
    else if (this.mode === 'sort') bar = this.functionBar(cols, [['Enter', 'Sort   '], ['Esc', 'Cancel ']]);
    else if (this.mode === 'user') bar = this.functionBar(cols, [['Enter', 'Show   '], ['Esc', 'Cancel ']]);
    else if (this.mode === 'search') bar = this.functionBar(cols, [['F3', 'Next  '], ['S-F3', 'Prev   '], ['Esc', 'Cancel '], ['  ', ' Search: ']], this.search, this.searchFailed ? this.col(C.failed) : undefined);
    else if (this.mode === 'filter') bar = this.functionBar(cols, [['Enter', 'Done  '], ['Esc', 'Clear '], ['  ', ' Filter: ']], this.filter);
    else bar = this.mainBar(cols);
    while (lines.length < rows - 1) lines.push('');
    lines.length = rows - 1;
    lines.push(bar);
    return lines;
  }

  helpScreen(cols: number, rows: number): string[] {
    const b = (s: string) => `${this.col(C.value)}${s}${C.reset}`;
    const lines = [
      `${this.col(C.bold)}htop 3.3.0 - (C) 2004-2019 Hisham Muhammad. (C) 2020-2023 htop dev team.${C.reset}`,
      'Released under the GNU GPLv2+. See \'man\' page for more info.',
      '',
      `CPU usage bar: ${this.col(C.border)}[${C.reset}${this.col(C.blue)}low-priority${C.reset}/${this.col(C.green)}normal${C.reset}/${this.col(C.red)}kernel${C.reset}${' '.repeat(28)}${this.col(C.shadow)}used%${C.reset}${this.col(C.border)}]${C.reset}`,
      `Memory bar:    ${this.col(C.border)}[${C.reset}${this.col(C.green)}used${C.reset}/${this.col(C.magenta)}shared${C.reset}/${this.col(C.blue)}buffers${C.reset}/${this.col(C.yellow)}cache${C.reset}${' '.repeat(18)}${this.col(C.shadow)}used/total${C.reset}${this.col(C.border)}]${C.reset}`,
      `Swap bar:      ${this.col(C.border)}[${C.reset}${this.col(C.red)}used${C.reset}${' '.repeat(39)}${this.col(C.shadow)}used/total${C.reset}${this.col(C.border)}]${C.reset}`,
      'Type and layout of header meters are configurable in the setup screen.',
      '',
      `Process state: ${b('R')}: running; ${b('S')}: sleeping; ${b('T')}: stopped; ${b('Z')}: zombie`,
      '',
      ` ${b('     Arrows')}: scroll process list     ${b('     Space')}: tag process`,
      ` ${b('     Digits')}: incremental PID search  ${b('         U')}: untag all processes`,
      ` ${b('       F3 /')}: incremental name search ${b('         c')}: tag process and its children`,
      ` ${b('       F4 \\')}: incremental name filter ${b('      F9 k')}: kill process/tagged processes`,
      ` ${b('       F5 t')}: tree view               ${b('      F7 ]')}: higher priority (root only)`,
      ` ${b('          u')}: show a single user      ${b('      F8 [')}: lower priority (+ nice)`,
      ` ${b('          K')}: hide/show kernel threads${b('         Z')}: pause/resume process updates`,
      ` ${b('    N P M T')}: sort by PID, CPU%, MEM% or TIME`,
      ` ${b('          I')}: invert sort order       ${b('    F2 C S')}: setup`,
      ` ${b('     F6 > .')}: select sort column      ${b('    F1 h ?')}: show this help screen`,
      ` ${b('     Ctrl-L')}: refresh                 ${b('     F10 q')}: quit`,
      '',
      `${this.col(C.bold)}Press any key to return.${C.reset}`,
    ];
    const out: string[] = [];
    for (let r = 0; r < rows; r++) out.push(truncateAnsi(lines[r] ?? '', cols));
    return out;
  }

  setupOptions(): [string, keyof HtopSettings][] {
    return [
      ['Tree view', 'tree'],
      ["Shadow other users' processes", 'shadowOthers'],
      ['Hide kernel threads', 'hideKernel'],
      ['Hide userland process threads', 'hideThreads'],
      ['Highlight program "basename"', 'highlightBase'],
      ['Highlight large numbers in memory counters', 'highlightMegabytes'],
      ['Count CPUs from 1 instead of 0', 'cpusFromOne'],
      ['Add margin around header', 'headerMargin'],
      ['Show program path', 'showPath'],
    ];
  }

  setupScreen(cols: number, rows: number): string[] {
    const lines: string[] = [];
    const catW = 18;
    const cats = ['Display options', 'Colors'];
    const right = this.setupPanel === 0 ? this.setupOptions().map(([label, key]) => `[${this.s[key] ? 'x' : ' '}] ${label}`) : [`(${this.s.monochrome ? ' ' : '*'}) Default`, `(${this.s.monochrome ? '*' : ' '}) Monochromatic Colors`];
    lines.push(new Line(cols).add('Setup', this.col(C.bold)).toString());
    lines.push(new Line(catW).add('Categories', this.col(C.header)).pad(this.col(C.header)).toString() + ' ' + new Line(cols - catW - 1).add(cats[this.setupPanel], this.col(C.header)).pad(this.col(C.header)).toString());
    for (let r = 0; r < rows - 3; r++) {
      const catLine = new Line(catW);
      if (cats[r] !== undefined) {
        const sgr = r === this.setupPanel ? this.col(C.unfocused) : '';
        catLine.add(cats[r], sgr).pad(sgr);
      } else catLine.pad();
      const itemLine = new Line(cols - catW - 1);
      if (right[r] !== undefined) {
        const sgr = r === this.setupSel ? this.col(C.sel) : '';
        itemLine.add(right[r], sgr).pad(sgr);
      }
      lines.push(catLine.toString() + ' ' + itemLine.toString());
    }
    lines.push(this.functionBar(cols, [['F10', 'Done  ']], '   Space toggles, arrows move, Esc returns'));
    return lines;
  }
}

async function runHtop(ctx: CommandContext, h: Htop, delayMs: number): Promise<number> {
  const scr = new FullScreen(ctx, { name: 'htop', alt: true, hideCursor: true });
  let quit = false;
  const offs = [ctx.onSignal('SIGINT', () => { quit = true; scr.wake(); }), ctx.onSignal('SIGTERM', () => { quit = true; scr.wake(); })];
  let iterations = 0;
  const draw = async (full: boolean) => {
    const lines = h.render(scr.cols, scr.rows);
    let out = full ? '\x1b[H\x1b[2J' : '';
    lines.forEach((l, i) => {
      out += `\x1b[${i + 1};1H\x1b[0m` + l + '\x1b[0m\x1b[K';
    });
    await scr.write(out);
  };
  const selected = (): Task | undefined => h.list()[h.sel];
  const targets = (): Task[] => {
    if (h.tagged.size) return h.sampler.tasks.filter((t) => h.tagged.has(t.pid));
    const t = selected();
    return t ? [t] : [];
  };
  const bell = () => scr.write('\x07');
  const searchFrom = (start: number, dir = 1): boolean => {
    const list = h.list();
    const needle = h.search.toLowerCase();
    if (!needle) return true;
    for (let i = 0; i < list.length; i++) {
      const idx = (((start + i * dir) % list.length) + list.length) % list.length;
      if (list[idx].cmd.toLowerCase().includes(needle)) {
        h.sel = idx;
        return true;
      }
    }
    return false;
  };

  await scr.start();
  try {
    h.sampler.sample();
    let full = true;
    for (;;) {
      if (await scr.sync()) full = true;
      if (quit) break;
      await draw(full);
      full = false;
      const k = await scr.key(delayMs);
      if (quit) break;
      if (k === 'timeout') {
        if (!h.paused) h.sampler.sample();
        if (++iterations >= h.maxIterations) break;
        continue;
      }
      if (k === null) continue;
      const name = keyName(k);
      const avail = Math.max(1, scr.rows - h.headerLines(scr.cols).length - 2);
      if (name === 'C-c') break;
      if (name === 'C-z') {
        ctx.proc.job.kill('SIGTSTP');
        continue;
      }
      if (h.mode === 'help') {
        h.mode = 'main';
        full = true;
        continue;
      }
      if (h.mode === 'setup') {
        const opts = h.setupOptions();
        const count = h.setupPanel === 0 ? opts.length : 2;
        if (name === 'escape' || name === 'f10' || name === 'q') h.mode = 'main';
        else if (name === 'up') h.setupSel = Math.max(0, h.setupSel - 1);
        else if (name === 'down') h.setupSel = Math.min(count - 1, h.setupSel + 1);
        else if (name === 'left' || name === 'right' || name === 'tab') {
          h.setupPanel = h.setupPanel === 0 ? 1 : 0;
          h.setupSel = 0;
        } else if (name === ' ' || name === 'enter') {
          if (h.setupPanel === 0) {
            const key = opts[h.setupSel][1];
            h.s[key] = !h.s[key];
          } else h.s.monochrome = h.setupSel === 1;
        }
        full = true;
        continue;
      }
      if (h.mode === 'kill' || h.mode === 'sort' || h.mode === 'user') {
        const items = h.menuItems();
        if (name === 'escape' || name === 'f10' || name === 'q') {
          h.mode = 'main';
          full = true;
        } else if (name === 'up') h.menuSel = Math.max(0, h.menuSel - 1);
        else if (name === 'down') h.menuSel = Math.min(items.length - 1, h.menuSel + 1);
        else if (name === 'pgup') h.menuSel = Math.max(0, h.menuSel - avail);
        else if (name === 'pgdn') h.menuSel = Math.min(items.length - 1, h.menuSel + avail);
        else if (name === 'home') h.menuSel = 0;
        else if (name === 'end') h.menuSel = items.length - 1;
        else if (h.mode === 'kill' && k.t === 'text' && /\d/.test(k.s)) {
          const idx = HTOP_SIGNALS.findIndex(([n]) => String(n).startsWith(k.s));
          if (idx >= 0) h.menuSel = idx;
        } else if (name === 'enter') {
          if (h.mode === 'kill') {
            const [num] = HTOP_SIGNALS[h.menuSel];
            if (num !== 0) {
              const sig = parseSignalName(String(num));
              let failed = false;
              if (sig) for (const t of targets()) if (sendSignal(ctx, t.pid, sig)) failed = true;
              if (failed) await bell();
              await ctx.sleep(30);
              h.sampler.sample();
            }
          } else if (h.mode === 'sort') {
            h.sort = HTOP_KEYS[h.menuSel];
            h.ascending = HTOP_ASCENDING.has(h.sort);
            h.s.tree = false;
          } else {
            h.userFilter = h.menuSel === 0 ? null : items[h.menuSel];
            h.sel = 0;
          }
          h.mode = 'main';
          full = true;
        }
        continue;
      }
      if (h.mode === 'search' || h.mode === 'filter') {
        if (name === 'escape') {
          if (h.mode === 'filter') h.filter = '';
          h.mode = 'main';
        } else if (name === 'enter') h.mode = 'main';
        else if (name === 'f3' && h.mode === 'search') h.searchFailed = !searchFrom(h.sel + 1);
        else if (name === 'backspace') {
          if (h.mode === 'search') h.search = [...h.search].slice(0, -1).join('');
          else h.filter = [...h.filter].slice(0, -1).join('');
        } else if (k.t === 'text') {
          if (h.mode === 'search') {
            h.search += k.s;
            h.searchFailed = !searchFrom(h.sel);
          } else {
            h.filter += k.s;
            h.sel = 0;
          }
        } else if (name === 'up' || name === 'down') {
          h.mode = 'main';
          h.sel += name === 'up' ? -1 : 1;
        }
        continue;
      }
      // main mode
      if (k.t === 'text' && /\d/.test(k.s)) {
        h.pidSearch += k.s;
        const list = h.list();
        const idx = list.findIndex((t) => String(t.pid).startsWith(h.pidSearch));
        if (idx >= 0) h.sel = idx;
        else h.pidSearch = k.s;
        continue;
      }
      h.pidSearch = '';
      switch (name) {
        case 'q':
        case 'f10':
          quit = true;
          break;
        case 'up':
        case 'C-p':
          h.sel--;
          break;
        case 'down':
        case 'C-n':
          h.sel++;
          break;
        case 'pgup':
          h.sel -= avail;
          break;
        case 'pgdn':
          h.sel += avail;
          break;
        case 'home':
          h.sel = 0;
          break;
        case 'end':
          h.sel = h.list().length - 1;
          break;
        case 'f1':
        case 'h':
        case '?':
          h.mode = 'help';
          full = true;
          break;
        case 'f2':
        case 'S':
        case 'C':
          h.mode = 'setup';
          h.setupPanel = 0;
          h.setupSel = 0;
          full = true;
          break;
        case 'f3':
        case '/':
          h.mode = 'search';
          h.search = '';
          h.searchFailed = false;
          break;
        case 'f4':
        case '\\':
          h.mode = 'filter';
          break;
        case 'f5':
        case 't':
          h.s.tree = !h.s.tree;
          break;
        case 'f6':
        case '>':
        case '.':
        case '<':
        case ',':
          h.mode = 'sort';
          h.menuSel = Math.max(0, HTOP_KEYS.indexOf(h.sort));
          h.menuTop = 0;
          break;
        case 'f9':
        case 'k':
          if (!h.list().length) break;
          h.mode = 'kill';
          h.menuSel = HTOP_SIGNALS.findIndex(([n]) => n === 15);
          h.menuTop = 0;
          break;
        case 'u':
          h.mode = 'user';
          h.menuSel = 0;
          h.menuTop = 0;
          break;
        case 'f7':
        case ']':
        case 'f8':
        case '[': {
          const delta = name === 'f7' || name === ']' ? -1 : 1;
          let failed = false;
          for (const t of targets()) {
            const v = Math.max(-20, Math.min(19, t.ni + delta));
            if (canRenice(ctx, t, v)) failed = true;
            else niceMap(ctx).set(t.pid, v);
          }
          if (failed) await bell();
          h.sampler.sample();
          break;
        }
        case ' ': {
          const t = selected();
          if (t) {
            if (h.tagged.has(t.pid)) h.tagged.delete(t.pid);
            else h.tagged.add(t.pid);
            h.sel++;
          }
          break;
        }
        case 'U':
          h.tagged.clear();
          break;
        case 'c': {
          const t = selected();
          if (t) {
            const add = (pid: number) => {
              h.tagged.add(pid);
              for (const c of h.sampler.tasks) if (c.ppid === pid && c.pid !== pid) add(c.pid);
            };
            add(t.pid);
          }
          break;
        }
        case 'M':
          h.sort = 'PERCENT_MEM';
          h.ascending = false;
          h.s.tree = false;
          break;
        case 'P':
          h.sort = 'PERCENT_CPU';
          h.ascending = false;
          h.s.tree = false;
          break;
        case 'T':
          h.sort = 'TIME';
          h.ascending = false;
          h.s.tree = false;
          break;
        case 'N':
          h.sort = 'PID';
          h.ascending = true;
          h.s.tree = false;
          break;
        case 'I':
          h.ascending = !h.ascending;
          break;
        case 'K':
          h.s.hideKernel = !h.s.hideKernel;
          break;
        case 'H':
          h.s.hideThreads = !h.s.hideThreads;
          break;
        case 'p':
          h.s.showPath = !h.s.showPath;
          break;
        case 'Z':
          h.paused = !h.paused;
          break;
        case 'C-l':
          full = true;
          h.sampler.sample();
          break;
        default:
          break;
      }
      if (quit) break;
    }
  } finally {
    for (const off of offs) off();
    await scr.finish();
  }
  return 0;
}

const HTOP_HELP = `htop 3.3.0
(C) 2004-2019 Hisham Muhammad. (C) 2020-2023 htop dev team.
Released under the GNU GPLv2+.

-C --no-color                   Use a monochrome color scheme
-d --delay=DELAY                Set the delay between updates, in tenths of seconds
-F --filter=FILTER              Show only the commands matching the given filter
-h --help                       Print this help screen
-n --max-iterations=NUMBER      Exit htop after NUMBER iterations/frame updates
-p --pid=PID[,PID,PID...]       Show only the given PIDs
-s --sort-key=COLUMN            Sort by COLUMN in list view (try --sort-key=help for a list)
-t --tree                       Show the tree view (can be combined with -s)
-u --user[=USERNAME]            Show only processes for a given user (or $USER)
-V --version                    Print version info

Press F1 inside htop for online help.
See 'man htop' for more information.
`;

defineCommand({
  name: 'htop',
  pkg: 'htop',
  size: 342048,
  gnu: false,
  doc: {
    category: 'processes',
    summary: 'interactive process viewer',
    synopsis: ['htop [-dCFhnpstuV]'],
    description:
      'htop is a colorful, interactive process viewer. The top of the screen shows meters for each CPU, for memory and swap, plus the number of tasks, the load average and the uptime. Below them is the list of processes, with the selected one highlighted.\n\n' +
      'Use the arrow keys to move the selection. The function keys are listed on the bottom line: F1 help, F3 search, F4 filter, F5 tree view, F6 choose the sort column, F7/F8 change the priority (nice value), F9 kill the selected process (choose a signal and press Enter) and F10 (or q) to quit. Letters work too: k kills, t toggles the tree view, M sorts by memory and P by CPU.',
    options: [
      { flags: '-C, --no-color', desc: 'Start htop in monochrome mode.' },
      { flags: '-d, --delay=DELAY', desc: 'Delay between updates, in tenths of seconds (default 15).' },
      { flags: '-F, --filter=FILTER', desc: 'Show only processes whose command line contains FILTER.' },
      { flags: '-n, --max-iterations=NUMBER', desc: 'Exit after NUMBER updates.' },
      { flags: '-p, --pid=PID,PID...', desc: 'Show only the given PIDs.' },
      { flags: '-s, --sort-key=COLUMN', desc: 'Sort by this column (use --sort-key=help for a list).' },
      { flags: '-t, --tree', desc: 'Show the tree view of processes.' },
      { flags: '-u, --user=USERNAME', desc: 'Show only the processes of a given user.' },
      { flags: '-V, --version', desc: 'Output version information and exit.' },
    ],
    examples: [
      { cmd: 'htop', desc: 'Browse running processes (press F10 or q to quit).' },
      { cmd: 'htop -t', desc: 'Start in tree view to see which process started which.' },
      { cmd: 'htop -u learner', desc: 'Only your own processes.' },
    ],
    seeAlso: ['top', 'ps', 'kill'],
    tip: 'htop is like a friendlier top. Select a process with the arrow keys and press F9 (or k) to stop it.',
  },
  run: async (ctx) => {
    const h = new Htop(ctx);
    let delay = 15;
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const m = /^(--[a-z-]+)(?:=(.*))?$/.exec(a);
      const take = (inline: string | undefined): string | null => (inline !== undefined ? inline : i + 1 < args.length ? args[++i] : null);
      let opt = a;
      let inline: string | undefined;
      if (m) {
        opt = m[1];
        inline = m[2];
      } else if (/^-[dFnpsu].+/.test(a)) {
        opt = a.slice(0, 2);
        inline = a.slice(2);
      }
      switch (opt) {
        case '-h':
        case '--help':
          await ctx.out(HTOP_HELP);
          return 0;
        case '-V':
        case '--version':
          await ctx.out('htop 3.3.0\n');
          return 0;
        case '-C':
        case '--no-color':
        case '--no-colour':
          h.s.monochrome = true;
          break;
        case '-t':
        case '--tree':
          h.s.tree = true;
          break;
        case '-M':
        case '--no-mouse':
        case '-U':
        case '--no-unicode':
        case '--readonly':
        case '-H':
        case '--highlight-changes':
          break;
        case '-d':
        case '--delay': {
          const v = take(inline);
          if (v === null || !/^\d+$/.test(v)) {
            await ctx.err(`Error: invalid delay value "${v ?? ''}".\n`);
            return 1;
          }
          delay = Math.max(1, Math.min(100, parseInt(v, 10)));
          break;
        }
        case '-n':
        case '--max-iterations': {
          const v = take(inline);
          if (v === null || !/^\d+$/.test(v)) {
            await ctx.err(`Error: invalid max iterations value "${v ?? ''}".\n`);
            return 1;
          }
          h.maxIterations = parseInt(v, 10) || Infinity;
          break;
        }
        case '-F':
        case '--filter': {
          const v = take(inline);
          if (v === null) {
            await ctx.err('htop: option requires an argument -- \'F\'\n');
            return 1;
          }
          h.filter = v;
          break;
        }
        case '-p':
        case '--pid': {
          const v = take(inline);
          if (v === null || !/^\d+(,\d+)*$/.test(v)) {
            await ctx.err('Error: invalid PID list.\n');
            return 1;
          }
          h.pids = v.split(',').map(Number);
          break;
        }
        case '-s':
        case '--sort-key': {
          const v = take(inline);
          if (v === 'help') {
            await ctx.out(HTOP_KEYS.map((k) => `${k.padEnd(19)} ${{ PID: 'Process/thread ID', USER: 'Username of the process owner (or user ID if name cannot be determined)', PRIORITY: "Kernel's internal priority for the process", NICE: 'The process\'s nice value', M_VIRT: 'Total program size in virtual memory', M_RESIDENT: 'Resident set size, size of the text and data sections, plus stack usage', M_SHARE: 'Size of the process\'s shared pages', STATE: 'Process state (S sleeping, R running, Z zombie, T stopped)', PERCENT_CPU: 'Percentage of the CPU time the process used in the last sampling', PERCENT_MEM: 'Percentage of the memory the process is using, based on resident memory size', TIME: 'Total time the process has spent in user and system time', Command: 'Command line of the process' }[k]}`).join('\n') + '\n');
            return 0;
          }
          const key = HTOP_KEYS.find((k) => k.toLowerCase() === (v ?? '').toLowerCase());
          if (!key) {
            await ctx.err(`Error: invalid column "${v ?? ''}".\n`);
            return 1;
          }
          h.sort = key;
          h.ascending = HTOP_ASCENDING.has(key);
          break;
        }
        case '-u':
        case '--user': {
          const v = inline ?? (i + 1 < args.length && !args[i + 1].startsWith('-') ? args[++i] : ctx.env.get('USER') ?? 'learner');
          if (!ctx.system.userByName(v)) {
            await ctx.err(`Error: invalid user "${v}".\n`);
            return 1;
          }
          h.userFilter = v;
          break;
        }
        default:
          if (a.startsWith('--')) await ctx.err(`htop: unrecognized option '${a}'\n`);
          else await ctx.err(`htop: invalid option -- '${a.slice(1, 2)}'\n`);
          await ctx.err('Try \'htop --help\' for more information.\n');
          return 1;
      }
    }
    if (!ctx.tty || !ctx.stdout.isTTY) {
      // Not a terminal: print one plain snapshot instead of the interactive screen.
      h.s.monochrome = true;
      h.s.headerMargin = false;
      h.sampler.sample();
      const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
      const out = [...h.headerLines(80).map((l) => plain(l).replace(/\s+$/, '')), '', plain(h.panelHeader(80)).replace(/\s+$/, '')];
      for (const t of h.list()) out.push(plain(h.row(t, 512, false)).replace(/\s+$/, ''));
      await ctx.out(out.join('\n') + '\n');
      return 0;
    }
    return runHtop(ctx, h, delay * 100);
  },
});

// ---------------------------------------------------------------------------
// watch

const WATCH_USAGE = `
Usage:
 watch [options] command

Options:
  -b, --beep             beep if command has a non-zero exit
  -c, --color            interpret ANSI color and style sequences
  -C, --no-color         do not interpret ANSI color and style sequences
  -d, --differences[=<permanent>]
                         highlight changes between updates
  -e, --errexit          exit if command has a non-zero exit
  -g, --chgexit          exit when output from command changes
  -q, --equexit <cycles>
                         exit when output from command does not change
  -n, --interval <secs>  seconds to wait between updates
  -p, --precise          attempt run command in precise intervals
  -r, --no-rerun         do not rerun program on window resize
  -t, --no-title         turn off header
  -w, --no-wrap          turn off line wrapping
  -x, --exec             pass command to exec instead of "sh -c"

 -h, --help     display this help and exit
 -v, --version  output version information and exit

For more details see watch(1).
`;

interface WatchOptions {
  interval: number;
  diff: false | 'normal' | 'permanent';
  title: boolean;
  beep: boolean;
  color: boolean;
  errexit: boolean;
  chgexit: boolean;
  equexit: number;
  wrap: boolean;
  exec: boolean;
}

/** Lay command output out on screen cells (one string per row, each exactly `width` wide). */
function watchLayout(text: string, width: number, height: number, o: WatchOptions): { cells: string[][]; styles: string[][] } {
  const cells: string[][] = [];
  const styles: string[][] = [];
  let row: string[] = [];
  let st: string[] = [];
  let sgr = '';
  const pushRow = () => {
    while (row.length < width) {
      row.push(' ');
      st.push('');
    }
    cells.push(row);
    styles.push(st);
    row = [];
    st = [];
  };
  let skipRest = false;
  for (let i = 0; i < text.length && cells.length < height; i++) {
    const c = text[i];
    if (c === '\n') {
      pushRow();
      skipRest = false;
      continue;
    }
    if (c === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(i));
      if (m && o.color) {
        if (m[0].endsWith('m')) sgr = m[0] === '\x1b[0m' || m[0] === '\x1b[m' ? '' : sgr + m[0];
        i += m[0].length - 1;
        continue;
      }
      continue;
    }
    if (skipRest) continue;
    if (c === '\t') {
      const n = 8 - (row.length % 8);
      for (let k = 0; k < n && row.length < width; k++) {
        row.push(' ');
        st.push(sgr);
      }
      continue;
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (ch.length > 1) i++;
    if (cp < 0x20 || cp === 0x7f) continue;
    const w = charWidth(cp);
    if (w === 0) {
      // Combining marks join the previous cell.
      if (row.length) row[row.length - 1] += ch;
      continue;
    }
    if (row.length + w > width) {
      if (!o.wrap) {
        skipRest = true;
        continue;
      }
      pushRow();
      if (cells.length >= height) break;
    }
    row.push(ch);
    st.push(sgr);
    if (w === 2) {
      row.push('');
      st.push(sgr);
    }
  }
  if (row.length && cells.length < height) pushRow();
  while (cells.length < height) pushRow();
  return { cells, styles };
}

async function runWatch(ctx: CommandContext, o: WatchOptions, argv: string[], cmdText: string): Promise<number> {
  const interactive = !!ctx.tty && ctx.stdout.isTTY;
  const sys = ctx.system;
  const run = async (cols: number, rows: number): Promise<{ text: string; status: number }> => {
    const cap = new CaptureOutput({ limit: 1 << 20 });
    const env = new Map(ctx.env);
    env.set('COLUMNS', String(cols));
    env.set('LINES', String(rows));
    let status: number;
    try {
      status = await ctx.exec(o.exec ? argv : ['sh', '-c', cmdText], { stdout: cap, stderr: cap, stdin: new NullInput(), env });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      status = 1;
    }
    if (status === 127 && o.exec) {
      await cap.write(`watch: unable to execute ${argv[0]}\n`).catch(() => {});
    }
    return { text: cap.text(), status };
  };
  const header = (cols: number): string => {
    const left = `Every ${o.interval.toFixed(1)}s: `;
    const right = `${sys.hostname}: ${strftime('%a %b %e %H:%M:%S %Y', sys.now())}`;
    const rhlen = right.length + 1;
    const hlen = left.length;
    if (cols < rhlen) return '';
    const line = new Array(cols).fill(' ');
    const put = (at: number, s: string) => {
      for (let i = 0; i < s.length && at + i < cols; i++) if (at + i >= 0) line[at + i] = s[i];
    };
    if (rhlen + hlen + 1 <= cols) {
      put(0, left);
      if (rhlen + hlen + 2 <= cols) {
        if (cols < rhlen + hlen + 4) put(cols - rhlen - 4, '... ');
        else if (cols < rhlen + hlen + cmdText.length) {
          put(hlen, cmdText.slice(0, cols - rhlen - hlen - 4));
          put(cols - rhlen - 4, '... ');
        } else put(hlen, cmdText.slice(0, cols - rhlen - hlen));
      }
    }
    put(cols - rhlen + 1, right);
    return line.join('').replace(/\s+$/, '');
  };

  if (!interactive) {
    // No terminal to draw on: print each update one after another.
    let prev: string | null = null;
    let same = 0;
    for (let n = 0; ; n++) {
      await ctx.checkpoint();
      if (n > 0) await ctx.sleep(o.interval * 1000);
      const r = await run(80, 24);
      if (o.title) await ctx.out(header(80) + '\n\n');
      await ctx.out(r.text.endsWith('\n') || r.text === '' ? r.text : r.text + '\n');
      if (r.status !== 0 && o.errexit) return 8;
      if (prev !== null && r.text !== prev && o.chgexit) return 0;
      same = prev !== null && r.text === prev ? same + 1 : 0;
      if (o.equexit && same >= o.equexit) return 0;
      prev = r.text;
    }
  }

  const scr = new FullScreen(ctx, { name: 'watch', alt: true, hideCursor: false });
  let quit = false;
  const offs = [ctx.onSignal('SIGINT', () => { quit = true; scr.wake(); }), ctx.onSignal('SIGTERM', () => { quit = true; scr.wake(); }), ctx.onSignal('SIGHUP', () => { quit = true; scr.wake(); })];
  let status = 0;
  await scr.start();
  try {
    let prevCells: string[][] | null = null;
    let prevText: string | null = null;
    let everChanged: boolean[][] = [];
    let sameCount = 0;
    let first = true;
    for (;;) {
      await scr.sync();
      if (quit) break;
      const cols = scr.cols;
      const rows = scr.rows;
      const top = o.title ? 2 : 0;
      // The interval is measured from the start of each run, like watch does.
      const timer = scr.timer(o.interval * 1000);
      const r = await run(cols, rows - top);
      if (quit) break;
      if (await scr.sync()) prevCells = null;
      if (quit) break;
      const { cells, styles } = watchLayout(r.text, cols, Math.max(0, rows - top), o);
      let out = '\x1b[H\x1b[2J';
      if (o.title) out += '\x1b[1;1H' + header(cols);
      if (o.diff === 'permanent' && everChanged.length !== cells.length) everChanged = cells.map((row) => row.map(() => false));
      for (let y = 0; y < cells.length; y++) {
        let line = `\x1b[${top + y + 1};1H`;
        for (let x = 0; x < cells[y].length; x++) {
          const ch = cells[y][x];
          let changed = false;
          if (o.diff && prevCells && !first) {
            const before = prevCells[y]?.[x] ?? ' ';
            if (before !== ch) changed = true;
            if (o.diff === 'permanent') {
              if (changed) everChanged[y][x] = true;
              changed = everChanged[y]?.[x] ?? false;
            }
          }
          if (ch === '') continue;
          const sgr = (styles[y][x] || '') + (changed ? '\x1b[7m' : '');
          line += sgr ? `${sgr}${ch}\x1b[0m` : ch;
        }
        out += line.replace(/(?: )+$/, '');
      }
      out += `\x1b[${rows};${cols}H`;
      await scr.write(out);
      if (r.status !== 0 && o.beep) await scr.write('\x07');
      if (r.status !== 0 && o.errexit) {
        await scr.write(`\x1b[${rows};1H\x1b[7mcommand exit with a non-zero status, press a key to exit\x1b[0m`);
        await scr.key(null);
        status = 8;
        break;
      }
      if (o.chgexit && prevText !== null && r.text !== prevText) break;
      sameCount = prevText !== null && r.text === prevText ? sameCount + 1 : 0;
      if (o.equexit && sameCount >= o.equexit) break;
      prevCells = cells;
      prevText = r.text;
      first = false;
      // Wait for the next update; keys are ignored (watch only stops with Ctrl+C).
      while (!quit) {
        const k = await scr.key(timer);
        if (k === 'timeout') break;
        if (k === null) {
          if (await scr.sync()) break;
          continue;
        }
        if (keyName(k) === 'C-c') quit = true;
        else if (keyName(k) === 'C-z') ctx.proc.job.kill('SIGTSTP');
      }
      if (quit) break;
    }
  } finally {
    for (const off of offs) off();
    await scr.finish();
  }
  return status;
}

defineCommand({
  name: 'watch',
  pkg: 'procps',
  size: 27304,
  gnu: false,
  doc: {
    category: 'processes',
    summary: 'execute a program periodically, showing output fullscreen',
    synopsis: ['watch [options] command'],
    description:
      'watch runs command repeatedly, displaying its output and errors (the first screenfull). This allows you to watch the program output change over time. By default, command is run every 2 seconds and watch will run until interrupted with Ctrl+C.\n\n' +
      'The header line shows the interval, the command, the host name and the current time. command is given to sh -c, so quote it if it contains pipes or other special characters, for example: watch -n 1 \'ls -l | wc -l\'',
    options: [
      { flags: '-n, --interval=SECONDS', desc: 'Specify update interval. Values smaller than 0.1 are converted to 0.1.' },
      { flags: '-d, --differences[=permanent]', desc: 'Highlight the differences between successive updates. With permanent, everything that has ever changed stays highlighted.' },
      { flags: '-t, --no-title', desc: 'Turn off the header showing the interval, command, and current time at the top of the display, as well as the following blank line.' },
      { flags: '-b, --beep', desc: 'Beep if command has a non-zero exit.' },
      { flags: '-c, --color', desc: 'Interpret ANSI color and style sequences.' },
      { flags: '-e, --errexit', desc: 'Freeze updates on command error, and exit after a key press.' },
      { flags: '-g, --chgexit', desc: 'Exit when the output of command changes.' },
      { flags: '-w, --no-wrap', desc: 'Turn off line wrapping. Long lines will be truncated instead of wrapped to the next line.' },
      { flags: '-x, --exec', desc: 'Pass command to exec instead of sh -c.' },
    ],
    examples: [
      { cmd: 'watch date', desc: 'A clock that updates every 2 seconds (Ctrl+C to stop).' },
      { cmd: 'watch -n 1 ls -l', desc: 'Watch a folder change, once a second.' },
      { cmd: 'watch -d free -h', desc: 'Highlight what changed in the memory numbers.' },
    ],
    seeAlso: ['top', 'sleep'],
    tip: 'watch keeps going until you press Ctrl+C.',
  },
  run: async (ctx) => {
    const o: WatchOptions = { interval: 2, diff: false, title: true, beep: false, color: false, errexit: false, chgexit: false, equexit: 0, wrap: true, exec: false };
    const args = [...ctx.args];
    let i = 0;
    const longs: Record<string, string> = { beep: 'b', color: 'c', 'no-color': 'C', differences: 'd', errexit: 'e', chgexit: 'g', equexit: 'q', interval: 'n', precise: 'p', 'no-rerun': 'r', 'no-title': 't', 'no-wrap': 'w', exec: 'x', help: 'h', version: 'v' };
    const parseInterval = async (v: string): Promise<boolean> => {
      const n = Number(v.replace(',', '.'));
      if (v.trim() === '' || !Number.isFinite(n)) {
        await ctx.err(`watch: failed to parse argument: '${v}': Invalid argument\n`);
        return false;
      }
      o.interval = Math.max(0.1, n);
      return true;
    };
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        i++;
        break;
      }
      if (!a.startsWith('-') || a === '-') break;
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
        const val = eq === -1 ? undefined : a.slice(eq + 1);
        const hits = Object.keys(longs).filter((k) => k.startsWith(name));
        const key = longs[name] ?? (hits.length === 1 ? longs[hits[0]] : undefined);
        if (!key) {
          await ctx.err(`watch: unrecognized option '${a}'\n${WATCH_USAGE}`);
          return 1;
        }
        if (key === 'd') {
          o.diff = val === 'permanent' || val === 'cumulative' ? 'permanent' : 'normal';
          continue;
        }
        if (key === 'n' || key === 'q') {
          const v = val ?? args[++i];
          if (v === undefined) {
            await ctx.err(`watch: option '--${name}' requires an argument\n${WATCH_USAGE}`);
            return 1;
          }
          if (key === 'n') {
            if (!(await parseInterval(v))) return 1;
          } else o.equexit = Math.max(1, parseInt(v, 10) || 1);
          continue;
        }
        args[i] = '-' + key;
      }
      const s = args[i];
      for (let j = 1; j < s.length; j++) {
        const c = s[j];
        switch (c) {
          case 'b': o.beep = true; break;
          case 'c': o.color = true; break;
          case 'C': o.color = false; break;
          case 'd':
            // getopt "d::": anything attached to -d is its argument, and any argument means permanent.
            o.diff = s.slice(j + 1) ? 'permanent' : 'normal';
            j = s.length;
            break;
          case 'e': o.errexit = true; break;
          case 'g': o.chgexit = true; break;
          case 'p': case 'r': break;
          case 't': o.title = false; break;
          case 'w': o.wrap = false; break;
          case 'x': o.exec = true; break;
          case 'h':
            await ctx.out(WATCH_USAGE);
            return 0;
          case 'v':
            await ctx.out('watch from procps-ng 4.0.4\n');
            return 0;
          case 'n':
          case 'q': {
            const v = s.slice(j + 1) || args[++i];
            if (v === undefined) {
              await ctx.err(`watch: option requires an argument -- '${c}'\n${WATCH_USAGE}`);
              return 1;
            }
            if (c === 'n') {
              if (!(await parseInterval(v))) return 1;
            } else o.equexit = Math.max(1, parseInt(v, 10) || 1);
            j = s.length;
            break;
          }
          default:
            await ctx.err(`watch: invalid option -- '${c}'\n${WATCH_USAGE}`);
            return 1;
        }
      }
    }
    const rest = args.slice(i);
    if (rest.length === 0) {
      await ctx.err(WATCH_USAGE);
      return 1;
    }
    return runWatch(ctx, o, rest, rest.join(' '));
  },
});
