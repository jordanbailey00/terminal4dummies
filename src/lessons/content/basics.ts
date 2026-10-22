// Module 1: First steps.

import type { ExecEvent } from '../../shell/system';
import { resolvePath } from '../../shell/vfs/path';
import { abs, all, any, flagsOf, interrupted, keyUsed, lineMatches, operandsOf, outputIncludes, ran } from '../checks';
import type { CheckContext, Lesson } from '../types';

type Check = (c: CheckContext) => boolean;

const base = (path: string | undefined) => path?.split('/').pop() ?? '';

/** The arguments of a command that aren't options, as absolute paths. */
function targets(e: ExecEvent): string[] {
  return operandsOf(e).map((a) => resolvePath(e.cwd, a));
}

/**
 * The last command listed the folder `path` with ls (named as an argument, or
 * the folder ls ran in when it got none), with one option from each group:
 * listsFolder('~/Desktop', ['l'], ['a', 'A']) needs -l, and -a or -A.
 */
function listsFolder(path: string, ...groups: string[][]): Check {
  const want = abs(path);
  return (c) =>
    !!c.ev &&
    c.ev.execs.some((e) => {
      if (e.kind === 'not-found' || base(e.argv[0]) !== 'ls') return false;
      const paths = targets(e);
      if (paths.length === 0 ? e.cwd !== want : !paths.includes(want)) return false;
      const flags = flagsOf(e);
      return !flags.has('d') && groups.every((g) => g.some((f) => flags.has(f)));
    });
}

/** The last command printed the file at `path` (with cat or a similar command). */
function printed(path: string): Check {
  const want = abs(path);
  return (c) =>
    !!c.ev && c.ev.execs.some((e) => e.kind !== 'not-found' && ['cat', 'less', 'more', 'head', 'tail'].includes(base(e.argv[0])) && targets(e).includes(want));
}

