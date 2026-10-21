// A terminal session: the login shell, the startup banner, and restarting
// the shell when it exits. The read-eval-print loop itself lives in repl.ts.

import './builtins';
import { History } from './history';
import { Shell } from './interpreter';
import { Repl } from './repl';
import { ShellState } from './state';
import type { System } from './system';
import { TtyDriver, type TerminalBackend } from './tty';
import { DEFAULT_LS_COLORS } from './commands/lscolors';

export type { CommandEvent } from './repl';

export interface SessionOptions {
  system: System;
  backend: TerminalBackend;
  user?: string;
  /** 'welcome' (default), 'none', or custom text printed at startup. */
  banner?: string;
  /** Persisted history lines to start with. */
  history?: string[];
  /** Folder (relative to home, or absolute) to start in. */
  startDir?: string;
}

export const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin';

/** Create a login-style shell for `user` with the usual environment. */
export function createLoginShell(system: System, username: string, opts: { interactive: boolean }): Shell {
  const user = system.userByName(username) ?? system.users[system.users.length - 1];
  const creds = system.credsFor(user);
  const pid = system.processes.allocPid();
  const state = new ShellState(creds, pid, pid - 1, system.now());
  state.interactive = opts.interactive;
  state.umask = user.uid === 0 ? 0o022 : 0o002;
  const fs = system.fs;
  const ctx = { cwd: '/', creds, umask: state.umask };
  state.cwd = fs.isDir(user.home, ctx) ? user.home : '/';
  let path = DEFAULT_PATH;
  if (user.uid !== 0) {
    if (fs.isDir(`${user.home}/.local/bin`, ctx)) path = `${user.home}/.local/bin:${path}`;
    if (fs.isDir(`${user.home}/bin`, ctx)) path = `${user.home}/bin:${path}`;
  }
  const exported: Record<string, string> = {
    HOME: user.home,
    USER: user.name,
    LOGNAME: user.name,
    SHELL: user.shell,
    PATH: path,
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    PWD: state.cwd,
    SHLVL: '1',
    MAIL: `/var/mail/${user.name}`,
    XDG_RUNTIME_DIR: `/run/user/${user.uid}`,
    LS_COLORS: DEFAULT_LS_COLORS,
    LESSOPEN: '| /usr/bin/lesspipe %s',
    LESSCLOSE: '/usr/bin/lesspipe %s %s',
    _: '/usr/bin/bash',
  };
  for (const [k, v] of Object.entries(exported)) state.vars.set(k, { value: v, exported: true, readonly: false, integer: false });
  const shellVars: Record<string, string> = {
    BASH: '/usr/bin/bash',
    BASH_VERSION: '5.2.21(1)-release',
    HOSTNAME: system.hostname,
    HOSTTYPE: 'x86_64',
    MACHTYPE: 'x86_64-pc-linux-gnu',
    OSTYPE: 'linux-gnu',
    IFS: ' \t\n',
    PS1: '\\s-\\v\\$ ',
    PS2: '> ',
    PS4: '+ ',
    OPTERR: '1',
    OPTIND: '1',
    HISTFILE: `${user.home}/.bash_history`,
    HISTSIZE: '500',
    HISTFILESIZE: '500',
    COLUMNS: String(system.tty?.cols ?? 80),
    LINES: String(system.tty?.rows ?? 24),
  };
  for (const [k, v] of Object.entries(shellVars)) state.vars.set(k, { value: v, exported: false, readonly: false, integer: false });
  for (const k of ['UID', 'EUID']) state.vars.set(k, { value: String(user.uid), exported: false, readonly: true, integer: true });
  state.vars.set('PPID', { value: String(pid - 1), exported: false, readonly: true, integer: true });
  state.arg0 = 'bash';
  state.options.expand_aliases = opts.interactive;
  state.options.histexpand = opts.interactive;
  return new Shell({ system, state, interactiveTree: opts.interactive });
}

const WELCOME =
  '\x1b[1mWelcome to your practice terminal!\x1b[0m\n' +
  'This is a simulated Linux computer (Ubuntu-style) running in your browser.\n' +
  'Nothing you do here can harm your real computer.\n\n' +
  'Type a command and press \x1b[1mEnter\x1b[0m. Not sure where to start? Try: \x1b[1;32mls\x1b[0m\n\n';

