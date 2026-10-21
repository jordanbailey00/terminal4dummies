// bash/sh as programs (scripts, bash -c), sudo, su, and passwd.

import { ExitException } from '../control';
import { IO } from '../io';
import { Shell } from '../interpreter';
import { ShellState } from '../state';
import { SignalError } from '../streams';
import type { CommandContext } from '../types';
import { FsError } from '../vfs/fs';
import { defineCommand, errText } from './util';

/** Build a non-interactive shell process from a program context. */
export function shellFromContext(ctx: CommandContext, opts: { arg0: string; positional: string[] }): Shell {
  const sys = ctx.system;
  const state = new ShellState({ ...ctx.creds, groups: [...ctx.creds.groups] }, ctx.proc.pid, ctx.proc.ppid, sys.now());
  for (const [k, v] of ctx.env) state.vars.set(k, { value: v, exported: true, readonly: false, integer: false });
  const defaults: Record<string, string> = { IFS: ' \t\n', PS4: '+ ', OPTIND: '1', BASH: '/usr/bin/bash', BASH_VERSION: '5.2.21(1)-release', HOSTNAME: sys.hostname, OSTYPE: 'linux-gnu' };
  for (const [k, v] of Object.entries(defaults)) if (!state.vars.has(k)) state.vars.set(k, { value: v, exported: false, readonly: false, integer: false });
  const shlvl = parseInt(ctx.env.get('SHLVL') ?? '0', 10);
  state.vars.set('SHLVL', { value: String((Number.isNaN(shlvl) ? 0 : shlvl) + 1), exported: true, readonly: false, integer: false });
  state.vars.set('UID', { value: String(ctx.creds.uid), exported: false, readonly: true, integer: true });
  state.vars.set('EUID', { value: String(ctx.creds.uid), exported: false, readonly: true, integer: true });
  state.cwd = ctx.cwd;
  state.vars.set('PWD', { value: ctx.cwd, exported: true, readonly: false, integer: false });
  state.umask = ctx.umask;
  state.arg0 = opts.arg0;
  state.positional = opts.positional;
  state.interactive = false;
  return new Shell({ system: sys, state, interactiveTree: false });
}

async function runShellProgram(ctx: CommandContext, sh: Shell, src: string): Promise<number> {
  const io = IO.of(ctx.proc.job, ctx.stdin, ctx.stdout, ctx.stderr);
  try {
    const status = await sh.runSource(src, io);
    await runExitTrap(sh, io);
    return status;
  } catch (e) {
    if (e instanceof ExitException) {
      await runExitTrap(sh, io);
      return e.status;
    }
    if (e instanceof SignalError) throw e;
    throw e;
  }
}

async function runExitTrap(sh: Shell, io: IO): Promise<void> {
  const trap = sh.traps.get('EXIT');
  if (!trap) return;
  sh.traps.delete('EXIT');
  try {
    await sh.runSource(trap, io);
  } catch {
    // ignore errors in the exit trap
  }
}

