// Module 1: First steps.

import { all, any, keyUsed, ran, lineMatches, interrupted } from '../checks';
import type { Lesson } from '../types';

export const welcome: Lesson = {
  id: 'welcome',
  title: 'Your first commands',
  summary: 'Meet the terminal, the shell and the prompt, and run your very first commands.',
  moduleId: 'basics',
  minutes: 5,
  intro: `
A **terminal** is a window where you control the computer by *typing* instead of clicking. You type a command, press <kbd>Enter</kbd>, and the computer answers with text. The program that reads your commands and carries them out is called the **shell**. This one is **bash**, the most common shell on Linux.

Look at the terminal on the right. The text at the start of the line is the **prompt**:

\`\`\`
learner@sandbox:~$
\`\`\`

| Part | Meaning |
| --- | --- |
| \`learner\` | who you are (your user name) |
| \`sandbox\` | which computer you're on |
| \`~\` | where you are: \`~\` is short for your **home folder** |
| \`$\` | "I'm ready, type something!" |

> [!TIP]
> You can't break anything here. This computer is simulated inside your browser, so experiment as much as you like.
`,
  steps: [
    {
      id: 'echo',
      title: 'Say hello',
      instruction: 'Click the terminal, type this command, and press <kbd>Enter</kbd>:\n\n`$ echo Hello, terminal!`',
      hint: 'Type it exactly, including the word `echo` and a space after it, then press the Enter key.',
      solution: ['echo Hello, terminal!'],
      explain: '`echo` prints back whatever you give it. It sounds useless, but it is handy for showing messages and, later, for writing text into files.',
      check: ran('echo'),
    },
    {
      id: 'whoami',
      title: 'Who am I?',
      instruction: 'Ask the computer which user you are logged in as:\n\n`$ whoami`',
      solution: ['whoami'],
      explain: "It answered `learner`, the same name you see in the prompt. The computer always knows who is running each command, which matters later when we talk about permissions.",
      check: ran('whoami'),
    },
    {
      id: 'date',
      title: 'What time is it?',
      instruction: 'Print the current date and time:\n\n`$ date`',
      solution: ['date'],
      explain: 'Many commands are short English words or abbreviations. `date` does exactly what its name says.',
      check: ran('date'),
    },
    {
      id: 'typo',
      title: 'Make a mistake on purpose',
      instruction: "Everyone mistypes commands. Let's see what happens. Type this deliberately misspelled command:\n\n`$ dtae`",
      hint: 'Just type `dtae` (the letters swapped) and press Enter.',
      solution: ['dtae'],
      explain:
        "**command not found** means the shell has no program by that name. Nothing broke. Check the spelling and try again. Remember too that commands are **case-sensitive**: `Date` and `date` are different.",
      check: (c) => !!c.ev && c.ev.execs.some((e) => e.kind === 'not-found'),
    },
    {
      id: 'clear',
      title: 'Clean the screen',
      instruction: 'The screen is getting busy. Clear it with:\n\n`$ clear`\n\nor press <kbd>Ctrl</kbd>+<kbd>L</kbd>.',
      solution: ['clear'],
      explain: '`clear` wipes the screen. Your previous commands are not lost: you will learn how to get them back in a later lesson.',
      check: any(ran('clear'), keyUsed('clear-screen')),
    },
  ],
  recap: `
You ran your first commands! The pattern is always the same: **type a command, press Enter, read the answer.**

- The **prompt** (\`learner@sandbox:~$\`) shows who you are, where you are, and that the shell is ready.
- \`echo\` prints text, \`whoami\` shows your user name, \`date\` shows the time, \`clear\` cleans the screen.
- "command not found" just means a typo (or a program that isn't installed).
`,
  cheatsheet: [
    ['echo TEXT', 'print text'],
    ['whoami', 'show your user name'],
    ['date', 'show the date and time'],
    ['clear', 'clear the screen (or Ctrl+L)'],
  ],
  realWorld: `
**Opening a terminal on your own computer**

- **macOS:** press <kbd>Cmd</kbd>+<kbd>Space</kbd>, type *Terminal*, press Enter. macOS uses the **zsh** shell, whose prompt ends in \`%\` instead of \`$\`, but these commands work the same.
- **Windows:** the closest match to this site is **WSL** (Windows Subsystem for Linux), which gives you a real Ubuntu terminal. Open PowerShell and run \`wsl --install\`. The built-in PowerShell uses different commands.
- **Linux (Ubuntu):** press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd>.
`,
};

