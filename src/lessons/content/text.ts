// Module: Pipes and power tools.

import { all, any, missing, ran, lineMatches } from '../checks';
import type { CheckContext, Lesson } from '../types';

/** Every listed command ran as part of the same command line. */
function pipeline(...names: string[]) {
  return (c: CheckContext) => !!c.ev && names.every((n) => c.ev!.execs.some((e) => e.argv[0]?.split('/').pop() === n));
}

const NAMES = ['Zoe', 'adam', 'Maya', 'Liam', 'zoe', 'Maya', 'Noah', 'Ava', 'Liam', 'Maya', 'Ella', 'Noah', 'Maya', 'Ava', 'Owen'];

export const pipes: Lesson = {
  id: 'pipes',
  title: 'Pipes: connecting commands',
  summary: 'Feed the output of one command into another with |, and build little data machines.',
  moduleId: 'text',
  minutes: 9,
  setup: (env) => {
    env.file('names.txt', NAMES.join('\n') + '\n');
  },
  intro: `
Most command-line tools do **one small job** well: \`sort\` sorts lines, \`uniq\` removes repeats, \`wc\` counts. The magic happens when you connect them.

The **pipe** symbol \`|\` (usually <kbd>Shift</kbd>+<kbd>\\</kbd>) takes everything the command on its left prints and feeds it to the command on its right, as if you had typed it in:

\`\`\`
ls /usr/bin  |  wc -l
   │              │
   │              └── counts the lines it receives
   └── prints one program name per line
\`\`\`

> [!HOW]
> Each command in a pipeline is a separate running program. The shell connects the **standard output** of one to the **standard input** of the next, so text flows through them like water through pipes. None of the commands knows or cares where the text comes from.
`,
  steps: [
    {
      id: 'count-programs',
      title: 'Count your programs',
      instruction: 'How many programs live in `/usr/bin`? List them and count the lines:\n\n`$ ls /usr/bin | wc -l`',
      hint: 'The | character is usually Shift + the backslash key, above Enter.',
      solution: ['ls /usr/bin | wc -l'],
      explain: '`ls` printed one name per line (it does that when its output goes into a pipe instead of the screen), and `wc -l` counted the lines. Two simple tools answered a question neither could alone.',
      check: all(pipeline('ls', 'wc'), ran('wc', { flags: 'l' })),
    },
    {
      id: 'sort',
      title: 'Sort a list',
      instruction: '`names.txt` is a messy list of names. Print it sorted:\n\n`$ sort names.txt`',
      solution: ['sort names.txt'],
      explain: 'Notice the duplicates: several names appear more than once. `sort` puts identical lines next to each other, which is exactly what the next tool needs.',
      check: ran('sort'),
    },
    {
      id: 'uniq',
      title: 'Remove duplicates',
      instruction: 'Pipe the sorted names into `uniq`, which drops repeated lines:\n\n`$ sort names.txt | uniq`',
      solution: ['sort names.txt | uniq'],
      explain: "`uniq` only removes duplicates that are **next to each other**, so you almost always `sort` first. (`zoe` and `Zoe` count as different names: Linux is case-sensitive.)",
      check: pipeline('sort', 'uniq'),
    },
    {
      id: 'ranking',
      title: 'Count and rank',
      instruction: "Which name is most common? Count each name with `uniq -c`, then sort the counts from highest to lowest:\n\n`$ sort names.txt | uniq -c | sort -rn`",
      hint: '`-c` makes uniq print a count. `sort -rn` sorts numerically (`-n`) in reverse (`-r`).',
      solution: ['sort names.txt | uniq -c | sort -rn'],
      explain: 'Three commands, one answer: Maya appears 4 times. This *sort | uniq -c | sort -rn* pattern is one of the most useful recipes on the command line; it works on any list, from log files to survey answers.',
      check: all(ran('uniq', { flags: 'c' }), ran('sort', { flags: 'rn' })),
    },
    {
      id: 'top3',
      title: 'Keep just the top 3',
      instruction: 'Add one more pipe to keep only the first three lines:\n\n`$ sort names.txt | uniq -c | sort -rn | head -3`',
      solution: ['sort names.txt | uniq -c | sort -rn | head -3'],
      explain: 'You can keep adding tools to a pipeline. Each one transforms the text a little more.',
      check: all(pipeline('sort', 'uniq', 'head'), ran('head')),
    },
    {
      id: 'search-pipe',
      title: 'Filter with grep',
      instruction: "`grep` keeps only lines that contain a word. Which programs have *zip* in their name?\n\n`$ ls /usr/bin | grep zip`",
      solution: ['ls /usr/bin | grep zip'],
      explain: '`grep` is the most common tool to put after a pipe: it cuts long output down to the lines you care about. You will meet it properly in the next lesson.',
      check: pipeline('ls', 'grep'),
    },
  ],
  recap: `
- \`A | B\` sends the output of command A into command B.
- Small tools combine into powerful pipelines: \`sort | uniq -c | sort -rn | head\` ranks anything.
- \`wc -l\` counts lines, \`sort\` sorts, \`uniq\` removes neighbouring duplicates, \`head\` keeps the first lines, \`grep\` filters.
`,
  cheatsheet: [
    ['A | B', "feed A's output into B"],
    ['wc -l', 'count lines'],
    ['sort / sort -n / sort -r', 'sort alphabetically / numerically / reversed'],
    ['uniq / uniq -c', 'remove / count neighbouring duplicates'],
    ['head -N / tail -N', 'keep the first / last N lines'],
  ],
};

