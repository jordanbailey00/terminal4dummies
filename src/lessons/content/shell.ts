// Module: Your shell, your way.

import { BASHRC } from '../../shell/sampledata';
import { all, any, cwdIs, everRan, fileContains, fileText, lineMatches, ran, varIs } from '../checks';
import type { CheckContext, Lesson } from '../types';

type Check = (c: CheckContext) => boolean;

/** The variable exists and is exported to child programs. */
function exported(name: string): Check {
  return (c) => !!c.sh.state.getVar(name)?.exported;
}

/** The output of the last command contains a whole number matching `re` (e.g. the value of $?). */
function printedNumber(re: RegExp): Check {
  return (c) => !!c.ev && c.ev.output.split(/\s+/).some((w) => re.test(w));
}

// ---------------------------------------------------------------------------
// Lesson: Variables and the environment

export const variables: Lesson = {
  id: 'variables',
  title: 'Variables and the environment',
  summary: 'Store values in variables, see how quotes change them, share them with programs, and discover how the shell finds commands.',
  moduleId: 'shell',
  minutes: 10,
  intro: `
A **variable** is a name that holds a value, like a labelled box. You create one by writing the name, an equals sign and the value, **with no spaces**:

\`\`\`
city=Paris
\`\`\`

To use it, put a \`$\` in front of the name. Before running any command, the shell swaps each \`$name\` for the value it holds:

| You type | The shell runs |
| --- | --- |
| \`echo $city\` | \`echo Paris\` |
| \`echo "I love \${city}"\` | \`echo "I love Paris"\` |
| \`echo 'I love $city'\` | \`echo 'I love $city'\` (single quotes: no swapping) |

The braces in \`\${city}\` mark exactly where the name ends, which matters when letters follow it: \`\${city}ian\` gives *Parisian*, but \`$cityian\` looks for a variable called \`cityian\`.

> [!HOW]
> When you type a command such as \`ls\`, the shell has to find the program file to run. It looks through a list of folders stored in the variable **\`PATH\`**, separated by colons, **from left to right**, and runs the first \`ls\` it finds (here \`/usr/bin/ls\`). If no folder has it, you get *command not found*. This is also why a program in the current folder needs \`./\` in front: the current folder isn't on the list.
`,
  steps: [
    {
      id: 'set',
      title: 'Make a variable',
      instruction: 'Create a variable called `city`. Remember: no spaces around the `=`.\n\n`$ city=Paris`',
      hint: 'Type it as one single word: `city=Paris`.',
      solution: ['city=Paris'],
      explain:
        'Nothing was printed: the shell quietly stored the value. Variable names may contain letters, digits and underscores (but must not start with a digit), and they are case-sensitive: `city` and `CITY` are two different variables.',
      check: varIs('city'),
    },
    {
      id: 'use',
      title: 'Use it with $',
      instruction: 'Now use it. The shell replaces `$city` with its value before `echo` even starts:\n\n`$ echo "Welcome to $city"`',
      solution: ['echo "Welcome to $city"'],
      explain:
        '`echo` never saw `$city`, only `Welcome to Paris`. Now try the braces: `$ echo "${city}ian food"` prints *Parisian food*, while `$ echo "$cityian food"` prints only *food*: there is no variable called `cityian`, and a variable that was never set is simply empty.',
      check: (c) => !!c.ev && /\$\{?city\b/.test(c.ev.line) && c.ev.status === 0,
    },
    {
      id: 'spaces',
      title: 'Spaces break it',
      instruction: 'Spaces around `=` are the most common mistake with variables. Make it on purpose:\n\n`$ city = Rome`',
      solution: ['city = Rome'],
      explain:
        'The shell splits a line into words at the spaces, so it saw a command called `city` with the arguments `=` and `Rome`. There is no such command. Your variable is unharmed: `$ echo $city` still says Paris. To really change it, write `city=Rome`.',
      check: (c) => !!c.ev && /\bcity\s*=\s|\bcity\s+=/.test(c.ev.line) && c.ev.execs.some((e) => e.kind === 'not-found'),
    },
    {
      id: 'quotes',
      title: 'Single quotes vs double quotes',
      instruction: 'Single quotes keep text exactly as you wrote it, dollar signs included:\n\n`$ echo \'Welcome to $city\'`',
      solution: ["echo 'Welcome to $city'"],
      explain:
        '| Quotes | `$city` inside them | Use them for |\n| --- | --- | --- |\n| `"double"` | replaced by the value | text that includes variables |\n| `\'single\'` | left exactly as typed | text that must not change |\n\nBoth kinds hold spaces together, so the whole sentence reaches `echo` as **one** argument.',
      check: all(lineMatches(/'[^']*\$\{?city[^']*'/), (c) => !!c.ev && c.ev.status === 0),
    },
    {
      id: 'builtin',
      title: 'Variables you already have',
      instruction:
        'The shell started with plenty of variables already set. Three useful ones are `$USER` (your user name), `$HOME` (your home folder) and `$PWD` (the folder you are in):\n\n`$ echo "I am $USER, my home is $HOME and I am in $PWD"`',
      solution: ['echo "I am $USER, my home is $HOME and I am in $PWD"'],
      explain:
        '`$PWD` changes every time you `cd`. Variables like these are **environment variables**: settings that every program receives when it starts. See the whole environment with `$ env` (it is long, so `$ env | less` lets you scroll; press q to quit).',
      check: any(lineMatches(/\$\{?(USER|HOME|PWD)\b/), ran('env'), ran('printenv')),
    },
    {
      id: 'export',
      title: 'Share it with programs: export',
      instruction:
        "Your `city` variable only exists inside this shell. The programs the shell starts (its **child** programs) can't see it. Ask `printenv`, a separate program that prints environment variables:\n\n`$ printenv city`\n\nNothing at all. Now **export** the variable, which adds it to the environment, and ask again:\n\n`$ export city`\n\n`$ printenv city`",
      hint: '`export city` has no `$` in it: you are naming the variable, not using its value.',
      solution: ['printenv city', 'export city', 'printenv city'],
      explain:
        "Every program you start receives a **copy** of the environment. Plain variables stay behind in the shell; exported ones are copied along. You can create and export in one go, as in `export EDITOR=nano`. Because programs get a copy, nothing they do can change the variables in your shell.",
      check: all(exported('city'), any(ran('printenv', { status: 0 }), ran('env'), ran('bash'), ran('sh'))),
    },
    {
      id: 'path',
      title: 'How the shell finds programs',
      instruction: 'One environment variable matters more than any other. Print it:\n\n`$ echo $PATH`\n\nIt is a list of folders separated by `:`. Now ask which file runs when you type `ls`:\n\n`$ which ls`',
      solution: ['echo $PATH', 'which ls'],
      explain:
        '`/usr/bin` is one of the folders in your PATH, so typing `ls` finds `/usr/bin/ls`. Try `$ which cd`: it prints nothing, because `cd` is not a program file but part of the shell itself (`$ type cd` says so). Later you will add a folder of your own to PATH.',
      check: any(ran('which'), ran('type'), ran('whereis'), ran('command', { args: ['-v'] })),
    },
  ],
  recap: `
- \`name=value\` creates or changes a variable (no spaces!); \`$name\` or \`\${name}\` uses it.
- Double quotes allow \`$\` substitution; single quotes keep everything exactly as typed.
- \`$USER\`, \`$HOME\`, \`$PWD\` and \`$PATH\` are set for you, and \`env\` lists the whole environment.
- \`export name\` hands a variable on to the programs you start.
- The shell finds programs by searching the folders in \`$PATH\` in order; \`which\` shows the result.
`,
  cheatsheet: [
    ['name=value', 'create or change a variable'],
    ['$name / ${name}', 'use a variable'],
    ['"..." / \'...\'', 'quotes with / without $ substitution'],
    ['export name', 'pass a variable on to programs'],
    ['env / printenv NAME', 'show environment variables'],
    ['echo $PATH', 'where the shell looks for programs'],
    ['which COMMAND', 'which file a command runs'],
  ],
  realWorld: `
- **macOS (zsh)** works the same way: \`city=Paris\`, \`echo $city\`, \`export\`, \`$PATH\` and \`which\` all behave as here.
- **Windows PowerShell** has its own syntax. Variables start with \`$\` even when you set them, and spaces are allowed: \`$city = "Paris"\`. Environment variables live under \`$env:\`, such as \`$env:PATH\` or \`$env:USERNAME\`, and \`Get-Command notepad\` does the job of \`which\`.
- **Windows Command Prompt (cmd)** uses \`set city=Paris\` and \`echo %city%\`.
`,
};

// ---------------------------------------------------------------------------
// Lesson: Exit codes and chaining

const SHOPPING = `milk
bread
eggs
apples
`;

export const chaining: Lesson = {
  id: 'chaining',
  title: 'Exit codes and chaining',
  summary: 'Learn how every command reports success or failure, and use &&, || and ; to decide what runs next.',
  moduleId: 'shell',
  minutes: 8,
  setup: (env) => {
    env.file('shopping.txt', SHOPPING, { daysAgo: 1 });
    env.remove('build');
  },
  intro: `
Every command finishes by handing the shell a number, its **exit status** (also called an *exit code*). It's a tiny report on how things went:

- **0** means success.
- **Anything else** (1 to 255) means something went wrong. Each program chooses its own numbers; \`127\`, for example, means *command not found*.

You rarely see this number, but it's always kept in the special variable \`$?\`. Better still, the shell can use it to decide what to run next:

| You write | B runs... |
| --- | --- |
| \`A && B\` | only if A succeeded |
| \`A \\|\\| B\` | only if A failed |
| \`A ; B\` | always, once A has finished |

> [!HOW]
> The shell runs \`A\` and waits for it to finish. Then it looks at the exit status: \`&&\` carries on only after a 0, \`||\` only after anything else. A chain like \`A && B && C\` stops at the first failure, which makes it a safe way to say *do these steps in order, but stop if one goes wrong*.
`,
  steps: [
    {
      id: 'zero',
      title: 'Success is zero',
      instruction: 'Run a command that works, then print its exit status straight away:\n\n`$ ls`\n\n`$ echo $?`',
      hint: 'Run them as two separate commands, one after the other.',
      solution: ['ls', 'echo $?'],
      explain: '`0`: everything went fine. `$?` always holds the status of the **most recent** command, so check it immediately. Even `echo $?` itself succeeds and sets it back to 0.',
      check: all(lineMatches(/\$\?/), printedNumber(/^0$/)),
    },
    {
      id: 'nonzero',
      title: 'Failure is not zero',
      instruction: 'Now a command that fails:\n\n`$ ls nowhere`\n\n`$ echo $?`',
      solution: ['ls nowhere', 'echo $?'],
      explain:
        '`ls` reports `2` when something it was asked to list does not exist. Other codes you will meet: `1` (a general failure), `126` (not allowed to run), `127` (command not found) and `130` (stopped with <kbd>Ctrl</kbd>+<kbd>C</kbd>).',
      check: all(lineMatches(/\$\?/), printedNumber(/^[1-9]\d*$/)),
    },
    {
      id: 'true-false',
      title: 'Meet true and false',
      instruction: 'Two commands do nothing at all except succeed or fail: `true` and `false`. Try the gloomy one:\n\n`$ false`\n\n`$ echo $?`',
      solution: ['false', 'echo $?'],
      explain:
        '`false` always reports 1, and `true` always reports 0. They sound useless, but they are handy for trying out `&&` and `||`, and in scripts: `while true` repeats something forever.',
      check: all(everRan('false'), lineMatches(/\$\?/)),
    },
    {
      id: 'and',
      title: 'Only if it worked: &&',
      instruction: '`&&` runs the second command only if the first one succeeded. Create a folder and step into it in one go:\n\n`$ mkdir build && cd build`',
      hint: 'Two ampersands (Shift+7 on a US keyboard), with spaces around them.',
      solution: ['mkdir build && cd build'],
      explain:
        'The prompt shows you are now in `~/build`. If `mkdir` had failed, `cd` would never have run. See for yourself: go back with `$ cd ..` and run the same line again. This time `mkdir` complains that the folder already exists, and you stay where you are.',
      check: all(lineMatches(/&&/), cwdIs('~/build')),
    },
    {
      id: 'or',
      title: 'Plan B: ||',
      instruction: '`||` is the opposite: it runs the second command only if the first one **failed**. Use it for a plan B:\n\n`$ cd nowhere || echo "No such folder"`',
      hint: 'The | key is usually Shift plus the backslash key, above Enter.',
      solution: ['cd nowhere || echo "No such folder"'],
      explain: '`cd` failed (status 1), so `echo` ran. Had the folder existed, `cd` would have succeeded and the message would have been skipped.',
      check: all(lineMatches(/\|\|/), (c) => !!c.ev && c.ev.execs.length >= 2 && c.ev.execs[0].status !== 0),
    },
    {
      id: 'semicolon',
      title: 'No matter what: ;',
      instruction: 'A semicolon simply runs commands one after the other, whether they work or not:\n\n`$ ls nowhere; echo "I run anyway"`',
      solution: ['ls nowhere; echo "I run anyway"'],
      explain:
        "> [!CAUTION]\n> This is why `&&` is often the safer choice. Imagine `cd old-photos; rm *.jpg`: if the `cd` fails, `rm` runs anyway, in whatever folder you happen to be in. With `cd old-photos && rm *.jpg`, nothing is deleted unless the `cd` worked.",
      check: (c) => !!c.ev && c.ev.line.includes(';') && c.ev.execs.length >= 2,
    },
    {
      id: 'grep-q',
      title: 'Exit codes at work',
      instruction:
        'Exit codes shine with commands that answer *yes or no*. `grep -q` searches **q**uietly: it prints nothing and just reports 0 (found) or 1 (not found). Is milk on your shopping list?\n\n`$ grep -q milk ~/shopping.txt && echo "Milk is on the list"`\n\nNow add cheese, but only if it is not there yet:\n\n`$ grep -q cheese ~/shopping.txt || echo cheese >> ~/shopping.txt`',
      solution: ['grep -q milk ~/shopping.txt && echo "Milk is on the list"', 'grep -q cheese ~/shopping.txt || echo cheese >> ~/shopping.txt'],
      explain:
        'Run the second line again and nothing happens: grep finds cheese now, so the `echo` is skipped. *Only do it if it has not been done yet* is a common trick in setup scripts. Check the list with `$ cat ~/shopping.txt`.',
      check: all(fileContains('shopping.txt', /cheese/i), everRan('grep', { flags: 'q' })),
    },
  ],
  recap: `
- Every command ends with an **exit status**: 0 for success, anything else for failure. \`$?\` holds the latest one.
- \`A && B\` runs B only if A succeeded; \`A || B\` only if A failed; \`A ; B\` always.
- \`true\` and \`false\` do nothing but succeed or fail.
- Prefer \`&&\` whenever a step depends on the one before it.
`,
  cheatsheet: [
    ['echo $?', 'exit status of the last command'],
    ['A && B', 'run B only if A worked'],
    ['A || B', 'run B only if A failed'],
    ['A ; B', 'run B after A, no matter what'],
    ['true / false', 'always succeed / always fail'],
    ['grep -q WORD FILE', 'search silently, just set the status'],
  ],
  realWorld: `
- **macOS (zsh)** behaves the same: \`$?\`, \`&&\`, \`||\` and \`;\` all work.
- **Windows PowerShell 7** understands \`&&\` and \`||\` too, but the older Windows PowerShell 5.1 that comes with Windows does not, so use \`;\` there. In PowerShell \`$?\` is simply \`True\` or \`False\`, and the exit code of the last program is in \`$LASTEXITCODE\`.
- **Windows Command Prompt (cmd)** understands \`&&\` and \`||\`, and keeps the exit code in \`%ERRORLEVEL%\`.
`,
};

// ---------------------------------------------------------------------------
// Lesson: Aliases and .bashrc

/** Aliases that ~/.bashrc sets up on this computer. */
const DEFAULT_ALIASES = new Set(['ls', 'grep', 'fgrep', 'egrep', 'll', 'la', 'l']);

/** The prompt that ~/.bashrc sets. */
const DEFAULT_PS1 = /^PS1='([^']*)'$/m.exec(BASHRC)?.[1];

function firstWord(line: string): string {
  return line.trim().split(/\s+/)[0] ?? '';
}

/** A custom (not built-in) alias is currently defined. */
const customAliasDefined: Check = (c) => [...c.sh.state.aliases.keys()].some((a) => !DEFAULT_ALIASES.has(a));

/** Names that were used as custom aliases earlier in the lesson (the line's first word was replaced). */
function aliasNamesUsed(c: CheckContext): Set<string> {
  const names = new Set<string>();
  for (const ev of c.commands) {
    const w = firstWord(ev.line);
    const first = ev.execs[0];
    if (/^[\w.-]+$/.test(w) && !DEFAULT_ALIASES.has(w) && first && first.kind !== 'assignment' && first.argv[0] !== w && ev.status === 0) names.add(w);
  }
  return names;
}

/** ~/.bashrc defines an alias of the learner's own. */
const customAliasInBashrc: Check = (c) => {
  const t = fileText(c, '.bashrc') ?? '';
  return [...t.matchAll(/^\s*alias\s+([^\s=]+)=/gm)].some((m) => !DEFAULT_ALIASES.has(m[1]));
};

/** ~/.bashrc still has its original settings (it was appended to, not replaced). */
const bashrcIntact = fileContains('.bashrc', /HISTSIZE=/);

export const customizing: Lesson = {
  id: 'customizing',
  title: 'Make it yours: aliases and .bashrc',
  summary: 'Create shortcuts with alias, make them permanent in ~/.bashrc, and design your own prompt.',
  moduleId: 'shell',
  minutes: 10,
  intro: `
Typing the same long command over and over gets old. An **alias** is a nickname for a command: you type the short name, and the shell swaps in the full text before running it.

\`\`\`
alias ll='ls -alF'
      │   └── what it stands for
      └── the new short name
\`\`\`

Aliases you type only last until the shell exits. To keep them, you write them into **\`~/.bashrc\`**, a settings file in your home folder that bash reads every time you open a new terminal. The same goes for other personal settings, like the look of your prompt.

> [!HOW]
> Each time bash starts up to work with you (when you open a terminal window, for example), it reads \`~/.bashrc\` from top to bottom and runs every line, exactly as if you had typed it. That's where this computer's colorful prompt, the colors in \`ls\` and the \`ll\` alias come from. Later, each time you press Enter, the shell checks whether the **first word** of your line is an alias and, if it is, replaces it with the alias's text before doing anything else.
`,
  steps: [
    {
      id: 'existing',
      title: 'Aliases you already have',
      instruction: 'This computer already has a few aliases. List them:\n\n`$ alias`\n\nThen ask the shell what `ll` really is:\n\n`$ type ll`',
      solution: ['alias', 'type ll'],
      explain:
        "`ll` is short for `ls -alF`. Even plain `ls` is an alias: it adds `--color=auto`, which is where the colors come from. `type` works on any name and tells you whether it is an alias, part of the shell or a program file. Try `$ type cd` and `$ type cat`.",
      check: (c) => !!c.ev && c.ev.execs.some((e) => e.argv[0] === 'type' && e.argv.slice(1).some((a) => c.sh.state.aliases.has(a))),
    },
    {
      id: 'create',
      title: 'Make your own alias',
      instruction: "Make an alias called `now` that shows the time in hours and minutes:\n\n`$ alias now='date +%H:%M'`\n\nThen use it:\n\n`$ now`",
      hint: 'No spaces around the `=`, and keep the single quotes: they hold `date +%H:%M` together as one piece of text.',
      solution: ["alias now='date +%H:%M'", 'now'],
      explain:
        "The rules are the same as for variables: no spaces around `=`, and quotes around anything that contains spaces. If an alias has the same name as a real command, the alias wins. That's how `ls` gets its colors.",
      check: (c) => {
        if (!c.ev || c.ev.status !== 0) return false;
        const w = firstWord(c.ev.line);
        return !DEFAULT_ALIASES.has(w) && c.sh.state.aliases.has(w);
      },
    },
    {
      id: 'unalias',
      title: 'Remove an alias',
      instruction: '`unalias` deletes an alias. Remove the `ls` alias and see what plain `ls` looks like:\n\n`$ unalias ls`\n\n`$ ls`',
      solution: ['unalias ls', 'ls'],
      explain: "No more colors: `ls` is now the plain program, without `--color=auto`. Don't worry, nothing is broken. The next step brings the colors back.",
      check: ran('unalias', { status: 0 }),
    },
    {
      id: 'restart',
      title: 'Start a fresh shell',
      instruction:
        'Aliases live in the shell\'s memory, so they vanish when it exits. End this shell (on your own computer, this would close the terminal window or tab):\n\n`$ exit`\n\nPress <kbd>Enter</kbd> to start a brand-new shell, then try your alias:\n\n`$ now`',
      hint: 'After `exit`, the terminal waits for you to press Enter before it starts a new shell.',
      solution: ['exit', { keys: '\r', label: 'Press Enter to start a new shell', delay: 300 }, 'now'],
      explain:
        "`now` is gone, but `ls` has its colors back. The new shell read `~/.bashrc` as it started, and that file sets up the `ls` alias but knows nothing about `now`.",
      check: (c) => {
        if (!c.ev) return false;
        const w = firstWord(c.ev.line);
        return (w === 'now' || aliasNamesUsed(c).has(w)) && c.ev.execs.some((e) => e.argv[0] === w && e.kind === 'not-found');
      },
    },
    {
      id: 'bashrc',
      title: 'Make it permanent',
      instruction:
        "To keep `now`, add it to the end of `~/.bashrc`. Use **two** arrows, which append:\n\n`$ echo \"alias now='date +%H:%M'\" >> ~/.bashrc`\n\nThen check the end of the file:\n\n`$ tail -3 ~/.bashrc`\n\n> [!CAUTION]\n> A single `>` would replace the whole file with that one line, wiping out all your other settings. To add to a file, always use `>>`.",
      hint: "If you prefer, open the file with `nano ~/.bashrc`, add the line at the very end, then save with Ctrl+O and exit with Ctrl+X. If you used a single `>` by accident, press Reset above the terminal to start the lesson over.",
      solution: [`echo "alias now='date +%H:%M'" >> ~/.bashrc`, 'tail -3 ~/.bashrc'],
      explain:
        'The double quotes around the whole line let the single quotes inside reach the file untouched. Editing the file in nano works just as well: it is an ordinary text file.',
      check: all(customAliasInBashrc, bashrcIntact),
    },
    {
      id: 'source',
      title: 'Load the new settings',
      instruction: 'bash only reads `~/.bashrc` when it starts. Instead of starting a new shell, tell this one to read the file now:\n\n`$ source ~/.bashrc`\n\nAnd try the alias again:\n\n`$ now`',
      solution: ['source ~/.bashrc', 'now'],
      explain:
        "`source` runs the commands in a file inside the **current** shell, which is why the alias stuck. (Running a script, which you'll learn soon, starts a separate shell instead.) A single dot does the same job, so you will often see `. ~/.bashrc`.",
      check: all(everRan('source', { aliases: ['.'] }), customAliasDefined),
    },
    {
      id: 'prompt',
      title: 'Change your prompt',
      instruction:
        "The prompt itself comes from a variable, `PS1`, full of special codes:\n\n| Code | Shows |\n| --- | --- |\n| `\\u` | your user name |\n| `\\h` | the computer's name |\n| `\\w` | the current folder, like `~/Documents` |\n| `\\W` | only its last part, like `Documents` |\n| `\\$` | `$`, or `#` when you are root |\n\nGive yourself a shorter prompt (single quotes keep the backslashes safe):\n\n`$ PS1='\\u:\\W\\$ '`",
      hint: 'Copy it exactly, including the space before the closing quote, so your typing does not stick to the `$`.',
      solution: ["PS1='\\u:\\W\\$ '"],
      explain:
        "To add color, wrap a color code in `\\[\\e[...m\\]`. For example `$ PS1='\\[\\e[1;35m\\]\\u\\[\\e[0m\\]:\\W\\$ '` shows your name in bold magenta. The number picks the color (32 green, 33 yellow, 34 blue, 35 magenta, 36 cyan), `1;` makes it bold and `0` switches back to normal. `\\[` and `\\]` tell bash that the codes take up no space on screen. Changed your mind? `source ~/.bashrc` brings back the original. To keep a prompt you like, add its `PS1=` line to the end of `~/.bashrc` with nano.",
      check: all(lineMatches(/\bPS1=/), (c) => !!c.ev && c.ev.status === 0 && c.ev.execs.some((e) => e.argv.some((a) => a.startsWith('PS1=') && a.slice(4) !== DEFAULT_PS1))),
    },
  ],
  recap: `
- \`alias name='command'\` creates a shortcut; \`alias\` lists them, \`type name\` reveals what a name is, \`unalias name\` removes one.
- Aliases (and variables) you type are forgotten when the shell exits.
- \`~/.bashrc\` runs every time a new terminal shell starts, so that's where your aliases and settings belong. Append with \`>>\` or edit it with nano.
- \`source ~/.bashrc\` applies the changes to the shell you're in.
- \`PS1\` controls the prompt: \`\\u\` user, \`\\h\` computer, \`\\w\` folder, \`\\$\` prompt sign.
`,
  cheatsheet: [
    ['alias', 'list your aliases'],
    ["alias now='date +%H:%M'", 'create an alias'],
    ['type NAME', 'find out what a name really is'],
    ['unalias NAME', 'remove an alias'],
    ['~/.bashrc', 'settings read by every new terminal shell'],
    ['source ~/.bashrc', 'reload it in the current shell'],
    ["PS1='\\u:\\W\\$ '", 'change the prompt'],
  ],
  realWorld: `
- **macOS** uses **zsh**, whose settings file is \`~/.zshrc\` (create it if it doesn't exist). Aliases work exactly the same, and you reload with \`source ~/.zshrc\`. zsh prompts use different codes: \`PROMPT='%n:%1~ %# '\` shows your name, the current folder and \`%\` (or \`#\` for root).
- **Windows PowerShell** has \`Set-Alias\` for simple nicknames, such as \`Set-Alias np notepad\`. Your startup settings go in the file named by \`$PROFILE\` (open it with \`notepad $PROFILE\`), and you change the prompt by defining a function called \`prompt\`.
- On Linux and in **WSL**, everything in this lesson works as shown.
`,
};

export const shellLessons: Lesson[] = [variables, chaining, customizing];
