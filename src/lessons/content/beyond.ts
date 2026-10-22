// Module: Beyond this computer.

import { ran } from '../checks';
import type { Lesson } from '../types';

export const realTerminal: Lesson = {
  id: 'real-terminal',
  title: 'Taking it home: your own terminal',
  summary: 'Open a real terminal on macOS, Windows or Linux, know what is different, and pick what to learn next.',
  moduleId: 'beyond',
  minutes: 7,
  intro: `
Everything you practised here works on real computers. This last lesson helps you make the jump.

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
- Many tools are the BSD versions, with slightly different options: \`ls -G\` for colours, \`sed -i ''\` for in-place edits.
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
  quiz: [
    {
      prompt: 'Which of these is true on a Mac?',
      options: [
        'You install software with `sudo apt install NAME`',
        '`uname` prints `Linux`, just like on Ubuntu',
        'Home folders live in `/home`, as on Linux',
        'The default shell is zsh, and its settings go in `~/.zshrc`',
      ],
      answer: 3,
      explain:
        'Macs use zsh, so your aliases and settings go in `~/.zshrc` instead of `~/.bashrc`. There is no `apt` (install Homebrew and use `brew install NAME`), home folders are in `/Users`, and `uname` says `Darwin`.',
    },
    {
      prompt: 'What is the recommended way to get the kind of terminal you used in this course on a Windows PC?',
      options: [
        'Install WSL with `wsl --install`, which gives you a real Ubuntu with bash',
        'Use PowerShell, which understands exactly the same commands as bash',
        'Install Homebrew from brew.sh, then run `brew install bash`',
      ],
      answer: 0,
      explain:
        'WSL runs a real Ubuntu inside Windows, with bash, apt and the commands you learned here. PowerShell is a different language (even though it has a few aliases, such as `ls`), and Homebrew is how you install software on a Mac.',
    },
    {
      kind: 'command',
      prompt: 'Type the command that shows which Linux distribution, and which version of it, a computer is running.',
      accept: [
        'cat /etc/os-release',
        /^(cat|less|more|head) \/(etc|usr\/lib)\/os-release$/,
        /^(cat|less|more|head) \/etc\/lsb-release$/,
        /^cat \/etc\/\*-?release$/,
        'lsb_release -a',
        'hostnamectl',
      ],
      explain: '`/etc/os-release` is a small text file in which Linux describes the installed system, including the name and version of the distribution. You will often need that when following installation instructions.',
    },
    {
      prompt: 'On your own computer, you are about to run `rm *.log`. Which habit protects you from deleting the wrong files?',
      options: [
        'Put `sudo` in front, so that it cannot fail halfway through',
        'Run `ls *.log` first, to see exactly which files the wildcard matches',
        'Run it from your home folder, where nothing important is kept',
      ],
      answer: 1,
      explain: 'The same wildcard matches the same files, so `ls *.log` shows exactly what `rm *.log` would delete, and `rm` has no undo. `sudo` only makes a mistake bigger: use it only when a command really needs it.',
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
