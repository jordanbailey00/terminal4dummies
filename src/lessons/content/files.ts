// Module 3: Working with files.

import { ROOT_CREDS } from '../../shell/vfs/fs';
import { all, any, cwdIs, fileContains, isDir, isFile, lineMatches, missing, ran } from '../checks';
import type { CheckContext, Lesson, LessonSetupEnv } from '../types';

type Check = (c: CheckContext) => boolean;

const DAY = 86400 * 1000;

/** A binary file such as a photo: `file` recognizes it, but there is no readable text inside. */
function binary(env: LessonSetupEnv, path: string, description: string, size: number, daysAgo = 0): void {
  if (path.includes('/')) env.dir(path.slice(0, path.lastIndexOf('/')));
  const node = env.sys.fs.writeFile(`${env.home}/${path}`, { kind: 'blob', description, payload: null, size }, { cwd: '/', creds: ROOT_CREDS, umask: 0o002 }, { mode: 0o664 });
  node.mode = 0o664;
  node.uid = 1000;
  node.gid = 1000;
  node.mtime = node.atime = env.sys.now() - daysAgo * DAY;
}

const base = (path: string | undefined) => path?.split('/').pop() ?? '';

/** The last command ran ls or echo, and the shell handed it every name in `want`. */
function listed(want: (string | RegExp)[]): Check {
  return (c) =>
    !!c.ev &&
    c.ev.execs.some((e) => {
      if (!['ls', 'echo'].includes(base(e.argv[0]))) return false;
      const names = e.argv.slice(1).map(base);
      return want.every((w) => names.some((n) => (typeof w === 'string' ? n === w : w.test(n))));
    });
}

// ---------------------------------------------------------------------------

