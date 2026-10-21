// Job control builtins: jobs, fg, bg, wait, kill, disown.

import { formatJobLine } from '../jobs';
import type { Job } from '../process';
import { SIGNAL_NUMBERS, signalByNumber, type SignalName } from '../streams';
import { defineBuiltin, type BuiltinContext } from './registry';

/** Resolves when the job finishes or stops. */
export function waitForJob(job: Job): Promise<'done' | 'stopped'> {
  return new Promise((resolve) => {
    if (job.state === 'done') {
      resolve('done');
      return;
    }
    if (job.state === 'stopped') {
      resolve('stopped');
      return;
    }
    const off = job.onChange((j) => {
      if (j.state === 'done' || j.state === 'stopped') {
        off();
        resolve(j.state);
      }
    });
  });
}

async function resolveJob(ctx: BuiltinContext, spec: string | undefined, label: string): Promise<Job | null> {
  const jobs = ctx.sh.jobs;
  if (spec === undefined) {
    const cur = jobs.getCurrent();
    if (!cur) {
      await ctx.error(`${label}: no such job`);
      return null;
    }
    return cur;
  }
  const r = jobs.find(spec);
  if (r === 'ambiguous') {
    await ctx.error(`${spec}: ambiguous job spec`);
    return null;
  }
  if (!r) {
    await ctx.error(`${spec}: no such job`);
    return null;
  }
  return r;
}

defineBuiltin(
  'jobs',
  {
    usage: 'jobs [-lnprs] [jobspec ...] or jobs -x command [args]',
    summary: 'Display status of jobs.',
    body: 'Lists the active jobs.  JOBSPEC restricts output to that job.\nWithout options, the status of all active jobs is displayed.\n\nOptions:\n  -l\tlists process IDs in addition to the normal information\n  -p\tlists process IDs only\n  -r\trestrict output to running jobs\n  -s\trestrict output to stopped jobs',
  },
  async (ctx) => {
    const flags = ctx.args.filter((a) => a.startsWith('-')).join('');
    const jobs = ctx.sh.jobs;
    let out = '';
    for (const job of jobs.all()) {
      if (flags.includes('r') && job.state !== 'running') continue;
      if (flags.includes('s') && job.state !== 'stopped') continue;
      if (flags.includes('p')) {
        out += job.leaderPid + '\n';
        continue;
      }
      out += formatJobLine(job, jobs.marker(job), flags.includes('l')) + '\n';
      if (job.state === 'done') {
        job.reportedState = 'done';
        jobs.remove(job);
      }
    }
    await ctx.out(out);
    return 0;
  },
);

defineBuiltin(
  'fg',
  { usage: 'fg [job_spec]', summary: 'Move job to the foreground.', body: 'Place the job identified by JOB_SPEC in the foreground, making it the\ncurrent job.  If JOB_SPEC is not present, the shell\'s notion of the\ncurrent job is used.' },
  async (ctx) => {
    const job = await resolveJob(ctx, ctx.args[0], ctx.args[0] ?? 'current');
    if (!job) return 1;
    const tty = ctx.sh.system.tty;
    await ctx.out(job.command + '\n');
    const prev = tty?.foreground ?? null;
    if (tty) tty.foreground = job;
    job.background = false;
    ctx.sh.jobs.makeCurrent(job);
    job.cont();
    const result = await waitForJob(job);
    if (tty) tty.foreground = prev;
    if (result === 'stopped') {
      job.reportedState = 'stopped';
      await ctx.err('\n' + formatJobLine(job, ctx.sh.jobs.marker(job)) + '\n');
      return 128 + SIGNAL_NUMBERS.SIGTSTP;
    }
    job.reportedState = 'done';
    ctx.sh.jobs.remove(job);
    const status = job.status ?? 0;
    if (job.termSignal === 'SIGINT') await ctx.err('\n');
    return status;
  },
);