async function bashMain(ctx: CommandContext): Promise<number> {
  const args = ctx.args;
  let i = 0;
  let command: string | null = null;
  const setFlags: string[] = [];
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-c') {
      command = args[i + 1] ?? null;
      if (command === null) {
        await ctx.err(`${ctx.name}: -c: option requires an argument\n`);
        return 2;
      }
      i += 2;
      break;
    }
    if (a === '--version') {
      await ctx.out('GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)\nCopyright (C) 2022 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>\n\nThis is free software; you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n');
      return 0;
    }
    if (a === '--' || a === '-') {
      i++;
      break;
    }
    if (/^-[exuvnil]+$/.test(a) || /^\+[exu]+$/.test(a)) {
      setFlags.push(a);
      continue;
    }
    if (a === '-o' && args[i + 1]) {
      setFlags.push('-o', args[i + 1]);
      i++;
      continue;
    }
    if (a.startsWith('--')) continue;
    break;
  }
  const applyFlags = (sh: Shell) => {
    for (let k = 0; k < setFlags.length; k++) {
      const f = setFlags[k];
      if (f === '-o') {
        const name = setFlags[++k];
        if (name === 'pipefail') sh.state.options.pipefail = true;
        if (name === 'errexit') sh.state.options.errexit = true;
        if (name === 'nounset') sh.state.options.nounset = true;
        if (name === 'xtrace') sh.state.options.xtrace = true;
        continue;
      }
      const on = f[0] === '-';
      for (const c of f.slice(1)) {
        if (c === 'e') sh.state.options.errexit = on;
        if (c === 'x') sh.state.options.xtrace = on;
        if (c === 'u') sh.state.options.nounset = on;
      }
    }
  };
  if (command !== null) {
    const arg0 = args[i] ?? ctx.name;
    const sh = shellFromContext(ctx, { arg0, positional: args.slice(i + 1) });
    applyFlags(sh);
    return runShellProgram(ctx, sh, command);
  }
  const script = args[i];
  if (script === undefined) {
    if (ctx.stdin.isTTY && ctx.tty) {
      // An interactive sub-shell.
      const { runNestedInteractive } = await import('./nested');
      return runNestedInteractive(ctx);
    }
    const src = await ctx.stdin.readAll();
    const sh = shellFromContext(ctx, { arg0: ctx.name, positional: [] });
    applyFlags(sh);
    return runShellProgram(ctx, sh, src);
  }
  let src: string;
  try {
    const node = ctx.fs.stat(script);
    if (node.type === 'dir') throw new FsError('EISDIR', script);
    src = ctx.fs.readFile(script);
  } catch (e) {
    if (e instanceof FsError && e.code === 'EISDIR') {
      await ctx.err(`${ctx.name}: ${script}: Is a directory\n`);
      return 126;
    }
    await ctx.err(`${ctx.name}: ${script}: ${errText(e)}\n`);
    return 127;
  }
  if (/[\x00]/.test(src.slice(0, 80))) {
    await ctx.err(`${ctx.name}: ${script}: cannot execute binary file\n`);
    return 126;
  }
  const sh = shellFromContext(ctx, { arg0: script, positional: args.slice(i + 1) });
  applyFlags(sh);
  return runShellProgram(ctx, sh, src);
}

const BASH_DOC = {
  category: 'shell' as const,
  summary: 'GNU Bourne-Again SHell',
  synopsis: ['bash [options] [command_string | file]'],
  description: 'Bash is the shell: the program that reads your commands and runs them. Running bash with a file name executes the commands in that file (a shell script). bash -c "commands" runs a string of commands.',
  options: [
    { flags: '-c string', desc: 'Read commands from string.' },
    { flags: '-x', desc: 'Print each command before running it (great for debugging scripts).' },
    { flags: '-e', desc: 'Exit immediately if a command fails.' },
  ],
  examples: [
    { cmd: 'bash myscript.sh', desc: 'Run a script, even if it is not executable.' },
    { cmd: 'bash -x myscript.sh', desc: 'Run a script and show every command as it runs.' },
  ],
  seeAlso: ['sh', 'help'],
};

defineCommand({ name: 'bash', pkg: 'bash', size: 1446024, doc: BASH_DOC, gnu: false, run: bashMain });
defineCommand({ name: 'sh', pkg: 'bash', size: 125688, doc: { ...BASH_DOC, summary: 'command interpreter (shell)' }, gnu: false, run: bashMain });

// ---------------------------------------------------------------------------
// sudo

const SUDO_TIMEOUT = 15 * 60 * 1000;

async function readPassword(ctx: CommandContext, prompt: string): Promise<string | null> {
  const tty = ctx.tty;
  if (!tty) return null;
  await tty.write(prompt);
  const saved = tty.getModes();
  tty.setModes({ icanon: true, echo: false, isig: true });
  try {
    const line = await tty.readLine(ctx.signal);
    await tty.write('\n');
    return line === null ? null : line.replace(/\n$/, '');
  } finally {
    tty.setModes(saved);
  }
}

