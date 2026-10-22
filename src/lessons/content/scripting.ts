// Module: Automating with scripts.

import { all, any, fileContains, interrupted, isExecutable, isFile, lineMatches, not, ran } from '../checks';
import type { CheckContext, Lesson, SolutionAction } from '../types';

type Check = (c: CheckContext) => boolean;

/** A first line that starts bash (or sh). */
const SHEBANG = /^#!\s*(\/usr)?\/bin\/(env\s+)?(bash|sh)\b/;

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
      kind: 'command',
      prompt: 'You type `./hello.sh` and get `bash: ./hello.sh: Permission denied`. Type the command that fixes this, so that `./hello.sh` works.',
      accept: ['chmod +x hello.sh', /^chmod (u|a|ug|ugo)?\+(x|rx|xr) (\.\/)?hello\.sh$/, /^chmod 0?[57][0-7]{2} (\.\/)?hello\.sh$/],
      explain: 'The file is not executable yet. `chmod +x hello.sh` gives it the `x` (execute) permission, and from then on `./hello.sh` runs it like any other program.',
    },
    {
      prompt: '`greet.sh` contains:\n\n```\n#!/bin/bash\necho "Hello, $1"\necho "Number of names: $#"\n```\n\nWhat does `./greet.sh "Ada Lovelace" Grace` print?',
      options: [
        '`Hello, Ada` and `Number of names: 3`',
        '`Hello, Ada Lovelace` and `Number of names: 3`',
        '`Hello, Ada Lovelace` and `Number of names: 2`',
        '`Hello, $1` and `Number of names: $#`',
      ],
      answer: 2,
      explain:
        'The quotes hold `Ada Lovelace` together as one argument, so `$1` is `Ada Lovelace`, and `$#`, the number of arguments, is 2. Without the quotes there would be three: `Ada`, `Lovelace` and `Grace`.',
    },
    {
      prompt: 'Your script now lives in `~/bin/greet`. Which line puts `~/bin` on your `PATH` and keeps everything that was already there?',
      options: ['`export PATH="$HOME/bin"`', '`export PATH = "$HOME/bin:$PATH"`', '`export $PATH="$HOME/bin:$PATH"`', '`export PATH="$HOME/bin:$PATH"`'],
      answer: 3,
      explain:
        'The `:$PATH` at the end keeps the old list after your own folder, so every other command is still found. Leaving it out would throw that list away (even `cat` would stop working), and the other two break the variable rules: no spaces around `=`, and no `$` in front of the name being set.',
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
  quiz: [
    {
      prompt: 'You type `if [-f notes.txt]; then echo "Found it"; fi` and get `[-f: command not found`. Why?',
      options: [
        'There is no file called `notes.txt` in this folder, so the test failed',
        'An `if` must always have an `else` part, even if it does nothing',
        '`[` is a command, so it needs a space after it, and `]` needs a space before it',
        'File names in a test must be in quotes, as in `"notes.txt"`',
      ],
      answer: 2,
      explain: '`[` is a command (its other name is `test`), and the shell splits words at spaces, so `[-f` looked like the name of an unknown command. Write the test as `[ -f notes.txt ]`.',
    },
    {
      prompt: 'What does this print?\n\n```\nn=1\nwhile [ $n -le 3 ]; do\n  echo "Lap $n"\n  n=$((n + 1))\ndone\n```',
      options: ['`Lap 1` and `Lap 2`', '`Lap 1`, `Lap 2` and `Lap 3`', '`Lap 1`, `Lap 2`, `Lap 3` and `Lap 4`', '`Lap 1` over and over, until you press <kbd>Ctrl</kbd>+<kbd>C</kbd>'],
      answer: 1,
      explain: '`-le` means *less than or equal to*, so the loop runs while `n` is 1, 2 or 3. Each lap adds one to `n`, and once it reaches 4 the test is false and the loop stops.',
    },
    {
      prompt: '`temp` holds a number. Which test is true only when it is greater than 25?',
      options: ['`[ "$temp" -gt 25 ]`', '`[ "$temp" > 25 ]`', '`[ "$temp" -ge 25 ]`', '`[ "$temp" = 25 ]`'],
      answer: 0,
      explain:
        '`-gt` means *greater than*, while `-ge` is also true for exactly 25. Inside `[ ]` a `>` is a redirection: it quietly creates a file called `25`, and the test then comes out true for any temperature.',
    },
    {
      kind: 'command',
      prompt: 'Type a one-line `for` loop that prints the name of every `.txt` file in the current folder, one per line. Use `f` as the loop variable and `echo` to print.',
      accept: [
        'for f in *.txt; do echo "$f"; done',
        /^for f in \*\.txt ?; ?do echo (\$f|\$\{f\}|"\$f"|"\$\{f\}") ?; ?done$/,
        /^for f in \*\.txt ?; ?do echo "[^"$]*(\$f\b|\$\{f\})[^"]*" ?; ?done$/,
      ],
      explain: 'The wildcard `*.txt` turns into the list of matching files, and the loop runs the commands between `do` and `done` once for each of them, with `$f` holding the next name every time.',
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