defineBuiltin(
  'bg',
  { usage: 'bg [job_spec ...]', summary: 'Move jobs to the background.', body: 'Place the jobs identified by each JOB_SPEC in the background, as if they\nhad been started with `&\'.' },
  async (ctx) => {
    const specs = ctx.args.length ? ctx.args : [undefined];
    let status = 0;
    for (const spec of specs) {
      const job = await resolveJob(ctx, spec, spec ?? 'current');
      if (!job) {
        status = 1;
        continue;
      }
      if (job.state === 'running') {
        await ctx.error(`job ${job.id} already in background`);
        continue;
      }
      job.background = true;
      job.cont();
      job.reportedState = 'running';
      await ctx.out(`[${job.id}]${ctx.sh.jobs.marker(job)} ${job.command} &\n`);
    }
    return status;
  },
);

defineBuiltin(
  'wait',
  { usage: 'wait [-fn] [-p var] [id ...]', summary: 'Wait for job completion and return exit status.', body: 'Waits for each process identified by an ID, which may be a process ID or a\njob specification, and reports its termination status.  If ID is not\ngiven, waits for all currently active child processes.' },
  async (ctx) => {
    const jobs = ctx.sh.jobs;
    const ids = ctx.args.filter((a) => !a.startsWith('-'));
    if (ids.length === 0) {
      for (const job of jobs.all()) {
        if (job.state === 'done') continue;
        await job.done;
      }
      return 0;
    }
    let status = 0;
    for (const id of ids) {
      let job: Job | null | 'ambiguous' = null;
      if (id.startsWith('%')) job = jobs.find(id);
      else job = jobs.all().find((j) => String(j.leaderPid) === id) ?? null;
      if (!job || job === 'ambiguous') {
        await ctx.error(`pid ${id} is not a child of this shell`);
        status = 127;
        continue;
      }
      status = await job.done;
    }
    return status;
  },
);

defineBuiltin(
  'disown',
  { usage: 'disown [-h] [-ar] [jobspec ... | pid ...]', summary: 'Remove jobs from current shell.', body: 'Removes each JOBSPEC argument from the table of active jobs.' },
  async (ctx) => {
    const specs = ctx.args.filter((a) => !a.startsWith('-'));
    if (ctx.args.includes('-a')) {
      for (const j of ctx.sh.jobs.all()) ctx.sh.jobs.remove(j);
      return 0;
    }
    const job = await resolveJob(ctx, specs[0], specs[0] ?? 'current');
    if (!job) return 1;
    ctx.sh.jobs.remove(job);
    return 0;
  },
);

// --- kill ----------------------------------------------------------------------------

export const SIGNAL_LIST: [number, string][] = [
  [1, 'SIGHUP'], [2, 'SIGINT'], [3, 'SIGQUIT'], [4, 'SIGILL'], [5, 'SIGTRAP'], [6, 'SIGABRT'], [7, 'SIGBUS'], [8, 'SIGFPE'],
  [9, 'SIGKILL'], [10, 'SIGUSR1'], [11, 'SIGSEGV'], [12, 'SIGUSR2'], [13, 'SIGPIPE'], [14, 'SIGALRM'], [15, 'SIGTERM'],
  [16, 'SIGSTKFLT'], [17, 'SIGCHLD'], [18, 'SIGCONT'], [19, 'SIGSTOP'], [20, 'SIGTSTP'], [21, 'SIGTTIN'], [22, 'SIGTTOU'],
  [23, 'SIGURG'], [24, 'SIGXCPU'], [25, 'SIGXFSZ'], [26, 'SIGVTALRM'], [27, 'SIGPROF'], [28, 'SIGWINCH'], [29, 'SIGIO'],
  [30, 'SIGPWR'], [31, 'SIGSYS'],
];

export function parseSignalName(s: string): SignalName | null {
  const up = s.toUpperCase();
  if (/^\d+$/.test(up)) return signalByNumber(parseInt(up, 10));
  const name = (up.startsWith('SIG') ? up : 'SIG' + up) as SignalName;
  return name in SIGNAL_NUMBERS ? name : null;
}

