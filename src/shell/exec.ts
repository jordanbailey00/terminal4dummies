// Starting programs: PATH lookup, permission checks, #! scripts, and the
// process context handed to native (JavaScript) implementations.

import type { Shell } from './interpreter';
import { IO } from './io';
import { Proc } from './process';
import { ProcFs } from './procfs';
import {
  BrokenPipeError,
  GatedInput,
  GatedOutput,
  SignalError,
  WriteError,
  type InputStream,
  type OutputStream,
} from './streams';
import type { CommandContext, ExecOptions, NativeCommand } from './types';
import { FsError, VirtualFS, strerror, type Credentials, type OpContext } from './vfs/fs';

export const MAX_PROCESSES = 400;

export interface SpawnOptions {
  path: string;
  argv: string[];
  env: Map<string, string>;
  io: IO;
  creds: Credentials;
  cwd: string;
  umask: number;
}

/** Search $PATH for an executable, like bash does. */
export function findInPath(fs: VirtualFS, name: string, pathVar: string, ctx: OpContext): string | null {
  if (name === '') return null;
  let fallback: string | null = null;
  for (const dir of pathVar.split(':')) {
    const base = dir === '' ? '.' : dir;
    const p = base.endsWith('/') ? base + name : base + '/' + name;
    const node = fs.tryStat(p, ctx);
    if (!node || node.type === 'dir') continue;
    if (VirtualFS.canAccess(node, ctx.creds, 1)) return p;
    if (!fallback) fallback = p;
  }
  return fallback;
}

async function safeWrite(s: OutputStream, text: string): Promise<void> {
  try {
    await s.write(text);
  } catch {
    // ignore
  }
}

/** Execute the program at `path`. Returns its exit status. */
export async function spawnProgram(sh: Shell, o: SpawnOptions, depth = 0): Promise<number> {
  const fs = sh.system.fs;
  const ctx: OpContext = { cwd: o.cwd, creds: o.creds, umask: o.umask };
  const prefix = sh.errorPrefix();
  let node;
  try {
    node = fs.stat(o.path, ctx);
  } catch (e) {
    await safeWrite(o.io.stderr, `${prefix}${o.path}: ${strerror(e)}\n`);
    return e instanceof FsError && e.code === 'ENOENT' ? 127 : 126;
  }
  if (node.type === 'dir') {
    await safeWrite(o.io.stderr, `${prefix}${o.path}: Is a directory\n`);
    return 126;
  }
  if (node.type !== 'file' || !VirtualFS.canAccess(node, o.creds, 1)) {
    await safeWrite(o.io.stderr, `${prefix}${o.path}: Permission denied\n`);
    return 126;
  }
  const data = node.data;
  if (typeof data !== 'string') {
    if (data.kind === 'native') {
      const cmd = sh.system.commands.get(data.command);
      if (cmd) return runNative(sh, cmd, o);
    }
    await safeWrite(o.io.stderr, `${prefix}${o.path}: cannot execute binary file: Exec format error\n`);
    return 126;
  }
  if (!VirtualFS.canAccess(node, o.creds, 4)) {
    await safeWrite(o.io.stderr, `${prefix}${o.path}: Permission denied\n`);
    return 126;
  }
  if (depth > 4) {
    await safeWrite(o.io.stderr, `${prefix}${o.path}: Too many levels of symbolic links\n`);
    return 126;
  }
  const firstLine = data.split('\n', 1)[0];
  if (firstLine.startsWith('#!')) {
    const spec = firstLine.slice(2).trim();
    const m = /^(\S+)(?:\s+(.*))?$/.exec(spec);
    if (!m) {
      await safeWrite(o.io.stderr, `${prefix}${o.path}: : bad interpreter: No such file or directory\n`);
      return 126;
    }
    const interp = m[1];
    const interpNode = fs.tryStat(interp, ctx);
    if (!interpNode || interpNode.type !== 'file') {
      await safeWrite(o.io.stderr, `${prefix}${o.path}: ${interp}: bad interpreter: No such file or directory\n`);
      return 126;
    }
    const argv = [interp, ...(m[2] ? [m[2].trim()] : []), o.path, ...o.argv.slice(1)];
    return spawnProgram(sh, { ...o, path: interp, argv }, depth + 1);
  }
  // No #! line: bash runs the file as a shell script.
  return spawnProgram(sh, { ...o, path: '/bin/bash', argv: ['bash', o.path, ...o.argv.slice(1)] }, depth + 1);
}