const LOG = [
  '2026-10-19 08:00:01 INFO  server started on port 8080',
  '2026-10-19 08:00:02 INFO  connected to database',
  '2026-10-19 08:15:44 WARN  slow response from /api/search (2.1s)',
  '2026-10-19 08:16:02 INFO  user ava logged in',
  '2026-10-19 08:31:17 ERROR payment service timeout after 30s',
  '2026-10-19 08:31:18 INFO  retrying payment request',
  '2026-10-19 08:31:20 INFO  payment request succeeded',
  '2026-10-19 09:02:51 WARN  disk usage at 81%',
  '2026-10-19 09:10:05 INFO  user ben logged in',
  '2026-10-19 09:12:33 ERROR could not send email: connection refused',
  '2026-10-19 09:12:34 INFO  email queued for retry',
  '2026-10-19 09:40:00 INFO  nightly report generated',
  '2026-10-19 10:05:12 error in template "invoice" (line 12), using fallback',
  '2026-10-19 10:20:45 WARN  slow response from /api/orders (3.4s)',
  '2026-10-19 10:21:00 ERROR database timeout after 10s',
  '2026-10-19 10:21:01 INFO  reconnected to database',
  '2026-10-19 11:00:00 INFO  user chloe logged in',
];

export const grepLesson: Lesson = {
  id: 'grep',
  title: 'Searching text with grep',
  summary: 'Find the lines you need in huge files: case-insensitive, counted, numbered, inverted and recursive searches.',
  moduleId: 'text',
  minutes: 9,
  setup: (env) => {
    env.file('server.log', LOG.join('\n') + '\n');
    env.dir('notes');
    env.file('notes/monday.txt', 'Call the bank\nTODO: renew passport\nLunch with Sam\n');
    env.file('notes/tuesday.txt', 'Gym at 7\nTODO: fix the bike\n');
    env.file('notes/ideas/app.txt', 'An app that waters plants\nTODO: sketch the screens\n');
  },
  intro: `
\`grep\` prints every line of a file that contains a pattern. It is the command-line version of *Find*, except that it can search thousands of files at once and plugs into pipes.

\`\`\`
grep  [options]  PATTERN  FILE...
\`\`\`

The most useful options:

| Option | Meaning |
| --- | --- |
| \`-i\` | ignore upper/lower case |
| \`-n\` | show line numbers |
| \`-c\` | just count matching lines |
| \`-v\` | invert: show lines that do **not** match |
| \`-r\` | search every file in a folder, recursively |
| \`-E\` | extended patterns, e.g. \`"WARN|ERROR"\` |

> [!TIP]
> Put the pattern in quotes when it contains spaces or special characters: \`grep "connection refused" server.log\`.
`,
  steps: [
    {
      id: 'basic',
      title: 'Find the errors',
      instruction: 'Show every line containing ERROR in the server log:\n\n`$ grep ERROR server.log`',
      solution: ['grep ERROR server.log'],
      explain: 'Matches are highlighted in red. grep searched every line and printed only the ones containing ERROR.',
      check: ran('grep', { args: ['ERROR', 'server.log'] }),
    },
    {
      id: 'ignore-case',
      title: 'Ignore case',
      instruction: 'One error was written in lowercase and slipped through. Search again, ignoring case:\n\n`$ grep -i error server.log`',
      solution: ['grep -i error server.log'],
      explain: 'With `-i`, `error`, `Error` and `ERROR` all match, so you found the one from 10:05 too.',
      check: ran('grep', { flags: 'i', args: [/^error$/i] }),
    },
    {
      id: 'count',
      title: 'Count them',
      instruction: 'How many warnings were there? `-c` counts matching lines instead of printing them:\n\n`$ grep -c WARN server.log`',
      solution: ['grep -c WARN server.log'],
      check: ran('grep', { flags: 'c' }),
    },
    {
      id: 'numbers',
      title: 'Where exactly?',
      instruction: 'Show line numbers with `-n`, so you can find the lines in an editor:\n\n`$ grep -n timeout server.log`',
      solution: ['grep -n timeout server.log'],
      explain: 'Each match is prefixed with its line number. `nano +15 server.log` would open the file right at line 15.',
      check: ran('grep', { flags: 'n' }),
    },
    {
      id: 'invert',
      title: 'Hide the noise',
      instruction: 'Most lines are routine INFO messages. Show everything **except** those with `-v`:\n\n`$ grep -v INFO server.log`',
      solution: ['grep -v INFO server.log'],
      explain: '`-v` inverts the match. It is perfect for filtering out noise from logs.',
      check: ran('grep', { flags: 'v' }),
    },
    {
      id: 'either',
      title: 'This or that',
      instruction: 'Show warnings **and** errors at once. With `-E`, the `|` inside the quotes means "or":\n\n`$ grep -E "WARN|ERROR" server.log`',
      hint: 'Keep the quotes! Without them the shell would treat `|` as a pipe.',
      solution: ['grep -E "WARN|ERROR" server.log'],
      check: all(ran('grep', { flags: 'E' }), lineMatches(/WARN\|ERROR|ERROR\|WARN/)),
    },
    {
      id: 'recursive',
      title: 'Search a whole folder',
      instruction: 'Find every TODO in all your notes, including subfolders:\n\n`$ grep -r TODO notes`',
      solution: ['grep -r TODO notes'],
      explain: 'With `-r`, grep walks through every file under `notes` and prefixes each match with the file it came from.',
      check: any(ran('grep', { flags: 'r' }), ran('grep', { flags: 'R' })),
    },
  ],
  recap: `
- \`grep PATTERN FILE\` prints matching lines.
- \`-i\` ignores case, \`-n\` numbers lines, \`-c\` counts, \`-v\` inverts, \`-r\` searches folders.
- \`-E "A|B"\` matches either pattern. Quote patterns with spaces or special characters.
- grep also filters other commands' output: \`history | grep cd\`.
`,
  cheatsheet: [
    ['grep WORD FILE', 'lines containing WORD'],
    ['grep -i WORD FILE', 'ignore case'],
    ['grep -n / -c / -v', 'line numbers / count / invert'],
    ['grep -r WORD FOLDER', 'search every file in a folder'],
    ['grep -E "A|B" FILE', 'lines matching A or B'],
    ['COMMAND | grep WORD', "filter a command's output"],
  ],
  realWorld: `
On **macOS**, \`grep\` is the BSD version: the options in this lesson behave the same. On **Windows PowerShell** the rough equivalent is \`Select-String\`.
`,
};