export function signalListing(): string {
  let out = '';
  SIGNAL_LIST.forEach(([n, name], i) => {
    out += `${String(n).padStart(2)}) ${name}`;
    out += (i + 1) % 5 === 0 || i === SIGNAL_LIST.length - 1 ? '\n' : '\t';
  });
  return out;
}

defineBuiltin(
  'kill',
  {
    usage: 'kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]',
    summary: 'Send a signal to a job.',
    body: 'Send the processes identified by PID or JOBSPEC the signal named by\nSIGSPEC or SIGNUM.  If neither SIGSPEC nor SIGNUM is present, then\nSIGTERM is assumed.\n\nOptions:\n  -s sig\tSIG is a signal name\n  -n sig\tSIG is a signal number\n  -l\tlist the signal names',
  },
  async (ctx) => {
    let args = ctx.args;
    if (args.length === 0) {
      await ctx.err('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n');
      return 2;
    }
    if (args[0] === '-l' || args[0] === '-L') {
      if (args[1]) {
        const sig = parseSignalName(args[1]);
        if (!sig) {
          await ctx.error(`${args[1]}: invalid signal specification`);
          return 1;
        }
        await ctx.out((/^\d+$/.test(args[1]) ? sig.slice(3) : String(SIGNAL_NUMBERS[sig])) + '\n');
        return 0;
      }
      await ctx.out(signalListing());
      return 0;
    }
    let sig: SignalName = 'SIGTERM';
    if (args[0] === '-s' || args[0] === '-n') {
      const s = parseSignalName(args[1] ?? '');
      if (!s) {
        await ctx.error(`${args[1] ?? ''}: invalid signal specification`);
        return 1;
      }
      sig = s;
      args = args.slice(2);
    } else if (/^-/.test(args[0]) && args[0] !== '--') {
      const s = parseSignalName(args[0].slice(1));
      if (!s) {
        await ctx.error(`${args[0].slice(1)}: invalid signal specification`);
        return 1;
      }
      sig = s;
      args = args.slice(1);
    }
    if (args[0] === '--') args = args.slice(1);
    const sys = ctx.sh.system;
    const creds = ctx.sh.state.creds;
    let status = 0;
    for (const target of args) {
      if (target.startsWith('%')) {
        const job = ctx.sh.jobs.find(target);
        if (!job || job === 'ambiguous') {
          await ctx.error(`${target}: no such job`);
          status = 1;
          continue;
        }
        job.kill(sig);
        if (sig === 'SIGCONT' && job.state === 'running') job.background = true;
        continue;
      }
      if (!/^-?\d+$/.test(target)) {
        await ctx.error(`${target}: arguments must be process or job IDs`);
        status = 1;
        continue;
      }
      const pid = parseInt(target, 10);
      const proc = sys.processes.get(pid);
      const job = ctx.sh.jobs.all().find((j) => j.leaderPid === pid);
      if (proc) {
        if (creds.uid !== 0 && proc.uid !== creds.uid) {
          await ctx.error(`(${pid}) - Operation not permitted`);
          status = 1;
          continue;
        }
        if (job && proc.job === job) job.kill(sig);
        else proc.kill(sig);
        continue;
      }
      if (job) {
        job.kill(sig);
        continue;
      }
      if (pid === ctx.sh.state.pid) {
        // signalling our own shell: ignore SIGTERM like interactive bash does
        if (sig === 'SIGKILL') await ctx.err('');
        continue;
      }
      const sp = sys.processes.staticProcs.find((p) => p.pid === pid);
      if (sp) {
        if (creds.uid !== 0 && sp.user !== sys.userName(creds.uid)) {
          await ctx.error(`(${pid}) - Operation not permitted`);
          status = 1;
        }
        continue;
      }
      await ctx.error(`(${pid}) - No such process`);
      status = 1;
    }
    return status;
  },
);
