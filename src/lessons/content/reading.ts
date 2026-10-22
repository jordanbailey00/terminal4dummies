// Module 4: Reading and writing.

import type { ExecEvent } from '../../shell/system';
import { ROOT_CREDS } from '../../shell/vfs/fs';
import { all, any, everRan, fileContains, fileLineCount, fileText, flagsOf, not, outputIncludes, ran } from '../checks';
import type { CheckContext, Lesson, LessonSetupEnv } from '../types';

type Check = (c: CheckContext) => boolean;

/** A binary file such as a picture: `file` recognizes it, but there is no readable text inside. */
function binary(env: LessonSetupEnv, path: string, description: string, size: number): void {
  if (path.includes('/')) env.dir(path.slice(0, path.lastIndexOf('/')));
  const node = env.sys.fs.writeFile(`${env.home}/${path}`, { kind: 'blob', description, payload: null, size }, { cwd: '/', creds: ROOT_CREDS, umask: 0o002 }, { mode: 0o664 });
  node.mode = 0o664;
  node.uid = 1000;
  node.gid = 1000;
}

const base = (path: string | undefined) => path?.split('/').pop() ?? '';

/** The last command ran `cmd` on a matching file, choosing how many lines (-n 5, -5, --lines=5). */
function withCount(cmd: string, file: RegExp): Check {
  return (c) =>
    !!c.ev &&
    file.test(c.ev.line) &&
    c.ev.execs.some((e) => base(e.argv[0]) === cmd && (flagsOf(e).has('n') || e.argv.some((a) => /^-\d+$/.test(a))));
}

/** Some command line in this lesson matched (useful for redirections, which never reach the command). */
function everLine(re: RegExp): Check {
  return (c) => c.commands.some((ev) => re.test(ev.line));
}

/** The non-blank lines of a file, trimmed (null if it doesn't exist). */
function linesOf(c: CheckContext, path: string): string[] | null {
  const t = fileText(c, path);
  return t === null ? null : t.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** The last command printed every one of `want` and none of `unwanted`. */
function showsOnly(c: CheckContext, want: string[], unwanted: string[]): boolean {
  if (!c.ev) return false;
  const out = c.ev.output;
  return want.every((l) => out.includes(l)) && !unwanted.some((l) => out.includes(l));
}

/** Two lists of lines are the same, ignoring extra spaces. */
function sameLines(a: string[] | null, b: string[]): boolean {
  const norm = (l: string) => l.replace(/\s+/g, ' ').trim();
  return !!a && a.length === b.length && a.every((l, i) => norm(l) === norm(b[i]));
}

/** A command that counts lines, or shows line numbers. */
function countsLines(e: ExecEvent): boolean {
  const cmd = base(e.argv[0]);
  const f = flagsOf(e);
  return cmd === 'wc' || cmd === 'nl' || (cmd === 'grep' && f.has('c')) || (cmd === 'cat' && (f.has('n') || f.has('b')));
}

// ---------------------------------------------------------------------------

const POEM = `The Patient Prompt

A blinking cursor, small and bright,
sits waiting at the edge of night.
I type a word and press the key;
the screen writes back a line to me.

No buttons here, no menus wide,
just quiet text with power inside.
And when I stumble, spell it wrong,
it shrugs, and waits, and plays along.
`;

function captainsLog(): string {
  const weather = ['Calm sea', 'Light rain', 'Fresh wind from the west', 'Thick fog until noon', 'Bright sunshine', 'Choppy waves', 'Gray skies', 'A gentle breeze', 'Heavy swell', 'Clear and cold'];
  const events = [
    'The cook burned the porridge again.',
    'We mended a torn sail.',
    'Dolphins swam beside the ship all afternoon.',
    'The crew sang until midnight.',
    'Counted the water barrels: plenty left.',
    'A seagull stole a cookie from the cook.',
    'Nothing happened. Lovely.',
    'We polished the brass bell.',
    "The ship's cat caught a fish.",
    'Played cards in the galley after supper.',
    'Scrubbed the deck from bow to stern.',
    'Spotted a whale far to the north.',
    'Checked our course with the compass, twice.',
  ];
  const special: Record<number, string> = {
    1: 'Left the harbor at dawn. Half the town came to wave.',
    41: 'Land ho! We spotted an island with three palm trees.',
    42: 'Went ashore on the island and filled every barrel with fresh water.',
    50: 'Halfway there, says the navigator. Cake for everyone.',
    100: 'Home at last. The harbor looks smaller than I remember.',
  };
  const lines = ['The Log of the Good Ship Marigold', ''];
  for (let d = 1; d <= 100; d++) {
    lines.push(`Day ${d}: ${special[d] ?? `${weather[(d * 7) % weather.length]}. ${events[(d * 5) % events.length]}`}`);
  }
  return lines.join('\n') + '\n';
}

/** The quiz's loans log: one line per borrowed or returned book, oldest first. */
const LOANS = (() => {
  const titles = ['Moby-Dick', 'Emma', 'Dracula', 'Heidi', 'Jane Eyre', 'Peter Pan', 'Little Women', 'Treasure Island', 'The Time Machine', 'Black Beauty', 'Kidnapped'];
  const names = ['Ana', 'Ben', 'Chloe', 'Dev', 'Ella', 'Finn', 'Grace', 'Hugo', 'Ivy', 'Jonas', 'Kofi', 'Lena', 'Mo'];
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) {
    const day = String(6 + Math.floor(i / 2)).padStart(2, '0');
    const time = i % 2 === 0 ? '10:15' : '16:40';
    lines.push(`2026-10-${day} ${time}  ${names[(i * 5) % names.length]} ${i % 3 === 2 ? 'returned' : 'borrowed'} ${titles[(i * 4) % titles.length]}`);
  }
  return lines;
})();

const CATALOG_HEADER = 'title,author,year';

const CATALOG_ROWS = [
  'Pride and Prejudice,Jane Austen,1813',
  'Frankenstein,Mary Shelley,1818',
  'Moby-Dick,Herman Melville,1851',
  'Jane Eyre,Charlotte Bronte,1847',
  'Wuthering Heights,Emily Bronte,1847',
  'Little Women,Louisa May Alcott,1868',
  'Great Expectations,Charles Dickens,1861',
  'A Tale of Two Cities,Charles Dickens,1859',
  "Alice's Adventures in Wonderland,Lewis Carroll,1865",
  'The Adventures of Tom Sawyer,Mark Twain,1876',
  'Treasure Island,Robert Louis Stevenson,1883',
  'Heidi,Johanna Spyri,1881',
  'Dracula,Bram Stoker,1897',
  'The Time Machine,H. G. Wells,1895',
  'The War of the Worlds,H. G. Wells,1898',
  'The Wonderful Wizard of Oz,L. Frank Baum,1900',
  'Peter Pan,J. M. Barrie,1911',
  'The Secret Garden,Frances Hodgson Burnett,1911',
  'Anne of Green Gables,L. M. Montgomery,1908',
  'The Wind in the Willows,Kenneth Grahame,1908',
  'Black Beauty,Anna Sewell,1877',
  'Robinson Crusoe,Daniel Defoe,1719',
  "Gulliver's Travels,Jonathan Swift,1726",
  'Emma,Jane Austen,1815',
  'Sense and Sensibility,Jane Austen,1811',
  'The Jungle Book,Rudyard Kipling,1894',
  'Around the World in Eighty Days,Jules Verne,1872',
  'Twenty Thousand Leagues Under the Seas,Jules Verne,1870',
  'The Call of the Wild,Jack London,1903',
  'Kidnapped,Robert Louis Stevenson,1886',
];

const CATALOG_LINES = CATALOG_ROWS.length + 1;