const makingThings: Lesson = {
  id: 'making-things',
  title: 'Creating files and folders',
  summary: 'Make folders with mkdir (even several levels deep), create empty files with touch, and handle names that contain spaces.',
  moduleId: 'files',
  minutes: 8,
  intro: `
So far you have only looked around. Time to make something of your own! Two commands do the creating:

| Command | Creates | Example |
| --- | --- | --- |
| \`mkdir\` | a folder (*make directory*) | \`mkdir trip\` |
| \`touch\` | an empty file | \`touch notes.txt\` |

A few things worth knowing about names on Linux:

- Names are **case-sensitive**: \`Trip\`, \`trip\` and \`TRIP\` are three different folders.
- An **extension** like \`.txt\` is simply part of the name. Linux doesn't need it, but it helps you (and some programs) guess what's inside.
- Almost any character is allowed. The big exception is \`/\`, because it separates the folders in a path. Sticking to letters, numbers, \`-\`, \`_\` and \`.\` saves trouble, as you're about to see.

> [!HOW]
> Before it runs anything, the shell chops your line into **words** at every space. The first word is the command and the others become its arguments. So \`touch my notes.txt\` hands \`touch\` two separate names, \`my\` and \`notes.txt\`, and you get two files. To keep a space *inside* a name, wrap the name in quotes (\`"my notes.txt"\`) or put a backslash in front of the space (\`my\\ notes.txt\`).
`,
  steps: [
    {
      id: 'mkdir',
      title: 'Make a folder',
      instruction: 'You\'re planning a trip. Make a folder called `trip` for everything to do with it, then step inside:\n\n`$ mkdir trip`\n\n`$ cd trip`',
      hint: 'Two separate commands: first `mkdir trip`, then `cd trip`. If you see *File exists*, the folder is already there, so just run `cd trip`.',
      solution: ['mkdir trip', 'cd trip'],
      explain:
        "`mkdir` printed nothing at all. In the terminal, **no news is good news**: most commands only speak up when something goes wrong. The prompt now ends in `~/trip`, so you're standing in your new, empty folder.",
      check: cwdIs('~/trip'),
    },
    {
      id: 'mkdir-p',
      title: 'Folders inside folders',
      instruction:
        "You'll want a `photos` folder with a `beach` folder inside it. Try making both in one go:\n\n`$ mkdir photos/beach`\n\nThat fails, because `photos` doesn't exist yet and `mkdir` won't invent it. Add the `-p` option and try again:\n\n`$ mkdir -p photos/beach`",
      hint: 'The option goes between the command and the path, with spaces around it: `mkdir -p photos/beach`.',
      solution: ['mkdir photos/beach', 'mkdir -p photos/beach'],
      explain:
        '`-p` stands for **parents**: it creates every missing folder along the path, so `mkdir -p a/b/c` makes three folders at once. It also stays quiet when a folder already exists, where plain `mkdir` would complain *File exists*.',
      check: isDir('trip/photos/beach'),
    },
    {
      id: 'touch',
      title: 'Create empty files',
      instruction: '`touch` creates empty files, and like most commands it accepts several names at once:\n\n`$ touch packing-list.txt budget.txt`\n\nNow look at them with a long listing:\n\n`$ ls -l`',
      hint: 'Make sure the prompt shows `~/trip`. If it doesn\'t, run `cd ~/trip` first.',
      solution: ['touch packing-list.txt budget.txt', 'ls -l'],
      explain:
        "Both files have a size of **0** bytes: they exist, but there's nothing in them yet. (Officially, `touch` updates a file's *last modified* time. If the file doesn't exist, it creates an empty one, and that's what most people use it for.)",
      check: all(isFile('trip/packing-list.txt'), isFile('trip/budget.txt'), ran('ls', { flags: 'l' })),
    },
    {
      id: 'quotes',
      title: 'A name with a space',
      instruction: 'What if a name needs a space? Put the whole name in quotes:\n\n`$ touch "hotel booking.txt"`\n\nThen list the folder:\n\n`$ ls`',
      hint: "Don't forget the quotes. Without them, `touch` makes two files called `hotel` and `booking.txt`: harmless, but not what you wanted.",
      solution: ['touch "hotel booking.txt"', 'ls'],
      explain:
        "`ls` shows the name as `'hotel booking.txt'`, wrapped in single quotes. Those quotes aren't part of the name: `ls` adds them to warn you that the name contains a space, and to show how you could type it.",
      check: all(isFile('trip/hotel booking.txt'), ran('ls')),
    },
    {
      id: 'backslash',
      title: 'Why spaces are a nuisance',
      instruction:
        'From now on, the space needs protecting every time you use that name. See what happens without protection:\n\n`$ ls hotel booking.txt`\n\n`ls` looks for two files, `hotel` and `booking.txt`, and finds neither. A backslash in front of the space fixes it:\n\n`$ ls hotel\\ booking.txt`',
      hint: 'Even easier: type `ls hot` and press <kbd>Tab</kbd>. The shell completes the name and adds the backslash for you.',
      solution: ['ls hotel booking.txt', 'ls hotel\\ booking.txt'],
      explain:
        'A backslash means *the next character is part of the name, not a separator*. Quotes work just as well: `ls "hotel booking.txt"`. Because spaces need this care every single time, most people avoid them and use dashes or underscores instead: `hotel-booking.txt` or `hotel_booking.txt`. You\'ll still meet spaces in files that come from other programs, so now you know how to handle them.',
      check: ran('ls', { args: ['hotel booking.txt'] }),
    },
    {
      id: 'ls-r',
      title: 'See the whole tree',
      instruction: 'A plain `ls` shows one folder. Add `-R` (a capital R, for *recursive*) to list this folder and every folder inside it:\n\n`$ ls -R`',
      hint: 'It has to be a capital `R`. Lowercase `-r` means something else: *reverse the order*.',
      solution: ['ls -R'],
      explain:
        'Each section starts with a folder\'s path and a colon. `.` means *this folder*, so `./photos` is the photos folder in here and `./photos/beach` is the folder inside that. **Recursive** means *do the same thing inside every folder you find, all the way down*. You\'ll meet it again in `cp -r` and `rm -r`.',
      check: ran('ls', { flags: 'R' }),
    },
  ],
  recap: `
You built a little folder tree from nothing:

- \`mkdir NAME\` makes a folder; \`mkdir -p a/b/c\` makes a whole path of folders at once.
- \`touch NAME...\` makes empty files.
- The shell splits your line at spaces, so a name with a space needs quotes (\`"my file.txt"\`) or a backslash (\`my\\ file.txt\`). <kbd>Tab</kbd> adds the backslash for you.
- \`ls -R\` lists a folder and everything inside it.
`,
  cheatsheet: [
    ['mkdir NAME', 'make a folder'],
    ['mkdir -p a/b/c', 'make nested folders (no error if they exist)'],
    ['touch FILE...', 'create empty files'],
    ['touch "my file.txt"', 'a name with a space, in quotes'],
    ['touch my\\ file.txt', 'the same, with a backslash'],
    ['ls -R', 'list a folder and everything inside it'],
  ],
  realWorld: `
- **macOS:** \`mkdir\`, \`mkdir -p\`, \`touch\` and \`ls -R\` work exactly the same. One difference: Mac disks normally ignore upper and lower case, so \`Trip\` and \`trip\` are the *same* folder there.
- **Windows (PowerShell):** \`mkdir\` works, and it creates any missing parent folders by itself. There is no \`touch\`; use \`New-Item -ItemType File notes.txt\` instead. Windows ignores case in names too. Inside **WSL**, everything works as in this lesson.
`,
};

