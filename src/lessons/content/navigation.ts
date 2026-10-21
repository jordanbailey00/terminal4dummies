// Module 2: Finding your way around.

import { all, cwdIs, ran } from '../checks';
import type { Lesson } from '../types';

export const whereAmI: Lesson = {
  id: 'where-am-i',
  title: 'Where am I?',
  summary: 'Understand the folder tree, your home folder, and how to look around without getting lost.',
  moduleId: 'navigation',
  minutes: 6,
  intro: `
Files on Linux live in folders (also called **directories**), and folders live inside other folders, forming one big upside-down tree. The very top of the tree is called the **root** and is written as a single slash: \`/\`.

\`\`\`
/                      ← the root: everything starts here
├── etc/               ← system settings
├── home/
│   └── learner/       ← your home folder (~)
│       ├── Documents/
│       └── Pictures/
├── tmp/               ← temporary files
├── usr/               ← installed programs
└── var/               ← logs and changing data
\`\`\`

At every moment the shell is "standing" in one folder, called the **current working directory**. Commands work relative to that place unless you say otherwise.

> [!NOTE]
> Unlike Windows, Linux has no drive letters like \`C:\`. Everything, including USB sticks, appears somewhere inside \`/\`. And paths use forward slashes \`/\`, not backslashes.
`,
  steps: [
    {
      id: 'pwd',
      title: 'Print your location',
      instruction: '`pwd` stands for *print working directory*. Run it:\n\n`$ pwd`',
      solution: ['pwd'],
      explain: '`/home/learner` is your **home folder**: the place for your own files. The prompt shows it as `~` for short.',
      check: ran('pwd'),
    },
    {
      id: 'ls-here',
      title: "See what's here",
      instruction: 'List the contents of your current folder:\n\n`$ ls`',
      solution: ['ls'],
      explain: 'These are the folders and files inside `/home/learner`. Folders appear in blue.',
      check: ran('ls'),
    },
    {
      id: 'ls-root',
      title: 'Peek at the root',
      instruction: "You can list any folder by giving its path. Look at the very top of the tree:\n\n`$ ls /`",
      solution: ['ls /'],
      explain: 'These are the standard top-level folders that every Linux system has. `home` is where user folders live, `etc` holds settings, `usr` holds programs and `var` holds logs.',
      check: ran('ls', { args: ['/'] }),
    },
    {
      id: 'ls-home',
      title: 'Look inside /home',
      instruction: 'Now list the folder that contains every user\'s home folder:\n\n`$ ls /home`',
      solution: ['ls /home'],
      explain: 'There is one folder per user. On this computer there is only you, `learner`.',
      check: ran('ls', { args: ['/home'] }),
    },
    {
      id: 'ls-deep',
      title: 'Look two levels down',
      instruction: 'Paths can go several levels deep, separated by `/`. List the recipes folder inside Documents:\n\n`$ ls Documents/recipes`',
      hint: 'Try typing `ls Doc`, press Tab, then `re`, and Tab again.',
      solution: ['ls Documents/recipes'],
      explain: '`Documents/recipes` means "the recipes folder inside the Documents folder". You looked inside it without moving there.',
      check: ran('ls', { args: [/(^|\/)Documents\/recipes\/?$/] }),
    },
  ],
  recap: `
- The filesystem is a tree that starts at the **root**, \`/\`.
- Your **home folder** is \`/home/learner\`, written \`~\` for short.
- \`pwd\` tells you where you are; \`ls PATH\` shows what's inside any folder.
`,
  cheatsheet: [
    ['pwd', 'print the current folder'],
    ['ls PATH', 'list a folder'],
    ['/', 'the root of the filesystem'],
    ['~', 'your home folder'],
  ],
  realWorld: `
- **macOS:** home folders are in \`/Users\` instead of \`/home\` (for example \`/Users/ada\`).
- **Windows (PowerShell):** paths look like \`C:\\Users\\ada\`. In WSL, your Windows drives appear under \`/mnt/c\`.
`,
};

