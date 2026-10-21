// The coach: plain-English explanations of what just went wrong (or right).

import type { CommandEvent } from '../shell/repl';
import type { Shell } from '../shell/interpreter';
import { packagesProviding } from '../shell/packages';

export interface Tip {
  kind: 'error' | 'info';
  title: string;
  /** Markdown. */
  body: string;
}

const WINDOWS: Record<string, [string, string]> = {
  cls: ['clear', 'clears the screen'],
  copy: ['cp', 'copies files'],
  del: ['rm', 'deletes files'],
  erase: ['rm', 'deletes files'],
  move: ['mv', 'moves or renames files'],
  ren: ['mv', 'renames files'],
  rename: ['mv', 'renames files'],
  md: ['mkdir', 'makes a folder'],
  rd: ['rmdir', 'removes an empty folder'],
  ipconfig: ['ip addr', 'shows network addresses'],
  tracert: ['traceroute', 'traces a network route'],
  findstr: ['grep', 'searches text'],
  tasklist: ['ps aux', 'lists running programs'],
  taskkill: ['kill', 'stops a program'],
  where: ['which', 'finds where a program is'],
  'cd..': ['cd ..', 'goes up one folder'],
};

const ELSEWHERE: Record<string, string> = {
  brew: 'Homebrew is the package manager for **macOS**. On Ubuntu (like this computer) you install software with `sudo apt install NAME`.',
  winget: '`winget` is the package manager for **Windows**. On Ubuntu you install software with `sudo apt install NAME`.',
  code: '`code` opens Visual Studio Code, a graphical editor that is not part of this practice computer. Use `nano` to edit files here.',
  python: 'Python is not available in this practice computer. On a real Ubuntu system it is usually called `python3`.',
  python3: 'Python is not available in this practice computer, but on a real Ubuntu system `python3` is normally preinstalled.',
  node: 'Node.js is not part of this practice computer.',
  npm: 'npm comes with Node.js, which is not part of this practice computer.',
  git: 'git is not part of this practice computer yet. On a real Ubuntu system install it with `sudo apt install git`.',
  vim: 'vim is not installed here. Use `nano` instead; it is much friendlier for beginners. (If you ever get stuck inside vim on a real computer: press <kbd>Esc</kbd>, type `:q!` and press Enter.)',
  vi: 'vi is not installed here. Use `nano` instead. (If you ever get stuck inside vi on a real computer: press <kbd>Esc</kbd>, type `:q!` and press Enter.)',
  emacs: 'emacs is not installed here. Use `nano` to edit files.',
  docker: 'Docker is not part of this practice computer.',
  systemctl: 'systemctl manages system services. Services are not simulated on this practice computer.',
};

function lastLine(output: string): string {
  const lines = output.trim().split('\n');
  return lines[lines.length - 1] ?? '';
}

