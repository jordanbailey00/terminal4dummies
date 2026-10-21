// An interactive shell started from inside the terminal: `bash`, `sudo -i`, `su`.

import { History } from '../history';
import { Shell } from '../interpreter';
import { Repl } from '../repl';
import { ShellState } from '../state';
import type { CommandContext } from '../types';
import type { Credentials } from '../vfs/fs';

export async function runNestedInteractive(
  ctx: CommandContext,
  opts: { creds?: Credentials; env?: Map<string, string>; cwd?: string; user?: string; login?: boolean } = {},
): Promise<number> {
  const sys = ctx.system;
  const tty = ctx.tty!;
  const creds = opts.creds ?? ctx.creds;
  const env = opts.env ?? ctx.env;
  const user = sys.userByUid(creds.uid);
  const state = new ShellState({ ...creds, groups: [...creds.groups] }, ctx.proc.pid, ctx.proc.ppid, sys.now());
  for (const [k, v] of env) state.vars.set(k, { value: v, exported: true, readonly: false, integer: false });
  const shlvl = parseInt(env.get('SHLVL') ?? '1', 10);
  state.vars.set('SHLVL', { value: String((Number.isNaN(shlvl) ? 1 : shlvl) + 1), exported: true, readonly: false, integer: false });
  const defaults: Record<string, string> = {
    IFS: ' \t\n',
    PS1: '\\s-\\v\\$ ',
    PS2: '> ',
    PS4: '+ ',
    BASH: '/usr/bin/bash',
    BASH_VERSION: '5.2.21(1)-release',
    HOSTNAME: sys.hostname,
    HISTFILE: `${user?.home ?? '/'}/.bash_history`,
    COLUMNS: String(tty.cols),
    LINES: String(tty.rows),
  };
  for (const [k, v] of Object.entries(defaults)) state.vars.set(k, { value: v, exported: false, readonly: false, integer: false });
  state.vars.set('UID', { value: String(creds.uid), exported: false, readonly: true, integer: true });
  state.vars.set('EUID', { value: String(creds.uid), exported: false, readonly: true, integer: true });
  state.cwd = opts.cwd ?? ctx.cwd;
  state.vars.set('PWD', { value: state.cwd, exported: true, readonly: false, integer: false });
  state.umask = creds.uid === 0 ? 0o022 : 0o002;
  state.interactive = true;
  state.loginShell = opts.login ?? false;
  state.options.expand_aliases = true;
  state.options.histexpand = true;
  const shell = new Shell({ system: sys, state, interactiveTree: true });
  const history = new History();
  try {
    const h = sys.fs.readFile(`${user?.home ?? '/'}/.bash_history`, { cwd: '/', creds, umask: 0o022 });
    history.load(h.split('\n'));
  } catch {
    // no history yet
  }
  const repl = new Repl({ system: sys, tty, shell, history, depth: 1 });
  const home = state.get('HOME') ?? user?.home ?? '/';
  await repl.source(`${home}/.bashrc`);
  const prevFg = tty.foreground;
  try {
    return await repl.run();
  } finally {
    tty.foreground = prevFg;
  }
}