// ---------------------------------------------------------------------------

const copyMove: Lesson = {
  id: 'copy-move',
  title: 'Copying, moving and renaming',
  summary: 'Copy files and whole folders with cp, move and rename them with mv, and avoid overwriting things by accident.',
  moduleId: 'files',
  minutes: 9,
  setup: (env) => {
    env.file('office/report.txt', 'Quarterly report\n\nSales went up a little.\nCosts went down a little.\nEveryone is cautiously happy.\n', { daysAgo: 6 });
    env.file('office/letter.txt', 'Dear neighbor,\n\nYour cat has moved in with us. She seems very happy here,\nbut we think you might miss her. Please come and collect her.\n\nBest wishes,\nNumber 12\n', { daysAgo: 3 });
    env.file('office/invoice-march.txt', 'Invoice for March\nWindow cleaning: 40.00\nTotal: 40.00\n', { daysAgo: 40 });
    env.file('office/invoice-april.txt', 'Invoice for April\nWindow cleaning: 40.00\nGutter repair: 85.00\nTotal: 125.00\n', { daysAgo: 12 });
    env.file('office/draft.txt', 'Speech for the office party (rough draft)\n\nThank you all for coming.\nThis year was busy, but we did it together.\nThe cake is in the kitchen.\n', { daysAgo: 1 });
    env.dir('office/backup');
    env.file('office/website/index.html', '<!DOCTYPE html>\n<html>\n  <head><title>Our office</title></head>\n  <body><h1>Welcome!</h1></body>\n</html>\n', { daysAgo: 20 });
    env.file('office/website/about.html', '<!DOCTYPE html>\n<html>\n  <body><p>We are a small, friendly office.</p></body>\n</html>\n', { daysAgo: 20 });
    env.file('office/website/css/style.css', 'body { font-family: sans-serif; }\nh1 { color: teal; }\n', { daysAgo: 20 });
  },
  startDir: 'office',
  intro: `
Two commands do all the copying, moving and renaming:

| Command | Does | Afterwards |
| --- | --- | --- |
| \`cp\` (*copy*) | copies a file or folder | two: the original and the copy |
| \`mv\` (*move*) | moves or renames a file or folder | still one, with a new name or in a new place |

Both follow the same pattern: **source first, destination last**, like a sentence: *copy this to there*.

\`\`\`
cp  report.txt  report-backup.txt
│   │           └── destination: the new name (or a folder to put it in)
│   └── source: what to copy
└── command
\`\`\`

> [!HOW]
> A folder is really a list of names, each pointing to the place on the disk where that file's data is stored. \`cp\` reads all the data and writes a second copy, so big files take a while. \`mv\` within the same disk only adds the name to the new folder's list and removes it from the old one. The data itself never moves, which is why moving even a huge file is instant.

> [!WARNING]
> If the destination is an existing file, \`cp\` and \`mv\` **replace it without asking**. You'll learn the safety option for that at the end of this lesson.
`,
  steps: [
    {
      id: 'cp',
      title: 'Make a copy',
      instruction: 'You\'re in a folder called `office`. Before editing the report, make a backup copy of it:\n\n`$ cp report.txt report-backup.txt`',
      hint: 'Use <kbd>Tab</kbd> to complete `report.txt`, then type the new name yourself.',
      solution: ['cp report.txt report-backup.txt'],
      explain: 'Run `$ ls` and you\'ll see both: the original, untouched, and next to it an identical copy with the new name. `cp` creates the destination file if it doesn\'t exist yet.',
      check: all(isFile('office/report.txt'), fileContains('office/report-backup.txt', 'Quarterly report')),
    },
    {
      id: 'cp-into',
      title: 'Copy into a folder',
      instruction: 'If the destination is a **folder**, `cp` puts the copy inside it and keeps the name:\n\n`$ cp letter.txt backup/`',
      hint: 'Type `cp let` and press <kbd>Tab</kbd> to complete the name, then add a space and `backup/`.',
      solution: ['cp letter.txt backup/'],
      explain:
        "`$ ls backup` shows the copy in its new home. The slash at the end of `backup/` is optional, but it's a good habit: it says *I mean a folder*. If you mistype the folder name, `cp` stops with an error instead of quietly creating a file called, say, `bakcup`. To copy something from elsewhere into the folder you're in, use `.` (*here*) as the destination: `cp ~/Documents/todo.txt .`",
      check: all(isFile('office/backup/letter.txt'), isFile('office/letter.txt')),
    },
    {
      id: 'cp-many',
      title: 'Copy several files at once',
      instruction: 'List as many files as you like, and put the folder **last**:\n\n`$ cp invoice-march.txt invoice-april.txt backup/`',
      hint: 'Type `cp inv` and press <kbd>Tab</kbd> twice to see both invoice names.',
      solution: ['cp invoice-march.txt invoice-april.txt backup/'],
      explain: 'With more than two names, `cp` treats the last one as the destination folder and copies everything before it into it. If that last name isn\'t a folder, `cp` refuses with an error.',
      check: all(isFile('office/backup/invoice-march.txt'), isFile('office/backup/invoice-april.txt')),
    },
    {
      id: 'cp-r',
      title: 'Copy a whole folder',
      instruction:
        'Folders need one extra option. Try copying the `website` folder:\n\n`$ cp website website-old`\n\n`cp` refuses (*-r not specified; omitting directory*). Add `-r` to copy the folder together with everything inside it:\n\n`$ cp -r website website-old`',
      hint: 'The option goes straight after the command: `cp -r website website-old`.',
      solution: ['cp website website-old', 'cp -r website website-old'],
      explain: '`-r` means **recursive**: copy the folder, everything in it, everything in the folders inside it, and so on all the way down. See the complete copy with `$ ls -R website-old`.',
      check: all(isFile('office/website-old/index.html'), isFile('office/website-old/css/style.css')),
    },
    {
      id: 'mv-rename',
      title: 'Rename a file',
      instruction: "In the terminal, renaming means *moving a file to a new name*, so it's done with `mv`. The draft is finished; give it a better name:\n\n`$ mv draft.txt speech.txt`",
      hint: 'Old name first, new name second: `mv draft.txt speech.txt`.',
      solution: ['mv draft.txt speech.txt'],
      explain: "Unlike `cp`, `mv` leaves nothing behind: `draft.txt` is gone, and `speech.txt` has taken its place with the same contents. Renaming a folder works exactly the same way, and needs no `-r`.",
      check: all(missing('office/draft.txt'), isFile('office/speech.txt')),
    },
    {
      id: 'mv-into',
      title: 'Move into a folder',
      instruction: 'Give `mv` a folder as the destination and the file moves there. Tidy away the report backup:\n\n`$ mv report-backup.txt backup/`',
      hint: 'The file comes first and the folder last. If you see *No such file or directory*, run `ls`: the copy called `report-backup.txt` was made in the first step.',
      solution: ['mv report-backup.txt backup/'],
      explain:
        "Compare `$ ls` and `$ ls backup`: the file left this folder and arrived in `backup`. Just like `cp`, `mv` can take several names at once, as long as the folder comes last: `mv a.txt b.txt backup/`.",
      check: all(isFile('office/backup/report-backup.txt'), missing('office/report-backup.txt')),
    },
    {
      id: 'cp-i',
      title: 'Ask before overwriting',
      instruction:
        '`backup` already holds a copy of `letter.txt`. Copying it again would silently replace that copy. Add `-i` (*interactive*) and `cp` asks first:\n\n`$ cp -i letter.txt backup/`\n\nWhen it asks *overwrite \'backup/letter.txt\'?*, type `n` and press <kbd>Enter</kbd> to keep the existing copy (`y` would replace it).',
      hint: 'If nothing seems to happen, look at the terminal: `cp` is waiting for your answer. Type `n` and press Enter.',
      solution: ['cp -i letter.txt backup/', { keys: 'n\r', label: 'Type n and press Enter to keep the old copy' }],
      explain:
        "`mv -i` works the same way. Without `-i`, `cp` and `mv` never ask, and the old version is gone for good. That's why some people make `-i` the default with an *alias*, which you'll learn about later.",
      check: any(ran('cp', { flags: 'i' }), ran('mv', { flags: 'i' })),
    },
  ],
  recap: `
- \`cp SOURCE DESTINATION\` copies; \`cp FILE... FOLDER/\` copies files into a folder; \`cp -r\` copies whole folders.
- \`mv OLD NEW\` renames; \`mv FILE... FOLDER/\` moves things into a folder. Folders move without \`-r\`.
- The destination always comes **last**.
- Both replace existing files **without asking**. Add \`-i\` to be asked first.
`,
  cheatsheet: [
    ['cp FILE COPY', 'copy a file to a new name'],
    ['cp FILE... FOLDER/', 'copy files into a folder'],
    ['cp FILE .', 'copy a file into the current folder'],
    ['cp -r FOLDER COPY', 'copy a folder and everything in it'],
    ['mv OLD NEW', 'rename a file or folder'],
    ['mv FILE... FOLDER/', 'move into a folder'],
    ['cp -i / mv -i', 'ask before overwriting'],
  ],
  realWorld: `
- **macOS:** \`cp\`, \`mv\`, \`-r\` and \`-i\` behave the same, with one trap: \`cp -r photos/ backup\` (with a slash after the *source*) copies only what's *inside* \`photos\`, not the folder itself. On Linux that slash makes no difference.
- **Windows (PowerShell):** \`cp\` and \`mv\` are nicknames for \`Copy-Item\` and \`Move-Item\`. Simple copies and moves work the same way, but most of the other options are different.
`,
};