export const movingAround: Lesson = {
  id: 'moving-around',
  title: 'Moving around with cd',
  summary: 'Walk through the folder tree with cd, using relative paths, absolute paths, .. and ~.',
  moduleId: 'navigation',
  minutes: 8,
  intro: `
\`cd\` (*change directory*) moves you to another folder. There are two ways to say where to go:

- A **relative path** starts from where you are now: \`cd Documents\` means "the Documents folder *in here*".
- An **absolute path** starts at the root and always begins with \`/\`: \`cd /var/log\` works from anywhere.

A few special names save typing:

| Name | Means |
| --- | --- |
| \`..\` | the folder above (the parent) |
| \`.\` | the current folder |
| \`~\` | your home folder |
| \`-\` | (only with \`cd\`) the folder you were in before |

> [!TIP]
> Watch the prompt as you move: the part before \`$\` always shows where you are.
`,
  steps: [
    {
      id: 'cd-docs',
      title: 'Go into Documents',
      instruction: '`$ cd Documents`',
      hint: 'Use Tab: type `cd Doc` and press Tab.',
      solution: ['cd Documents'],
      explain: 'The prompt changed to `~/Documents`. `cd` itself printed nothing; most commands stay quiet when everything goes well.',
      check: cwdIs('~/Documents'),
    },
    {
      id: 'cd-recipes',
      title: 'Go one level deeper',
      instruction: 'From here, move into the recipes folder:\n\n`$ cd recipes`',
      solution: ['cd recipes'],
      explain: 'That was a **relative** path: `recipes` was found inside the folder you were already in.',
      check: cwdIs('~/Documents/recipes'),
    },
    {
      id: 'cd-up',
      title: 'Go back up',
      instruction: '`..` means "the parent folder". Go up one level:\n\n`$ cd ..`',
      hint: 'There must be a space between `cd` and `..`.',
      solution: ['cd ..'],
      explain: 'You are back in Documents. You can climb several levels at once with `cd ../..`.',
      check: cwdIs('~/Documents'),
    },
    {
      id: 'cd-abs',
      title: 'Jump with an absolute path',
      instruction: 'Absolute paths start at the root, so they work from anywhere. Jump to the system log folder:\n\n`$ cd /var/log`',
      solution: ['cd /var/log'],
      explain: 'Because the path started with `/`, it did not matter where you were. Take a look around with `ls` if you like.',
      check: cwdIs('/var/log'),
    },
    {
      id: 'cd-home',
      title: 'Go home',
      instruction: '`cd` on its own (or `cd ~`) always takes you home:\n\n`$ cd`',
      solution: ['cd'],
      explain: 'Wherever you are, `cd` with no arguments brings you back to `/home/learner`.',
      check: cwdIs('~'),
    },
    {
      id: 'cd-dash',
      title: 'Go back to where you were',
      instruction: '`cd -` returns to the previous folder, like a back button:\n\n`$ cd -`',
      solution: ['cd -'],
      explain: '`cd -` prints the folder it switched to. Running it again toggles back, which is handy when you work in two places at once.',
      check: all(ran('cd', { args: ['-'] }), cwdIs('/var/log')),
    },
  ],
  recap: `
- \`cd FOLDER\` moves into a folder; the prompt shows where you are.
- **Relative** paths start from the current folder; **absolute** paths start with \`/\`.
- \`cd ..\` goes up, \`cd\` or \`cd ~\` goes home, \`cd -\` goes back.
`,
  cheatsheet: [
    ['cd FOLDER', 'move into a folder'],
    ['cd ..', 'go up one level'],
    ['cd / cd ~', 'go to your home folder'],
    ['cd -', 'go back to the previous folder'],
    ['cd /var/log', 'go to an absolute path'],
  ],
};