/** Explain the outcome of a command, or return null if nothing needs saying. */
export function coach(ev: CommandEvent, sh: Shell): Tip | null {
  const out = ev.output;
  const line = ev.line.trim();

  if (ev.stopped) {
    return {
      kind: 'info',
      title: 'The command is paused, not finished',
      body: 'You pressed <kbd>Ctrl</kbd>+<kbd>Z</kbd>, which **stops** (pauses) the running command and puts it in the background. Type `$ fg` to bring it back, or `$ kill %1` to end it. To cancel a command for good, use <kbd>Ctrl</kbd>+<kbd>C</kbd> instead.',
    };
  }
  if (ev.interrupted) {
    return { kind: 'info', title: 'Stopped with Ctrl+C', body: 'You pressed <kbd>Ctrl</kbd>+<kbd>C</kbd>, which interrupts the running command. That is the standard way to cancel anything that is taking too long or waiting for input.' };
  }
  if (ev.syntaxError) {
    const m = /syntax error near unexpected token `([^']*)'/.exec(out);
    return {
      kind: 'error',
      title: 'The shell could not understand that line',
      body: m
        ? `This is a **syntax error**: the shell did not expect \`${m[1]}\` there. Check for a stray \`|\`, \`;\` or \`&\`, or a missing word around it.`
        : 'This is a **syntax error**. Check that quotes, brackets and keywords like `if ... fi` are properly matched.',
    };
  }

  // command not found
  const nf = ev.execs.find((e) => e.kind === 'not-found');
  if (nf) {
    const name = nf.argv[0];
    if (/^cd\.\.?/.test(name)) return { kind: 'error', title: 'Add a space after cd', body: 'Commands and their arguments are separated by spaces. Write `$ cd ..` (with a space) instead of `cd..`.' };
    if (nf.argv[1] === '=' || /^[A-Za-z_]\w*$/.test(name) && nf.argv[1]?.startsWith('=')) {
      return { kind: 'error', title: 'No spaces around = when setting a variable', body: `To set a variable, write it without spaces: \`${name}=value\`. With spaces, bash thinks \`${name}\` is a command.` };
    }
    const lower = name.toLowerCase();
    if (WINDOWS[lower]) {
      const [linux, what] = WINDOWS[lower];
      return { kind: 'error', title: `That's a Windows command`, body: `\`${name}\` is from Windows. On Linux the command that ${what} is \`${linux}\`.` };
    }
    if (ELSEWHERE[lower]) return { kind: 'error', title: `${name} isn't available here`, body: ELSEWHERE[lower] };
    if (name !== lower && sh.findCommand(lower)) {
      return { kind: 'error', title: 'Commands are case-sensitive', body: `There is no \`${name}\`, but there is \`${lower}\`. Linux treats upper and lower case letters as different.` };
    }
    if (sh.system.fs.exists(name, sh.opCtx()) && !name.includes('/')) {
      return {
        kind: 'error',
        title: 'Run programs in this folder with ./',
        body: `\`${name}\` is a file in the current folder, but the shell only looks for commands in the folders listed in \`$PATH\`. To run a program from the current folder, type \`./${name}\`.`,
      };
    }
    const pkgs = packagesProviding(name).filter((p) => !p.preinstalled);
    if (pkgs.length && pkgs[0].available) {
      return { kind: 'error', title: `${name} is not installed`, body: `\`${name}\` exists, but it isn't installed on this computer yet. Install it with \`$ sudo apt install ${pkgs[0].name}\`.` };
    }
    return {
      kind: 'error',
      title: 'Command not found',
      body: `The shell has no command called \`${name}\`. Check the spelling (commands are case-sensitive) and remember that <kbd>Tab</kbd> can complete command names for you.`,
    };
  }

  if (ev.status === 0) return null;
  const last = lastLine(out);
  const cmd = ev.execs[ev.execs.length - 1]?.argv[0]?.split('/').pop() ?? line.split(/\s+/)[0];

  if (/: Permission denied$/m.test(out)) {
    if (/^bash: \.?\/?[^ ]+: Permission denied$/m.test(out) && /^\.?\//.test(line)) {
      return { kind: 'error', title: "The file isn't executable", body: 'To run a script, it needs **execute** permission. Add it with `chmod +x FILENAME`, then try again.' };
    }
    if (/^(\/etc|\/usr|\/var|\/root|\/opt|\/boot)/m.test(line.split(/\s+/).slice(1).join(' ')) || /\/(etc|usr|var|root)\//.test(line) || line.includes(' /etc') || line.includes(' /root')) {
      return { kind: 'error', title: 'Permission denied', body: 'Only the administrator (**root**) may change or read that. If you really need to, put `sudo` in front of the command. Use it carefully: root can change anything.' };
    }
    return { kind: 'error', title: 'Permission denied', body: "You don't have permission to do that. `ls -l` shows a file's permissions and owner. Files you own can be changed with `chmod`; system files need `sudo`." };
  }
  if (/No such file or directory/.test(out)) {
    if (cmd === 'cd' || line.startsWith('cd ')) {
      return { kind: 'error', title: "That folder doesn't exist here", body: 'Check the spelling and the capital letters. Run `$ ls` to see what is in the current folder and `$ pwd` to see where you are. <kbd>Tab</kbd> completion avoids typos.' };
    }
    return { kind: 'error', title: 'No such file or directory', body: 'The name you typed does not exist **in the current folder** (or at the path you gave). Use `$ ls` to see what is here, check upper/lower case, and use <kbd>Tab</kbd> to complete names.' };
  }
  if (/Is a directory/.test(out)) {
    if (cmd === 'rm') return { kind: 'error', title: 'rm needs -r for folders', body: '`rm` only deletes files. To delete an **empty** folder use `rmdir`; to delete a folder *and everything in it* use `rm -r FOLDER` (careful, there is no undo).' };
    if (cmd === 'cp') return { kind: 'error', title: 'cp needs -r for folders', body: 'To copy a folder and its contents, add `-r` (recursive): `cp -r SOURCE DESTINATION`.' };
    return { kind: 'error', title: "That's a folder, not a file", body: 'Use `ls FOLDER` to see what is inside a folder, or `cd FOLDER` to go into it.' };
  }
  if (/Not a directory/.test(out)) return { kind: 'error', title: "That's a file, not a folder", body: 'You can only `cd` into folders. Use `cat` or `less` to read a file.' };
  if (/Directory not empty/.test(out)) return { kind: 'error', title: 'The folder is not empty', body: '`rmdir` only removes empty folders. Delete the contents first, or use `rm -r FOLDER` to remove the folder and everything inside it.' };
  if (/File exists/.test(out)) return { kind: 'error', title: 'That name is already taken', body: 'Something with that name already exists here. Choose another name, or use `mkdir -p` (which does not complain about existing folders).' };
  if (/missing (file )?operand/.test(out)) return { kind: 'error', title: 'Something is missing', body: `\`${cmd}\` needs more information, usually a file name. For example \`cp\` needs a source *and* a destination. Run \`${cmd} --help\` to see how to use it.` };
  if (/invalid option|unrecognized option/.test(out)) return { kind: 'error', title: 'Unknown option', body: `\`${cmd}\` does not understand one of the options. Options are case-sensitive: \`-l\` and \`-L\` are different. \`${cmd} --help\` lists them all.` };
  if (/it is dangerous to operate recursively on '\/'/.test(out)) return { kind: 'info', title: 'A safety net caught that', body: '`rm -rf /` would try to delete the entire system, so `rm` refuses. Even here, where nothing is real, it is a good habit to double-check every `rm -r`.' };
  if (/No manual entry for/.test(out)) {
    const name = line.split(/\s+/)[1];
    if (name && ['cd', 'alias', 'export', 'history', 'source', 'type', 'jobs', 'fg', 'bg'].includes(name)) {
      return { kind: 'info', title: `${name} is built into the shell`, body: `\`${name}\` is part of bash itself, so it has no separate manual page. Use \`$ help ${name}\` instead.` };
    }
    return null;
  }
  if (ev.status === 127 && /command not found/.test(last)) {
    return { kind: 'error', title: 'Command not found', body: 'Check the spelling of the command.' };
  }
  return null;
}