const readingFiles: Lesson = {
  id: 'reading-files',
  title: 'Peeking inside files',
  summary: 'Print files with cat, look at just the start or end with head and tail, scroll through long ones with less, count lines and identify file types.',
  moduleId: 'reading',
  minutes: 9,
  setup: (env) => {
    env.file('library/poem.txt', POEM, { daysAgo: 30 });
    env.file('library/captains-log.txt', captainsLog(), { daysAgo: 90 });
    binary(env, 'library/mystery', 'PNG image data, 800 x 600, 8-bit/color RGBA, non-interlaced', 183_406);
  },
  startDir: 'library',
  intro: `
There are several ways to look inside a text file without opening an editor. Which one to use depends mostly on how long the file is:

| Command | Shows | Best for |
| --- | --- | --- |
| \`cat\` | the whole file at once | short files |
| \`head\` | the first 10 lines | a quick look at the start |
| \`tail\` | the last 10 lines | the newest entries of a log |
| \`less\` | one screenful at a time | long files |
| \`wc\` | how many lines, words and bytes | measuring a file |
| \`file\` | what kind of data a file holds | mystery files |

None of them change the file in any way: they only read it. So go ahead and look at anything you like.

> [!HOW]
> \`less\` reads only as much of a file as it needs to fill the screen, and fetches more as you scroll. That's why it opens even a gigantic log file instantly, while \`cat\` would pour the whole thing through your terminal.

> [!NOTE]
> These commands are made for **text** files. Photos, music and PDFs are stored as *binary* data, which looks like gibberish when printed. \`file\` tells you which kind you're dealing with.
`,
  steps: [
    {
      id: 'cat',
      title: 'Print a whole file',
      instruction: "You're in a folder called `library`. Print the short poem in it:\n\n`$ cat poem.txt`",
      hint: 'Type `cat po` and press <kbd>Tab</kbd> to complete the file name.',
      solution: ['cat poem.txt'],
      explain:
        "`cat` is short for *concatenate*, which means *chain together*: give it several files (`cat a.txt b.txt`) and it prints them one after another. For a short file like this one it's perfect. For a long file, the beginning would scroll off the top of the screen.",
      check: ran('cat', { args: [/(^|\/)poem\.txt$/] }),
    },
    {
      id: 'cat-n',
      title: 'Number the lines',
      instruction: 'Add `-n` to number every line:\n\n`$ cat -n poem.txt`',
      hint: 'The option goes between the command and the file name: `cat -n poem.txt`.',
      solution: ['cat -n poem.txt'],
      explain: 'Numbers make it easy to talk about *line 7*. Blank lines get a number too; `cat -b` numbers only the lines that have text on them.',
      check: any(ran('cat', { flags: 'n' }), ran('cat', { flags: 'b' })),
    },
    {
      id: 'head',
      title: 'Just the beginning',
      instruction:
        "The ship's log is much longer. `head` shows just the first 10 lines:\n\n`$ head captains-log.txt`\n\nAdd `-n` and a number to choose how many:\n\n`$ head -n 5 captains-log.txt`",
      hint: 'There\'s a space on both sides of the number: `head -n 5 captains-log.txt`. Type `cap` and press <kbd>Tab</kbd> to complete the name.',
      solution: ['head captains-log.txt', 'head -n 5 captains-log.txt'],
      explain: 'Perfect for a quick look at what a file is about, like the column names at the top of a spreadsheet file. You may also see the short form `head -5`, which means the same.',
      check: withCount('head', /captains-log\.txt/),
    },
    {
      id: 'tail',
      title: 'Just the end',
      instruction: '`tail` is the opposite: it shows the **last** lines. How did the voyage end?\n\n`$ tail -n 3 captains-log.txt`',
      hint: 'It works just like `head`: `tail -n 3 captains-log.txt`.',
      solution: ['tail -n 3 captains-log.txt'],
      explain:
        "`tail` is the go-to tool for log files, where the newest entries are always at the bottom. `tail -f FILE` goes one better: it keeps watching the file and prints new lines as they're added, until you press <kbd>Ctrl</kbd>+<kbd>C</kbd>.",
      check: withCount('tail', /captains-log\.txt/),
    },
    {
      id: 'less',
      title: 'Scroll through a long file',
      instruction:
        "To read the whole log comfortably, open it in `less`:\n\n`$ less captains-log.txt`\n\nInside `less`:\n\n| Key | Does |\n| --- | --- |\n| <kbd>Space</kbd> / <kbd>b</kbd> | page down / page back up |\n| <kbd>↓</kbd> / <kbd>↑</kbd> | one line down / up |\n| `/` then a word, then <kbd>Enter</kbd> | search forward |\n| <kbd>n</kbd> | next match |\n| <kbd>q</kbd> | quit |\n\nPage down and back up once, then find the day they reached land: type `/island` and press <kbd>Enter</kbd>, then press <kbd>n</kbd> for the next mention. Press <kbd>q</kbd> when you're done.",
      hint: 'The search starts with a forward slash: press <kbd>/</kbd>, and the bottom line shows `/` waiting for you to type the word.',
      solution: [
        'less captains-log.txt',
        { keys: ' ', label: 'Press Space to page down' },
        { keys: 'b', label: 'Press b to page back up' },
        { keys: '/', label: 'Press / to start a search' },
        { keys: 'island\r', label: 'Type island and press Enter' },
        { keys: 'n', label: 'Press n to jump to the next match' },
        { keys: 'q', label: 'Press q to quit' },
      ],
      explain:
        "`less` is a **pager**: it shows one screenful at a time and never changes the file. When it reaches the end, the bottom line shows `(END)`. Manual pages, which you'll meet in the next lesson, are shown in exactly the same viewer, so these keys will come in handy again. Most important of all: <kbd>q</kbd> quits.",
      check: all(ran('less'), (c) => !!c.ev && /captains-log\.txt/.test(c.ev.line)),
    },
    {
      id: 'wc',
      title: 'Count the lines',
      instruction: 'How long was the voyage? Count the lines with `wc` (*word count*) and its `-l` option (a lowercase L, for *lines*):\n\n`$ wc -l captains-log.txt`',
      hint: 'That\'s a lowercase L, not the number one: `wc -l captains-log.txt`.',
      solution: ['wc -l captains-log.txt'],
      explain:
        '102 lines: a title, a blank line and 100 days at sea. Without `-l`, `wc` shows three numbers: lines, words and bytes (for plain English text, bytes and characters are the same thing). `-w` counts just the words.',
      check: ran('wc', { flags: 'l' }),
    },
    {
      id: 'file',
      title: 'What kind of file is this?',
      instruction: "There's also a file called `mystery`, with no extension. Rather than printing it and hoping for the best, ask `file` what it is:\n\n`$ file mystery`",
      hint: 'Just the command and the name: `file mystery`.',
      solution: ['file mystery'],
      explain:
        "It's a picture! `file` doesn't care about the name: it reads the first few bytes inside the file, where most formats leave a recognizable signature. On Linux, extensions are just a naming habit. A photo can be called `mystery`, and a text file can be called `song.mp3`. Try `$ file *` to check everything here at once.",
      check: ran('file', { args: [/(^|\/)mystery$/] }),
    },
  ],
  quizSetup: (env) => {
    env.file('library/loans.log', LOANS.join('\n') + '\n');
    env.file('library/catalog.csv', [CATALOG_HEADER, ...CATALOG_ROWS].join('\n') + '\n', { daysAgo: 12 });
    binary(env, 'library/scan-0042', 'PDF document, version 1.7, 2 page(s)', 96_311);
  },
  quiz: [
    {
      kind: 'task',
      prompt: 'Every time someone borrows or returns a book, the library adds a line to the **end** of `loans.log`. Show just the 6 most recent entries.',
      hint: 'Use the command that shows the end of a file, and tell it how many lines you want.',
      solution: ['tail -n 6 loans.log'],
      explain: '`tail -n 6` shows the last 6 lines, which is where a log keeps its newest entries. `tail -6 loans.log` is the short form.',
      check: (c) => showsOnly(c, LOANS.slice(-6), LOANS.slice(0, -6)),
    },
    {
      kind: 'task',
      prompt: '`catalog.csv` is a spreadsheet file with one book per line. Show only its first line, which names the columns.',
      hint: 'Use the command that shows the start of a file, and ask it for a single line.',
      solution: ['head -n 1 catalog.csv'],
      explain: '`head -n 1` (or `head -1`) prints just the first line. Peeking at the top is a good first step with any data file: it tells you what the columns are.',
      check: (c) => showsOnly(c, [CATALOG_HEADER], CATALOG_ROWS),
    },
    {
      prompt: "You're reading a long file in `less`. How do you search it for the word *island*?",
      options: [
        'Press <kbd>Ctrl</kbd>+<kbd>F</kbd>, type `island` and press <kbd>Enter</kbd>',
        'Press <kbd>n</kbd>, then type `island`',
        'Press <kbd>q</kbd>, then run `less island`',
        'Type `/island` and press <kbd>Enter</kbd>',
      ],
      answer: 3,
      explain: "In `less`, <kbd>/</kbd> starts a search: type the word after it and press <kbd>Enter</kbd>. After that, <kbd>n</kbd> jumps to the next match, and <kbd>q</kbd> quits when you're done.",
    },
    {
      kind: 'task',
      prompt: 'How many lines long is `catalog.csv`? Let a command count them for you.',
      hint: 'The *word count* command can count lines too, with the right option.',
      solution: ['wc -l catalog.csv'],
      explain: `\`wc -l\` counts the lines: ${CATALOG_LINES}, the header plus ${CATALOG_ROWS.length} books. Without \`-l\`, \`wc\` shows the number of lines, words and bytes together.`,
      check: (c) => !!c.ev && c.ev.execs.some(countsLines) && /catalog\.csv/.test(c.ev.line + c.ev.output) && new RegExp(`(^|\\s)${CATALOG_LINES}(\\s|$)`).test(c.ev.output),
    },
    {
      kind: 'task',
      prompt: 'The scanner saved a file called `scan-0042`, with no extension. Without opening it, find out what kind of data it holds.',
      hint: "There's a command that reads the first few bytes of a file and names the format it finds there.",
      solution: ['file scan-0042'],
      explain: "It's a PDF document, 2 pages long. `file` recognizes the format from the data inside, so it doesn't need a name ending in `.pdf`.",
      check: (c) =>
        !!c.ev &&
        /PDF document/.test(c.ev.output) &&
        c.ev.execs.some((e) => base(e.argv[0]) === 'file' && (e.argv.some((a) => /(^|\/)scan-0042$/.test(a)) || /scan-0042:\s*PDF/.test(c.ev!.output))),
    },
  ],
  recap: `
- \`cat FILE\` prints a whole file; \`cat -n\` adds line numbers.
- \`head\` and \`tail\` show the first or last 10 lines; \`-n 5\` picks how many.
- \`less FILE\` lets you scroll and search: <kbd>Space</kbd>, <kbd>b</kbd>, \`/word\`, <kbd>n</kbd> and <kbd>q</kbd> to quit.
- \`wc -l FILE\` counts the lines.
- \`file FILE\` tells you what's really inside, whatever the name says.
`,
  cheatsheet: [
    ['cat FILE', 'print a whole file'],
    ['cat -n FILE', 'print with line numbers'],
    ['head -n 5 FILE', 'the first 5 lines (default 10)'],
    ['tail -n 5 FILE', 'the last 5 lines (default 10)'],
    ['tail -f FILE', 'keep showing new lines (Ctrl+C stops)'],
    ['less FILE', 'scroll and search (q quits)'],
    ['wc -l FILE', 'count lines'],
    ['file FILE', 'identify what a file contains'],
  ],
  realWorld: `
- **macOS:** \`cat\`, \`head\`, \`tail\`, \`less\`, \`wc\` and \`file\` are all there and work the same way.
- **Windows (PowerShell):** \`cat\` is a nickname for \`Get-Content\`. Instead of \`head\` and \`tail\`, use \`Get-Content FILE -Head 5\` and \`Get-Content FILE -Tail 5\`. Inside **WSL** you get the real Linux tools.
`,
};