export const anatomy: Lesson = {
  id: 'anatomy',
  title: 'Commands, options and arguments',
  summary: 'Learn the grammar of every command: the command name, options that change it, and arguments it works on.',
  moduleId: 'basics',
  minutes: 7,
  intro: `
Almost every command follows the same grammar:

\`\`\`
ls   -l       Documents
│    │        │
│    │        └── argument: what to work on
│    └── option (also called a flag): how to do it
└── command: what to do
\`\`\`

- The **command** is the program to run (\`ls\` lists files).
- **Options** start with a dash and change how the command behaves. Short options are one letter (\`-l\`); long options use two dashes and a word (\`--all\`).
- **Arguments** tell the command what to work on, often a file or folder name.

Words are separated by **spaces**, so \`ls -l\` and \`ls-l\` are completely different: the second one is a command that doesn't exist.
`,
  steps: [
    {
      id: 'ls',
      title: 'Just the command',
      instruction: 'List the files and folders in your home folder:\n\n`$ ls`',
      solution: ['ls'],
      explain: '`ls` (short for *list*) shows what is in the current folder. Folders are shown in **blue** and ordinary files in white.',
      check: ran('ls'),
    },
    {
      id: 'ls-l',
      title: 'Add an option',
      instruction: 'Now add the `-l` option (a lowercase L, for *long*):\n\n`$ ls -l`',
      hint: 'There is a space between `ls` and `-l`, and no space between the dash and the letter.',
      solution: ['ls -l'],
      explain: 'Same command, different output: one item per line with extra details (permissions, owner, size, date). Options change *how* a command does its job.',
      check: ran('ls', { flags: 'l' }),
    },
    {
      id: 'ls-a',
      title: 'A different option',
      instruction: 'The `-a` option (for *all*) also shows **hidden** files:\n\n`$ ls -a`',
      solution: ['ls -a'],
      explain: 'Files whose names start with a dot, like `.bashrc`, are hidden by default. They are usually settings files. `.` means "this folder" and `..` means "the folder above".',
      check: ran('ls', { flags: 'a' }),
    },
    {
      id: 'ls-la',
      title: 'Combine options',
      instruction: 'You can use several options at once. Short options can be glued together after a single dash:\n\n`$ ls -la`',
      hint: '`ls -la`, `ls -al` and `ls -l -a` all mean the same thing.',
      solution: ['ls -la'],
      explain: '`-la` is shorthand for `-l -a`: a long listing that includes hidden files. The order of the letters does not matter.',
      check: ran('ls', { flags: 'la' }),
    },
    {
      id: 'ls-arg',
      title: 'Give it an argument',
      instruction: "Arguments tell a command *what* to work on. List what's inside the Documents folder without going there:\n\n`$ ls Documents`",
      hint: 'Folder names are case-sensitive: `Documents` with a capital D.',
      solution: ['ls Documents'],
      explain: 'The argument `Documents` told `ls` which folder to list. Without an argument, `ls` lists the folder you are in.',
      check: ran('ls', { args: [/^(\.\/)?Documents\/?$/] }),
    },
    {
      id: 'help',
      title: 'Ask for help',
      instruction: 'Most commands describe their own options when you pass `--help`. Try:\n\n`$ ls --help`',
      solution: ['ls --help'],
      explain: "That's a lot of options! You never need to memorize them; `--help` and `man` (coming later) are always there. Scroll up with your mouse wheel to see the beginning.",
      check: all(ran('ls'), lineMatches(/--help/)),
    },
  ],
  recap: `
Every command line has the same shape: **command**, then **options** (starting with \`-\` or \`--\`), then **arguments**.

- Short options can be combined: \`ls -la\` = \`ls -l -a\`.
- Long options are spelled out: \`ls --all\` = \`ls -a\`.
- Add \`--help\` to almost any command to see what it can do.
`,
  cheatsheet: [
    ['ls', 'list files'],
    ['ls -l', 'long listing with details'],
    ['ls -a', 'include hidden files'],
    ['ls FOLDER', "list another folder's contents"],
    ['COMMAND --help', 'show the options of a command'],
  ],
};