// ---------------------------------------------------------------------------

const deleting: Lesson = {
  id: 'deleting',
  title: 'Deleting safely',
  summary: 'Remove files and folders with rm and rmdir, learn the options that ask before deleting, and why there is no undo.',
  moduleId: 'files',
  minutes: 8,
  setup: (env) => {
    env.file('attic/junk.txt', 'Nothing important in here. Honestly.\n', { daysAgo: 400 });
    env.dir('attic/empty-box');
    env.file('attic/old-games/chess-notes.txt', 'Always castle early.\nNever trust a quiet bishop.\n', { daysAgo: 900 });
    env.file('attic/old-games/crossword.txt', '1 across: a terminal command that lists files (2)\n', { daysAgo: 900 });
    env.file('attic/old-games/high-scores/2019.txt', 'Space Invaders: 12040\n', { daysAgo: 1500 });
    env.file('attic/old-games/high-scores/2020.txt', 'Space Invaders: 15210\n', { daysAgo: 1200 });
    env.file('attic/receipts-2019.txt', 'Lamp: 25.00\nRug: 60.00\n', { daysAgo: 1700 });
    env.file('attic/receipts-2024.txt', 'Washing machine: 450.00 (2-year warranty)\n', { daysAgo: 300 });
  },
  startDir: 'attic',
  intro: `
Deleting needs only two commands, \`rm\` and \`rmdir\`:

| Command | Deletes |
| --- | --- |
| \`rm FILE...\` | files (*remove*) |
| \`rmdir FOLDER\` | empty folders only |
| \`rm -r FOLDER\` | a folder and **everything** inside it |

> [!HOW]
> In a graphical file manager, *delete* usually moves things to the Trash, where you can rescue them later. \`rm\` doesn't. It removes the file's name from its folder, and the computer marks the space the file used as free, ready to be reused later. There's no Trash folder and no undo.

> [!CAUTION]
> \`rm\` never asks *Are you sure?* unless you tell it to. Before pressing <kbd>Enter</kbd> on any \`rm\`, and especially one with \`-r\`, \`-f\` or a wildcard like \`*\` (coming in the next lesson), read the line once more and check where you are with \`pwd\`. A single stray space turns \`rm *.txt\` (delete the text files) into \`rm * .txt\` (delete **every** file here).
`,
  steps: [
    {
      id: 'rm',
      title: 'Delete a file',
      instruction: "You're clearing out the attic. Start with something nobody will miss:\n\n`$ rm junk.txt`",
      hint: 'Run `ls` first if you want to see everything in the attic.',
      solution: ['rm junk.txt'],
      explain:
        "No question, no confirmation, no Trash: `junk.txt` is simply gone, as `$ ls` will show you. `rm` accepts several names at once (`rm a.txt b.txt`), and deletes them all just as quietly. That's why the rest of this lesson is about deleting **carefully**.",
      check: missing('attic/junk.txt'),
    },
    {
      id: 'rmdir',
      title: 'Remove an empty folder',
      instruction: 'Plain `rm` refuses to delete folders. For an **empty** folder, use `rmdir` (*remove directory*):\n\n`$ rmdir empty-box`',
      hint: 'The folder is called `empty-box`; <kbd>Tab</kbd> can complete it for you.',
      solution: ['rmdir empty-box'],
      explain: '`rmdir` only ever deletes empty folders, and that\'s a feature: it can never take any files with it.',
      check: missing('attic/empty-box'),
    },
    {
      id: 'rm-r',
      title: 'Delete a folder and its contents',
      instruction:
        "The `old-games` folder isn't empty. See what `rmdir` says:\n\n`$ rmdir old-games`\n\nTo delete a folder *with* everything inside it, use `rm -r`. Look inside first, so you know exactly what you're about to lose:\n\n`$ ls -R old-games`\n\n`$ rm -r old-games`",
      hint: '`-r` (*recursive*) goes between `rm` and the folder name: `rm -r old-games`.',
      solution: ['rmdir old-games', 'ls -R old-games', 'rm -r old-games'],
      explain:
        '`rm -r` deleted the folder, the folder inside it and every file in them, in one go and without a single question. Looking before you delete (`ls`, or `ls -R` for a whole tree) is the habit that protects you.',
      check: missing('attic/old-games'),
    },
    {
      id: 'rm-i',
      title: 'Ask before each file',
      instruction:
        "When you're not completely sure, add `-i` (*interactive*) and `rm` asks before each file. The 2019 receipts can go, but the 2024 ones are still needed for the washing machine warranty:\n\n`$ rm -i receipts-2019.txt receipts-2024.txt`\n\nAnswer `y` (and <kbd>Enter</kbd>) for the 2019 file, and `n` (and <kbd>Enter</kbd>) for the 2024 one.",
      hint: '`rm` waits for an answer after each question. Type `y` or `n`, then press Enter.',
      solution: [
        'rm -i receipts-2019.txt receipts-2024.txt',
        { keys: 'y\r', label: 'Type y and press Enter to delete receipts-2019.txt' },
        { keys: 'n\r', label: 'Type n and press Enter to keep receipts-2024.txt' },
      ],
      explain:
        'An answer starting with `y` means yes; anything else, even a plain <kbd>Enter</kbd>, means no. `-i` also works with `-r`: `rm -ri FOLDER` asks about every file and folder inside. For bigger jobs, `-I` (a capital i) asks just once: before deleting more than three files, or before a recursive delete.',
      check: ran('rm', { flags: 'i' }),
    },
    {
      id: 'rm-f',
      title: 'What -f really means',
      instruction:
        "Instructions online often say `rm -rf`. The `f` stands for **force**. Compare these two, for a file that doesn't exist:\n\n`$ rm ghost.txt`\n\n`$ rm -f ghost.txt`",
      hint: 'The option goes between `rm` and the name: `rm -f ghost.txt`. Silence is the expected result!',
      solution: ['rm ghost.txt', 'rm -f ghost.txt'],
      explain:
        'The first one complains that `ghost.txt` doesn\'t exist; the second says nothing at all. `-f` hides those errors **and** skips every question. Together with `-r`, nothing stands between you and the delete: `rm -rf FOLDER` wipes out a whole tree without a word. Scripts use it on purpose. When you type it yourself, slow down and re-read the line first.',
      check: ran('rm', { flags: 'f' }),
    },
  ],
  recap: `
- \`rm FILE...\` deletes files, immediately and for good.
- \`rmdir FOLDER\` deletes empty folders; \`rm -r FOLDER\` deletes a folder and everything in it.
- \`-i\` asks before each deletion; \`-f\` never asks and hides errors.
- Look before you delete (\`ls\`, \`pwd\`), and re-read every \`rm\` before pressing Enter.
`,
  cheatsheet: [
    ['rm FILE...', 'delete files (no undo!)'],
    ['rmdir FOLDER', 'delete an empty folder'],
    ['rm -r FOLDER', 'delete a folder and everything in it'],
    ['rm -i FILE...', 'ask before each file'],
    ['rm -I FILE...', 'ask once before deleting many'],
    ['rm -f FILE', "never ask, no error if it's missing"],
  ],
  realWorld: `
- **Ubuntu desktop:** \`gio trash FILE\` moves a file to the Trash instead of deleting it, so you can still restore it from the Files app.
- **macOS:** \`rm\`, \`rmdir\` and \`rm -r\` work the same way, and they skip the Trash too.
- **Windows (PowerShell):** \`rm\` is a nickname for \`Remove-Item\`; for a folder with things in it, add \`-Recurse\`. It doesn't use the Recycle Bin either.
- Everywhere, the real safety net is a **backup**. Deleted files are only truly safe if a copy lives somewhere else.
`,
};