// ---------------------------------------------------------------------------

const gettingHelp: Lesson = {
  id: 'getting-help',
  title: 'Getting help',
  summary: 'Read manual pages with man, get quick summaries with --help, find help for shell builtins, and search for commands by keyword.',
  moduleId: 'reading',
  minutes: 8,
  intro: `
Nobody remembers every option of every command, and nobody has to: the help is built in.

| Command | Gives you |
| --- | --- |
| \`man COMMAND\` | the full manual page |
| \`COMMAND --help\` | a quick summary of the options |
| \`help COMMAND\` | help for commands built into the shell, like \`cd\` |
| \`type COMMAND\` | what kind of command something is |
| \`man -k WORD\` | commands whose description mentions *WORD* |

Manual pages open in a viewer called \`less\`. These keys get you around:

| Key | Does |
| --- | --- |
| <kbd>Space</kbd> / <kbd>b</kbd> | page down / page back up |
| <kbd>↓</kbd> / <kbd>↑</kbd> | one line down / up |
| \`/\` then a word, then <kbd>Enter</kbd> | search |
| <kbd>n</kbd> | next match |
| <kbd>q</kbd> | quit |

> [!HOW]
> Most commands are **programs**: files stored in folders such as \`/usr/bin\`. When you type \`cat\`, the shell searches a list of folders for a program file called \`cat\` and runs it. A few commands, like \`cd\`, are **builtins**: they're part of the shell itself, so there's no program file to find, and usually no manual page of their own.

> [!TIP]
> Stuck inside a manual page? Press <kbd>q</kbd>. It's the way out of \`man\`, \`less\` and many other full-screen programs.
`,
  steps: [
    {
      id: 'man',
      title: 'Read the manual',
      instruction:
        'Every proper command comes with a **manual page**. Open the one for `ls`:\n\n`$ man ls`\n\nScroll down a page with <kbd>Space</kbd>. Then search for the word *sort*: type `/sort` and press <kbd>Enter</kbd>, and press <kbd>n</kbd> to jump to the next match. Press <kbd>q</kbd> to quit.',
      hint: 'Press <kbd>/</kbd> first; the bottom line then shows `/` and waits for the word. Press <kbd>q</kbd> at any time to leave.',
      solution: [
        'man ls',
        { keys: ' ', label: 'Press Space to page down' },
        { keys: '/', label: 'Press / to start a search' },
        { keys: 'sort\r', label: 'Type sort and press Enter' },
        { keys: 'n', label: 'Press n to jump to the next match' },
        { keys: 'q', label: 'Press q to quit' },
      ],
      explain:
        "Manual pages share a common layout: **NAME** (what it is, in one line), **SYNOPSIS** (how to call it), **DESCRIPTION** (the details, often with a separate **OPTIONS** section) and **SEE ALSO** (related commands). In the synopsis, anything in `[square brackets]` is optional, and `...` means *you can give several*.",
      check: (c) =>
        !!c.ev &&
        c.ev.execs.some((e) => base(e.argv[0]) === 'man' && e.status === 0 && e.argv.slice(1).some((a) => !a.startsWith('-')) && !['k', 'f', '--apropos', '--whatis'].some((f) => flagsOf(e).has(f))),
    },
    {
      id: 'dash-help',
      title: 'The quick version: --help',
      instruction: 'Manual pages can be long. Most commands also print a compact summary of their options when you add `--help`:\n\n`$ mkdir --help`',
      hint: 'Two dashes and no space: `mkdir --help`.',
      solution: ['mkdir --help'],
      explain:
        "`--help` prints straight into the terminal instead of opening a viewer; for long ones, scroll back up with your mouse wheel. It's the fastest answer to *what was that option called again?* A few programs use `-h` instead.",
      check: (c) => !!c.ev && c.ev.execs.some((e) => e.kind !== 'not-found' && e.argv.includes('--help')),
    },
    {
      id: 'man-cd',
      title: 'A command without a manual',
      instruction: 'Now try the manual for `cd`:\n\n`$ man cd`',
      hint: 'Type `man cd` exactly. This time an error message is the expected result.',
      solution: ['man cd'],
      explain:
        "*No manual entry for cd*! That's because `cd` is a **builtin**, part of the shell itself. It has to be: every program runs as a separate *process* with its own current folder, so a separate `cd` program could only change its own folder before exiting, leaving your shell exactly where it was.",
      check: ran('man', { args: ['cd'] }),
    },
    {
      id: 'help',
      title: 'Help for builtins',
      instruction: 'Builtins have their own help command, called `help`:\n\n`$ help cd`',
      hint: '`help` is a command of its own: `help cd`.',
      solution: ['help cd'],
      explain: 'The first line shows how to call it, followed by a description and the options, like a mini manual page. Run `help` on its own to list all the builtins: `cd`, `echo`, `pwd`, `history` and friends.',
      check: ran('help'),
    },
    {
      id: 'type-which',
      title: 'Builtin or program?',
      instruction:
        "How can you tell which kind of command you're dealing with? Ask `type`, which describes each name you give it:\n\n`$ type cd ls cat`\n\n`which` answers a narrower question: *where is the program's file?*\n\n`$ which cat`",
      hint: '`type` accepts several names at once: `type cd ls cat`. Then run `which cat`.',
      solution: ['type cd ls cat', 'which cat'],
      explain:
        "`type` knows everything the shell knows: `cd` is a builtin, `ls` is an **alias** (a nickname: typing `ls` really runs `ls --color=auto`, which adds the colors), and `cat` is a program stored in `/usr/bin`. `which` only looks for program files, so `which cd` prints nothing at all.",
      check: all(everRan('type'), everRan('which')),
    },
    {
      id: 'apropos',
      title: 'Find a command by keyword',
      instruction: "What if you don't know a command's name? `man -k` searches the one-line descriptions of all manual pages:\n\n`$ man -k copy`",
      hint: '`apropos copy` does exactly the same search.',
      solution: ['man -k copy'],
      explain:
        "Each result shows a command name, its manual **section** in brackets and its description. Section 1 holds everyday commands, 8 is for administrator commands and 5 for file formats, so `cp (1)` is the one you want. On a full Ubuntu system the list is much longer; try other words too, like `$ man -k directory`.",
      check: any(ran('man', { flags: 'k' }), ran('man', { args: ['--apropos'] }), ran('apropos')),
    },
  ],
  quiz: [
    {
      kind: 'task',
      prompt: 'What options does `cp` have? Print its short summary of options right here in the terminal, without opening the full manual page.',
      hint: 'Most commands print that summary when you give them a special option that starts with two dashes.',
      solution: ['cp --help'],
      explain: "`--help` prints a compact list of options straight into the terminal. It's the quickest answer to *what was that option called again?*",
      check: (c) => !!c.ev && c.ev.execs.some((e) => base(e.argv[0]) === 'cp' && e.kind !== 'not-found' && e.argv.includes('--help')),
    },
    {
      kind: 'task',
      prompt: "You need a command that can compress files, but you don't know its name. Search the one-line descriptions of all the manual pages for the word *compress*.",
      hint: '`man` has an option that searches those descriptions instead of opening a page.',
      solution: ['man -k compress'],
      explain: '`man -k` (the same search as `apropos`) lists every manual page whose description mentions the word. `gzip` is the one you want, and `man gzip` explains how to use it.',
      check: all(any(ran('man', { flags: 'k' }), ran('man', { args: ['--apropos'] }), ran('apropos')), outputIncludes('gzip')),
    },
    {
      prompt: 'The SYNOPSIS section of `man ls` says:\n\n```\nls [OPTION]... [FILE]...\n```\n\nWhat does that tell you?',
      options: ['You must give exactly one option and one file name', 'Options and file names are both optional, and you can give several of each', 'You type square brackets around each option', 'Options must come after the file names'],
      answer: 1,
      explain: 'In a synopsis, anything in `[square brackets]` is optional, and `...` means *you can give several*. So plain `ls` works, and so does `ls -l -a Documents Music`.',
    },
    {
      kind: 'task',
      prompt: '`export` is built into the shell itself, so it has no manual page: `man export` finds nothing. Show the help text that the shell has for it instead.',
      hint: 'Builtins have a help command of their own.',
      solution: ['help export'],
      explain: '`help` shows the help for shell builtins such as `export`, `cd` and `history`, which usually have no manual page of their own. The first line shows how to call it.',
      check: any(ran('help', { args: ['export'], status: 0 }), all(ran('export', { args: ['--help'] }), outputIncludes('Set export attribute'))),
    },
    {
      kind: 'task',
      prompt: 'Is `ll` a shell builtin, an alias or a program file? Ask the shell.',
      hint: 'One command describes whatever name you give it. You used it on `cd`, `ls` and `cat` in this lesson.',
      solution: ['type ll'],
      explain: '`ll` is an **alias**: typing it really runs `ls -alF`, a long listing that includes hidden files. Ubuntu sets it up for you in `~/.bashrc`.',
      check: any(outputIncludes(/\bll is aliased to\b/), all(ran('type'), outputIncludes(/^alias$/m)), all(ran('alias'), outputIncludes(/^alias ll=/m))),
    },
  ],
  recap: `
- \`man COMMAND\` opens the manual: <kbd>Space</kbd> pages, \`/word\` searches, <kbd>q</kbd> quits.
- \`COMMAND --help\` prints a quick summary of the options.
- Builtins like \`cd\` have no manual page; use \`help cd\`.
- \`type NAME\` says what a command is; \`which NAME\` says where its program file lives.
- \`man -k WORD\` (or \`apropos WORD\`) finds commands by keyword.
`,
  cheatsheet: [
    ['man COMMAND', 'read the manual (q quits)'],
    ['COMMAND --help', 'quick summary of options'],
    ['help BUILTIN', 'help for shell builtins like cd'],
    ['type NAME', 'builtin, alias or program?'],
    ['which NAME', 'where a program lives'],
    ['man -k WORD', 'search manual descriptions (= apropos)'],
    ['whatis COMMAND', 'one-line description'],
  ],
  realWorld: `
- **macOS:** \`man\` works the same way. Many macOS commands don't support \`--help\` and print a short usage line instead, so reach for \`man\`. The default shell, zsh, has no \`help\` command: its builtins are described in \`man zshbuiltins\`.
- **Windows (PowerShell):** use \`Get-Help COMMAND\` (or simply \`help COMMAND\`).
- Online, the community project **tldr** offers short, example-first pages for popular commands.
`,
};