async function runNative(sh: Shell, cmd: NativeCommand, o: SpawnOptions): Promise<number> {
  const sys = sh.system;
  const job = o.io.job;
  if (sys.processes.size >= MAX_PROCESSES) {
    await safeWrite(o.io.stderr, `bash: fork: retry: Resource temporarily unavailable\n`);
    return 254;
  }
  const pid = job.takeLeaderPid() ?? sys.processes.allocPid();
  const proc = new Proc({
    pid,
    ppid: sh.state.bashPid,
    job,
    argv: o.argv,
    uid: o.creds.uid,
    tty: sys.tty?.name ?? null,
    startTime: sys.now(),
  });
  job.procs.add(proc);
  sys.processes.add(proc);
  const ctx = makeContext(sh, o, proc);
  try {
    const status = await cmd.run(ctx);
    return status & 255;
  } catch (e) {
    if (e instanceof BrokenPipeError) return 141;
    if (e instanceof SignalError) return e.status;
    if (e instanceof WriteError) {
      await safeWrite(o.io.stderr, `${ctx.name}: write error: ${e.message}\n`);
      return 1;
    }
    if (e instanceof FsError) {
      await safeWrite(o.io.stderr, `${ctx.name}: ${e.message}\n`);
      return 1;
    }
    console.error(e);
    await safeWrite(o.io.stderr, `${ctx.name}: internal error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    job.procs.delete(proc);
    sys.processes.remove(proc);
  }
}

function makeContext(sh: Shell, o: SpawnOptions, proc: Proc): CommandContext {
  const sys = sh.system;
  const stdin: InputStream = new GatedInput(o.io.stdin, proc);
  const stdout: OutputStream = new GatedOutput(o.io.stdout, proc);
  const stderr: OutputStream = new GatedOutput(o.io.stderr, proc);
  const name = o.argv[0];
  const ctx: CommandContext = {
    argv: o.argv,
    args: o.argv.slice(1),
    name,
    stdin,
    stdout,
    stderr,
    env: o.env,
    cwd: o.cwd,
    creds: o.creds,
    umask: o.umask,
    system: sys,
    fs: undefined as unknown as ProcFs,
    tty: sys.tty,
    proc,
    signal: proc.signal,
    out: (s: string) => stdout.write(s),
    err: (s: string) => stderr.write(s),
    error: (m: string) => stderr.write(`${name}: ${m}\n`),
    checkpoint: () => proc.checkpoint(),
    sleep: async (ms: number) => {
      let remaining = ms;
      while (remaining > 0) {
        await proc.checkpoint();
        const chunk = Math.min(remaining, 200);
        await sys.delay(chunk, proc.signal);
        remaining -= chunk;
      }
      await proc.checkpoint();
    },
    exec: (argv: string[], opts: ExecOptions = {}) => execChild(sh, ctx, argv, opts),
    onSignal: (sig, fn) => proc.onSignal(sig, fn),
    which: (n: string) => {
      if (n.includes('/')) return n;
      return findInPath(sys.fs, n, ctx.env.get('PATH') ?? '', { cwd: ctx.cwd, creds: ctx.creds, umask: ctx.umask });
    },
  };
  (ctx as { fs: ProcFs }).fs = new ProcFs(sys.fs, () => ({ cwd: ctx.cwd, creds: ctx.creds, umask: ctx.umask }));
  return ctx;
}

async function execChild(sh: Shell, parent: CommandContext, argv: string[], opts: ExecOptions): Promise<number> {
  const env = opts.env ?? parent.env;
  const creds = opts.creds ?? parent.creds;
  const cwd = opts.cwd ?? parent.cwd;
  const path = argv[0].includes('/')
    ? argv[0]
    : findInPath(sh.system.fs, argv[0], env.get('PATH') ?? '', { cwd, creds, umask: parent.umask });
  if (!path) {
    sh.system.emitExec({ argv, kind: 'not-found', status: 127, uid: creds.uid, cwd });
    return 127;
  }
  const io = IO.of(
    parent.proc.job,
    opts.stdin ?? unwrapIn(parent.stdin),
    opts.stdout ?? unwrapOut(parent.stdout),
    opts.stderr ?? unwrapOut(parent.stderr),
  );
  const status = await spawnProgram(sh, { path, argv, env, io, creds, cwd, umask: opts.umask ?? parent.umask });
  // programs started by programs (sudo whoami, xargs rm, find -exec) count as commands that ran
  sh.system.emitExec({ argv, kind: 'external', status, path, uid: creds.uid, cwd });
  return status;
}

function unwrapIn(s: InputStream): InputStream {
  return s instanceof GatedInput ? s.inner : s;
}

function unwrapOut(s: OutputStream): OutputStream {
  return s instanceof GatedOutput ? s.inner : s;
}
