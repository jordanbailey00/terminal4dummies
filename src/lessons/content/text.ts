// Module: Pipes and power tools.

import { ROOT_CREDS } from '../../shell/vfs/fs';
import { all, any, exists, missing, ran, lineMatches } from '../checks';
import type { CheckContext, Lesson, LessonSetupEnv } from '../types';

/** Every listed command ran as part of the same command line. */
function pipeline(...names: string[]) {
  return (c: CheckContext) => !!c.ev && names.every((n) => c.ev!.execs.some((e) => e.argv[0]?.split('/').pop() === n));
}

const base = (path: string | undefined) => path?.split('/').pop() ?? '';

/** The last command's output as trimmed, non-blank lines, with runs of spaces squeezed to one. */
function outputLines(c: CheckContext): string[] {
  return c.ev ? c.ev.output.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
}

/** The last command printed every one of `want` and none of `unwanted`. */
function showsOnly(c: CheckContext, want: string[], unwanted: string[]): boolean {
  if (!c.ev) return false;
  const out = c.ev.output;
  return want.every((l) => out.includes(l)) && !unwanted.some((l) => out.includes(l));
}

/** What `ls DIR` lists: every name in the folder except hidden ones. */
function visibleNames(c: CheckContext, dir: string): string[] {
  try {
    return c.sys.fs.readdir(dir, { cwd: '/', creds: ROOT_CREDS }).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

/** A binary file (a photo, a video...) of a given size, owned by the learner. */
function blob(env: LessonSetupEnv, path: string, description: string, size: number, daysAgo: number): void {
  env.dir(path.slice(0, path.lastIndexOf('/')));
  const node = env.sys.fs.writeFile(`${env.home}/${path}`, { kind: 'blob', description, payload: null, size }, { cwd: '/', creds: ROOT_CREDS, umask: 0o002 }, { mode: 0o664 });
  node.mode = 0o664;
  node.uid = 1000;
  node.gid = 1000;
  node.mtime = node.atime = env.sys.now() - daysAgo * 86400 * 1000;
}

const NAMES = ['Zoe', 'adam', 'Maya', 'Liam', 'zoe', 'Maya', 'Noah', 'Ava', 'Liam', 'Maya', 'Ella', 'Noah', 'Maya', 'Ava', 'Owen'];

/** The quiz's ice cream vote: one flavor per line. */
const VOTES = ['vanilla', 'chocolate', 'mint', 'strawberry', 'chocolate', 'lemon', 'vanilla', 'strawberry', 'chocolate', 'mint', 'strawberry', 'chocolate', 'vanilla', 'strawberry', 'chocolate'];

const FLAVORS = [...new Set(VOTES)].sort();

/** Each flavor with its number of votes, most votes first. */
const RANKED = FLAVORS.map((flavor) => ({ flavor, votes: VOTES.filter((v) => v === flavor).length })).sort((a, b) => b.votes - a.votes);

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
  quizSetup: (env) => {
    env.file('votes.txt', VOTES.join('\n') + '\n');
  },
  quiz: [
    {
      kind: 'task',
      prompt: 'How many files and folders does `ls /etc` list? Instead of counting them yourself, connect `ls` to a command that counts.',
      hint: 'Going into a pipe, `ls` prints one name per line. Which command counts lines?',
      solution: ['ls /etc | wc -l'],
      explain: 'The pipe hands everything `ls` prints to `wc -l`, which counts the lines it receives: one line for each name.',
      check: (c) =>
        !!c.ev &&
        c.ev.execs.some((e) => base(e.argv[0]) === 'ls' && e.argv.some((a) => /^\/etc\/?$/.test(a))) &&
        new RegExp(`^\\s*${visibleNames(c, '/etc').length}\\b`).test(c.ev.output),
    },
    {
      kind: 'task',
      prompt: '`votes.txt` holds the answers to *What is your favorite ice cream?*, one per line. Show each flavor only once, in alphabetical order.',
      hint: '`uniq` only drops repeats that sit right next to each other, so get them next to each other first.',
      solution: ['sort votes.txt | uniq'],
      explain: '`sort` puts identical lines together and `uniq` keeps one of each. `sort -u votes.txt` does both jobs in one go.',
      check: (c) => outputLines(c).join('\n') === FLAVORS.join('\n'),
    },
    {
      prompt: 'Why is `red` still in the list twice?\n\n```\n$ cat colors.txt\nred\nblue\nred\n$ uniq colors.txt\nred\nblue\nred\n```',
      options: ['`uniq` only works on text that comes through a pipe', '`uniq` needs `-c` before it removes anything', '`uniq` only removes repeated lines that are next to each other'],
      answer: 2,
      explain: '`uniq` compares each line only with the one just before it, which is why it almost always comes after `sort`: `sort colors.txt | uniq` prints `blue` and `red` once each.',
    },
    {
      kind: 'task',
      prompt: 'Which two flavors in `votes.txt` got the most votes? Show just those two, each with its number of votes, the winner first.',
      hint: 'Start like before, but count the repeats this time. Then sort the counts as numbers, biggest first, and keep the top two lines.',
      solution: ['sort votes.txt | uniq -c | sort -rn | head -2'],
      explain: `\`uniq -c\` counts each flavor, \`sort -rn\` puts the biggest count first and \`head -2\` keeps the top two: ${RANKED[0].flavor} with ${RANKED[0].votes} votes and ${RANKED[1].flavor} with ${RANKED[1].votes}.`,
      check: (c) => outputLines(c).join('\n') === RANKED.slice(0, 2).map((r) => `${r.votes} ${r.flavor}`).join('\n'),
    },
    {
      kind: 'task',
      prompt: 'How many programs in `/usr/bin` have *dir* somewhere in their name, like `mkdir` and `rmdir`? Let the computer count them.',
      hint: 'Build it step by step: list the programs, keep only the names containing *dir*, then count what is left.',
      solution: ['ls /usr/bin | grep dir | wc -l'],
      explain: 'Three tools, one answer: `ls` lists, `grep` keeps the matching names and `wc -l` counts them. (`grep -c dir` would count the matching lines by itself.)',
      check: (c) => !!c.ev && c.ev.line.includes('/usr/bin') && c.ev.output.trim() === String(visibleNames(c, '/usr/bin').filter((n) => n.includes('dir')).length),
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

/** The quiz's log of an online shop. */
const SHOP_LOG = [
  '2026-10-20 09:00:01 INFO  shop opened, 42 products online',
  '2026-10-20 09:05:13 INFO  customer 1017 logged in',
  '2026-10-20 09:06:40 WARN  stock low: blue mugs (3 left)',
  '2026-10-20 09:12:02 ERROR card payment timeout for order 5531',
  '2026-10-20 09:12:05 INFO  order 5531 paid on second try',
  '2026-10-20 09:30:44 INFO  customer 1022 logged in',
  '2026-10-20 09:41:19 WARN  checkout page slow, close to timeout (4.2s)',
  '2026-10-20 10:02:37 ERROR Timeout while sending receipt email',
  '2026-10-20 10:02:38 INFO  receipt email queued',
  '2026-10-20 10:15:00 INFO  daily backup finished',
  '2026-10-20 10:20:51 WARN  stock low: green socks (1 left)',
  '2026-10-20 10:33:12 ERROR TIMEOUT talking to the warehouse',
  '2026-10-20 10:33:30 INFO  warehouse connection restored',
  '2026-10-20 10:45:09 INFO  customer 1031 logged in',
  '2026-10-20 10:52:40 WARN  coupon SAVE10 used 50 times today',
  '2026-10-20 11:00:00 INFO  hourly report sent',
  '2026-10-20 11:04:27 INFO  customer 1017 logged out',
];

const SHOP_TIMEOUTS = SHOP_LOG.filter((l) => /timeout/i.test(l));
const SHOP_INFO = SHOP_LOG.filter((l) => l.includes('INFO'));
const SHOP_WARNINGS = SHOP_LOG.filter((l) => l.includes('WARN')).length;

const COOKBOOK: Record<string, string> = {
  'cookbook/soup.txt': 'Tomato soup\n\n4 ripe tomatoes\n1 onion\n2 cloves of garlic\n1 l vegetable stock\n',
  'cookbook/bread.txt': 'Garlic bread\n\n1 baguette\n50 g soft butter\n3 cloves of garlic, crushed\nparsley\n',
  'cookbook/cake.txt': 'Chocolate cake\n\n200 g dark chocolate\n200 g butter\n4 eggs\n150 g sugar\n',
  'cookbook/sauces/pesto.txt': 'Pesto\n\n2 handfuls of basil\n1 clove of garlic\n50 g pine nuts\n50 g parmesan\nolive oil\n',
  'cookbook/sauces/caramel.txt': 'Caramel sauce\n\n200 g sugar\n100 ml cream\n30 g butter\na pinch of salt\n',
};

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
  quizSetup: (env) => {
    env.file('shop.log', SHOP_LOG.join('\n') + '\n');
    for (const [path, text] of Object.entries(COOKBOOK)) env.file(path, text, { daysAgo: 6 });
  },
  quiz: [
    {
      kind: 'task',
      prompt: 'Show every line of `shop.log` that mentions a timeout, however it was written: *timeout*, *Timeout* or *TIMEOUT*.',
      hint: 'grep has an option that makes it ignore the difference between capital and small letters.',
      solution: ['grep -i timeout shop.log'],
      explain: 'With `-i`, grep ignores upper and lower case, so one search finds all three spellings. Without it, `grep timeout shop.log` finds only the lowercase ones.',
      check: (c) => showsOnly(c, SHOP_TIMEOUTS, SHOP_LOG.filter((l) => !SHOP_TIMEOUTS.includes(l))),
    },
    {
      kind: 'task',
      prompt: 'How many lines in `shop.log` are warnings (marked WARN)? Get the answer as a number.',
      hint: 'grep has an option that prints how many lines match, instead of the lines themselves.',
      solution: ['grep -c WARN shop.log'],
      explain: `\`grep -c\` counts the matching lines: ${SHOP_WARNINGS}. Piping the matches into \`wc -l\` gives the same answer.`,
      check: (c) => !!c.ev && ran('grep')(c) && /warn/i.test(c.ev.line) && c.ev.output.trim() === String(SHOP_WARNINGS),
    },
    {
      prompt: 'Why did this go wrong?\n\n```\n$ grep -E WARN|ERROR server.log\nERROR: command not found\n```',
      options: ['There is no line with ERROR in `server.log`', '`-E` patterns may only contain one word', 'The shell took `|` as a pipe and ran `ERROR` as a command', 'grep is case-sensitive and needed `-i`'],
      answer: 2,
      explain: 'The shell handles `|` before grep ever sees it, so it split the line into `grep -E WARN` and a command called `ERROR`. Quote the pattern, as in `grep -E "WARN|ERROR" server.log`, and the `|` reaches grep, where it means *or*. (The broken version leaves grep waiting for keyboard input: press <kbd>Ctrl</kbd>+<kbd>C</kbd>.)',
    },
    {
      kind: 'task',
      prompt: 'Most of `shop.log` is routine INFO messages. Show every line **except** those.',
      hint: 'grep can turn a search around and show the lines that do *not* match.',
      solution: ['grep -v INFO shop.log'],
      explain: '`-v` inverts the search: it hides every line containing INFO and shows all the others, a quick way to cut the noise out of a log.',
      check: (c) => showsOnly(c, SHOP_LOG.filter((l) => !SHOP_INFO.includes(l)), SHOP_INFO),
    },
    {
      kind: 'task',
      prompt: 'Which recipes in the `cookbook` folder, subfolders included, mention *garlic*? Search them all with one command.',
      hint: 'grep can walk through a folder and everything below it, with the right option.',
      solution: ['grep -r garlic cookbook'],
      explain: '`-r` makes grep search every file below the folder, and each match starts with the name of the file it came from: the soup, the garlic bread and the pesto in `sauces`.',
      check: (c) => ran('grep')(c) && showsOnly(c, ['soup.txt', 'bread.txt', 'pesto.txt'], ['cake.txt', 'caramel.txt']),
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

/** Every file below ~/archive in the find quiz (lesson files plus the quiz's extras). */
const ARCHIVE_FILES = [
  '2024/holiday/beach.jpg',
  '2024/holiday/sunset.JPG',
  '2024/holiday/clip.mp4',
  '2024/report.txt',
  '2024/taxes.pdf',
  '2025/party.jpg',
  '2025/budget.csv',
  '2025/budget.csv.bak',
  '2025/video-raw.mov',
  '2025/tickets.PDF',
  'drafts/letter.txt',
  'drafts/letter.txt.bak',
  'drafts/~letter.tmp',
  'drafts/cache.tmp',
  'drafts/old/manual.pdf',
  'notes.txt',
  'notes.txt.bak',
];

const ARCHIVE_DIRS = ['2024', '2024/holiday', '2025', 'drafts', 'drafts/old'];
const ARCHIVE_PDFS = ARCHIVE_FILES.filter((f) => /\.pdf$/i.test(f));
const ARCHIVE_BAKS = ARCHIVE_FILES.filter((f) => f.endsWith('.bak'));

/** The last command's output lines as paths relative to ~/archive ("" for the folder itself). */
function archivePaths(c: CheckContext): string[] {
  return outputLines(c).map((l) => l.replace(/^(\/home\/learner\/archive|~\/archive|\.)(\/|$)/, '').replace(/\/$/, ''));
}

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
      solution: ['find . -name "*.tmp"', 'find . -name "*.tmp" -delete'],
      explain: 'Both `.tmp` files are gone. `-delete` cannot be undone, which is why the habit of looking first matters.',
      check: all(missing('~/archive/drafts/cache.tmp'), missing('~/archive/drafts/~letter.tmp')),
    },
  ],
  quizSetup: (env) => {
    blob(env, 'archive/2024/taxes.pdf', 'PDF document, version 1.7, 4 page(s)', 61_337, 200);
    blob(env, 'archive/2025/tickets.PDF', 'PDF document, version 1.4, 1 page(s)', 18_204, 40);
    blob(env, 'archive/drafts/old/manual.pdf', 'PDF document, version 1.6, 32 page(s)', 2_406, 90);
    blob(env, 'archive/2024/holiday/clip.mp4', 'ISO Media, MP4 v2 [ISO 14496-14]', 1_350_000, 380);
    env.file('archive/2025/budget.csv.bak', 'item,cost\n', { daysAgo: 21 });
    env.file('archive/drafts/letter.txt.bak', 'Dear Sam,\n', { daysAgo: 3 });
    env.file('archive/notes.txt.bak', 'remember the milk\n', { daysAgo: 6 });
  },
  quiz: [
    {
      kind: 'task',
      prompt: 'Find every PDF below this folder, whether its name ends in `.pdf` or in `.PDF`.',
      hint: '`-name` cares about capital letters. It has a sister test that does not.',
      solution: ['find . -iname "*.pdf"'],
      explain: '`-iname` matches the pattern in any case, so it finds `.pdf` and `.PDF` alike. Keep the quotes, so that the shell leaves the `*` for find.',
      check: (c) => ran('find')(c) && showsOnly(c, ARCHIVE_PDFS, ['.jpg', '.JPG', '.mp4', '.txt', '.csv', '.mov', '.tmp', '.bak']),
    },
    {
      kind: 'task',
      prompt: 'Something below this folder takes up a lot of space. Find the files that are bigger than 1 megabyte.',
      hint: 'find has a test for sizes. A `+` in front of the size means *more than*, and `M` stands for megabytes.',
      solution: ['find . -size +1M'],
      explain: '`-size +1M` keeps the files bigger than 1 megabyte (`k` is for kilobytes, `G` for gigabytes). A forgotten video is a classic way to fill up a disk.',
      check: (c) => ran('find')(c) && showsOnly(c, ['2024/holiday/clip.mp4'], ARCHIVE_FILES.filter((f) => !f.endsWith('clip.mp4'))),
    },
    {
      prompt: 'Which command finds files that were modified in the last 7 days?',
      options: ['`find . -mtime +7`', '`find . -mtime 7`', '`find . -size -7`', '`find . -mtime -7`'],
      answer: 3,
      explain: 'For `-mtime`, a minus means *less than* that many days ago, so `-7` finds recent changes, while `+7` finds files older than that. `-size` uses the same `+` and `-` idea for sizes.',
    },
    {
      kind: 'task',
      prompt: 'List only the folders inside this one, at any depth, without the files.',
      hint: 'find can test what *type* of thing each item is.',
      solution: ['find . -type d'],
      explain: '`-type d` keeps only directories (`-type f` would keep only regular files). The `.` at the top is the folder you started from.',
      check: (c) => {
        const found = archivePaths(c).filter((p) => p !== '');
        return ran('find')(c) && found.length === ARCHIVE_DIRS.length && ARCHIVE_DIRS.every((d) => found.includes(d));
      },
    },
    {
      kind: 'task',
      prompt: 'Time to clean up: delete every `.bak` backup file below this folder, wherever it is, and leave everything else alone.',
      hint: 'Search by name first to see what would go, then add the action that deletes every match.',
      solution: ['find . -name "*.bak"', 'find . -name "*.bak" -delete'],
      explain: '`-delete` removes every match without asking, and there is no trash to get them back from. That is why it pays to run the same search without `-delete` first.',
      check: all(...ARCHIVE_BAKS.map((f) => missing(`archive/${f}`)), ...ARCHIVE_FILES.filter((f) => !ARCHIVE_BAKS.includes(f)).map((f) => exists(`archive/${f}`))),
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

/** The quiz's spreadsheet: one pet per line. */
const PETS = [
  'name,species,age,city',
  'Biscuit,dog,3,Denver',
  'Luna,cat,12,Austin',
  'Pickles,rabbit,2,Denver',
  'Max,dog,9,Boston',
  'Mochi,cat,1,Austin',
  'Shadow,cat,15,Boston',
  'Pepper,parrot,23,Denver',
  'Rocky,dog,5,Austin',
  'Nugget,hamster,1,Boston',
  'Willow,cat,7,Denver',
];

const PET_ROWS = PETS.slice(1).map((l) => l.split(','));
const OLDEST_PET = PETS.slice(1).sort((a, b) => Number(a.split(',')[2]) - Number(b.split(',')[2])).pop()!;

/** "COUNT species" for every species, as `uniq -c` prints them (squeezed). */
const SPECIES_COUNTS = [...new Set(PET_ROWS.map((r) => r[1]))].map((s) => `${PET_ROWS.filter((r) => r[1] === s).length} ${s}`);

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
      solution: ["sed 's/,/ | /g' sales.csv"],
      explain: "`sed` never changes the file itself unless you add `-i`; it prints the edited result. Save it with `> sales.txt` if you like it.",
      check: ran('sed'),
    },
  ],
  quizSetup: (env) => {
    env.file('pets.csv', PETS.join('\n') + '\n');
  },
  quiz: [
    {
      kind: 'task',
      prompt: '`pets.csv` is a small spreadsheet of pets. Show just the city of each pet, one per line.',
      hint: 'The first line names the columns, so you can see which one holds the city. Then cut out that field; commas separate the columns.',
      solution: ['cut -d, -f4 pets.csv'],
      explain: '`-d,` tells cut that commas separate the columns, and `-f4` picks the 4th one. cut treats the header line like any other, so `cut -d, -f4 pets.csv` prints the word `city` first.',
      check: (c) => {
        const lines = outputLines(c);
        const i = lines.indexOf('city');
        if (i >= 0) lines.splice(i, 1);
        return lines.sort().join('\n') === PET_ROWS.map((r) => r[3]).sort().join('\n');
      },
    },
    {
      kind: 'task',
      prompt: 'How many pets of each species are there in `pets.csv`? Count them, without counting the header line as a species.',
      hint: 'Skip the first line, cut out the species column, then group the same species together and count them.',
      solution: ['tail -n +2 pets.csv | cut -d, -f2 | sort | uniq -c'],
      explain: '`tail -n +2` starts at line 2, which drops the header. Then `cut` picks the species, `sort` puts the same ones together, and `uniq -c` counts them.',
      check: (c) => {
        const lines = outputLines(c);
        return lines.length === SPECIES_COUNTS.length && SPECIES_COUNTS.every((l) => lines.includes(l));
      },
    },
    {
      kind: 'task',
      prompt: "Which pet in `pets.csv` is the oldest? Let `sort` work it out, and show only that pet's line.",
      hint: 'Sort by the 3rd column (tell sort the columns are separated by commas), as numbers, and keep the last line.',
      solution: ['sort -t, -k3 -n pets.csv | tail -1'],
      explain: '`-t,` splits each line at the commas, `-k3` sorts by the 3rd column and `-n` compares the ages as numbers. Without `-n`, sort compares text character by character, so `9` would come after `23`.',
      check: (c) => outputLines(c).join('\n') === OLDEST_PET,
    },
    {
      kind: 'task',
      prompt: 'Show the contents of `pets.csv` with every comma replaced by a semicolon (`;`), without changing the file itself.',
      hint: "Use sed's find and replace, and make sure it replaces *every* comma on a line, not just the first. Put the whole sed instruction in quotes.",
      solution: ["sed 's/,/;/g' pets.csv"],
      explain: "`s/,/;/g` replaces every comma on each line: the `g` stands for *global*. The quotes matter here, because the shell would otherwise take `;` as the end of the command. (`tr , ';' < pets.csv` gives the same result.)",
      check: (c) => !!c.ev && c.ev.output.includes(PETS.join('\n').replace(/,/g, ';')),
    },
    {
      prompt: "What does this print?\n\n```\necho \"red,green,blue\" | sed 's/,/ and /'\n```",
      options: ['`red and green and blue`', '`red and green,blue`', '`red,green,blue`'],
      answer: 1,
      explain: "Without a `g` at the end, `s/old/new/` replaces only the **first** match on each line. `sed 's/,/ and /g'` would replace every comma.",
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