// ---------------------------------------------------------------------------

const TEA = `How to make a cup of tea

1. Boil some water.
3. Pour the hot water into the cup.
2. Put a tea bag in a cup.
4. Wait three minutes.
5. Take out the tea bag and enjoy.
`;

const PACKING = [
  'Packing list: summer camping trip',
  '',
  ...[
    'tent', 'tent pegs', 'sleeping bag', 'sleeping mat', 'pillow', 'flashlight', 'spare batteries', 'matches', 'camping stove', 'gas canister',
    'cooking pot', 'frying pan', 'plates', 'cups', 'cutlery', 'can opener', 'water bottles', 'water filter', 'cooler', 'trash bags',
    'dish soap', 'sponge', 'dish towel', 'towels', 'soap', 'toothbrush', 'toothpaste', 'sunscreen', 'sunglasses', 'sun hat',
    'insect repellent', 'first aid kit', 'bandages', 'map', 'compass', 'phone charger', 'power bank', 'rain jacket', 'warm sweater', 'snow boots',
    't-shirts', 'shorts', 'socks', 'swimsuit', 'sandals', 'playing cards', 'a good book', 'notebook', 'pen', 'camera',
    'binoculars', 'folding chairs', 'camping table', 'clothespins', 'rope', 'pocketknife',
  ].map((item) => `- ${item}`),
].join('\n') + '\n';

const TEA_ORDER: Check = (c) => {
  const steps = (linesOf(c, 'writing/tea.txt') ?? []).filter((l) => /^\d\./.test(l));
  return steps.length === 5 && steps.every((l, i) => l.startsWith(`${i + 1}.`));
};

const SUNFLOWER_STEPS = ['1. Fill a pot with soil.', '2. Push a seed into the soil, about 2 cm deep.', '3. Put the pot somewhere sunny.', '4. Water it a little every day.'];

const SUNFLOWER = `How to grow a sunflower

${SUNFLOWER_STEPS[1]}
${SUNFLOWER_STEPS[2]}
${SUNFLOWER_STEPS[3]}
${SUNFLOWER_STEPS[0]}
`;