export const shortcuts: Lesson = {
  id: 'shortcuts',
  title: 'Keyboard superpowers',
  summary: 'Repeat commands with the arrow keys, let Tab do your typing, and stop anything with Ctrl+C.',
  moduleId: 'basics',
  minutes: 8,
  intro: `
Experienced terminal users type surprisingly little. A handful of keyboard shortcuts do most of the work:

| Keys | What it does |
| --- | --- |
| <kbd>↑</kbd> / <kbd>↓</kbd> | step through the commands you ran before |
| <kbd>Tab</kbd> | finish the word you're typing (file names, commands) |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | stop the command that's running, or abandon the line you're typing |
| <kbd>Ctrl</kbd>+<kbd>L</kbd> | clear the screen |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> / <kbd>Ctrl</kbd>+<kbd>E</kbd> | jump to the start / end of the line |
| <kbd>Ctrl</kbd>+<kbd>R</kbd> | search through your past commands |

> [!NOTE]
> On a Mac, terminal shortcuts use the **Control** key, not Command: <kbd>Ctrl</kbd>+<kbd>C</kbd> stops a program, while <kbd>Cmd</kbd>+<kbd>C</kbd> copies text.
`,
  steps: [
    {
      id: 'run-echo',
      title: 'Run something',
      instruction: 'Run a command you can repeat in a moment:\n\n`$ echo I love shortcuts`',
      solution: ['echo I love shortcuts'],
      check: ran('echo'),
    },
    {
      id: 'up-arrow',
      title: 'Bring it back with ↑',
      instruction: 'Press the <kbd>↑</kbd> (up arrow) key. Your last command appears again. Press <kbd>Enter</kbd> to run it once more.',
      hint: 'Click inside the terminal first so it receives your key presses.',
      solution: [{ keys: '\x1b[A', label: 'Press ↑' }, { keys: '\r', label: 'Press Enter' }],
      explain: 'The shell remembers everything you type. <kbd>↑</kbd> walks backwards through that history and <kbd>↓</kbd> walks forwards. You can edit a recalled command before pressing Enter.',
      check: (c) => c.keys.includes('history-prev') && !!c.ev && c.ev.line.trim() === c.commands[c.commands.length - 2]?.line.trim(),
    },
    {
      id: 'tab',
      title: 'Let Tab type for you',
      instruction: 'Type `cat wel` (don\'t press Enter yet), then press <kbd>Tab</kbd>. The shell completes the file name to `welcome.txt`. Now press <kbd>Enter</kbd>.',
      hint: 'Type `cat wel`, press the Tab key once, then Enter.',
      solution: [{ keys: 'cat wel', label: 'Type cat wel' }, { keys: '\t', label: 'Press Tab' }, { keys: '\r', label: 'Press Enter' }],
      explain: '<kbd>Tab</kbd> completion saves typing *and* prevents typos. If several names match, press <kbd>Tab</kbd> twice to see all the choices.',
      check: all(keyUsed('tab-complete'), ran('cat', { args: ['welcome.txt'] })),
    },
    {
      id: 'ctrl-c',
      title: 'Stop a running command',
      instruction: '`sleep 100` waits for 100 seconds, which is far too long. Run it, then press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop it:\n\n`$ sleep 100`',
      hint: 'Hold the Ctrl key and press C. On a Mac use the Control key, not Command.',
      solution: ['sleep 100', { keys: '\x03', label: 'Press Ctrl+C', delay: 600 }],
      explain: '<kbd>Ctrl</kbd>+<kbd>C</kbd> interrupts the running program. It\'s your emergency exit whenever something hangs or takes too long. The `^C` you see is the terminal showing that you pressed it.',
      check: all(ran('sleep'), interrupted()),
    },
    {
      id: 'ctrl-l',
      title: 'Clear with Ctrl+L',
      instruction: 'Press <kbd>Ctrl</kbd>+<kbd>L</kbd> to clear the screen without typing a command.',
      solution: [{ keys: '\x0c', label: 'Press Ctrl+L' }],
      check: any(keyUsed('clear-screen'), ran('clear')),
    },
    {
      id: 'history',
      title: 'See your history',
      instruction: 'List every command you have run so far:\n\n`$ history`',
      solution: ['history'],
      explain: 'Each command has a number. You can re-run one with `!` and its number (for example `!3`), or run the previous command again with `!!`.',
      check: ran('history'),
    },
  ],
  recap: `
These shortcuts will save you thousands of keystrokes:

- <kbd>↑</kbd> recalls previous commands; \`history\` lists them all.
- <kbd>Tab</kbd> completes names. Use it constantly!
- <kbd>Ctrl</kbd>+<kbd>C</kbd> stops a running command (or cancels the line you're typing).
- <kbd>Ctrl</kbd>+<kbd>L</kbd> clears the screen.
`,
  cheatsheet: [
    ['↑ / ↓', 'previous / next command'],
    ['Tab', 'complete a name (twice to list choices)'],
    ['Ctrl+C', 'stop the running command'],
    ['Ctrl+L', 'clear the screen'],
    ['Ctrl+R', 'search command history'],
    ['history', 'list previous commands'],
    ['!!', 'run the last command again'],
  ],
};
