// Module 2: Finding your way around.

import type { ExecEvent } from '../../shell/system';
import { resolvePath } from '../../shell/vfs/path';
import { abs, all, any, cwdIs, flagsOf, not, operandsOf, ran } from '../checks';
import type { CheckContext, Lesson } from '../types';

type Check = (c: CheckContext) => boolean;

const base = (path: string | undefined) => path?.split('/').pop() ?? '';

/** Options of an ls command, with the spelled-out sort orders counted as -S and -t. */
function lsFlags(e: ExecEvent): Set<string> {
  const flags = flagsOf(e);
  if (e.argv.includes('--sort=size')) flags.add('S');
  if (e.argv.includes('--sort=time')) flags.add('t');
  return flags;
}

/**
 * The last command listed the folder `path` with ls (named as an argument, or
 * the folder ls ran in when it got none), with one option from each group:
 * listsFolder('~/shed', ['l'], ['a', 'A']) needs -l, and -a or -A.
 */
function listsFolder(path: string, ...groups: string[][]): Check {
  const want = abs(path);
  return (c) =>
    !!c.ev &&
    c.ev.execs.some((e) => {
      if (e.kind === 'not-found' || base(e.argv[0]) !== 'ls') return false;
      const paths = operandsOf(e).map((a) => resolvePath(e.cwd, a));
      if (paths.length === 0 ? e.cwd !== want : !paths.includes(want)) return false;
      const flags = lsFlags(e);
      return !flags.has('d') && groups.every((g) => g.some((f) => flags.has(f)));
    });
}

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
  quizSetup: (env) => {
    env.file('Documents/recipes/desserts/brownies.txt', 'Brownies\n\n200 g dark chocolate\n150 g butter\n3 eggs\n', { daysAgo: 4 });
    env.file('Documents/recipes/desserts/apple-pie.txt', 'Apple pie\n\n6 apples\n1 pie crust\nA pinch of cinnamon\n', { daysAgo: 4 });
  },
  quizStartDir: 'Documents',
  quiz: [
    {
      kind: 'task',
      prompt: "Print the full path of the folder you're in right now.",
      hint: 'The shell calls the folder you are in the *working directory*, and a three-letter command prints it.',
      solution: ['pwd'],
      explain:
        '`pwd` prints the full path of the folder you are in: here, `/home/learner/Documents`, the `Documents` folder inside your home folder. The prompt shows the same place in short, as `~/Documents`.',
      check: any(ran('pwd'), (c) => !!c.ev && c.ev.execs.some((e) => e.argv[0] === 'echo' && e.argv.slice(1).join(' ') === e.cwd)),
    },
    {
      kind: 'task',
      prompt: 'Without leaving this folder, list what is in your home folder.',
      hint: 'Give `ls` the path of your home folder. It has a one-character nickname, too.',
      solution: ['ls ~'],
      explain: '`~` is short for your home folder, `/home/learner`, so `ls ~` and `ls /home/learner` show the same thing from wherever you are.',
      check: listsFolder('~'),
    },
    {
      prompt: 'What is the very top of the Linux folder tree called, and how is it written?',
      options: ['The home folder, written `~`', 'The root, written `/`', 'The C: drive, written `C:\\`', 'The root, written `\\`'],
      answer: 1,
      explain: 'Everything on Linux lives somewhere inside the **root**, `/`. There are no drive letters like `C:`, and paths use forward slashes, not backslashes.',
    },
    {
      kind: 'task',
      prompt: 'System settings live in a folder called `etc`, right below the root. List what is in it.',
      hint: 'A path that starts at the root begins with a `/`.',
      solution: ['ls /etc'],
      explain: '`/etc` is an **absolute path**: it starts at the root, so it works from any folder. The files in it hold the settings of the whole system.',
      check: listsFolder('/etc'),
    },
    {
      kind: 'task',
      prompt: 'The folder you are in contains `recipes`, and `recipes` contains a folder called `desserts`. Without moving, list what is in `desserts`.',
      hint: 'A path can go through several folders, with a `/` between each one and the next.',
      solution: ['ls recipes/desserts'],
      explain:
        '`recipes/desserts` is a **relative path**: it starts from the folder you are in, so from here it means `/home/learner/Documents/recipes/desserts`.',
      check: listsFolder('~/Documents/recipes/desserts'),
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
  quizSetup: (env) => {
    env.file('Music/jazz/1959/kind-of-blue.txt', 'Kind of Blue, by Miles Davis (1959)\n', { daysAgo: 6 });
    env.file('Music/jazz/1965/a-love-supreme.txt', 'A Love Supreme, by John Coltrane (1965)\n', { daysAgo: 6 });
  },
  quizStartDir: 'Music/jazz/1959',
  quiz: [
    {
      kind: 'task',
      prompt: 'You are in `1959`, a folder inside `jazz`, which is inside `Music`. Climb two levels up, to `Music`.',
      hint: '`..` means the folder above, and you can put two of them in one path, with a `/` in between.',
      solution: ['cd ../..'],
      explain: 'Each `..` climbs one level: from `1959` up to `jazz`, then up to `Music`. `cd ../..` does both at once, and running `cd ..` twice gets you there too.',
      check: cwdIs('~/Music'),
    },
    {
      prompt: 'Which of these is an **absolute** path?',
      options: ['`Documents/recipes`', '`../Pictures`', '`recipes`', '`/var/log`'],
      answer: 3,
      explain: "An absolute path starts at the root, so it begins with `/` and works from anywhere. The others are **relative**: they start from the folder you're in now.",
    },
    {
      kind: 'task',
      prompt: 'Jump to the folder `apt`, which is inside `etc`, right below the root.',
      hint: 'Start the path at the root, so that it works from anywhere.',
      solution: ['cd /etc/apt'],
      explain:
        '`/etc/apt` is an **absolute path**: it starts at the root, so it takes you to the same place no matter where you are. This is where `apt`, the program that installs software, keeps its settings.',
      check: cwdIs('/etc/apt'),
    },
    {
      kind: 'task',
      prompt: 'Head straight back to your home folder.',
      hint: 'Your home folder has a one-character nickname, and `cd` knows it.',
      solution: ['cd'],
      explain: '`cd` on its own always takes you home, and so do `cd ~` and `cd /home/learner`.',
      check: cwdIs('~'),
    },
    {
      kind: 'task',
      prompt: 'Go back to the folder you were in just before, without typing its name.',
      hint: '`cd` has a special argument that works like the Back button of a web browser.',
      solution: ['cd -'],
      explain: '`cd -` takes you back to the previous folder and prints where you landed. Run it again and you are back where you started: it switches between the last two folders.',
      check: (c) => !!c.ev && c.ev.status === 0 && c.ev.execs.some((e) => e.argv[0] === 'cd' && (e.argv[1] === '-' || /OLDPWD/.test(c.ev?.line ?? ''))),
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
      explain: '`seed-catalog.txt` is about 7.7K: roughly 7.7 kilobytes. `-h` only changes how sizes are shown.',
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
  quizSetup: (env) => {
    env.file('shed/.spare-key.txt', 'The spare key is under the blue flower pot.\n', { daysAgo: 5 });
    env.file('shed/lawnmower-manual.txt', 'Lawnmower manual\n'.repeat(1500), { daysAgo: 400 });
    env.file('shed/bike-repair.txt', 'Patch the back tire.\nOil the chain.\nPump up both tires.\n', { daysAgo: 45 });
    env.file('shed/paint-colors.txt', 'Fence: forest green\nDoor: sunny yellow\n', { daysAgo: 2 });
    env.dir('shed/toolbox');
  },
  quizStartDir: 'shed',
  quiz: [
    {
      kind: 'task',
      prompt: 'Something in this folder, `shed`, is hidden. Show every file in it, including the hidden ones.',
      hint: 'Hidden files have names that start with a dot. One option makes `ls` show *all* files.',
      solution: ['ls -a'],
      explain: '`ls -a` (*all*) also shows the names that start with a dot, like `.spare-key.txt`, plus `.` (this folder) and `..` (the folder above). `ls -A` does the same without those two.',
      check: listsFolder('~/shed', ['a', 'A']),
    },
    {
      kind: 'task',
      prompt: 'Show a long listing of this folder with sizes that are easy to read, like `25K`, instead of a long number of bytes.',
      hint: 'Add the *human-readable* option to the long listing.',
      solution: ['ls -lh'],
      explain: '`-h` (*human-readable*) writes sizes with K, M or G, so the manual shows up as about 25 kilobytes. It only changes how the sizes are written, not the order.',
      check: listsFolder('~/shed', ['l'], ['h']),
    },
    {
      prompt: 'In this line from `ls -l`, what does `7800` tell you?\n\n```\n-rw-rw-r-- 1 learner learner 7800 Apr  4  2026 seed-catalog.txt\n```',
      options: ['The file has 7800 lines', 'The file is 7800 bytes', 'The file is 7800 kilobytes'],
      answer: 1,
      explain: 'The number just before the date is the size in **bytes**. `ls -lh` would show the same size as `7.7K`.',
    },
    {
      kind: 'task',
      prompt: 'List this folder with the largest file first.',
      hint: 'One option sorts by size. It is a capital letter.',
      solution: ['ls -lS'],
      explain: '`-S` (a capital S) sorts by size, largest first. With `-l` you see the sizes too, so you can check the order.',
      // -r would put the smallest first
      check: all(listsFolder('~/shed', ['S']), not(listsFolder('~/shed', ['r']))),
    },
    {
      kind: 'task',
      prompt: 'Show a long listing of this folder with the oldest file at the top and the newest at the bottom.',
      hint: 'Sorting by time puts the newest first. Then add the option that reverses any order.',
      solution: ['ls -ltr'],
      explain: '`-t` sorts by modification time, newest first, and `-r` reverses the order, so the oldest comes first. The letters can go in any order: `ls -ltr` and `ls -rtl` are the same.',
      check: listsFolder('~/shed', ['l'], ['t'], ['r']),
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