defineCommand({
  name: 'sudo',
  pkg: 'sudo',
  size: 277936,
  doc: {
    category: 'permissions',
    summary: 'execute a command as another user',
    synopsis: ['sudo [-u user] command [arg ...]', 'sudo -i', 'sudo -k'],
    description:
      'sudo allows a permitted user to execute a command as the superuser (root) or another user. You must type your own password the first time; sudo then remembers it for 15 minutes.\n\n' +
      'While you type the password nothing appears on the screen. That is normal: just type it and press Enter. (In this practice computer any password works.)\n\n' +
      'With great power comes great responsibility: commands run with sudo can change or delete anything on the system.',
    options: [
      { flags: '-u user', desc: 'Run the command as a user other than root.' },
      { flags: '-i', desc: 'Start a login shell as root.' },
      { flags: '-k', desc: 'Forget the cached password, so the next sudo asks again.' },
      { flags: '-l', desc: 'List the commands you are allowed to run.' },
    ],
    examples: [
      { cmd: 'sudo apt update', desc: 'Refresh the package lists (requires root).' },
      { cmd: 'sudo nano /etc/hosts', desc: 'Edit a system file.' },
      { cmd: 'sudo whoami', desc: 'Prints root.' },
    ],
    seeAlso: ['su', 'sudo_root'],
  },
  gnu: false,
  run: async (ctx) => {
    let args = ctx.args;
    let user = 'root';
    let loginShell = false;
    let list = false;
    while (args.length && args[0].startsWith('-') && args[0] !== '--') {
      const a = args[0];
      if (a === '-u') {
        user = args[1] ?? 'root';
        args = args.slice(2);
        continue;
      }
      if (a === '-i' || a === '-s') loginShell = true;
      else if (a === '-k' || a === '-K') {
        ctx.system.sudoTimestamps.delete(ctx.creds.uid);
        if (args.length === 1) return 0;
      } else if (a === '-l') list = true;
      else if (a === '-v') {
        /* validate */
      } else if (a === '-h' || a === '--help') {
        await ctx.out('sudo - execute a command as another user\n\nusage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-ABkNnS] [-g group] [-h host] [-p prompt] [-U user]\n            [-u user] [command [arg ...]]\nusage: sudo [-ABbEHkNnPS] [-r role] [-t type] [-C num] [-D directory]\n            [-g group] [-h host] [-p prompt] [-R directory] [-T timeout]\n            [-u user] [VAR=value] [-i | -s] [command [arg ...]]\n');
        return 0;
      } else if (a === '-V' || a === '--version') {
        await ctx.out('Sudo version 1.9.15p5\n');
        return 0;
      } else if (!/^-[EHAbnS]+$/.test(a)) {
        await ctx.err(`sudo: invalid option -- '${a.slice(1, 2)}'\nusage: sudo -h | -K | -k | -V\n`);
        return 1;
      }
      args = args.slice(1);
    }
    if (args[0] === '--') args = args.slice(1);
    const sys = ctx.system;
    const me = sys.userByUid(ctx.creds.uid);
    const target = sys.userByName(user);
    if (!target) {
      await ctx.err(`sudo: unknown user ${user}\nsudo: error initializing audit plugin sudoers_audit\n`);
      return 1;
    }
    if (!list && args.length === 0 && !loginShell) {
      await ctx.err('usage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-ABkNnS] [-g group] [-h host] [-p prompt] [-U user]\n            [-u user] [command [arg ...]]\nusage: sudo [-ABbEHkNnPS] [-r role] [-t type] [-C num] [-D directory]\n            [-g group] [-h host] [-p prompt] [-R directory] [-T timeout]\n            [-u user] [VAR=value] [-i | -s] [command [arg ...]]\n');
      return 1;
    }
    if (ctx.creds.uid !== 0) {
      const sudoGid = sys.groupByName('sudo')?.gid ?? 27;
      if (!ctx.creds.groups.includes(sudoGid)) {
        await ctx.err(`${me?.name ?? 'user'} is not in the sudoers file.\n`);
        return 1;
      }
      const last = sys.sudoTimestamps.get(ctx.creds.uid);
      if (last === undefined || sys.now() - last > SUDO_TIMEOUT) {
        let ok = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const pw = await readPassword(ctx, `[sudo] password for ${me?.name}: `);
          if (pw === null) {
            await ctx.err('sudo: a password is required\n');
            return 1;
          }
          if (pw.length > 0) {
            ok = true;
            break;
          }
          await ctx.err('Sorry, try again.\n');
        }
        if (!ok) {
          await ctx.err('sudo: 3 incorrect password attempts\n');
          return 1;
        }
        sys.sudoTimestamps.set(ctx.creds.uid, sys.now());
        // Ubuntu's bash.bashrc hint goes away once sudo has been used
        if (me) {
          try {
            sys.fs.writeFile(`${me.home}/.sudo_as_admin_successful`, '', { cwd: '/', creds: ctx.creds, umask: 0o022 });
          } catch {
            // ignore
          }
        }
      } else {
        sys.sudoTimestamps.set(ctx.creds.uid, sys.now());
      }
    }
    if (list) {
      await ctx.out(`Matching Defaults entries for ${me?.name} on ${sys.hostname}:\n    env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin\\:/snap/bin, use_pty\n\nUser ${me?.name} may run the following commands on ${sys.hostname}:\n    (ALL : ALL) ALL\n`);
      return 0;
    }
    const creds = sys.credsFor(target);
    const env = new Map<string, string>();
    for (const k of ['TERM', 'LANG', 'LS_COLORS', 'DISPLAY', 'COLORTERM']) {
      const v = ctx.env.get(k);
      if (v !== undefined) env.set(k, v);
    }
    env.set('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin');
    env.set('HOME', loginShell ? target.home : ctx.env.get('HOME') ?? target.home);
    env.set('USER', target.name);
    env.set('LOGNAME', target.name);
    env.set('SHELL', target.shell);
    env.set('MAIL', `/var/mail/${target.name}`);
    env.set('SUDO_USER', me?.name ?? '');
    env.set('SUDO_UID', String(ctx.creds.uid));
    env.set('SUDO_GID', String(ctx.creds.gid));
    env.set('SUDO_COMMAND', args.length ? `/usr/bin/${args.join(' ')}` : '/bin/bash');
    if (loginShell) env.set('HOME', target.home);
    if (loginShell && args.length === 0) {
      const { runNestedInteractive } = await import('./nested');
      return runNestedInteractive(ctx, { creds, env, cwd: target.home, user: target.name });
    }
    while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) {
      const eq = args[0].indexOf('=');
      env.set(args[0].slice(0, eq), args[0].slice(eq + 1));
      args = args.slice(1);
    }
    const name = args[0];
    let path: string | null = name.includes('/') ? name : null;
    if (!path) {
      for (const dir of (env.get('PATH') ?? '').split(':')) {
        const p = `${dir}/${name}`;
        const node = sys.fs.tryStat(p, { cwd: ctx.cwd, creds, umask: 0o022 });
        if (node && node.type === 'file') {
          path = p;
          break;
        }
      }
    }
    if (!path || !sys.fs.tryStat(path, { cwd: ctx.cwd, creds, umask: 0o022 })) {
      await ctx.err(`sudo: ${name}: command not found\n`);
      return 1;
    }
    if (['cd', 'export', 'alias', 'source', 'history'].includes(name)) {
      await ctx.err(`sudo: ${name}: command not found\n`);
      return 1;
    }
    return ctx.exec([name, ...args.slice(1)], { creds, env, umask: 0o022, cwd: loginShell ? target.home : ctx.cwd });
  },
});