export const findLesson: Lesson = {
  id: 'find',
  title: 'Finding files with find',
  summary: 'Track down files by name, type, size and age, and act on everything you find.',
  moduleId: 'text',
  minutes: 9,
  setup: (env) => {
    env.dir('archive');
    env.file('archive/2024/holiday/beach.jpg', 'JPEG', { daysAgo: 400 });
    env.file('archive/2024/holiday/sunset.JPG', 'JPEG', { daysAgo: 400 });
    env.file('archive/2024/report.txt', 'Annual report\n', { daysAgo: 300 });
    env.file('archive/2025/party.jpg', 'JPEG', { daysAgo: 30 });
    env.file('archive/2025/budget.csv', 'item,cost\n', { daysAgo: 20 });
    env.file('archive/2025/video-raw.mov', 'x'.repeat(250000), { daysAgo: 25 });
    env.file('archive/drafts/letter.txt', 'Dear Sam,\n', { daysAgo: 2 });
    env.file('archive/drafts/~letter.tmp', '', { daysAgo: 2 });
    env.file('archive/drafts/cache.tmp', 'cache', { daysAgo: 2 });
    env.file('archive/notes.txt', 'remember the milk\n', { daysAgo: 1 });
  },
  startDir: 'archive',
  intro: `
\`ls\` shows one folder at a time. \`find\` searches a folder **and everything below it**, testing each file against the rules you give it:

\`\`\`
find  WHERE   TESTS...           ACTION
find  .       -name "*.jpg"      -print   (the default)
\`\`\`

| Test | Matches |
| --- | --- |
| \`-name "*.txt"\` | names matching a pattern (\`-iname\` ignores case) |
| \`-type f\` / \`-type d\` | files / directories |
| \`-size +100k\` | bigger than 100 KB (\`-1M\` = smaller than 1 MB) |
| \`-mtime -7\` | modified in the last 7 days |

> [!WARNING]
> Always put the pattern in **quotes**: \`find . -name "*.jpg"\`. Without them the shell expands \`*.jpg\` itself *before* find runs, and you get confusing results or errors.
`,
  steps: [
    {
      id: 'everything',
      title: 'Everything, everywhere',
      instruction: "You're in a folder called `archive`. List every file and folder inside it, at any depth:\n\n`$ find .`",
      solution: ['find .'],
      explain: '`.` means "start here". find printed the path of every single item below this folder.',
      check: ran('find'),
    },
    {
      id: 'by-name',
      title: 'Search by name',
      instruction: 'Find all the JPEG photos:\n\n`$ find . -name "*.jpg"`',
      solution: ['find . -name "*.jpg"'],
      explain: 'Only two? `sunset.JPG` has an uppercase extension, and `-name` is case-sensitive. Next, fix that.',
      check: ran('find', { args: ['-name', '*.jpg'] }),
    },
    {
      id: 'iname',
      title: 'Ignore case',
      instruction: 'Use `-iname` to match the name in any case:\n\n`$ find . -iname "*.jpg"`',
      solution: ['find . -iname "*.jpg"'],
      check: ran('find', { args: ['-iname'] }),
    },
    {
      id: 'dirs',
      title: 'Only folders',
      instruction: 'Show only directories:\n\n`$ find . -type d`',
      solution: ['find . -type d'],
      check: ran('find', { args: ['-type', 'd'] }),
    },
    {
      id: 'big',
      title: 'What is taking up space?',
      instruction: 'Find files bigger than 100 kilobytes:\n\n`$ find . -type f -size +100k`',
      hint: '`+100k` means "more than 100 KB". Tests are combined with AND automatically.',
      solution: ['find . -type f -size +100k'],
      explain: 'Hunting for big files is a classic way to free up disk space. Add `-exec ls -lh {} \\;` to see each file\'s size too.',
      check: ran('find', { args: ['-size'] }),
    },
    {
      id: 'recent',
      title: 'What changed recently?',
      instruction: 'Find files modified in the last 7 days:\n\n`$ find . -type f -mtime -7`',
      solution: ['find . -type f -mtime -7'],
      check: ran('find', { args: ['-mtime'] }),
    },
    {
      id: 'delete',
      title: 'Clean up temporary files',
      instruction: 'find can also **act** on what it finds. First check what would match, then delete it:\n\n`$ find . -name "*.tmp"`\n\n`$ find . -name "*.tmp" -delete`',
      hint: 'Always run the search without `-delete` first to see exactly what will be removed.',
      solution: ['find . -name "*.tmp"', 'find . -name "*.tmp" -delete'],
      explain: 'Both `.tmp` files are gone. `-delete` cannot be undone, which is why the habit of looking first matters.',
      check: all(missing('~/archive/drafts/cache.tmp'), missing('~/archive/drafts/~letter.tmp')),
    },
  ],
  recap: `
- \`find WHERE TESTS\` searches a whole folder tree.
- \`-name\`/\`-iname\` match names (quote the pattern!), \`-type f\`/\`-type d\` pick files or folders, \`-size\` and \`-mtime\` filter by size and age.
- Actions like \`-delete\` and \`-exec\` do something with every match. Look before you delete.
`,
  cheatsheet: [
    ['find .', 'everything below here'],
    ['find . -name "*.txt"', 'by name (case-sensitive)'],
    ['find . -iname "*.jpg"', 'by name, any case'],
    ['find . -type d', 'only directories'],
    ['find . -size +10M', 'bigger than 10 MB'],
    ['find . -mtime -7', 'changed in the last week'],
    ['find . -name "*.tmp" -delete', 'delete matches (careful!)'],
  ],
};