export class Session {
  readonly system: System;
  readonly tty: TtyDriver;
  readonly history = new History();
  repl: Repl;
  private readonly opts: SessionOptions;
  private readonly username: string;
  private disposed = false;
  private loop: Promise<void> | null = null;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.system = opts.system;
    this.username = opts.user ?? 'learner';
    this.tty = new TtyDriver(opts.backend);
    this.system.tty = this.tty;
    this.tty.onSignal = (sig) => this.tty.foreground?.kill(sig);
    if (opts.history) this.history.load(opts.history);
    this.repl = this.newRepl();
    this.tty.onResize((cols, rows) => {
      try {
        this.repl.shell.state.set('COLUMNS', String(cols));
        this.repl.shell.state.set('LINES', String(rows));
      } catch {
        // ignore
      }
    });
  }

  get shell(): Shell {
    return this.repl.shell;
  }

  private newRepl(): Repl {
    const shell = createLoginShell(this.system, this.username, { interactive: true });
    return new Repl({ system: this.system, tty: this.tty, shell, history: this.history });
  }

  /** Is a command currently running (as opposed to waiting at the prompt)? */
  get isBusy(): boolean {
    return this.repl.busy;
  }

  start(): Promise<void> {
    if (!this.loop) this.loop = this.run();
    return this.loop;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.repl.stopped = true;
    this.tty.foreground?.kill('SIGHUP');
    for (const j of this.repl.shell.jobs.all()) j.kill('SIGHUP');
    this.tty.dispose();
    if (this.system.tty === this.tty) this.system.tty = null;
  }

  /** Type text at the prompt as if the user pasted it (does not press Enter). */
  typeAtPrompt(text: string): void {
    this.tty.input(`\x1b[200~${text}\x1b[201~`);
  }

  private async print(s: string): Promise<void> {
    await this.tty.write(s);
  }

  private async startup(): Promise<void> {
    const banner = this.opts.banner ?? 'welcome';
    if (banner === 'welcome') await this.print(WELCOME);
    else if (banner !== 'none') await this.print(banner);
    const user = this.system.userByName(this.username);
    if (user && user.uid !== 0 && banner !== 'none') {
      const fs = this.system.fs;
      const creds = this.system.credsFor(user);
      const inSudo = this.system.groupIdsOf(user).includes(this.system.groupByName('sudo')?.gid ?? 27);
      if (inSudo && !fs.exists(`${user.home}/.sudo_as_admin_successful`, { cwd: '/', creds })) {
        await this.print('To run a command as administrator (user "root"), use "sudo <command>".\nSee "man sudo_root" for details.\n\n');
      }
    }
    await this.repl.source(`${this.repl.shell.state.get('HOME') ?? ''}/.bashrc`);
    this.applyStartDir();
  }

  private applyStartDir(): void {
    const dir = this.opts.startDir;
    if (!dir) return;
    const st = this.repl.shell.state;
    const home = st.get('HOME') ?? '/';
    const target = dir.startsWith('/') ? dir : `${home}/${dir}`;
    if (!this.system.fs.isDir(target, this.repl.shell.opCtx())) return;
    st.set('OLDPWD', st.cwd, { exported: true });
    st.cwd = target;
    st.set('PWD', target);
  }

  private async run(): Promise<void> {
    await this.startup();
    while (!this.disposed) {
      await this.repl.run();
      if (this.disposed) break;
      await this.print('\n\x1b[2m[The shell has exited. Press Enter to start a new one.]\x1b[0m');
      const saved = this.tty.getModes();
      this.tty.setModes({ icanon: false, echo: false, isig: false });
      try {
        for (;;) {
          const k = await this.tty.readRaw();
          if (k.includes('\r') || k.includes('\n')) break;
        }
      } finally {
        this.tty.setModes(saved);
      }
      if (this.disposed) break;
      await this.print('\n\n');
      this.repl = this.newRepl();
      await this.repl.source(`${this.repl.shell.state.get('HOME') ?? ''}/.bashrc`);
    }
  }
}