/** The guest list without the joke entry (which sits on line 33 of the file). */
const GUESTS = [
  'Party guests',
  ...['Amelia Brooks', 'Ben Carter', 'Chloe Diaz', 'Daniel Evans', 'Ella Fischer', 'Felix Garcia', 'Grace Hughes', 'Henry Ito', 'Isla Jensen', 'Jack Kim'],
  ...['Kira Lopez', 'Leo Martin', 'Maya Novak', 'Noah Okafor', 'Olivia Park', 'Pablo Quinn', 'Quinn Reyes', 'Rosa Silva', 'Sam Turner', 'Tara Usman'],
  ...['Umar Vance', 'Vera Wong', 'Will Xu', 'Yara Young', 'Zane Adams', 'Alice Baker', 'Bruno Costa', 'Cora Dunn', 'Dmitri Egorov', 'Eva Flores'],
  ...['Finn Gray', 'Gemma Hall', 'Hugo Ibsen', 'Iris James', 'Jonah Klein', 'Lena Moreau', 'Milo Nash', 'Nora Ortiz', 'Oscar Price'],
];

const GUESTS_FILE = [GUESTS[0], '', ...GUESTS.slice(1, 31), 'Count Dracula', ...GUESTS.slice(31)].join('\n') + '\n';

const INVITATION = `You're invited!

Come to my birthday party on Sunday at 3 pm.
Bring your swimsuit: there's a pool!
`;

