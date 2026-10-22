// Module: Automating with scripts.

import { all, any, fileContains, fileText, interrupted, isDir, isExecutable, isFile, lineMatches, missing, not, outputIncludes, ran } from '../checks';
import type { CheckContext, Lesson, SolutionAction } from '../types';

type Check = (c: CheckContext) => boolean;

/** A first line that starts bash (or sh). */
const SHEBANG = /^#!\s*(\/usr)?\/bin\/(env\s+)?(bash|sh)\b/;

/** A first line that starts bash. */
const BASH_SHEBANG = /^#!\s*(\/usr)?\/bin\/(env\s+)?bash\b/;

/** The keys that type `text` into nano, save it under its current name and exit. */
function typeInNano(text: string, what: string): SolutionAction[] {
  return [
    { keys: text.trimEnd().replace(/\n/g, '\r'), label: `Type ${what}`, delay: 400 },
    { keys: '\x0f', label: 'Press Ctrl+O to save' },
    { keys: '\r', label: 'Press Enter to keep the file name' },
    { keys: '\x18', label: 'Press Ctrl+X to exit nano' },
  ];
}

/** The last command ran the script `name`, either directly or through bash/sh, and it succeeded. */
function ranScript(name: string, opts: { minArgs?: number } = {}): Check {
  return (c) =>
    !!c.ev &&
    c.ev.execs.some((e) => {
      if (e.status !== 0) return false;
      const cmd = e.argv[0]?.split('/').pop();
      if (cmd === name) return e.argv.length - 1 >= (opts.minArgs ?? 0);
      if ((cmd === 'bash' || cmd === 'sh') && e.argv[1]?.split('/').pop() === name) return e.argv.length - 2 >= (opts.minArgs ?? 0);
      return false;
    });
}

const NANO_SAVE = 'Save with <kbd>Ctrl</kbd>+<kbd>O</kbd> and <kbd>Enter</kbd>, then exit with <kbd>Ctrl</kbd>+<kbd>X</kbd>.';

// ---------------------------------------------------------------------------
// Lesson: Your first shell script

const HELLO = `#!/bin/bash
# My first script
echo "Hello, $USER"
echo "Here is today's date:"
date
`;

const GREET = `#!/bin/bash
# greet.sh: say hello to the people you name
echo "Hello, $1"
echo "Number of names: $#"
echo "All the names: $@"
`;

// Quiz files
const BYE = `#!/bin/bash
echo "Goodbye"
`;

const CHEER = `#!/bin/bash
# cheer.sh: a little encouragement
echo "Well done, $USER. Keep it up."
`;

const WELCOME = `#!/bin/bash
# welcome.sh: welcome the person named in the first argument
echo "Welcome, $1"
`;

const HEY = `#!/bin/bash
# hey: a greeting from your own tools folder
echo "Hey there, $USER"
`;

/** PATH includes ~/tools, and still has the folders it had before. */
const pathIncludesTools: Check = (c) => {
  const parts = (c.sh.state.get('PATH') ?? '').split(':').map((p) => p.replace(/(.)\/+$/, '$1'));
  return parts.some((p) => p === '/home/learner/tools' || p === '~/tools') && parts.includes('/usr/bin') && parts.includes('/bin');
};

