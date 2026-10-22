// Module: Beyond this computer.

import { all, any, isFile, lineMatches, missing, outputIncludes, ran } from '../checks';
import type { CheckContext, Lesson } from '../types';

function command(argv: string[]): string {
  return argv[0]?.split('/').pop() ?? '';
}

/**
 * Before the first `rm` of .log files, `ls` (or echo/printf) showed the .log
 * files that a wildcard matched (expanded names, not an unmatched pattern).
 */
function lookedBeforeDeleting(c: CheckContext): boolean {
  const execs = c.commands.flatMap((ev) => ev.execs);
  const firstRm = execs.findIndex((e) => command(e.argv) === 'rm' && e.argv.slice(1).some((a) => /\.log$/.test(a)));
  return (
    firstRm > 0 &&
    execs
      .slice(0, firstRm)
      .some((e) => ['ls', 'echo', 'printf'].includes(command(e.argv)) && e.status === 0 && e.argv.slice(1).some((a) => /\.log$/.test(a) && !a.includes('*')))
  );
}

export const realTerminal: Lesson = {
  id: 'real-terminal',
  title: 'Taking it home: your own terminal',
  summary: 'Open a real terminal on macOS, Windows or Linux, know what is different, and pick what to learn next.',
  moduleId: 'beyond',
  minutes: 7,
  intro: `
Everything you practiced here works on real computers. This last lesson helps you make the jump.

## Opening a terminal

| System | How | Shell |
| --- | --- | --- |
| **Ubuntu / Linux** | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd>, or search for *Terminal* | bash (like here) |
| **macOS** | <kbd>Cmd</kbd>+<kbd>Space</kbd>, type *Terminal*, Enter | zsh (prompt ends in \`%\`) |
| **Windows** | install **WSL**: open PowerShell as administrator and run \`wsl --install\`, restart, then open *Ubuntu* from the Start menu | bash in a real Ubuntu |

> [!TIP]
> On Windows, WSL gives you exactly the environment you learned here: a real Ubuntu with bash, apt and all the commands. The built-in PowerShell is a different language (\`Get-ChildItem\` instead of \`ls\`, although it has some aliases).

## What's different on a Mac?

- The shell is **zsh**. Your settings go in \`~/.zshrc\` instead of \`~/.bashrc\`. Almost every command and shortcut is the same.
- Home folders live in \`/Users\`, not \`/home\`.
- Many tools are the BSD versions, with slightly different options: \`ls -G\` for colors, \`sed -i ''\` for in-place edits.
- There is no \`apt\`. Install **Homebrew** from brew.sh and use \`brew install NAME\`.

## Habits that will serve you well

1. Use <kbd>Tab</kbd> and <kbd>↑</kbd> constantly.
2. Read error messages; they usually say exactly what is wrong.
3. Look before you delete: run \`ls\` with the same wildcard before \`rm\`.
4. Use \`sudo\` only when a command really needs it.
5. When unsure, \`man COMMAND\` or \`COMMAND --help\`.

## Where next?

- **git**: version control for your files and code, used by nearly every developer.
- **SSH keys**: log in to servers securely without passwords.
- **Bigger scripts**: functions, \`case\`, reading files line by line.
- **vim** or **emacs**: powerful editors (and how to quit them: in vim, press <kbd>Esc</kbd> then type \`:q!\`).
`,
  steps: [
    {
      id: 'shell',
      title: 'Which shell is this?',
      instruction: 'On any computer, this tells you which shell you use by default:\n\n`$ echo $SHELL`',
      solution: ['echo $SHELL'],
      explain: 'Here it is `/bin/bash`. On a Mac it prints `/bin/zsh`.',
      check: ran('echo'),
    },
    {
      id: 'os',
      title: 'Which system is this?',
      instruction: 'Linux keeps a description of the installed system in a small text file:\n\n`$ cat /etc/os-release`',
      solution: ['cat /etc/os-release'],
      explain: 'On a real Linux computer this tells you the distribution and version, which you will need when following installation instructions. (macOS has no such file; use `sw_vers` there.)',
      check: ran('cat', { args: ['/etc/os-release'] }),
    },
    {
      id: 'kernel',
      title: 'The kernel underneath',
      instruction: 'Print the kernel name, version and machine type:\n\n`$ uname -a`',
      solution: ['uname -a'],
      explain: '`uname` works on Linux and macOS alike. On a Mac it says `Darwin` instead of `Linux`, the name of the core of macOS.',
      check: ran('uname'),
    },
    {
      id: 'goodbye',
      title: 'Say goodbye to the sandbox',
      instruction: 'You have learned a lot! Leave the shell the proper way:\n\n`$ exit`',
      solution: ['exit'],
      explain: 'On a real computer `exit` closes the terminal window (or logs you out of a remote server). Here a new shell is waiting whenever you press Enter. Congratulations on finishing the course!',
      check: (c) => !!c.ev && /^\s*exit\b/.test(c.ev.line),
    },
  ],
  quizSetup: (env) => {
    env.file('logs/app.log', '2026-09-30 08:00:01 app started\n2026-09-30 08:00:02 listening on port 8080\n', { daysAgo: 21 });
    env.file('logs/error.log', '2026-10-02 14:12:09 could not reach the database, retrying\n', { daysAgo: 19 });
    env.file('logs/debug.log', '2026-10-03 09:30:00 cache warmed up in 120 ms\n', { daysAgo: 18 });
    env.file('logs/summary.txt', 'September: 2 errors, both fixed.\n', { daysAgo: 20 });
    env.file('logs/README.txt', 'Old logs from the test server. Keep this file and the summary.\n', { daysAgo: 30 });
  },
  quiz: [
    {
      kind: 'task',
      prompt: 'Find out which shell this computer starts for you by default.',
      hint: 'An environment variable, named after the thing you are looking for, holds it.',
      solution: ['echo $SHELL'],
      explain: '`$SHELL` holds the path of your default shell: here `/bin/bash`. On a Mac, the same command prints `/bin/zsh`.',
      check: all(outputIncludes(/(^|[\s:="'])\/(usr\/)?bin\/bash\b/m), lineMatches(/SHELL|passwd/)),
    },
    {
      prompt: 'Which of these is true on a Mac?',
      options: [
        'The default shell is zsh, and its settings go in `~/.zshrc`',
        'You install software with `sudo apt install NAME`',
        '`uname` prints `Linux`, just like on Ubuntu',
        'Home folders live in `/home`, as on Linux',
      ],
      answer: 0,
      explain:
        'Macs use zsh, so your aliases and settings go in `~/.zshrc` instead of `~/.bashrc`. There is no `apt` (install Homebrew and use `brew install NAME`), home folders are in `/Users`, and `uname` says `Darwin`.',
    },
    {
      kind: 'task',
      prompt: 'Find out which Linux distribution this computer runs, and which version of it.',
      hint: 'Linux keeps a description of the installed system in a small text file in `/etc`.',
      solution: ['cat /etc/os-release'],
      explain:
        '`/etc/os-release` describes the installed system: here Ubuntu 24.04. You will often need that when following installation instructions. (`lsb_release -a` tells you the same thing.)',
      check: any(
        all(outputIncludes(/ubuntu/i), outputIncludes('24.04')),
        // a pager or editor shows the file on a screen of its own, so its output isn't captured
        ...['less', 'more', 'nano'].map((viewer) => ran(viewer, { status: 0, args: [/(os|lsb)-release$|^\/etc\/issue$/] })),
      ),
    },
    {
      prompt: 'What is the recommended way to get the kind of terminal you used in this course on a Windows PC?',
      options: [
        'Use PowerShell, which understands exactly the same commands as bash',
        'Install Homebrew from brew.sh, then run `brew install bash`',
        'Install WSL with `wsl --install`, which gives you a real Ubuntu with bash',
      ],
      answer: 2,
      explain:
        'WSL runs a real Ubuntu inside Windows, with bash, apt and the commands you learned here. PowerShell is a different language (even though it has a few aliases, such as `ls`), and Homebrew is how you install software on a Mac.',
    },
    {
      kind: 'task',
      prompt: 'The folder `logs` in your home folder is full of old `.log` files. Delete all of them, and nothing else, but first check exactly which files your wildcard matches.',
      hint: 'Show the matching files with `ls` first, then hand the very same wildcard to `rm`.',
      solution: ['ls logs/*.log', 'rm logs/*.log'],
      explain:
        'The same wildcard matches the same files, so `ls` showed you exactly what `rm` was about to delete, and `rm` has no undo. `README.txt` and `summary.txt` were safe, because their names don\'t end in `.log`.',
      check: all(
        ...['app.log', 'error.log', 'debug.log'].map((f) => missing(`logs/${f}`)),
        isFile('logs/summary.txt'),
        isFile('logs/README.txt'),
        lookedBeforeDeleting,
      ),
    },
  ],
  recap: `
You know how to move around, manage files, read and edit them, chain commands, search, use permissions and sudo, install software, manage processes, write scripts, and work with archives and remote computers.

That is the core of the command line, and it works the same way on millions of servers, laptops and cloud machines. Keep the [emulator](/) and the [command reference](/reference) handy, and keep experimenting!
`,
  cheatsheet: [
    ['echo $SHELL', 'which shell you use'],
    ['cat /etc/os-release', 'which Linux distribution'],
    ['uname -a', 'kernel and machine'],
    ['wsl --install', '(Windows) install Ubuntu inside Windows'],
    ['brew install NAME', '(macOS) install software with Homebrew'],
  ],
};

export const beyondLessons: Lesson[] = [realTerminal];