const nano: Lesson = {
  id: 'nano',
  title: 'Editing text with nano',
  summary: 'Write and change files in nano, the friendliest terminal text editor: typing, saving, exiting, cutting and pasting lines, and searching.',
  moduleId: 'reading',
  minutes: 10,
  setup: (env) => {
    env.file('writing/tea.txt', TEA, { daysAgo: 2 });
    env.file('writing/packing-list.txt', PACKING, { daysAgo: 5 });
  },
  startDir: 'writing',
  intro: `
To write and change text yourself, you need a **text editor**. \`nano\` is the friendliest one that runs inside the terminal, and it comes preinstalled on Ubuntu and most other Linux systems. It takes over the whole terminal window:

\`\`\`
  GNU nano 7.2               shopping.txt               Modified
milk
bread
apples



^G Help       ^O Write Out  ^F Where Is   ^K Cut
^X Exit       ^R Read File  ^\\ Replace    ^U Paste
\`\`\`

The top line shows the file name (and *Modified* when there are unsaved changes), the middle is your text, and the bottom two lines list the most useful shortcuts. In that list, \`^\` means the <kbd>Ctrl</kbd> key, so \`^X\` is <kbd>Ctrl</kbd>+<kbd>X</kbd>, and \`M-\` means <kbd>Alt</kbd>.

| Keys | Does |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>O</kbd>, then <kbd>Enter</kbd> | save (*Write Out*) |
| <kbd>Ctrl</kbd>+<kbd>X</kbd> | exit (asks first if there are unsaved changes) |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> / <kbd>Ctrl</kbd>+<kbd>U</kbd> | cut the current line / paste it |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | search (*Where Is*; it's <kbd>Ctrl</kbd>+<kbd>W</kbd> in real nano) |
| <kbd>Ctrl</kbd>+<kbd>G</kbd> | help |

There's no clicking: move the cursor with the arrow keys.

> [!HOW]
> nano doesn't change the file directly. It loads a copy into memory, called the **buffer**, and you edit that. The file on disk only changes when you write the buffer out (save). That's why saving is called *Write Out*, and why nano asks *Save modified buffer?* if you try to leave with unsaved changes.
`,
  steps: [
    {
      id: 'open',
      title: 'Open nano, then leave',
      instruction:
        "The most important thing to know about any editor is how to get out again. Open nano with a new file called `shopping.txt`:\n\n`$ nano shopping.txt`\n\nLook around: the file name at the top, *[ New File ]* near the bottom, the shortcuts below it. Then press <kbd>Ctrl</kbd>+<kbd>X</kbd> to exit.",
      hint: 'Hold down <kbd>Ctrl</kbd> and press <kbd>X</kbd>. On a Mac, use the Control key, not Command.',
      solution: ['nano shopping.txt', { keys: '\x18', label: 'Press Ctrl+X to exit' }],
      explain:
        "Whatever happens in nano, <kbd>Ctrl</kbd>+<kbd>X</kbd> is the way out. You didn't type anything, so nano left without a question, and it didn't create the file either: `$ ls` won't show `shopping.txt` yet. nano only writes a file when you save.",
      check: ran('nano'),
    },
    {
      id: 'write',
      title: 'Type and save',
      instruction:
        "Open the file again and type a short shopping list, one item per line (press <kbd>Enter</kbd> between them), for example *milk*, *bread* and *apples*:\n\n`$ nano shopping.txt`\n\nTo save, press <kbd>Ctrl</kbd>+<kbd>O</kbd> (*Write Out*). nano suggests the file name at the bottom; press <kbd>Enter</kbd> to accept it. Then exit with <kbd>Ctrl</kbd>+<kbd>X</kbd>.",
      hint: 'After <kbd>Ctrl</kbd>+<kbd>O</kbd>, the bottom of the screen says *File Name to Write: shopping.txt*. Just press <kbd>Enter</kbd>.',
      solution: [
        'nano shopping.txt',
        { keys: 'milk\rbread\rapples', label: 'Type milk, Enter, bread, Enter, apples' },
        { keys: '\x0f', label: 'Press Ctrl+O to save' },
        { keys: '\r', label: 'Press Enter to keep the name shopping.txt' },
        { keys: '\x18', label: 'Press Ctrl+X to exit' },
      ],
      explain:
        "*Write Out* is nano's old-fashioned name for saving, and the status line reported how many lines it wrote. Back at the prompt, check your work with `$ cat shopping.txt`. (<kbd>Ctrl</kbd>+<kbd>S</kbd> saves too, without asking for the name.)",
      check: all(ran('nano'), fileLineCount('writing/shopping.txt', 1)),
    },
    {
      id: 'exit-save',
      title: 'Save on the way out',
      instruction:
        "Open the list once more and add *eggs* at the top: the cursor starts there, so just type `eggs` and press <kbd>Enter</kbd>.\n\n`$ nano shopping.txt`\n\nThis time, press <kbd>Ctrl</kbd>+<kbd>X</kbd> straight away. nano notices the unsaved change and asks **Save modified buffer?** Press <kbd>Y</kbd> for yes, then <kbd>Enter</kbd> to confirm the file name.",
      hint: 'Answer the question with the <kbd>Y</kbd> key, then press <kbd>Enter</kbd> when nano shows the file name.',
      solution: [
        'nano shopping.txt',
        { keys: 'eggs\r', label: 'Type eggs and press Enter' },
        { keys: '\x18', label: 'Press Ctrl+X to exit' },
        { keys: 'y', label: 'Press Y to save the changes' },
        { keys: '\r', label: 'Press Enter to keep the name' },
      ],
      explain:
        '<kbd>Y</kbd> saves, <kbd>N</kbd> throws the changes away, and <kbd>Ctrl</kbd>+<kbd>C</kbd> cancels so you can keep editing. Answering <kbd>N</kbd> is the quick way out when you\'ve made a mess and want the file to stay as it was.',
      check: all(ran('nano'), fileContains('writing/shopping.txt', /eggs/i)),
    },
    {
      id: 'cut-paste',
      title: 'Move a line',
      instruction:
        "The steps of this tea recipe are in the wrong order. Open it:\n\n`$ nano tea.txt`\n\nPress <kbd>↓</kbd> until the cursor is on *2. Put a tea bag in a cup.*, and press <kbd>Ctrl</kbd>+<kbd>K</kbd> to **cut** that line. Then press <kbd>↑</kbd> once to get to *3. Pour the hot water...* and press <kbd>Ctrl</kbd>+<kbd>U</kbd> to **paste** the line back in above it. Save and exit as before: <kbd>Ctrl</kbd>+<kbd>X</kbd>, <kbd>Y</kbd>, <kbd>Enter</kbd>.",
      hint: 'If the line lands in the wrong place, press <kbd>Ctrl</kbd>+<kbd>K</kbd> to cut it again, move, and paste once more. Check the result afterwards with `cat tea.txt`.',
      solution: [
        'nano tea.txt',
        { keys: '\x1b[B\x1b[B\x1b[B\x1b[B', label: 'Press ↓ four times, to the line starting with 2.' },
        { keys: '\x0b', label: 'Press Ctrl+K to cut the line' },
        { keys: '\x1b[A', label: 'Press ↑ once, to the line starting with 3.' },
        { keys: '\x15', label: 'Press Ctrl+U to paste the line above it' },
        { keys: '\x18y\r', label: 'Press Ctrl+X, then Y, then Enter to save and exit' },
      ],
      explain:
        '<kbd>Ctrl</kbd>+<kbd>K</kbd> cuts the whole line into nano\'s clipboard, and <kbd>Ctrl</kbd>+<kbd>U</kbd> pastes it at the cursor; with the cursor at the start of a line, the pasted line lands just above it. Press <kbd>Ctrl</kbd>+<kbd>K</kbd> several times in a row to cut several lines together, and a single <kbd>Ctrl</kbd>+<kbd>U</kbd> pastes them all. Made a mistake? <kbd>Alt</kbd>+<kbd>U</kbd> undoes it.',
      check: all(ran('nano'), TEA_ORDER),
    },
    {
      id: 'search',
      title: 'Find a word',
      instruction:
        "The packing list is long, and a summer trip doesn't need *snow boots*. Instead of scrolling, search:\n\n`$ nano packing-list.txt`\n\nPress <kbd>Ctrl</kbd>+<kbd>F</kbd> (*Where Is*), type `boots` and press <kbd>Enter</kbd>: the cursor jumps to the match. Cut that line with <kbd>Ctrl</kbd>+<kbd>K</kbd>, then save and exit with <kbd>Ctrl</kbd>+<kbd>X</kbd>, <kbd>Y</kbd>, <kbd>Enter</kbd>.\n\n> [!WARNING]\n> In real nano, search is <kbd>Ctrl</kbd>+<kbd>W</kbd>. Browsers use <kbd>Ctrl</kbd>+<kbd>W</kbd> to close the tab, so this practice version moved search to <kbd>Ctrl</kbd>+<kbd>F</kbd>. Don't press <kbd>Ctrl</kbd>+<kbd>W</kbd> here!",
      hint: 'After <kbd>Ctrl</kbd>+<kbd>F</kbd>, the bottom line says *Search:*. Type the word there and press <kbd>Enter</kbd>.',
      solution: [
        'nano packing-list.txt',
        { keys: '\x06', label: 'Press Ctrl+F to search' },
        { keys: 'boots\r', label: 'Type boots and press Enter' },
        { keys: '\x0b', label: 'Press Ctrl+K to cut the line' },
        { keys: '\x18y\r', label: 'Press Ctrl+X, then Y, then Enter to save and exit' },
      ],
      explain:
        "nano's search ignores upper and lower case, and <kbd>Alt</kbd>+<kbd>W</kbd> jumps to the next match. <kbd>Ctrl</kbd>+<kbd>\\\\</kbd> searches *and replaces*, and <kbd>Ctrl</kbd>+<kbd>G</kbd> shows every shortcut nano has. You now know enough nano for everyday editing!",
      check: all(ran('nano'), not(fileContains('writing/packing-list.txt', /boots/i)), fileContains('writing/packing-list.txt', 'tent')),
    },
  ],
  quizSetup: (env) => {
    env.file('writing/sunflower.txt', SUNFLOWER, { daysAgo: 1 });
    env.file('writing/guests.txt', GUESTS_FILE, { daysAgo: 3 });
    env.file('writing/invitation.txt', INVITATION, { daysAgo: 1 });
  },
  quiz: [
    {
      kind: 'task',
      prompt: 'Use nano to create a new file called `reminder.txt` that says *Buy birthday candles*, and save it.',
      hint: 'Give nano the new file name when you open it. In nano, saving is called *Write Out*.',
      solution: [
        'nano reminder.txt',
        { keys: 'Buy birthday candles', label: 'Type Buy birthday candles' },
        { keys: '\x0f', label: 'Press Ctrl+O to save' },
        { keys: '\r', label: 'Press Enter to keep the name reminder.txt' },
        { keys: '\x18', label: 'Press Ctrl+X to exit' },
      ],
      explain: 'nano only creates the file when you save: <kbd>Ctrl</kbd>+<kbd>O</kbd> and <kbd>Enter</kbd>, or <kbd>Ctrl</kbd>+<kbd>X</kbd>, <kbd>Y</kbd> and <kbd>Enter</kbd> on the way out.',
      check: all(ran('nano'), fileContains('writing/reminder.txt', /buy birthday candles/i)),
    },
    {
      kind: 'task',
      prompt: 'In `sunflower.txt`, step 1 ended up at the bottom of the list. Use nano to move it to the top, so the steps go 1, 2, 3, 4.',
      hint: 'Cut the line where it is now, move the cursor to where it belongs, and paste it there.',
      solution: [
        'nano sunflower.txt',
        { keys: '\x1b[B'.repeat(5), label: 'Press ↓ five times, to the line starting with 1.' },
        { keys: '\x0b', label: 'Press Ctrl+K to cut the line' },
        { keys: '\x1b[A'.repeat(3), label: 'Press ↑ three times, to the line starting with 2.' },
        { keys: '\x15', label: 'Press Ctrl+U to paste the line above it' },
        { keys: '\x18y\r', label: 'Press Ctrl+X, then Y, then Enter to save and exit' },
      ],
      explain: '<kbd>Ctrl</kbd>+<kbd>K</kbd> cuts the whole line, and <kbd>Ctrl</kbd>+<kbd>U</kbd> pastes it just above the line the cursor is on, so pasting on step 2 put step 1 right before it.',
      check: all(ran('nano'), (c) => sameLines(linesOf(c, 'writing/sunflower.txt'), ['How to grow a sunflower', ...SUNFLOWER_STEPS])),
    },
    {
      prompt: "You've made a mess of a file in nano and want it to stay exactly as it was. You press <kbd>Ctrl</kbd>+<kbd>X</kbd>, and nano asks **Save modified buffer?** What now?",
      options: ['Press <kbd>N</kbd>', 'Press <kbd>Y</kbd>', 'Press <kbd>Ctrl</kbd>+<kbd>C</kbd>'],
      answer: 0,
      explain: '<kbd>N</kbd> (*no*) leaves nano without saving, so the file stays as it was. <kbd>Y</kbd> would save the mess, and <kbd>Ctrl</kbd>+<kbd>C</kbd> cancels the question and takes you back to editing.',
    },
    {
      kind: 'task',
      prompt: "As a joke, someone added *Count Dracula* to the long guest list in `guests.txt`. Use nano to remove that line, and keep everyone else on the list. (Careful: <kbd>Ctrl</kbd>+<kbd>W</kbd> can close your browser tab.)",
      hint: "Instead of scrolling, let nano find the line for you. In this practice terminal, nano's search is <kbd>Ctrl</kbd>+<kbd>F</kbd>.",
      solution: [
        'nano guests.txt',
        { keys: '\x06', label: 'Press Ctrl+F to search' },
        { keys: 'Dracula\r', label: 'Type Dracula and press Enter' },
        { keys: '\x0b', label: 'Press Ctrl+K to cut the line' },
        { keys: '\x18y\r', label: 'Press Ctrl+X, then Y, then Enter to save and exit' },
      ],
      explain: 'Searching jumps straight to the match, wherever it is in the file, and <kbd>Ctrl</kbd>+<kbd>K</kbd> removes the whole line. On a long file, that beats scrolling.',
      check: all(ran('nano'), (c) => sameLines(linesOf(c, 'writing/guests.txt'), GUESTS)),
    },
    {
      kind: 'task',
      prompt: "`invitation.txt` says the party is on Sunday, but it's really on Saturday. Use nano to fix that word.",
      hint: 'Search for the wrong word to jump to it, delete it and type the right one.',
      solution: [
        'nano invitation.txt',
        { keys: '\x06', label: 'Press Ctrl+F to search' },
        { keys: 'Sunday\r', label: 'Type Sunday and press Enter' },
        { keys: '\x1b[3~'.repeat(6), label: 'Press Delete six times' },
        { keys: 'Saturday', label: 'Type Saturday' },
        { keys: '\x18y\r', label: 'Press Ctrl+X, then Y, then Enter to save and exit' },
      ],
      explain: 'In nano you change text where it is: <kbd>Delete</kbd> removes the character under the cursor and <kbd>Backspace</kbd> the one before it. For many changes at once, <kbd>Ctrl</kbd>+<kbd>\\\\</kbd> searches and replaces.',
      check: all(
        ran('nano'),
        fileContains('writing/invitation.txt', /party on saturday at 3 pm/i),
        not(fileContains('writing/invitation.txt', /sunday/i)),
        fileContains('writing/invitation.txt', "You're invited!"),
        fileContains('writing/invitation.txt', "Bring your swimsuit: there's a pool!"),
      ),
    },
  ],
  recap: `
- \`nano FILE\` opens a file (or starts a new one). Move around with the arrow keys and just type.
- <kbd>Ctrl</kbd>+<kbd>O</kbd> then <kbd>Enter</kbd> saves; <kbd>Ctrl</kbd>+<kbd>X</kbd> exits and offers to save unsaved changes (<kbd>Y</kbd>, <kbd>N</kbd> or <kbd>Ctrl</kbd>+<kbd>C</kbd>).
- <kbd>Ctrl</kbd>+<kbd>K</kbd> cuts a line, <kbd>Ctrl</kbd>+<kbd>U</kbd> pastes it.
- <kbd>Ctrl</kbd>+<kbd>F</kbd> searches here; on a real Linux computer it's <kbd>Ctrl</kbd>+<kbd>W</kbd>.
- The shortcuts are always listed at the bottom of the screen: \`^\` means <kbd>Ctrl</kbd>.
`,
  cheatsheet: [
    ['nano FILE', 'edit a file (creates it when you save)'],
    ['Ctrl+O, Enter', 'save (Write Out)'],
    ['Ctrl+X', 'exit (Y / N to save or not)'],
    ['Ctrl+K / Ctrl+U', 'cut line / paste'],
    ['Ctrl+F', 'search (Ctrl+W in real nano)'],
    ['Alt+U', 'undo'],
    ['Ctrl+G', 'help'],
  ],
  realWorld: `
- **On a real Linux computer**, nano's search is <kbd>Ctrl</kbd>+<kbd>W</kbd> (*Where Is*), and <kbd>Ctrl</kbd>+<kbd>F</kbd> just moves the cursor one character forward. Everything else in this lesson works the same. To edit system files you'll need administrator rights: \`sudo nano /etc/hosts\`.
- **macOS:** typing \`nano\` opens a very similar editor (recent versions actually start Pico, nano's ancestor) with the same <kbd>Ctrl</kbd>+<kbd>O</kbd>, <kbd>Ctrl</kbd>+<kbd>X</kbd>, <kbd>Ctrl</kbd>+<kbd>K</kbd>, <kbd>Ctrl</kbd>+<kbd>U</kbd> and <kbd>Ctrl</kbd>+<kbd>W</kbd> keys.
- **Windows:** use nano inside WSL, or a graphical editor such as Notepad.
`,
};