export const firstScript: Lesson = {
  id: 'first-script',
  title: 'Your first shell script',
  summary: 'Save commands in a file, run it like a real program, pass it arguments, and make it available from anywhere.',
  moduleId: 'scripting',
  minutes: 12,
  intro: `
A **script** is a text file full of commands. Instead of typing them one by one, you run the file and the shell carries them out in order, from top to bottom. Anything you can type at the prompt can go into a script, and once it's written you can run it as often as you like.

A tiny script looks like this:

\`\`\`
#!/bin/bash
# say hello
echo "Hello, $USER"
\`\`\`

- The first line, \`#!/bin/bash\`, is called the **shebang** (from *hash*, \`#\`, and *bang*, \`!\`). It says which program should run the file: here, bash.
- Lines that start with \`#\` are **comments**: notes for humans, which the shell skips.
- Everything else is ordinary commands, exactly as you would type them.

> [!HOW]
> When you run \`./hello.sh\`, the shell asks Linux to start that file as a program. Linux first checks the \`x\` permission, then peeks at the first two characters of the file. Seeing \`#!\`, it starts the program named on that line and hands it the file, so \`./hello.sh\` quietly becomes \`/bin/bash ./hello.sh\`. That one trick is what lets a plain text file behave like a real program.
`,
  steps: [
    {
      id: 'write',
      title: 'Write a script',
      instruction: `Open a new file in nano:

\`$ nano hello.sh\`

Type these lines:

\`\`\`
${HELLO}\`\`\`

${NANO_SAVE}`,
      hint: 'The first line must be exactly `#!/bin/bash`, with nothing before it. If nano asks *Save modified buffer?* when you exit, press Y and then Enter.',
      solution: ['nano hello.sh', ...typeInNano(HELLO, 'the five lines of the script')],
      explain:
        "Your script is just a text file (`$ cat hello.sh` shows it), and nothing has run yet. The `.sh` at the end of the name is a reminder for humans that it's a shell script; Linux itself doesn't care what a file is called.",
      check: all(isFile('hello.sh'), fileContains('hello.sh', SHEBANG), fileContains('hello.sh', /\becho\b/)),
    },
    {
      id: 'bash-run',
      title: 'Run it with bash',
      instruction: 'Ask bash to run the commands in the file:\n\n`$ bash hello.sh`',
      solution: ['bash hello.sh'],
      explain: 'bash read the file and ran each line in turn. Notice that `$USER` turned into your name: scripts can use variables just like the command line.',
      check: ranScript('hello.sh'),
    },
    {
      id: 'executable',
      title: 'Make it a real command',
      instruction:
        'Typing `bash` every time is a chore; real programs start on their own. Try it:\n\n`$ ./hello.sh`\n\n*Permission denied*: the file isn\'t executable yet. Give it the `x` permission and try again:\n\n`$ chmod +x hello.sh`\n\n`$ ./hello.sh`',
      hint: 'Press ↑ twice to bring back `./hello.sh` after the chmod.',
      solution: ['./hello.sh', 'chmod +x hello.sh', './hello.sh'],
      explain:
        "With the `x` permission and the shebang line, your script behaves like any other program. The `./` is still needed because the current folder isn't in your `PATH`; you'll fix that at the end of this lesson.",
      check: all(isExecutable('hello.sh'), ran('hello.sh', { status: 0 })),
    },
    {
      id: 'arguments',
      title: 'A script with arguments',
      instruction: `Scripts become far more useful when you can hand them information. The words you type after a command are its **arguments**, and inside a script they arrive as special variables:

| Variable | Holds |
| --- | --- |
| \`$1\`, \`$2\`, ... | the first, second... argument |
| \`$#\` | how many arguments there are |
| \`$@\` | all of them |

Create a second script:

\`$ nano greet.sh\`

\`\`\`
${GREET}\`\`\`

${NANO_SAVE} Then make it executable:

\`$ chmod +x greet.sh\``,
      hint: 'Check the dollar signs: `$1`, `$#` and `$@`. If `chmod` says the file does not exist, nano was not saved: open it again with `nano greet.sh`.',
      solution: ['nano greet.sh', ...typeInNano(GREET, 'the script shown above'), 'chmod +x greet.sh'],
      explain: '`greet.sh` is ready to run. Each time it runs, `$1` and friends are filled in afresh from whatever you typed after its name.',
      check: all(isFile('greet.sh'), fileContains('greet.sh', /\$\{?1\b/), isExecutable('greet.sh')),
    },
    {
      id: 'run-arguments',
      title: 'Pass it some names',
      instruction: 'Run it with three names:\n\n`$ ./greet.sh Ada Grace Linus`',
      solution: ['./greet.sh Ada Grace Linus'],
      explain:
        '`$1` was `Ada`, `$#` was 3, and `$@` held all three names. Arguments are split at spaces, so put quotes around anything that belongs together: `$ ./greet.sh "Ada Lovelace" Grace`. Try it with no names at all, too.',
      check: ranScript('greet.sh', { minArgs: 1 }),
    },
    {
      id: 'bin',
      title: 'Give your scripts a home',
      instruction:
        "Your own commands deserve a home of their own. By tradition it's a folder called `bin` (short for *binaries*, a traditional name for programs) inside your home folder. Create it and move the script there, dropping the `.sh`, because commands don't usually have endings:\n\n`$ mkdir -p ~/bin`\n\n`$ mv greet.sh ~/bin/greet`",
      hint: 'Run the commands from your home folder, where `greet.sh` is. `cd` on its own takes you there.',
      solution: ['mkdir -p ~/bin', 'mv greet.sh ~/bin/greet'],
      explain: '`mkdir -p` creates the folder only if it is missing, without complaining. Moving a file keeps its permissions, so `greet` is still executable.',
      check: any(all(isFile('bin/greet'), isExecutable('bin/greet')), all(isFile('bin/greet.sh'), isExecutable('bin/greet.sh'))),
    },
    {
      id: 'path',
      title: 'Run it from anywhere',
      instruction:
        'The shell only finds commands in the folders listed in `PATH`. Put your `bin` folder at the front of that list, go somewhere else, and run your command just by its name:\n\n`$ export PATH="$HOME/bin:$PATH"`\n\n`$ cd /tmp`\n\n`$ greet Ada`',
      hint: 'Type the export line exactly, with the double quotes and the colon. It means: my bin folder, then everything that was in PATH before.',
      solution: ['export PATH="$HOME/bin:$PATH"', 'cd /tmp', 'greet Ada'],
      explain:
        "`greet` now works from any folder, just like `ls`. The `export` only lasts until this shell exits; to keep it, add the same line to the end of `~/.bashrc`. (On a real Ubuntu computer you may not even need that: the login settings in `~/.profile` add `~/bin` to PATH automatically whenever the folder exists, starting from your next login.)",
      check: (c) => !!c.ev && c.ev.execs.some((e) => (e.argv[0] === 'greet' || e.argv[0] === 'greet.sh') && e.kind === 'external' && e.status === 0),
    },
  ],
  quizSetup: (env) => {
    env.file('cheer.sh', CHEER);
    env.file('welcome.sh', WELCOME, { mode: 0o775 });
    env.file('tools/hey', HEY, { mode: 0o775 });
  },
  quiz: [
    {
      prompt: 'What is the first line of a script, `#!/bin/bash`, for?',
      options: [
        'It tells Linux which program should run the file: here, bash',
        "It's only a comment for people reading the script; nothing uses it",
        "It gives the file permission to run, so `chmod +x` isn't needed",
        'It loads your settings from `~/.bashrc` before the commands run',
      ],
      answer: 0,
      explain:
        'When you run `./hello.sh`, Linux sees the `#!` (the **shebang**) and hands the file to the program named after it, `/bin/bash`. It does not make the file executable, though; that is still the job of `chmod +x`.',
    },
    {
      kind: 'task',
      prompt: 'Write a script called `bye.sh` in your home folder that prints `Goodbye`. Its first line should tell Linux to run it with bash.',
      hint: 'Open the new file in nano. The first line starts with `#!`, followed by the full path of bash.',
      solution: ['nano bye.sh', ...typeInNano(BYE, 'the two lines of the script')],
      explain:
        '`#!/bin/bash` on the first line says which program runs the file, and the `echo` line does the work. Run it with `bash bye.sh`, or make it executable first and run `./bye.sh`.',
      check: all(isFile('bye.sh'), fileContains('bye.sh', BASH_SHEBANG), fileContains('bye.sh', /^\s*(echo|printf)\b.*goodbye/im)),
    },
    {
      kind: 'task',
      prompt: 'Your home folder has a script called `cheer.sh`, but running it as `./cheer.sh` fails with *Permission denied*. Fix that, then run it that way.',
      hint: 'The file is missing one permission: the one that lets you run it as a program.',
      solution: ['chmod +x cheer.sh', './cheer.sh'],
      explain: '`chmod +x` gave the file the `x` (execute) permission. Together with its shebang line, that lets you run the script like any other program.',
      check: all(isExecutable('cheer.sh'), ran('cheer.sh', { status: 0 })),
    },
    {
      kind: 'task',
      prompt: 'The script `welcome.sh` (it is already executable) welcomes whoever you name as its first argument. Run it so that it prints `Welcome, Ada Lovelace`.',
      hint: 'Arguments are split at spaces. How can you keep two words together as one argument?',
      solution: ['./welcome.sh "Ada Lovelace"'],
      explain:
        'The quotes hold `Ada Lovelace` together as one argument, so `$1` is the whole name. Without them, `$1` would be just `Ada`, and `Lovelace` would arrive separately, as `$2`.',
      check: all(ranScript('welcome.sh', { minArgs: 1 }), outputIncludes('Welcome, Ada Lovelace')),
    },
    {
      kind: 'task',
      prompt: 'The folder `~/tools` holds a program called `hey`. Add that folder to your `PATH`, keeping everything that is already in it, so that typing just `hey` works in any folder.',
      hint: 'Set `PATH` to the new folder, a colon, and the old value of `PATH`.',
      solution: ['export PATH="$HOME/tools:$PATH"'],
      explain:
        'The shell now also looks in `~/tools` when you type a command name: try `cd /tmp`, then `hey`. Leaving out the `:$PATH` would have thrown the old list away, and then even `ls` would no longer be found.',
      check: pathIncludesTools,
    },
  ],
  recap: `
- A **script** is a text file of commands. Its first line, the shebang \`#!/bin/bash\`, says which program runs it.
- Run it with \`bash script.sh\`, or make it executable with \`chmod +x\` and run \`./script.sh\`.
- Inside a script, \`$1\`, \`$2\`... are the arguments, \`$#\` counts them and \`$@\` holds them all.
- Keep your scripts in \`~/bin\` and put that folder on your \`PATH\` to run them by name from anywhere.
`,
  cheatsheet: [
    ['#!/bin/bash', 'first line of a bash script'],
    ['bash script.sh', 'run a script'],
    ['chmod +x script.sh', 'make it executable'],
    ['./script.sh', 'run it from the current folder'],
    ['$1 $2 ... / $# / $@', 'arguments / how many / all of them'],
    ['export PATH="$HOME/bin:$PATH"', 'run your own commands from anywhere'],
  ],
  realWorld: `
- **macOS** runs bash scripts the same way. Its built-in bash is an old version (3.2), so many people start scripts with \`#!/usr/bin/env bash\`, which uses whichever bash comes first in PATH (for example a newer one from Homebrew). Scripts for zsh start with \`#!/bin/zsh\`.
- **Windows** scripts are usually PowerShell files ending in \`.ps1\` (run as \`.\\script.ps1\`) or older batch files ending in \`.bat\`. In **WSL** bash scripts work as shown here, but a script saved by a Windows editor may have Windows line endings, which causes the error \`/bin/bash^M: bad interpreter\`. Fix the file with \`sed -i 's/\\r$//' script.sh\`.
`,
};

// ---------------------------------------------------------------------------
// Lesson: Decisions and loops

const BACKUP = `#!/bin/bash
# backup.sh: copy every .txt file into backup/
if [ ! -d backup ]; then
  mkdir backup
  echo "Created the backup folder"
fi
count=0
for f in *.txt; do
  cp "$f" backup/
  echo "Saved $f"
  count=$((count + 1))
done
echo "Backed up $count files."
`;

const IF_RE = /\bif\b[\s\S]*\bthen\b[\s\S]*\bfi\b/;

/** The last command was a complete `if` statement whose line also matches `test`. */
function ifWith(test: RegExp): Check {
  return (c) => !!c.ev && !c.ev.syntaxError && IF_RE.test(c.ev.line) && test.test(c.ev.line);
}

const FOR_RE = /\bfor\b[\s\S]*\bin\b[\s\S]*\bdo\b[\s\S]*\bdone\b/;

/** The .txt files in ~/project. */
const TXT_FILES = ['notes.txt', 'todo.txt', 'ideas.txt'];

/** A script for the quiz to fix: no spaces inside the brackets. */
const CHECK_SH = `#!/bin/bash
# check.sh: are the meeting notes here?
if [-f notes.txt]; then
  echo "Found the notes"
else
  echo "No notes here"
fi
`;

/**
 * The last command tested for `archive` and ran `mkdir` only when needed (an
 * `if`, or the short `[ -d archive ] || mkdir archive`), and the folder exists.
 * A `mkdir` that failed (the folder was already there) means the test was wrong.
 */
const madeArchive: Check = (c) =>
  !!c.ev &&
  !c.ev.syntaxError &&
  (IF_RE.test(c.ev.line) || /&&|\|\|/.test(c.ev.line)) &&
  /(\[\[?|\btest)\s[^;]*\barchive\b/.test(c.ev.line) &&
  /\bmkdir\b/.test(c.ev.line) &&
  !c.ev.execs.some((e) => e.argv[0] === 'mkdir' && e.status !== 0) &&
  isDir('project/archive')(c);

export const scriptLogic: Lesson = {
  id: 'script-logic',
  title: 'Decisions and loops',
  summary: 'Teach your scripts to make decisions with if, repeat work with for and while, and write a backup script.',
  moduleId: 'scripting',
  minutes: 12,
  setup: (env) => {
    env.dir('project');
    env.file('project/notes.txt', 'The meeting moved to Friday.\nBring the projector.\n', { daysAgo: 3 });
    env.file('project/todo.txt', 'Write the report\nEmail the team\nBook a room\n', { daysAgo: 1 });
    env.file('project/ideas.txt', 'A robot that waters the plants\nA calendar for cats\n', { daysAgo: 7 });
    env.file('project/budget.csv', 'item,cost\nsnacks,12\nposters,30\n', { daysAgo: 2 });
  },
  startDir: 'project',
  intro: `
So far your scripts run every line, top to bottom. Real automation needs two more skills: **deciding** (do this only if something is true) and **repeating** (do this for every file, or until a job is done).

**Decisions** use \`if\`:

\`\`\`
if [ -f notes.txt ]; then
  echo "Found it"
else
  echo "Not here"
fi
\`\`\`

The \`else\` part is optional, and \`fi\` (*if* backwards) marks the end. The test goes inside square brackets, **with a space after \`[\` and before \`]\`**:

| Test | True when |
| --- | --- |
| \`[ -f FILE ]\` | FILE exists and is a file |
| \`[ -d FOLDER ]\` | FOLDER exists and is a folder |
| \`[ "$a" = "$b" ]\` | the two pieces of text are the same (\`!=\` for different) |
| \`[ "$n" -gt 5 ]\` | the number is **g**reater **t**han 5 (also \`-lt\` less than, \`-ge\`, \`-le\`, \`-eq\` equal, \`-ne\` not equal) |
| \`[ ! -f FILE ]\` | \`!\` turns any test around: FILE does *not* exist |

**Loops** repeat commands. \`for\` runs once for each item in a list, and \`while\` keeps going as long as its test is true:

\`\`\`
for f in *.txt; do
  echo "$f"
done
\`\`\`

\`\`\`
n=1
while [ $n -le 3 ]; do
  echo "$n"
  n=$((n + 1))
done
\`\`\`

\`$(( ))\` does arithmetic: \`$((n + 1))\` is the value of \`n\` plus one.

> [!HOW]
> \`[\` is actually a command (its other name is \`test\`). It checks the condition and exits with status 0 for true or 1 for false, and \`if\` simply runs it and looks at that exit status, just like \`&&\` does. That's why the spaces matter: \`[\` is a command name and \`]\` is its last argument, so \`[-f\` would be an unknown command. It also means \`if\` works with any command at all: \`if grep -q milk list.txt; then ...\`
`,
  steps: [
    {
      id: 'if-file',
      title: 'Make a decision',
      instruction:
        'You can type an `if` straight at the prompt, with `;` instead of new lines. Is there a file called `notes.txt` in this folder?\n\n`$ if [ -f notes.txt ]; then echo "notes.txt is here"; else echo "No notes.txt"; fi`',
      hint: 'Spaces matter: `[ -f notes.txt ]` needs a space after `[` and another before `]`.',
      solution: ['if [ -f notes.txt ]; then echo "notes.txt is here"; else echo "No notes.txt"; fi'],
      explain:
        "It found the file. Press <kbd>↑</kbd>, change `notes.txt` to a name that doesn't exist, and run it again to see the `else` branch. (If you press Enter before an `if` is finished, the shell shows a `>` prompt and waits for the rest.)",
      check: ifWith(/(\[\[?|\btest)\s+(!\s+)?-[fed]\s/),
    },
    {
      id: 'if-text',
      title: 'Compare text',
      instruction: '`=` checks whether two pieces of text are the same. `$USER` holds your user name:\n\n`$ if [ "$USER" = "learner" ]; then echo "Hello, learner"; else echo "Who are you?"; fi`',
      solution: ['if [ "$USER" = "learner" ]; then echo "Hello, learner"; else echo "Who are you?"; fi'],
      explain:
        'Always put double quotes around variables in a test. If a variable is empty, `[ $name = learner ]` turns into `[ = learner ]`, which is an error, while `[ "$name" = learner ]` still works.',
      check: ifWith(/(\[\[?|\btest)\s[^;]*\s(==?|!=)\s/),
    },
    {
      id: 'if-number',
      title: 'Compare numbers',
      instruction:
        'Numbers have their own comparisons, such as `-gt` (greater than) and `-lt` (less than). Set a temperature, then test it:\n\n`$ temp=30`\n\n`$ if [ "$temp" -gt 25 ]; then echo "Hot: ice cream time"; else echo "Not that hot"; fi`\n\n> [!WARNING]\n> Don\'t use `>` or `<` inside `[ ]`. The shell treats them as redirections, so `[ $temp > 25 ]` quietly creates a file called `25` and gives the wrong answer.',
      solution: ['temp=30', 'if [ "$temp" -gt 25 ]; then echo "Hot: ice cream time"; else echo "Not that hot"; fi'],
      explain:
        'Change the temperature with `$ temp=12` and press <kbd>↑</kbd> twice to run the `if` again. Why not use `=` for numbers? Because `=` compares text: `[ 010 = 10 ]` is false, while `[ 010 -eq 10 ]` is true.',
      check: ifWith(/(\[\[?|\btest)\s[^;]*\s-(gt|lt|ge|le|eq|ne)\s|\(\([^)]*[<>=][^)]*\)\)/),
    },
    {
      id: 'for',
      title: 'Repeat for each file',
      instruction: '`for` repeats commands once for every item in a list. With a wildcard, the list is every matching file:\n\n`$ for f in *.txt; do echo "Found: $f"; done`',
      solution: ['for f in *.txt; do echo "Found: $f"; done'],
      explain:
        'The loop ran three times, and each time `$f` held the next file name. Between `do` and `done` you can put any commands: `$ for f in *.txt; do wc -l "$f"; done` counts the lines in each file. The list doesn\'t have to be files, either: `$ for n in 1 2 3; do echo "Number $n"; done`.',
      check: (c) => !!c.ev && !c.ev.syntaxError && /\bfor\b[\s\S]*\bin\b[\s\S]*\bdo\b[\s\S]*\bdone\b/.test(c.ev.line),
    },
    {
      id: 'while',
      title: 'Repeat while something is true',
      instruction:
        '`while` repeats as long as its test stays true. Count five laps:\n\n`$ n=1`\n\n`$ while [ $n -le 5 ]; do echo "Lap $n"; n=$((n + 1)); done`\n\n> [!TIP]\n> If you ever start a loop that never ends, press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop it.',
      solution: ['n=1', 'while [ $n -le 5 ]; do echo "Lap $n"; n=$((n + 1)); done'],
      explain:
        '`-le` means *less than or equal to*. Each lap adds one to `n` with `$(( ))`, the shell\'s calculator, so after lap 5 the test fails and the loop stops. Without the `n=$((n + 1))` the test would stay true forever.',
      check: all(lineMatches(/\b(while|until)\b[\s\S]*\bdo\b[\s\S]*\bdone\b/), lineMatches(/\$\(\(|\(\(|\blet\b/), not(interrupted()), (c) => !!c.ev && !c.ev.syntaxError),
    },
    {
      id: 'write-backup',
      title: 'Write a backup script',
      instruction: `Time to put it all together in a useful script: one that copies every \`.txt\` file into a \`backup\` folder.

\`$ nano backup.sh\`

\`\`\`
${BACKUP}\`\`\`

${NANO_SAVE}`,
      hint: 'The spaces at the start of some lines (the **indentation**) are optional: they only make the script easier to read. Everything else must be typed exactly.',
      solution: ['nano backup.sh', ...typeInNano(BACKUP, 'the script shown above')],
      explain:
        'Read it line by line: create the `backup` folder if it isn\'t there yet, set a counter to zero, then for each text file copy it, report it and add one to the counter. Finally, print the total.',
      check: all(isFile('project/backup.sh'), fileContains('project/backup.sh', /\bfor\b[\s\S]*\bdo\b[\s\S]*\bdone\b/), fileContains('project/backup.sh', /\bcp\b/)),
    },
    {
      id: 'run-backup',
      title: 'Run your backup',
      instruction: 'Make the script executable, run it, and look inside the backup folder:\n\n`$ chmod +x backup.sh`\n\n`$ ./backup.sh`\n\n`$ ls backup`',
      hint: 'If it says *Permission denied*, the `chmod +x` is missing. If it complains about a line, open the script again with `nano backup.sh` and compare it with the lines in the previous step.',
      solution: ['chmod +x backup.sh', './backup.sh', 'ls backup'],
      explain:
        'Your first automation! Run it again: this time the `if` skips creating the folder and the copies are simply refreshed. With a few more lines you could put the date in the folder name, and the computer can even run a script like this on a schedule for you (look up *cron* when you are ready).',
      check: all(ranScript('backup.sh'), isFile('project/backup/notes.txt'), isFile('project/backup/todo.txt'), isFile('project/backup/ideas.txt')),
    },
  ],
  quizSetup: (env) => {
    env.file('project/check.sh', CHECK_SH, { mode: 0o775 });
  },
  quiz: [
    {
      kind: 'task',
      prompt: 'Using `if`, write one line that creates a folder called `archive`, but only when there is no folder of that name here yet.',
      hint: 'Test for a folder with `-d`, and remember that `!` turns a test around.',
      solution: ['if [ ! -d archive ]; then mkdir archive; fi'],
      explain:
        '`[ ! -d archive ]` is true only while there is no folder called `archive`, so this time `mkdir` ran. Run the same line again: now the test is false, so nothing happens, and there is no error either.',
      check: madeArchive,
    },
    {
      kind: 'task',
      prompt: 'Use a `for` loop to make a copy of every `.txt` file in this folder, with `.bak` added to the end of its name: `notes.txt` gets a copy called `notes.txt.bak`, and so on.',
      hint: 'Loop over the `.txt` files with a wildcard. Inside the loop, the name of the copy is the loop variable with `.bak` added.',
      solution: ['for f in *.txt; do cp "$f" "$f.bak"; done'],
      explain:
        'The wildcard `*.txt` turned into the list of text files, and the loop ran `cp` once for each of them, with `$f` holding the next name every time. The quotes around `"$f"` keep names that contain spaces in one piece.',
      check: all(
        (c) => !!c.ev && !c.ev.syntaxError && FOR_RE.test(c.ev.line),
        ...TXT_FILES.map((f): Check => (c) => fileText(c, `project/${f}`) !== null && fileText(c, `project/${f}.bak`) === fileText(c, `project/${f}`)),
        missing('project/budget.csv.bak'),
      ),
    },
    {
      kind: 'task',
      prompt: 'Use a `while` loop to count down: print `3`, `2` and `1`, one number per line.',
      hint: 'Start a variable at 3. Each time round, print it and take one away, and stop once it gets to 0.',
      solution: ['n=3', 'while [ $n -gt 0 ]; do echo $n; n=$((n - 1)); done'],
      explain:
        'Each time round, the loop printed `n` and took one away from it with `$(( ))`. Once `n` reached 0, the test `[ $n -gt 0 ]` was false and the loop stopped. Without the subtraction, it would have printed `3` forever.',
      check: all(
        lineMatches(/\b(while|until)\b[\s\S]*\bdo\b[\s\S]*\bdone\b/),
        not(interrupted()),
        (c) => !!c.ev && !c.ev.syntaxError && c.ev.output.trim().split(/\s*\n\s*/).join(',') === '3,2,1',
      ),
    },
    {
      kind: 'task',
      prompt: 'The script `check.sh` in this folder should print `Found the notes` when there is a `notes.txt` here, but its `if` line has a mistake. Fix the script, then run it.',
      hint: 'Run it once and read the error message. Remember that `[` is a command, and the shell splits words at spaces.',
      solution: [
        'nano check.sh',
        { keys: '\x1b[B\x1b[B', label: 'Press ↓ twice to reach the if line', delay: 400 },
        { keys: '\x0b', label: 'Press Ctrl+K to cut that line' },
        { keys: 'if [ -f notes.txt ]; then\r', label: 'Type the line again, with spaces inside the brackets' },
        { keys: '\x0f', label: 'Press Ctrl+O to save' },
        { keys: '\r', label: 'Press Enter to keep the file name' },
        { keys: '\x18', label: 'Press Ctrl+X to exit nano' },
        './check.sh',
      ],
      explain:
        "Written as `[-f`, the test looked like a command called `[-f`, which doesn't exist, so the `if` failed and the `else` part ran. `[` is a command, so it needs a space after it, and `]` is its last argument, so it needs a space before it.",
      check: all(
        ranScript('check.sh'),
        outputIncludes('Found the notes'),
        not(outputIncludes('command not found')),
        fileContains('project/check.sh', IF_RE),
        fileContains('project/check.sh', /notes\.txt/),
      ),
    },
    {
      prompt: '`temp` holds a number. Which test is true only when it is greater than 25?',
      options: ['`[ "$temp" > 25 ]`', '`[ "$temp" -ge 25 ]`', '`[ "$temp" = 25 ]`', '`[ "$temp" -gt 25 ]`'],
      answer: 3,
      explain:
        '`-gt` means *greater than*, while `-ge` is also true for exactly 25. Inside `[ ]` a `>` is a redirection: it quietly creates a file called `25`, and the test then comes out true for any temperature.',
    },
  ],
  recap: `
- \`if [ TEST ]; then ...; else ...; fi\` makes decisions, and \`[ ]\` needs spaces inside.
- Tests: \`-f\` file, \`-d\` folder, \`=\` and \`!=\` for text, \`-gt\` \`-lt\` \`-ge\` \`-le\` \`-eq\` \`-ne\` for numbers, and \`!\` for *not*.
- \`for x in LIST; do ...; done\` repeats for each item; \`while [ TEST ]; do ...; done\` repeats while the test is true.
- \`$(( ))\` does arithmetic: \`n=$((n + 1))\`.
- A script combines all of this into a job you can run whenever you like.
`,
  cheatsheet: [
    ['if [ -f F ]; then ...; fi', 'do something only if file F exists'],
    ['[ "$a" = "$b" ]', 'the two texts are equal'],
    ['[ "$n" -gt 5 ]', 'the number is greater than 5'],
    ['for f in *.txt; do ...; done', 'repeat for each matching file'],
    ['while [ TEST ]; do ...; done', 'repeat while TEST is true'],
    ['$((n + 1))', 'arithmetic'],
  ],
  realWorld: `
- **macOS** (bash or zsh) uses exactly the same \`if\`, \`for\` and \`while\` syntax, so these scripts run there unchanged.
- **Windows PowerShell** has the same ideas in different clothes: \`if (Test-Path notes.txt) { "Found it" } else { "Not here" }\` and \`foreach ($f in Get-ChildItem *.txt) { $f.Name }\`. Funnily enough, it compares numbers with the very same \`-gt\`, \`-lt\` and \`-eq\`.
`,
};

export const scriptingLessons: Lesson[] = [firstScript, scriptLogic];