defineCommand({
  name: 'su',
  pkg: 'util-linux',
  dir: '/usr/bin',
  size: 55680,
  doc: { category: 'permissions', summary: 'run a command with substitute user and group ID', synopsis: ['su [options] [-] [user [argument...]]'], description: 'su allows commands to be run with a substitute user and group ID. On Ubuntu the root account has no password, so use sudo -i (or sudo su) instead of plain su.', seeAlso: ['sudo'] },
  gnu: false,
  run: async (ctx) => {
    const args = ctx.args.filter((a) => a !== '-' && a !== '-l' && a !== '--login');
    const user = args[0] ?? 'root';
    const sys = ctx.system;
    const target = sys.userByName(user);
    if (!target) {
      await ctx.err(`su: user ${user} does not exist or the user entry does not contain all the required fields\n`);
      return 1;
    }
    if (ctx.creds.uid !== 0) {
      const pw = await readPassword(ctx, 'Password: ');
      if (pw === null) return 1;
      await ctx.sleep(1500);
      await ctx.err('su: Authentication failure\n');
      return 1;
    }
    const { runNestedInteractive } = await import('./nested');
    const env = new Map(ctx.env);
    env.set('HOME', target.home);
    env.set('USER', target.name);
    env.set('LOGNAME', target.name);
    return runNestedInteractive(ctx, { creds: sys.credsFor(target), env, cwd: ctx.cwd, user: target.name });
  },
});

defineCommand({
  name: 'passwd',
  pkg: 'passwd',
  dir: '/usr/bin',
  size: 64152,
  doc: { category: 'permissions', summary: 'change user password', synopsis: ['passwd [options] [LOGIN]'], description: 'The passwd command changes passwords for user accounts.', seeAlso: ['sudo'] },
  gnu: false,
  run: async (ctx) => {
    const me = ctx.system.userName(ctx.creds.uid);
    await ctx.out(`Changing password for ${me}.\n`);
    const cur = await readPassword(ctx, 'Current password: ');
    if (cur === null) return 1;
    const a = await readPassword(ctx, 'New password: ');
    if (a === null) return 1;
    const b = await readPassword(ctx, 'Retype new password: ');
    if (b === null) return 1;
    if (a !== b) {
      await ctx.out('Sorry, passwords do not match.\npasswd: Authentication token manipulation error\npasswd: password unchanged\n');
      return 10;
    }
    if (a.length < 8) {
      await ctx.out('BAD PASSWORD: The password is shorter than 8 characters\n');
    }
    await ctx.out('passwd: password updated successfully\n');
    return 0;
  },
});