// ---------------------------------------------------------------------------

const SORTED_FRUITS = 'apple\nbanana\ncherry\nmango\npear';

const redirection: Lesson = {
  id: 'redirection',
  title: 'Saving output to files',
  summary: 'Send output into files with > and >>, feed files in with <, handle error messages separately, and see output while saving it with tee.',
  moduleId: 'reading',
  minutes: 10,
  setup: (env) => {
    env.file('lab/planets.txt', 'Neptune\nEarth\nVenus\nMars\nJupiter\nMercury\nSaturn\nUranus\n', { daysAgo: 4 });
    env.file('lab/fruits.txt', 'pear\nbanana\ncherry\napple\nmango\n', { daysAgo: 4 });
  },
  startDir: 'lab',
  intro: `
Every program has three standard channels, called **streams**:

\`\`\`
              ┌─────────┐ ── standard output (1) ──▶ screen
 keyboard ──▶ │ command │
standard      └─────────┘ ── standard error (2) ───▶ screen
input (0)
\`\`\`

Results go to **standard output**, error messages to **standard error**. Both normally end up on your screen, so they look alike, but the shell can send each one somewhere else. That's called **redirection**:

| You type | What happens |
| --- | --- |
| \`cmd > file\` | output goes into *file*, replacing what was in it |
| \`cmd >> file\` | output is added to the end of *file* |
| \`cmd < file\` | *cmd* reads its input from *file* instead of the keyboard |
| \`cmd 2> file\` | error messages go into *file* |
| \`cmd 2> /dev/null\` | error messages are thrown away |
| \`cmd &> file\` | output **and** errors go into *file* |
| \`cmd \\| tee file\` | output goes to the screen *and* into *file* |

> [!HOW]
> The shell sets up redirections **before** the command starts: it opens the file and connects it to the right stream. The command just writes its output as usual and never knows it ended up in a file. The numbers are how the shell names the streams (0 input, 1 output, 2 errors), so \`2>\` literally means *redirect stream 2*, and \`>\` is short for \`1>\`.
`,
  steps: [
    {
      id: 'save',
      title: 'Send output into a file',
      instruction: "You're in a folder called `lab`. Start a weather diary: `>` sends a command's output into a file instead of onto the screen.\n\n`$ echo \"Monday: rainy\" > weather.txt`\n\nNothing shows up on the screen, because the text goes into the file instead. Check what's inside with `$ cat weather.txt`.",
      hint: 'Keep the quotes around the text, and put a space on each side of the `>`.',
      solution: ['echo "Monday: rainy" > weather.txt', 'cat weather.txt'],
      explain: '`weather.txt` didn\'t exist, so `>` created it. This works with any command: `ls > files.txt` saves a listing, `date > today.txt` saves the date and time.',
      check: all(fileContains('lab/weather.txt', /monday/i), ran('cat', { args: [/weather\.txt$/] })),
    },
    {
      id: 'append',
      title: '> replaces, >> adds',
      instruction:
        "Now write Tuesday's weather the same way, and look at the file:\n\n`$ echo \"Tuesday: sunny\" > weather.txt`\n\n`$ cat weather.txt`\n\nMonday is gone! `>` empties the file before writing. To **add** to the end instead, use `>>`:\n\n`$ echo \"Wednesday: windy\" >> weather.txt`\n\n`$ cat weather.txt`",
      hint: 'Two arrows, with no space between them: `>>`.',
      solution: ['echo "Tuesday: sunny" > weather.txt', 'cat weather.txt', 'echo "Wednesday: windy" >> weather.txt', 'cat weather.txt'],
      explain:
        'One arrow **replaces**, two arrows **add**. `>` gives no warning before it wipes a file, so double-check the arrows when the file matters. (For extra safety, `set -o noclobber` makes bash refuse to overwrite existing files with `>`; `>|` then overrides it when you really mean it.)',
      check: all(ran('cat', { args: [/weather\.txt$/] }), (c) => {
        const lines = linesOf(c, 'lab/weather.txt') ?? [];
        const tuesday = lines.findIndex((l) => /tuesday/i.test(l));
        return tuesday >= 0 && tuesday < lines.length - 1;
      }),
    },
    {
      id: 'input',
      title: 'Feed a file in with <',
      instruction: '`<` works the other way round: it feeds a file into a command\'s **input**. Compare these two:\n\n`$ wc -l planets.txt`\n\n`$ wc -l < planets.txt`',
      hint: 'Think of `<` as an arrow pointing into the command: `wc -l < planets.txt`.',
      solution: ['wc -l planets.txt', 'wc -l < planets.txt'],
      explain:
        "Both count 8 lines, but the second doesn't show the file name. With `<`, it's the shell that opens the file; `wc` just receives a stream of text, exactly as if you had typed it on the keyboard, so it has no idea what the file was called.",
      check: (c) => !!c.ev && /(^|[^<])<\s*\S*planets\.txt/.test(c.ev.line) && c.ev.status === 0,
    },
    {
      id: 'stderr',
      title: 'Errors take a different route',
      instruction:
        "Try saving a listing that includes a file that doesn't exist:\n\n`$ ls planets.txt missing.txt > out.txt`\n\nThe error still appears on the screen! It went to **standard error**, which `>` doesn't touch. To redirect errors, put a `2` in front of the arrow:\n\n`$ ls planets.txt missing.txt 2> errors.txt`",
      hint: 'No space between the 2 and the arrow: `2>`.',
      solution: ['ls planets.txt missing.txt > out.txt', 'ls planets.txt missing.txt 2> errors.txt'],
      explain:
        "This time the normal output came to the screen and the error went into the file (see for yourself: `$ cat errors.txt`). Keeping the two streams apart is deliberate: you can save the results and still notice the problems, or the other way round.",
      check: fileContains('lab/errors.txt', 'No such file or directory'),
    },
    {
      id: 'discard',
      title: 'Throw errors away, or keep everything',
      instruction:
        "`/dev/null` is a special file that swallows anything written to it. Send errors there to hide them:\n\n`$ ls planets.txt missing.txt 2> /dev/null`\n\nAnd `&>` sends **both** streams into the same file:\n\n`$ ls planets.txt missing.txt &> everything.txt`\n\n`$ cat everything.txt`",
      hint: '`/dev/null` is written like any other path, with slashes. `&>` is an ampersand followed by an arrow.',
      solution: ['ls planets.txt missing.txt 2> /dev/null', 'ls planets.txt missing.txt &> everything.txt', 'cat everything.txt'],
      explain:
        "`2> /dev/null` is handy when a command reports problems you already know about, but use it with care: it also hides the errors you didn't expect. You'll often see the older spelling `> everything.txt 2>&1`, which does the same as `&>`: it means *send errors (2) to the same place as the output (1)*. The order matters there: `2>&1` has to come after `> everything.txt`.",
      check: all(everLine(/2>\s*\/dev\/null/), fileContains('lab/everything.txt', 'No such file'), fileContains('lab/everything.txt', 'planets.txt'), ran('cat', { args: [/everything\.txt$/] })),
    },
    {
      id: 'tee',
      title: 'Screen and file at once',
      instruction:
        "Sometimes you want to see the output *and* save it. The `|` symbol, called a **pipe**, passes one command's output to another command (much more about pipes in the next module). `tee` copies whatever it receives both to the screen and into a file:\n\n`$ sort planets.txt | tee sorted.txt`",
      hint: 'The `|` key is usually above <kbd>Enter</kbd> or next to the left <kbd>Shift</kbd> key; you may need <kbd>Shift</kbd> to type it.',
      solution: ['sort planets.txt | tee sorted.txt'],
      explain: "You saw the sorted planets, and `sorted.txt` holds the same list. `tee` is named after the T-shaped pipe fitting plumbers use to split one flow into two. Add `-a` to append instead of replacing: `tee -a sorted.txt`.",
      check: all(ran('tee'), fileContains('lab/sorted.txt', /Earth/)),
    },
    {
      id: 'trap',
      title: 'The classic trap',
      instruction:
        "Here's a mistake almost everyone makes once, so let's make it here, where it can't hurt. Try to sort a file *into itself*:\n\n`$ sort fruits.txt > fruits.txt`\n\n`$ cat fruits.txt`",
      hint: 'Type it exactly as shown, then look at the file with `cat fruits.txt`. It\'s supposed to go wrong!',
      solution: ['sort fruits.txt > fruits.txt', 'cat fruits.txt'],
      explain:
        "The file is **empty**! The shell sets up `> fruits.txt` before `sort` starts, and setting it up means emptying the file, so `sort` found nothing left to read. Instead, write to a new file (`sort fruits.txt > sorted-fruits.txt`), or use sort's own option, which is safe for this: `sort -o fruits.txt fruits.txt`.",
      check: all(everRan('sort'), ran('cat', { args: [/fruits\.txt$/] }), (c) => fileText(c, 'lab/fruits.txt') === ''),
    },
  ],
  quizSetup: (env) => {
    env.file('lab/samples.txt', 'water\nsand\n', { daysAgo: 1 });
  },
  quiz: [
    {
      kind: 'task',
      prompt: 'Save the list of files and folders in `/etc` into a new file called `etc-list.txt`, here in `lab`.',
      hint: 'List the folder as usual, then add the arrow that sends the output into a file.',
      solution: ['ls /etc > etc-list.txt'],
      explain: '`>` sent the listing into the file instead of onto the screen, and created the file on the way. Have a look inside with `cat etc-list.txt`.',
      check: (c) => {
        const t = fileText(c, 'lab/etc-list.txt');
        return t !== null && /(^|[\s/])hosts$/m.test(t) && /(^|[\s/])passwd$/m.test(t);
      },
    },
    {
      kind: 'task',
      prompt: '`samples.txt` lists two samples, *water* and *sand*. Add a third line, *salt*, to the end of the file without losing the other two.',
      hint: 'One arrow replaces everything in a file. Which one adds to the end?',
      solution: ['echo salt >> samples.txt'],
      explain: '`>>` adds to the end of a file. A single `>` would have emptied it first, wiping out *water* and *sand*.',
      check: (c) => sameLines(linesOf(c, 'lab/samples.txt')?.map((l) => l.toLowerCase()) ?? null, ['water', 'sand', 'salt']),
    },
    {
      kind: 'task',
      prompt: "`ls planets.txt moons.txt` complains, because there is no `moons.txt` here. Run it so that only the normal output appears, and the error message is thrown away.",
      hint: 'Error messages travel on a stream of their own, number 2. Send just that stream to the special file that swallows everything.',
      solution: ['ls planets.txt moons.txt 2> /dev/null'],
      explain: '`2>` redirects only the error messages (stream 2), and `/dev/null` swallows whatever is written to it. A plain `> /dev/null` would do the opposite: hide the normal output and still show the error.',
      check: (c) =>
        !!c.ev &&
        c.ev.execs.some((e) => base(e.argv[0]) === 'ls' && e.argv.some((a) => /(^|\/)moons\.txt$/.test(a))) &&
        c.ev.output.includes('planets.txt') &&
        !c.ev.output.includes('No such file') &&
        c.ev.line.includes('/dev/null'),
    },
    {
      kind: 'task',
      prompt: 'Sort `fruits.txt` so that the sorted list appears on the screen **and** is saved in a new file, `sorted-fruits.txt`, with a single command line.',
      hint: "There's a command that copies whatever it receives both onto the screen and into a file.",
      solution: ['sort fruits.txt | tee sorted-fruits.txt'],
      explain: '`tee` passes everything it receives on to the screen and also writes it into the file. With `-a` it would add to the end of the file instead of replacing it.',
      check: (c) => !!c.ev && c.ev.output.includes(SORTED_FRUITS) && fileText(c, 'lab/sorted-fruits.txt')?.trim() === SORTED_FRUITS,
    },
    {
      prompt: 'You tried to sort a file into itself:\n\n```\nsort fruits.txt > fruits.txt\n```\n\nNow `cat fruits.txt` prints nothing. What happened?',
      options: ['The shell emptied the file to set up `>` before `sort` even started', '`sort` removes the lines from a file after reading them', "`>` only works with files that don't exist yet"],
      answer: 0,
      explain: 'Redirections are set up before the command runs, and `>` starts by emptying the file, so `sort` found nothing to read. Write to a new file instead, or use `sort -o fruits.txt fruits.txt`, which is safe.',
    },
  ],
  recap: `
- Programs write results to **standard output** and errors to **standard error**; both go to the screen unless you redirect them.
- \`>\` saves output to a file, **replacing** it; \`>>\` **adds** to the end.
- \`<\` feeds a file into a command's input.
- \`2>\` redirects errors; \`2> /dev/null\` throws them away; \`&>\` saves output and errors together.
- \`cmd | tee file\` shows the output and saves it.
- Never redirect into the file you're reading from: \`sort f > f\` empties \`f\`.
`,
  cheatsheet: [
    ['cmd > file', 'save output (replaces the file)'],
    ['cmd >> file', 'append output'],
    ['cmd < file', 'read input from a file'],
    ['cmd 2> file', 'save error messages'],
    ['cmd 2> /dev/null', 'discard error messages'],
    ['cmd &> file', 'save output and errors'],
    ['cmd | tee file', 'show and save output'],
    ['sort -o f f', 'sort a file in place, safely'],
  ],
  realWorld: `
- **macOS (zsh):** all of these work the same way.
- **Windows (PowerShell):** \`>\`, \`>>\` and \`2>\` work, but there is no \`<\`, and instead of \`/dev/null\` you write \`$null\` (\`2> $null\`). \`Tee-Object\` does the job of \`tee\`.
`,
};

export const readingLessons: Lesson[] = [readingFiles, gettingHelp, nano, redirection];