// ---------------------------------------------------------------------------

const PHOTOS = ['day1.jpg', 'day2.jpg', 'day3.jpg', 'day4.jpg', 'day10.jpg', 'day11.jpg'];
const TEMP_FILES = ['upload1.tmp', 'upload2.tmp', 'thumbs.tmp'];

const wildcards: Lesson = {
  id: 'wildcards',
  title: 'Wildcards: many files at once',
  summary: 'Select many files with patterns like *.jpg, preview what they match, and create many names at once with braces.',
  moduleId: 'files',
  minutes: 10,
  setup: (env) => {
    PHOTOS.forEach((name, i) => {
      binary(env, `camera/${name}`, `JPEG image data, JFIF standard 1.01, resolution (DPI), density 72x72, segment length 16, baseline, precision 8, 4032x3024, components 3`, 2_400_000 + i * 131_071, 14 - i);
    });
    binary(env, 'camera/map.png', 'PNG image data, 1200 x 800, 8-bit/color RGB, non-interlaced', 318_442, 15);
    env.file('camera/notes.txt', 'Day 1: arrived late, ate pizza.\nDay 2: beach.\nDay 3: more beach.\n', { daysAgo: 8 });
    env.file('camera/budget.txt', 'Hotel: 300\nFood: 150\nIce cream: too much\n', { daysAgo: 8 });
    for (const name of TEMP_FILES) env.file(`camera/${name}`, '', { daysAgo: 2 });
  },
  startDir: 'camera',
  intro: `
Typing every file name gets old fast. **Wildcards** are patterns that match many names at once:

| Pattern | Matches | Example |
| --- | --- | --- |
| \`*\` | any characters, any number of them (even none) | \`*.jpg\`: every name ending in .jpg |
| \`?\` | exactly one character | \`day?.jpg\`: day1.jpg, but not day10.jpg |
| \`[abc]\` | one character from the list | \`day[13].jpg\`: day1.jpg and day3.jpg |
| \`[1-5]\`, \`[a-z]\` | one character from a range | \`day[1-3].jpg\`: day1.jpg to day3.jpg |

> [!HOW]
> Wildcards are handled by the **shell**, not by the command. Before your line runs, bash replaces each pattern with the matching names, in alphabetical order. \`rm *.tmp\` becomes \`rm thumbs.tmp upload1.tmp upload2.tmp\`, and \`rm\` never even sees the \`*\`. That's why wildcards work with *every* command, and why \`echo\` can show you exactly what a pattern turns into before you use it for real.

> [!NOTE]
> Wildcards skip hidden files (names that start with a dot), unless the pattern itself starts with a dot. And when nothing matches, bash leaves the pattern as it is, so \`ls *.gif\` complains that there's no file called \`*.gif\`.
`,
  steps: [
    {
      id: 'star',
      title: 'Match anything with *',
      instruction: "This is your camera folder after a trip, and it's a mess. Run `$ ls` to see everything, then list only the JPEG photos:\n\n`$ ls *.jpg`",
      hint: 'There is no space between `*` and `.jpg`. The pattern means *anything, followed by .jpg*.',
      solution: ['ls', 'ls *.jpg'],
      explain:
        "`*` matches **any characters, any number of them**. The shell swapped `*.jpg` for the six matching names before `ls` even started, so `ls` simply received a list of six files. (`ls day*` would have found the same six.)",
      check: all(lineMatches(/\*/), listed(PHOTOS)),
    },
    {
      id: 'question',
      title: 'Exactly one character with ?',
      instruction: "`?` stands for exactly **one** character:\n\n`$ ls day?.jpg`\n\nIt finds `day1.jpg` to `day4.jpg`, but not `day10.jpg` or `day11.jpg`: they have two characters where the `?` is.",
      hint: 'Put a question mark exactly where the changing character is: `day?.jpg`.',
      solution: ['ls day?.jpg'],
      explain: 'And `day??.jpg` (two question marks) would match exactly the two-digit days. `?` is handy whenever names follow a fixed pattern.',
      check: all(lineMatches(/\?/), listed([/^day\d+\.jpg$/])),
    },
    {
      id: 'brackets',
      title: 'Choose characters with [ ]',
      instruction: 'Square brackets match **one character from a list**. `[13]` means *1 or 3*:\n\n`$ ls day[13].jpg`\n\nWith a dash inside, the list becomes a **range**: `[1-3]` means *anything from 1 to 3*:\n\n`$ ls day[1-3].jpg`',
      hint: 'The range goes inside the square brackets, with a dash: `day[1-3].jpg`.',
      solution: ['ls day[13].jpg', 'ls day[1-3].jpg'],
      explain: 'Ranges work with letters too: `[a-c]*` matches every name starting with a, b or c. Just like `?`, a bracket always stands for exactly **one** character.',
      check: all(lineMatches(/\[[^\]]*-[^\]]*\]/), listed([/^day\d+\.jpg$/])),
    },
    {
      id: 'move-photos',
      title: 'Move all the photos at once',
      instruction: 'Now let a wildcard do some real work. Make a folder, then move every JPEG into it with a single command:\n\n`$ mkdir photos`\n\n`$ mv *.jpg photos/`',
      hint: 'Make the folder first, then move the photos into it with `mv *.jpg photos/`. If `mkdir` says *File exists*, the folder is already there.',
      solution: ['mkdir photos', 'mv *.jpg photos/'],
      explain: 'Check with `$ ls photos`: six files moved with one short command, and it would work just the same for six hundred. Since the shell expands wildcards, they work with `cp`, `mv`, `rm`, `cat` and every other command.',
      check: all(...PHOTOS.map((n) => isFile(`camera/photos/${n}`)), ...PHOTOS.map((n) => missing(`camera/${n}`))),
    },
    {
      id: 'delete-tmp',
      title: 'Preview, then delete',
      instruction:
        "The `.tmp` files are leftovers. Before deleting anything with a wildcard, **preview** the match. `echo` just prints whatever it's given, so it shows exactly the list the shell would hand to `rm`:\n\n`$ echo *.tmp`\n\nHappy with that list? Then delete them:\n\n`$ rm *.tmp`",
      hint: 'Use exactly the pattern you previewed. If you like, press <kbd>↑</kbd> to bring back the `echo` line, jump to its start with <kbd>Ctrl</kbd>+<kbd>A</kbd>, and replace `echo` with `rm`.',
      solution: ['echo *.tmp', 'rm *.tmp'],
      explain: "Previewing costs a second and can save your day: if the list looks wrong, nothing has been deleted yet. `ls *.tmp` works as a preview too. Remember the warning from the last lesson: `rm *.tmp` and `rm * .tmp` are very different commands.",
      check: all(...TEMP_FILES.map((n) => missing(`camera/${n}`))),
    },
    {
      id: 'braces',
      title: 'Many folders at once with { }',
      instruction:
        "Curly braces are a different trick. Instead of matching existing files, they **generate** names from a comma-separated list. Preview first:\n\n`$ echo app/{src,docs,tests}`\n\nThen create all three folders in one go:\n\n`$ mkdir -p app/{src,docs,tests}`",
      hint: 'No spaces inside the braces: `{src,docs,tests}`. With spaces, the shell would split it into separate words and the braces would stay as they are.',
      solution: ['echo app/{src,docs,tests}', 'mkdir -p app/{src,docs,tests}'],
      explain:
        'The shell turned `app/{src,docs,tests}` into `app/src app/docs app/tests` before `mkdir` ran. Braces can count, too: `echo {1..5}` prints `1 2 3 4 5`, and `touch day{1..3}.txt` creates three files. Look at your work with `$ ls -R app`.',
      check: all(isDir('camera/app/src'), isDir('camera/app/docs'), isDir('camera/app/tests')),
    },
    {
      id: 'quotes',
      title: 'Turn wildcards off with quotes',
      instruction: "Sometimes you need a real `*`. Ask the shell a sum:\n\n`$ echo 5 * 3`\n\nThe `*` was replaced by the names of the files here! Quotes switch wildcards off:\n\n`$ echo '5 * 3'`",
      hint: "Wrap the whole sum in single quotes: `echo '5 * 3'`.",
      solution: ['echo 5 * 3', "echo '5 * 3'"],
      explain:
        "Inside single quotes the shell leaves **everything** alone, wildcards included. Double quotes also stop wildcards (while still allowing a few special things like `$HOME`), and a backslash protects a single character: `echo 5 \\* 3`. You'll use quotes whenever a pattern is meant for the command itself rather than for the shell.",
      check: all(lineMatches(/['"\\]/), (c) => !!c.ev && c.ev.execs.some((e) => base(e.argv[0]) === 'echo' && e.argv.slice(1).some((a) => a.includes('*')))),
    },
  ],
  recap: `
- \`*\` matches anything, \`?\` exactly one character, \`[abc]\` and \`[a-z]\` one character from a list or range.
- The **shell** expands wildcards before the command runs, so they work with every command.
- Preview with \`echo\` or \`ls\` before using a wildcard with \`rm\` or \`mv\`.
- Braces generate names: \`mkdir -p app/{src,docs,tests}\`, \`echo {1..5}\`.
- Quotes (or a backslash) turn wildcards off.
`,
  cheatsheet: [
    ['ls *.jpg', 'everything ending in .jpg'],
    ['ls day?.jpg', 'day + one character + .jpg'],
    ['ls day[1-3].jpg', 'day1.jpg, day2.jpg, day3.jpg'],
    ['echo *.tmp', 'preview what a pattern matches'],
    ['mv *.jpg photos/', 'move all matching files'],
    ['mkdir -p app/{src,docs}', 'brace expansion: generate names'],
    ["echo '5 * 3'", 'quotes: no wildcard expansion'],
  ],
  realWorld: `
- **macOS (zsh):** wildcards and braces work the same, with one difference: when a pattern matches nothing, zsh stops with *no matches found* instead of passing the pattern on to the command.
- **Windows:** in PowerShell and the Command Prompt, each command handles \`*\` and \`?\` itself, so they mostly work (\`Remove-Item *.tmp\`), but brace expansion doesn't exist.
`,
};

export const filesLessons: Lesson[] = [makingThings, copyMove, deleting, wildcards];