/** The last command repeats one from earlier in this question, brought back from the history with a key. */
const recalled: Check = (c) =>
  !!c.ev &&
  (c.keys.includes('history-prev') || c.keys.includes('reverse-search')) &&
  c.commands.slice(0, -1).some((p) => p.line.trim() === c.ev?.line.trim());

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
  quiz: [
    {
      kind: 'task',
      prompt: 'Get the terminal to print the words `Good morning`.',
      hint: 'The command you need prints back whatever words you type after it.',
      solution: ['echo Good morning'],
      explain: "`echo` prints the words that come after it. The word `echo` is the command itself, so it isn't printed, and plain words like these need no quotes.",
      check: all(any(ran('echo'), ran('printf')), outputIncludes(/good\s+morning/i)),
    },
    {
      kind: 'task',
      prompt: 'Someone typed `Whoami` and got *command not found*. Run the command they meant.',
      hint: 'Look closely at the first letter. To the shell, a capital letter makes it a different word.',
      solution: ['whoami'],
      explain:
        "Commands are **case-sensitive**: the command is `whoami`, all in lowercase, so `Whoami` is a different name that doesn't exist. It answered with your user name, `learner`.",
      check: ran('whoami'),
    },
    {
      prompt: 'In this prompt, which part tells you which folder you are in?\n\n```\nlearner@sandbox:~$\n```',
      options: ['`learner`', '`sandbox`', '`~`', '`$`'],
      answer: 2,
      explain: '`~` is short for your **home folder**, and this part of the prompt shows where you are. `learner` is your user name, `sandbox` is the computer, and `$` means the shell is ready.',
    },
    {
      kind: 'task',
      prompt: 'Find out what day and time it is, according to this computer.',
      hint: 'Many commands are plain English words. This one is the word for a day on the calendar.',
      solution: ['date'],
      explain: '`date` prints the day, the date and the time. Like many commands, it does exactly what its name says.',
      check: all(ran('date'), outputIncludes(/\d:\d\d/)),
    },
    {
      kind: 'task',
      prompt: 'The screen is getting crowded. Wipe it, so that only a fresh prompt is left at the top.',
      hint: 'There is a command for this, named after what it does to the screen. A keyboard shortcut works too.',
      solution: ['clear'],
      explain: '`clear` wipes the screen, and so does <kbd>Ctrl</kbd>+<kbd>L</kbd>. Nothing is lost: the shell still remembers the commands you ran.',
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
  quizSetup: (env) => {
    env.file('Desktop/.reminder.txt', 'Water the plants on Friday.\n', { daysAgo: 2 });
  },
  quiz: [
    {
      kind: 'task',
      prompt: 'Show a long listing of the `Downloads` folder: one file per line, with sizes and dates.',
      hint: "Start with the command that lists files, add the option for a *long* listing, and end with the folder's name.",
      solution: ['ls -l Downloads'],
      explain: '`-l` is an **option**: it changes *how* `ls` lists. `Downloads` is an **argument**: it tells `ls` *what* to list.',
      check: listsFolder('~/Downloads', ['l']),
    },
    {
      kind: 'task',
      prompt: "`Desktop` looks empty, but it isn't. Show a long listing of `Desktop` that includes the hidden files.",
      hint: 'You need two options at once: the one for a long listing and the one for *all* files. Short options can share a single dash.',
      solution: ['ls -la Desktop'],
      explain:
        'Short options can be glued together after one dash, in any order: `ls -la Desktop`, `ls -al Desktop` and `ls -l -a Desktop` all do the same. The hidden file is `.reminder.txt`: names that start with a dot are hidden from a plain `ls`.',
      check: listsFolder('~/Desktop', ['l'], ['a', 'A']),
    },
    {
      kind: 'task',
      prompt: '`-a` also has a long name: a whole word, written after two dashes. Show the hidden files in `Desktop` again, using that long name instead of `-a`.',
      hint: 'Long options start with `--`. Which word is `-a` short for?',
      solution: ['ls --all Desktop'],
      explain:
        '`--all` is the long name of `-a`: easier to read, while `-a` is quicker to type. Careful with the dashes: with only one, `-all` means `-a -l -l`.',
      check: listsFolder('~/Desktop', ['--all', '--almost-all']),
    },
    {
      kind: 'task',
      prompt: '`mkdir` is a command that makes folders. Without making a folder, get `mkdir` to describe all of its options.',
      hint: 'The long option you used with `ls` at the end of the lesson works for almost every command.',
      solution: ['mkdir --help'],
      explain: '`--help` makes almost any command describe itself and its options instead of doing its usual job. It is the quickest way to look up an option you have forgotten.',
      check: any(ran('mkdir', { args: ['--help'] }), ran('man', { args: ['mkdir'] })),
    },
    {
      prompt: 'Why did this error happen?\n\n```\nlearner@sandbox:~$ ls-l\nls-l: command not found\n```',
      options: [
        "`ls` isn't installed on this computer",
        '`ls` needs an argument, such as a folder name',
        "`-l` isn't a real option for `ls`",
        "There's no space after `ls`, so the shell looked for a command called `ls-l`",
      ],
      answer: 3,
      explain: "The shell splits a line into words at the spaces, and the first word is the command. Without the space, `ls-l` is a single word: the name of a command that doesn't exist.",
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
  quizSetup: (env) => {
    env.file('packing-list-summer.txt', 'Sunscreen\nSandals\nA good book\n', { daysAgo: 1 });
    env.file('packing-list-winter.txt', 'Gloves\nWool hat\nA good book\n', { daysAgo: 1 });
  },
  quiz: [
    {
      kind: 'task',
      prompt: '`sleep` waits for as many seconds as you tell it to. Start a wait of ten minutes, then end it early instead of waiting.',
      hint: 'Ten minutes is 600 seconds. While it runs, hold <kbd>Ctrl</kbd> and press the letter that stands for *cancel*.',
      solution: ['sleep 600', { keys: '\x03', label: 'Press Ctrl+C', delay: 600 }],
      explain:
        '<kbd>Ctrl</kbd>+<kbd>C</kbd> interrupts the command that is running, and the prompt comes right back. On a Mac it is the Control key too: <kbd>Cmd</kbd>+<kbd>C</kbd> copies text.',
      check: all(ran('sleep'), interrupted()),
    },
    {
      kind: 'task',
      prompt: "Find out what time it is. Then run that same command a second time, but don't type it again: bring it back with a key.",
      hint: 'One of the arrow keys walks back through the commands you have run.',
      solution: ['date', { keys: '\x1b[A', label: 'Press ↑' }, { keys: '\r', label: 'Press Enter' }],
      explain:
        '<kbd>↑</kbd> brings back the commands you ran before, one at a time, and <kbd>↓</kbd> walks forward again. You can change a recalled command before you press <kbd>Enter</kbd>.',
      check: recalled,
    },
    {
      kind: 'task',
      prompt: 'Two files in your home folder have names that start with `packing-list`. Print the one for winter, and let <kbd>Tab</kbd> do most of the typing.',
      hint: '`cat` prints a file. After `cat`, type the start of the name and press <kbd>Tab</kbd>. When it stops, add a letter and press <kbd>Tab</kbd> again.',
      solution: [
        { keys: 'cat pa', label: 'Type cat pa' },
        { keys: '\t', label: 'Press Tab' },
        { keys: 'w', label: 'Type w' },
        { keys: '\t', label: 'Press Tab' },
        { keys: '\r', label: 'Press Enter' },
      ],
      explain:
        '<kbd>Tab</kbd> fills in as much of a name as it can. When several names fit, it stops where they differ, and pressing <kbd>Tab</kbd> twice lists them all.',
      check: all(keyUsed('tab-complete'), printed('~/packing-list-winter.txt')),
    },
    {
      prompt:
        'Here is your history. Which of these runs `cat welcome.txt` again?\n\n```\nlearner@sandbox:~$ history\n    1  echo I love shortcuts\n    2  cat welcome.txt\n    3  sleep 100\n    4  history\n```',
      options: ['`!2`', '`!!`', '`history 2`', 'Press <kbd>↑</kbd> twice, then <kbd>Enter</kbd>'],
      answer: 0,
      explain:
        '`!` followed by a number runs that command from your history again, so `!2` runs `cat welcome.txt`. `!!` repeats the most recent command (`history`), `history 2` only shows the last two lines of the list, and <kbd>↑</kbd> twice brings back `sleep 100`.',
    },
    {
      kind: 'task',
      prompt: 'Clear the screen with a keyboard shortcut, without typing any command.',
      hint: 'Hold <kbd>Ctrl</kbd> and press one letter. The table at the top of this lesson lists it.',
      solution: [{ keys: '\x0c', label: 'Press Ctrl+L' }],
      explain:
        '<kbd>Ctrl</kbd>+<kbd>L</kbd> does the same job as the `clear` command, and it even works halfway through typing a line: what you have typed so far stays put.',
      check: keyUsed('clear-screen'),
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