export const lookingCloser: Lesson = {
  id: 'looking-closer',
  title: 'Looking closer with ls',
  summary: 'Reveal hidden files and read the long listing: permissions, owners, sizes and dates.',
  moduleId: 'navigation',
  minutes: 8,
  setup: (env) => {
    env.dir('garden');
    env.file('garden/tomatoes.txt', 'Plant in late spring.\nWater every morning.\nHarvest when red.\n', { daysAgo: 30 });
    env.file('garden/roses.txt', 'Prune in winter.\n', { daysAgo: 12 });
    env.file('garden/seed-catalog.txt', 'Seed catalog\n'.repeat(600), { daysAgo: 200 });
    env.file('garden/.hidden-treasure.txt', 'You found the hidden treasure!\nFiles that start with a dot are hidden from a plain ls.\n', { daysAgo: 3 });
    env.file('garden/watering-schedule.txt', 'Mon Wed Fri: vegetables\nSun: roses\n', { daysAgo: 1 });
    env.dir('garden/tools');
  },
  intro: `
\`ls\` has dozens of options. Three of them answer most everyday questions: **what's hidden?** (\`-a\`), **tell me more** (\`-l\`), and **in what order?** (\`-t\`, \`-S\`, \`-r\`).

The long listing (\`ls -l\`) packs a lot into each line:

\`\`\`
-rw-rw-r-- 1 learner learner  61 Oct 20 09:12 roses.txt
│          │ │       │        │  │            └ name
│          │ │       │        │  └ last modified
│          │ │       │        └ size in bytes
│          │ │       └ group
│          │ └ owner
│          └ number of links
└ type and permissions (d = directory, - = file)
\`\`\`

Don't worry about permissions yet. They get a whole lesson later.
`,
  startDir: 'garden',
  steps: [
    {
      id: 'plain',
      title: 'A plain listing',
      instruction: "You're in a folder called `garden`. List it:\n\n`$ ls`",
      solution: ['ls'],
      check: ran('ls'),
    },
    {
      id: 'hidden',
      title: 'Find the hidden file',
      instruction: 'Something is hiding here. Show **all** files, including hidden ones:\n\n`$ ls -a`',
      solution: ['ls -a'],
      explain: 'Files that start with a dot are hidden from a normal `ls`. Programs use this for settings files so they don\'t clutter your folders.',
      check: ran('ls', { flags: 'a' }),
    },
    {
      id: 'treasure',
      title: 'Read the hidden file',
      instruction: 'Print the hidden file with `cat` (it prints files to the screen). Remember the dot!\n\n`$ cat .hidden-treasure.txt`',
      hint: 'Type `cat .h` and press Tab to complete the name.',
      solution: ['cat .hidden-treasure.txt'],
      check: ran('cat', { args: ['.hidden-treasure.txt'] }),
    },
    {
      id: 'long',
      title: 'Get the details',
      instruction: 'Show the long listing:\n\n`$ ls -l`',
      solution: ['ls -l'],
      explain:
        "Each line shows one item. A line starting with `d` is a **d**irectory (`tools`). The number before the date is the size in bytes. `total` at the top is the disk space used, in kilobytes.",
      check: ran('ls', { flags: 'l' }),
    },
    {
      id: 'human',
      title: 'Human-friendly sizes',
      instruction: "Sizes in bytes are hard to read. `-h` (*human-readable*) adds K, M and G:\n\n`$ ls -lh`",
      solution: ['ls -lh'],
      explain: '`seed-catalog.txt` is about 7.8K: roughly 7.8 kilobytes. `-h` only changes how sizes are shown.',
      check: ran('ls', { flags: 'lh' }),
    },
    {
      id: 'time',
      title: 'Newest first',
      instruction: 'Sort by modification time, newest first, with `-t`:\n\n`$ ls -lt`',
      solution: ['ls -lt'],
      explain: 'Notice that the oldest file shows a **year** instead of a time. `ls` does that for anything older than six months. Add `-r` to reverse any sort order (`ls -ltr` puts the newest at the bottom).',
      check: ran('ls', { flags: 'lt' }),
    },
  ],
  recap: `
- \`ls -a\` shows hidden (dot) files.
- \`ls -l\` shows details: type and permissions, owner, size, date.
- \`-h\` makes sizes readable, \`-t\` sorts by time, \`-S\` by size, \`-r\` reverses.
- Options combine freely: \`ls -lah\`, \`ls -ltr\`.
`,
  cheatsheet: [
    ['ls -a', 'show hidden files'],
    ['ls -l', 'long listing'],
    ['ls -lh', 'long listing with readable sizes'],
    ['ls -lt', 'newest first'],
    ['ls -lS', 'largest first'],
    ['ls -ltr', 'oldest first (reverse)'],
  ],
  realWorld: `
On **macOS**, \`ls\` is the BSD version: the common options here work, but colors need \`ls -G\` instead of \`--color\`.
`,
};