const SALES = [
  'date,region,product,units,price',
  '2026-09-01,North,Notebook,12,3.50',
  '2026-09-01,South,Pen,40,0.80',
  '2026-09-02,East,Backpack,3,24.00',
  '2026-09-02,North,Pen,25,0.80',
  '2026-09-03,West,Notebook,8,3.50',
  '2026-09-03,South,Notebook,15,3.50',
  '2026-09-04,East,Pen,30,0.80',
  '2026-09-04,North,Stapler,4,7.25',
  '2026-09-05,West,Pen,22,0.80',
  '2026-09-05,South,Backpack,2,24.00',
  '2026-09-06,North,Notebook,10,3.50',
  '2026-09-06,East,Notebook,6,3.50',
  '2026-09-07,South,Pen,35,0.80',
  '2026-09-07,West,Stapler,2,7.25',
];

export const dataWrangling: Lesson = {
  id: 'data-wrangling',
  title: 'Slicing and dicing data',
  summary: 'Answer real questions about a spreadsheet and a web server log using cut, sort, uniq, tr and sed.',
  moduleId: 'text',
  minutes: 10,
  setup: (env) => {
    env.file('sales.csv', SALES.join('\n') + '\n');
  },
  intro: `
Plenty of data lives in plain text: CSV spreadsheets, logs, exports. You don't need a spreadsheet program to answer questions about it. A few tools go a very long way:

| Tool | Job |
| --- | --- |
| \`cut -d, -f2\` | keep only column 2 of comma-separated lines |
| \`tail -n +2\` | skip the first line (a header row) |
| \`sort\`, \`uniq -c\` | group and count |
| \`tr\` | translate characters (e.g. lowercase to uppercase) |
| \`sed 's/old/new/'\` | find and replace on every line |

You'll work with \`sales.csv\`, a small sales spreadsheet.
`,
  steps: [
    {
      id: 'peek',
      title: 'Look at the data',
      instruction: 'Always start by looking at the first few lines:\n\n`$ head -5 sales.csv`',
      solution: ['head -5 sales.csv'],
      explain: 'The first line is a **header** naming the columns: date, region, product, units, price. Commas separate the columns.',
      check: ran('head'),
    },
    {
      id: 'cut',
      title: 'One column',
      instruction: 'Pull out just the region column (the 2nd field, separated by commas):\n\n`$ cut -d, -f2 sales.csv`',
      hint: '`-d,` sets the delimiter to a comma; `-f2` picks field 2.',
      solution: ['cut -d, -f2 sales.csv'],
      check: ran('cut', { args: [/^-?f?2$/] }),
    },
    {
      id: 'count-regions',
      title: 'Orders per region',
      instruction: 'Skip the header with `tail -n +2`, then count orders per region:\n\n`$ tail -n +2 sales.csv | cut -d, -f2 | sort | uniq -c`',
      solution: ['tail -n +2 sales.csv | cut -d, -f2 | sort | uniq -c'],
      explain: '`tail -n +2` means "start at line 2", which drops the header so it is not counted as a region. North and South have the most orders.',
      check: all(ran('tail'), ran('cut'), ran('uniq', { flags: 'c' })),
    },
    {
      id: 'best-product',
      title: 'Most popular product',
      instruction: 'Rank products by how often they were ordered:\n\n`$ tail -n +2 sales.csv | cut -d, -f3 | sort | uniq -c | sort -rn`',
      solution: ['tail -n +2 sales.csv | cut -d, -f3 | sort | uniq -c | sort -rn'],
      check: all(ran('cut'), ran('uniq', { flags: 'c' }), ran('sort', { flags: 'rn' })),
    },
    {
      id: 'biggest-order',
      title: 'Biggest order',
      instruction: 'Sort by the units column numerically and show the largest:\n\n`$ sort -t, -k4 -n sales.csv | tail -1`',
      hint: '`-t,` tells sort the columns are separated by commas, `-k4` sorts by the 4th column, `-n` sorts numerically.',
      solution: ['sort -t, -k4 -n sales.csv | tail -1'],
      explain: 'Without `-n`, "40" would sort before "8" because sort compares text character by character. `-n` compares numbers by value.',
      check: all(ran('sort', { flags: 'n' }), ran('sort', { args: [/^-?t?,$/, /^-?k?4/] })),
    },
    {
      id: 'tr',
      title: 'Shout it',
      instruction: '`tr` translates characters. Turn the regions into capital letters:\n\n`$ cut -d, -f2 sales.csv | tr a-z A-Z`',
      solution: ['cut -d, -f2 sales.csv | tr a-z A-Z'],
      check: ran('tr'),
    },
    {
      id: 'sed',
      title: 'Find and replace',
      instruction: "`sed` edits text as it flows past. Replace every comma with a tab-friendly ` | ` to make the file easier to read:\n\n`$ sed 's/,/ | /g' sales.csv`",
      hint: '`s/old/new/` replaces the first match on each line; the `g` at the end means *every* match.',
      solution: ["sed 's/,/ | /g' sales.csv"],
      explain: "`sed` never changes the file itself unless you add `-i`; it prints the edited result. Save it with `> sales.txt` if you like it.",
      check: ran('sed'),
    },
  ],
  recap: `
- Look first: \`head\`. Skip a header row: \`tail -n +2\`.
- \`cut -d, -fN\` pulls out a column; \`sort -t, -kN -n\` sorts by a numeric column.
- \`sort | uniq -c | sort -rn\` counts and ranks anything.
- \`tr\` translates characters; \`sed 's/old/new/g'\` finds and replaces.
`,
  cheatsheet: [
    ['cut -d, -f2 FILE', 'column 2 of a CSV'],
    ['tail -n +2 FILE', 'everything except the first line'],
    ['sort -t, -k4 -n FILE', 'sort a CSV by column 4, numerically'],
    ['tr a-z A-Z', 'convert to upper case'],
    ["sed 's/old/new/g' FILE", 'replace text on every line'],
    ["awk -F, '{print $2}' FILE", 'print column 2 (awk is a more powerful cut)'],
  ],
  realWorld: `
On **macOS**, \`sed -i\` needs an argument for the backup suffix (\`sed -i '' 's/a/b/' file\`); everything else in this lesson works the same.
`,
};

export const textLessons: Lesson[] = [pipes, grepLesson, findLesson, dataWrangling];
