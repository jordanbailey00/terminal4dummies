// Module: Permissions and power.

import { packageByName } from '../../shell/packages';
import { HOSTS } from '../../shell/sampledata';
import { abs, all, any, cwdIs, fileContains, fileLineCount, fileText, isExecutable, isFile, lineMatches, missing, modeIs, not, outputIncludes, ownerIs, packageInstalled, ran } from '../checks';
import type { ExecEvent } from '../../shell/system';
import { ROOT_CREDS } from '../../shell/vfs/fs';
import type { CheckContext, Lesson, LessonSetupEnv } from '../types';

type Check = (c: CheckContext) => boolean;

const ROOT_CTX = { cwd: '/', creds: { uid: 0, gid: 0, groups: [0] } };

/** Permission bits of a file (null if it doesn't exist). */
function modeOf(c: CheckContext, path: string): number | null {
  const n = c.sys.fs.tryStat(abs(path), ROOT_CTX);
  return n ? n.mode & 0o7777 : null;
}

/** The non-blank lines of a file, trimmed (null if it doesn't exist). */
function linesOf(c: CheckContext, path: string): string[] | null {
  const t = fileText(c, path);
  return t === null ? null : t.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** A file belongs to this user and group. */
function ownedBy(path: string, uid: number, gid: number): Check {
  return (c) => {
    const n = c.sys.fs.tryStat(abs(path), ROOT_CTX);
    return !!n && n.uid === uid && n.gid === gid;
  };
}

/** Some command in this lesson printed text matching `re`. */
function seenOutput(re: RegExp): Check {
  return (c) => c.commands.some((ev) => re.test(ev.output));
}

/** The command (and its arguments) that a `sudo ...` call runs, skipping sudo's own options. */
function sudoTarget(argv: string[]): string[] | null {
  if (argv[0]?.split('/').pop() !== 'sudo') return null;
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) {
    if (argv[i] === '--') {
      i++;
      break;
    }
    if (argv[i] === '-u' || argv[i] === '-g') i++;
    i++;
  }
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i++;
  return argv.slice(i);
}

interface RootRun {
  args?: (string | RegExp)[];
  status?: number;
  aliases?: string[];
}

/** Did this command line run `name` as root, through sudo (or inside a root shell)? */
function ranAsRootIn(execs: ExecEvent[], name: string, o: RootRun): boolean {
  return execs.some((e) => {
    const argv = sudoTarget(e.argv) ?? (e.uid === 0 ? e.argv : null);
    if (!argv || argv.length === 0) return false;
    const cmd = argv[0].split('/').pop() ?? '';
    if (cmd !== name && !(o.aliases ?? []).includes(cmd)) return false;
    if (o.status !== undefined && e.status !== o.status) return false;
    for (const want of o.args ?? []) {
      if (!argv.slice(1).some((a) => (typeof want === 'string' ? a === want : want.test(a)))) return false;
    }
    return true;
  });
}

function ranAsRoot(name: string, o: RootRun = {}): Check {
  return (c) => !!c.ev && ranAsRootIn(c.ev.execs, name, o);
}

function everRanAsRoot(name: string, o: RootRun = {}): Check {
  return (c) => c.commands.some((ev) => ranAsRootIn(ev.execs, name, o));
}

// ---------------------------------------------------------------------------
// Lesson: Who can do what

const DIARY = `Dear diary,
Today I joined the terminal club. The secret handshake involves Ctrl+C.
Tomorrow I will finally find out what rwx means.
`;

const RULES = `Club rules
1. Knock twice before entering.
2. Snacks are shared equally.
3. Whatever is typed in the club stays in the club.
`;

const RULES_LINES = RULES.split('\n').filter((l) => l.trim() !== '').length;

const HELLO_SH = `#!/bin/bash
echo "Welcome to the club, $USER. You just ran a program."
`;

const BACKUP_SH = `#!/bin/bash
echo "Backing up the club files... all done."
`;

const MENU_LINES = ['Snack menu', '1. Apples', '2. Popcorn', '3. Cookies'];

export const permissions: Lesson = {
  id: 'permissions',
  title: 'Who can do what: permissions',
  summary: 'Read the rwx permission string, find out who you are, and change who may read, write and run your files with chmod.',
  moduleId: 'permissions',
  minutes: 10,
  setup: (env) => {
    env.dir('club');
    env.file('club/diary.txt', DIARY, { mode: 0o644, daysAgo: 2 });
    env.file('club/rules.txt', RULES, { mode: 0o444, daysAgo: 30 });
    env.file('club/hello.sh', HELLO_SH, { mode: 0o664, daysAgo: 1 });
    env.dir('club/photos', { mode: 0o755 });
    env.file('club/photos/album.txt', 'Summer picnic\nBeach day\nBirthday cake\n', { mode: 0o644, daysAgo: 5 });
  },
  startDir: 'club',
  intro: `
Every file and folder on Linux records **who owns it** and **who may do what** with it. These rules are called **permissions**. They're what keep other people (and other programs) away from your private files, and what stop anyone but the administrator from changing the system.

The long listing shows them as ten characters at the start of each line, like \`-rwxr-xr--\`. Split it into four parts:

\`\`\`
 -   rwx   r-x   r--
 │    │     │     └── others: everyone else
 │    │     └──────── group: members of the file's group
 │    └────────────── user: the file's owner
 └─────────────────── type: - is a file, d is a folder
\`\`\`

Each set of three letters always comes in the same order, and a dash means *no*:

| Letter | On a file | On a folder |
| --- | --- | --- |
| \`r\` read | look at what's inside | list the names inside |
| \`w\` write | change it | add, delete or rename things inside |
| \`x\` execute | run it as a program | go inside (\`cd\`) and use what's there |

So \`-rwxr-xr--\` means: the owner may do everything, the group may read and run it, and everyone else may only read it.

> [!HOW]
> When you open a file, Linux asks one question at a time. Are you the file's **owner**? Then only the owner's three letters count. If not, are you in the file's **group**? Then the group's letters count. Otherwise the **others** letters apply. The first match wins, which is why an owner can be locked out of their own file.
`,
  steps: [
    {
      id: 'listing',
      title: 'Read the permissions',
      instruction: "You're in a folder called `club`. Show the long listing and look at the first column of each line:\n\n`$ ls -l`",
      hint: 'That is a lowercase L after the dash.',
      solution: ['ls -l'],
      explain:
        "Reading the first column: `diary.txt` is `rw-r--r--` (you may read and change it, everyone else may only read it). `hello.sh` is `rw-rw-r--`: nobody has an `x`, so nobody can run it yet. `rules.txt` is `r--r--r--`, read-only even for you. `photos` starts with `d` because it's a folder. The two names after the permissions are the file's **owner** (`learner`) and its **group** (also `learner`).",
      check: ran('ls', { flags: 'l' }),
    },
    {
      id: 'id',
      title: 'Who are you?',
      instruction: 'Linux decides which three letters apply to you by comparing you with the owner and group of the file. See who you are and which groups you belong to:\n\n`$ id`',
      hint: '`groups` shows the same list of groups without the numbers.',
      solution: ['id'],
      explain:
        "`uid=1000(learner)` is your **user ID**: Linux keeps track of users by number and shows the name for convenience. `gid` is your main group, and `groups=` lists every group you're a member of. On Ubuntu each user gets a private group with the same name, which is why `ls -l` showed `learner learner`. Notice `sudo` in the list: it makes you an administrator, the topic of the next lesson.",
      check: any(ran('id'), ran('groups')),
    },
    {
      id: 'private',
      title: 'Make your diary private',
      instruction:
        'Right now anyone can read your diary (`r--` for group and others). Take read permission away from the **g**roup and the **o**thers with `chmod` (*change mode*), then look at the result:\n\n`$ chmod go-r diary.txt`\n\n`$ ls -l diary.txt`',
      hint: 'Read it as *group and others, minus read*. There are no spaces inside `go-r`.',
      solution: ['chmod go-r diary.txt', 'ls -l diary.txt'],
      explain:
        "Now it's `rw-------`: only you can read or change it. This letter style of `chmod` is *who*, then `+` (add), `-` (remove) or `=` (set exactly), then *which permissions*. Who can be `u` (the user who owns it), `g` (group), `o` (others) or `a` (all). So `chmod u+w` gives the owner write permission, and `chmod a-x` takes execute away from everybody.",
      check: (c) => {
        const m = modeOf(c, 'club/diary.txt');
        return m !== null && (m & 0o044) === 0 && (m & 0o400) !== 0;
      },
    },
    {
      id: 'locked-out',
      title: 'Lock yourself out',
      instruction:
        "Permissions apply to the owner too. Remove your **own** read permission, then try to read the diary:\n\n`$ chmod u-r diary.txt`\n\n`$ cat diary.txt`\n\nNow repair it with a number instead of letters. `600` means *read and write for you, nothing for anyone else*:\n\n`$ chmod 600 diary.txt`",
      hint: 'After you see Permission denied, run `chmod 600 diary.txt` to make the diary readable again (by you only).',
      solution: ['chmod u-r diary.txt', 'cat diary.txt', 'chmod 600 diary.txt'],
      explain:
        "**Permission denied** is Linux enforcing the rules, even on the owner. You could still repair it because the owner may always change a file's permissions. Numbers work digit by digit (user, group, others), adding **r = 4, w = 2 and x = 1**: `6` is 4 + 2 = `rw-`, and `0` is `---`. So `600` is `rw-------`, the usual choice for private files such as passwords and keys.",
      check: all(seenOutput(/diary\.txt.*Permission denied/), modeIs('club/diary.txt', 0o600)),
    },
    {
      id: 'execute',
      title: 'Run a program',
      instruction:
        '`hello.sh` is a tiny program (a *script*). Try to run it; the `./` means *the file in this folder*:\n\n`$ ./hello.sh`\n\nNo `x`, no running. Add execute permission and try again:\n\n`$ chmod +x hello.sh`\n\n`$ ./hello.sh`',
      hint: 'Press ↑ twice to bring back `./hello.sh` after the chmod.',
      solution: ['./hello.sh', 'chmod +x hello.sh', './hello.sh'],
      explain:
        "Without `x`, Linux refuses to run a file, whatever is inside it. `+x` with no *who* letter gives execute permission to everyone, so the file is now `rwxrwxr-x`. Many people use `chmod 755` for scripts instead: `rwxr-xr-x` (7 = 4 + 2 + 1), where anyone may run it but only you may change it. You'll write your own scripts later in the course.",
      check: all(isExecutable('club/hello.sh'), ran('hello.sh', { status: 0 })),
    },
    {
      id: 'read-only',
      title: 'Unlock a read-only file',
      instruction:
        '`rules.txt` is `r--r--r--`, so not even you may change it. Give the **u**ser (you, the owner) write permission, then add a rule to the end of the file:\n\n`$ chmod u+w rules.txt`\n\n`$ echo "4. Leave the club tidier than you found it." >> rules.txt`',
      hint: 'If the `echo` says Permission denied, the `chmod` hasn\'t happened yet. Check with `ls -l rules.txt`.',
      solution: ['chmod u+w rules.txt', 'echo "4. Leave the club tidier than you found it." >> rules.txt'],
      explain:
        "The file is now `rw-r--r--`, which as a number is **644**: the standard setting for ordinary files. You may edit it, everyone else may read it. Making a file read-only is a gentle safety catch: you can always unlock your own files, but you won't change them by accident.",
      check: all((c) => ((modeOf(c, 'club/rules.txt') ?? 0) & 0o200) !== 0, fileLineCount('club/rules.txt', RULES_LINES + 1)),
    },
    {
      id: 'folder',
      title: 'What x means for a folder',
      instruction:
        'On a folder, `x` is the permission to go inside. Take it away from everyone and try to enter:\n\n`$ chmod -x photos`\n\n`$ cd photos`\n\nNow give the folder the usual folder permissions, `755`:\n\n`$ chmod 755 photos`',
      hint: 'If `cd` worked and you are now inside photos, the first chmod did not happen. Come back with `cd ..` and try again.',
      solution: ['chmod -x photos', 'cd photos', 'chmod 755 photos'],
      explain:
        "Without `x`, a folder is a locked door: `cd` is refused and nothing inside can be opened, even if you can see the names. `755` is `rwxr-xr-x`: you have every permission, while others may look inside and enter but not add or delete files. Almost every folder is set this way.",
      check: all(seenOutput(/photos: Permission denied/), modeIs('club/photos', 0o755)),
    },
  ],
  quizSetup: (env) => {
    env.file('club/backup.sh', BACKUP_SH, { mode: 0o664, daysAgo: 1 });
    env.file('club/secret.txt', 'The treasure is buried under the third oak tree.\n', { mode: 0o664, daysAgo: 3 });
    env.file('club/menu.txt', MENU_LINES.join('\n') + '\n', { mode: 0o444, daysAgo: 10 });
    env.file('club/minutes/october.txt', 'October meeting: we voted for more snacks.\n', { mode: 0o644, daysAgo: 8 });
    env.dir('club/minutes', { mode: 0o644 });
  },
  quiz: [
    {
      kind: 'task',
      prompt: "`backup.sh` is a script, but nobody may run it yet. Allow **only yourself**, its owner, to run it, without changing anyone else's permissions. Then run it.",
      hint: 'Add execute permission for the **u**ser who owns the file, and nobody else. To run a program in the current folder, put `./` in front of its name.',
      solution: ['chmod u+x backup.sh', './backup.sh'],
      explain: '`u+x` added execute permission for the owner only, so the file is now `rwxrw-r--` (764). A plain `chmod +x` would have let everyone run it.',
      check: all(
        modeIs('club/backup.sh', 0o764),
        any(ran('backup.sh', { status: 0 }), (c) => !!c.ev && c.ev.execs.some((e) => ['bash', 'sh'].includes(e.argv[0]?.split('/').pop() ?? '') && e.status === 0 && e.argv.some((a) => /(^|\/)backup\.sh$/.test(a)))),
      ),
    },
    {
      kind: 'task',
      prompt: 'Make `secret.txt` private: you may still read and change it, but nobody else may read it, change it or run it.',
      hint: 'Either take read and write away from the group and others, or use the number that means `rw-------` (r = 4, w = 2, x = 1).',
      solution: ['chmod 600 secret.txt'],
      explain: '`600` is `rw-------`: read and write for you, nothing for anyone else. `chmod go-rw secret.txt` gets you the same result with letters.',
      check: modeIs('club/secret.txt', 0o600),
    },
    {
      prompt: 'Which permissions does `chmod 750 run.sh` give the file?',
      options: ['`rwxrw----`', '`rw-r-x---`', '`rwxr-x---`', '`---r-xrwx`'],
      answer: 2,
      explain: 'Each digit adds up r = 4, w = 2 and x = 1, in the order user, group, others: 7 = 4 + 2 + 1 = `rwx`, 5 = 4 + 1 = `r-x`, and 0 = `---`.',
    },
    {
      kind: 'task',
      prompt: '`menu.txt` is read-only, even for you. Add the line *4. Pizza on Fridays* to the end of it, keeping the rest of the menu.',
      hint: "It's your file, so you may give yourself write permission first.",
      solution: ['chmod u+w menu.txt', 'echo "4. Pizza on Fridays" >> menu.txt'],
      explain: '`chmod u+w` gave you, the owner, write permission (`rw-r--r--`), and then `>>` could add the line. You can always change the permissions of your own files.',
      check: (c) => {
        const lines = linesOf(c, 'club/menu.txt');
        return !!lines && lines.length === MENU_LINES.length + 1 && MENU_LINES.every((l, i) => lines[i] === l) && /^4\.\s*pizza on fridays$/i.test(lines[MENU_LINES.length]);
      },
    },
    {
      kind: 'task',
      prompt: "You can't get into the `minutes` folder. Give it the usual permissions for a folder (you may do everything; everyone else may look inside and go in, but not change anything), then go inside.",
      hint: 'On a folder, `x` is the permission to go inside. The usual folder setting is the number that means `rwxr-xr-x`.',
      solution: ['chmod 755 minutes', 'cd minutes'],
      explain: "`755` is `rwxr-xr-x`, the setting almost every folder has. Without `x`, a folder is a locked door, even when you're allowed to read the names inside.",
      check: all(modeIs('club/minutes', 0o755), cwdIs('club/minutes')),
    },
  ],
  recap: `
- \`ls -l\` shows the type, then three sets of \`rwx\`: for the **u**ser who owns the file, its **g**roup and all **o**thers.
- On a file \`x\` means *run it*; on a folder it means *go inside*.
- \`chmod\` changes permissions with letters (\`chmod go-r\`, \`chmod +x\`, \`chmod u+w\`) or with numbers built from r = 4, w = 2, x = 1 (\`644\`, \`755\`, \`600\`).
- **Permission denied** means the rules said no. \`ls -l\` shows you which rule, and \`id\` shows who you are.
`,
  cheatsheet: [
    ['ls -l', 'show permissions, owner and group'],
    ['id / groups', 'show your user and your groups'],
    ['chmod +x FILE', 'let everyone run a file'],
    ['chmod go-r FILE', 'stop group and others reading it'],
    ['chmod u+w FILE', 'let the owner change it'],
    ['chmod 644 FILE', 'rw-r--r--: an ordinary file'],
    ['chmod 755 FILE', 'rwxr-xr-x: a program or folder'],
    ['chmod 600 FILE', 'rw-------: a private file'],
  ],
  realWorld: `
- **macOS** uses the same owner, group and others permissions and the same \`chmod\` commands. Its \`ls -l\` sometimes shows an extra \`@\` or \`+\` after the permissions, meaning the file carries extra attributes or access rules.
- **Windows** uses a different system called access control lists, which you manage in a file's *Properties → Security* tab (or with the \`icacls\` command). Whether a file can run depends on its ending, such as \`.exe\` or \`.bat\`, not on an \`x\` permission. Inside **WSL**, Linux permissions work exactly as described here.
`,
};

// ---------------------------------------------------------------------------
// Lesson: sudo

const ORIGINAL_HOSTS = new Set(
  HOSTS('sandbox')
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter(Boolean),
);

/** Entry lines in /etc/hosts that weren't there originally. */
function newHostEntries(c: CheckContext): string[] {
  const t = fileText(c, '/etc/hosts');
  if (t === null) return [];
  return t
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => /^[0-9a-fA-F.:]+ \S/.test(l) && !ORIGINAL_HOSTS.has(l));
}

const hostsIntact = fileContains('/etc/hosts', /^127\.0\.0\.1\s+localhost\b/m);

/** Every entry and comment that was in /etc/hosts at the start is still there. */
const hostsKept: Check = (c) => {
  const t = fileText(c, '/etc/hosts');
  if (t === null) return false;
  const lines = new Set(t.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')));
  return [...ORIGINAL_HOSTS].every((l) => lines.has(l));
};

const CLUB_CONF = `# Settings for the terminal club
name=Terminal Club
max_members=10
meeting_day=Thursday
`;

const PASSWORD = { keys: 'password\r', label: 'Type any password (nothing appears as you type) and press Enter', delay: 300 };

export const sudo: Lesson = {
  id: 'sudo',
  title: 'Administrator powers with sudo',
  summary: 'Meet root, the all-powerful administrator, and use sudo to change protected system files safely.',
  moduleId: 'permissions',
  minutes: 10,
  intro: `
Some files are too important to be changed by just anyone: the list of users, the system's settings, the installed programs. They belong to a special user called **root**, also known as the **superuser** or the administrator. Root may read, change and delete *anything* on the computer, whatever the permissions say.

You don't log in as root. Instead, when one command needs root's power, you put **\`sudo\`** (short for *superuser do*) in front of it:

\`\`\`
learner@sandbox:~$ sudo whoami
[sudo] password for learner:
root
\`\`\`

sudo asks for **your own** password, to prove it's really you at the keyboard. While you type it, **nothing appears on the screen**, not even dots. That's normal: type it and press <kbd>Enter</kbd>. (In this practice computer any password works.) sudo then remembers you for about 15 minutes, so it won't ask again for every command.

> [!HOW]
> sudo looks up who may use it in the file \`/etc/sudoers\`. On Ubuntu, one rule there says that members of the **sudo** group may run any command as root, and the first user created on a computer is put in that group. That's why \`id\` lists \`27(sudo)\` for you. Anyone outside the group just gets the reply *"... is not in the sudoers file"*. sudo also keeps a log of every command it runs.

> [!CAUTION]
> Root can break the whole system, and sudo won't stop it. Use sudo only when a command really needs it (changing system files, installing software), and never paste a sudo command from the internet that you don't understand.
`,
  steps: [
    {
      id: 'protected',
      title: 'A file you may not change',
      instruction:
        '`/etc/hosts` is a small system file that works like an address book, pairing names with network addresses. Look at who owns it:\n\n`$ ls -l /etc/hosts`\n\nIt belongs to `root` and is `rw-r--r--`, so you may read it but not change it. Try to add a line anyway:\n\n`$ echo "127.0.0.1 shop.test" >> /etc/hosts`',
      hint: 'Type the second command exactly, including the two `>` signs that append to the file.',
      solution: ['ls -l /etc/hosts', 'echo "127.0.0.1 shop.test" >> /etc/hosts'],
      explain:
        "**Permission denied**: the `w` for others is missing, and you are \"others\" for this file. Good! Imagine if any program you ran could rewrite your system's settings. (The line you tried to add would make the name `shop.test` point to your own computer, which web developers do all the time. Names ending in `.test` are reserved for exactly this kind of experiment.)",
      check: outputIncludes(/\/etc\/hosts: Permission denied/),
    },
    {
      id: 'sudo-whoami',
      title: "Borrow root's power",
      instruction:
        "Run `whoami` as root. When sudo asks for your password, type anything (you won't see it) and press <kbd>Enter</kbd>:\n\n`$ sudo whoami`",
      hint: 'Nothing appears while you type the password. That is normal. Just type something and press Enter.',
      solution: ['sudo whoami', PASSWORD],
      explain:
        "`root`! Only that one command ran as root. Run `$ whoami` again without sudo and you're back to `learner`. On a real computer you would type your real login password here, and after three wrong tries sudo gives up.",
      check: ranAsRoot('whoami', { status: 0 }),
    },
    {
      id: 'sudo-nano',
      title: 'Edit a system file',
      instruction:
        "Open the protected file in nano, as root:\n\n`$ sudo nano /etc/hosts`\n\nThe cursor starts at the top. Type this line and press <kbd>Enter</kbd>, so it becomes the new first line:\n\n```\n127.0.0.1   shop.test\n```\n\nSave with <kbd>Ctrl</kbd>+<kbd>O</kbd> and <kbd>Enter</kbd>, then exit with <kbd>Ctrl</kbd>+<kbd>X</kbd>.",
      hint: 'If sudo asks for your password again, type anything and press Enter. If nano says *Permission denied* when saving, you forgot the `sudo` in front of nano: exit with Ctrl+X, answer N, and start again.',
      solution: [
        'sudo nano /etc/hosts',
        { keys: '127.0.0.1   shop.test\r', label: 'Type the new line and press Enter', delay: 400 },
        { keys: '\x0f', label: 'Press Ctrl+O to save' },
        { keys: '\r', label: 'Press Enter to keep the file name' },
        { keys: '\x18', label: 'Press Ctrl+X to exit nano' },
      ],
      explain:
        "Because nano itself ran as root, it was allowed to save the file. Check your work with `$ cat /etc/hosts` (reading needs no sudo). This is the usual way to change a system settings file: `sudo nano` followed by the file's path.",
      check: all(everRanAsRoot('nano'), (c) => newHostEntries(c).length > 0),
    },
    {
      id: 'redirect-trap',
      title: 'The redirection trap',
      instruction: 'Here is a mistake almost everyone makes. You might expect this to add a line, since it has sudo in front:\n\n`$ sudo echo "127.0.0.1 blog.test" >> /etc/hosts`',
      solution: ['sudo echo "127.0.0.1 blog.test" >> /etc/hosts'],
      explain:
        "Still **Permission denied**. The `>>` isn't part of the `echo` command: **your own shell** opens the file for appending before it even starts sudo, and your shell runs as `learner`. sudo only gave root's power to `echo`, which never needed it.",
      check: all(lineMatches(/^\s*sudo\s[^|]*>>?\s*\/etc\/hosts/), outputIncludes('Permission denied')),
    },
    {
      id: 'tee',
      title: 'Append with sudo tee',
      instruction:
        "The fix is to let a root program write the file. `tee` copies what it receives into a file (and onto the screen), and `-a` makes it **a**ppend:\n\n`$ echo \"127.0.0.1 blog.test\" | sudo tee -a /etc/hosts`",
      hint: "Don't forget the `-a`. Without it, tee replaces the whole file instead of adding to the end.",
      solution: ['echo "127.0.0.1 blog.test" | sudo tee -a /etc/hosts'],
      explain:
        "This time the file was opened by `tee`, which ran as root. The line you see on screen is tee's copy; add `> /dev/null` to the end of the command to hide it. Take a look with `$ tail -3 /etc/hosts`.",
      check: all(
        any(
          ranAsRoot('tee', { args: [/^(-a|--append)$/, /^\/etc\/hosts$/], status: 0 }),
          (c) => !!c.ev && c.ev.status === 0 && /^\s*sudo\s+(ba)?sh\s+-c\s+.*>>\s*\/etc\/hosts/.test(c.ev.line),
        ),
        hostsIntact,
        (c) => newHostEntries(c).length > 0,
      ),
    },
    {
      id: 'own-files',
      title: "Don't sudo your own files",
      instruction: "sudo is for system files. Watch what happens when you use it on your own:\n\n`$ sudo touch mistake.txt`\n\n`$ ls -l mistake.txt`",
      solution: ['sudo touch mistake.txt', 'ls -l mistake.txt'],
      explain:
        "The new file belongs to `root`, even though it sits in your home folder. Now **you** can't change it: try `$ echo hello >> mistake.txt`. This is the classic result of using sudo out of habit. In your own home folder you should never need it, so if you get *Permission denied* there, find out why with `ls -l` instead of reaching for sudo.",
      check: all(ownerIs('mistake.txt', 0), ran('ls', { flags: 'l' })),
    },
    {
      id: 'chown',
      title: 'Give it back',
      instruction:
        "`chown` (*change owner*) gives a file to someone else, written as `user:group`. Only root may give files away, so this is a job for sudo:\n\n`$ sudo chown learner:learner mistake.txt`\n\n`$ ls -l mistake.txt`",
      solution: ['sudo chown learner:learner mistake.txt', 'ls -l mistake.txt'],
      explain:
        "It's yours again. (Deleting it with `rm mistake.txt` would also have worked, after rm double-checks that you really mean it: whoever may change a folder may remove files from it.) That's the right way to use sudo: deliberately, for one command, when you know why it's needed.",
      check: any(all(isFile('mistake.txt'), ownerIs('mistake.txt', 1000)), missing('mistake.txt')),
    },
  ],
  quizSetup: (env) => {
    env.file('/etc/club.conf', CLUB_CONF, { owner: 'root', mode: 0o644, daysAgo: 30 });
    env.file('report.txt', 'Quarterly report\n\nMembers: 12\nSnacks eaten: too many\n', { owner: 'root', mode: 0o644 });
  },
  quiz: [
    {
      kind: 'task',
      prompt: 'Run the command that prints your user name, but run it as the administrator, root.',
      hint: "One word in front of the command borrows root's power. Nothing appears on the screen while you type the password; that's normal.",
      solution: ['sudo whoami', PASSWORD],
      explain: "It printed `root`: sudo ran that one command as the administrator, after checking your password. The next command runs as you again.",
      check: ranAsRoot('whoami', { status: 0 }),
    },
    {
      prompt: 'Why is this refused, even with sudo?\n\n```\n$ sudo echo "127.0.0.1 blog.test" >> /etc/hosts\nbash: /etc/hosts: Permission denied\n```',
      options: ['sudo did not accept your password', 'Your own shell opens the file for `>>` before sudo starts, and your shell is not root', 'Not even root may change `/etc/hosts`', 'It should have been `>` instead of `>>`'],
      answer: 1,
      explain: "Redirections are done by the shell you're typing into, which runs as you, before the command even starts. Here sudo never even ran; it would only have given root's power to `echo`, which doesn't need it.",
    },
    {
      kind: 'task',
      prompt: 'Make the name `games.test` point to your own computer: add the line `127.0.0.1 games.test` to the protected file `/etc/hosts`, and keep everything that is already in it.',
      hint: "Let a program that runs as root open the file itself. `tee` can do that; don't forget its option that **a**ppends, or it replaces the whole file.",
      solution: ['echo "127.0.0.1 games.test" | sudo tee -a /etc/hosts'],
      explain: '`tee` opened the file itself, and it ran as root, so it was allowed to. `-a` made it add to the end instead of replacing everything. `sudo nano /etc/hosts` works too.',
      check: all(hostsKept, (c) => newHostEntries(c).includes('127.0.0.1 games.test')),
    },
    {
      kind: 'task',
      prompt: 'The club keeps its settings in the protected file `/etc/club.conf`. Change `max_members` from 10 to 20 there, without changing the other settings.',
      hint: 'Open the file in nano, but as root, so that nano is allowed to save it.',
      solution: [
        'sudo nano /etc/club.conf',
        { keys: '\x06', label: 'Press Ctrl+F to search' },
        { keys: '10\r', label: 'Type 10 and press Enter' },
        { keys: '\x1b[3~\x1b[3~', label: 'Press Delete twice' },
        { keys: '20', label: 'Type 20' },
        { keys: '\x18y\r', label: 'Press Ctrl+X, then Y, then Enter to save and exit' },
      ],
      explain: 'Because nano itself ran as root, it could save the protected file. `sudo nano` followed by the path is the usual way to change a system settings file.',
      check: all(
        fileContains('/etc/club.conf', /^max_members\s*=\s*20\s*$/m),
        not(fileContains('/etc/club.conf', /^max_members\s*=\s*10\s*$/m)),
        fileContains('/etc/club.conf', /^name=Terminal Club$/m),
        fileContains('/etc/club.conf', /^meeting_day=Thursday$/m),
      ),
    },
    {
      kind: 'task',
      prompt: 'Someone used sudo out of habit, and now `report.txt` in your home folder belongs to root, so you can no longer change it. Make it yours again: both its owner and its group should be `learner`.',
      hint: 'Only root may give a file to someone else. The command that changes the owner takes `user:group`.',
      solution: ['sudo chown learner:learner report.txt'],
      explain: '`chown learner:learner` gave the file back to you, both owner and group, and `ls -l report.txt` shows `learner learner` again.',
      check: ownedBy('report.txt', 1000, 1000),
    },
  ],
  recap: `
- **root** is the all-powerful administrator account, and system files belong to it.
- \`sudo COMMAND\` runs one command as root, after asking for *your* password (typing shows nothing).
- \`sudo nano FILE\` edits a protected file. To append from the command line use \`echo TEXT | sudo tee -a FILE\`, because redirections like \`>>\` are done by your own shell, not by sudo.
- Don't use sudo on your own files, and never run a sudo command you don't understand.
`,
  cheatsheet: [
    ['sudo COMMAND', 'run one command as root'],
    ['sudo whoami', 'prints root'],
    ['sudo nano FILE', 'edit a protected file'],
    ['echo TEXT | sudo tee -a FILE', 'append to a protected file'],
    ['sudo chown USER:GROUP FILE', 'change who owns a file'],
    ['sudo -i', 'open a whole shell as root (exit to leave)'],
    ['sudo -k', 'make sudo forget your password now'],
  ],
  realWorld: `
- **macOS** has sudo too. It asks for your Mac login password, and only administrator accounts may use it. The hosts file is at \`/etc/hosts\` there as well.
- **Windows** traditionally uses *Run as administrator*: right-click a program, or confirm the pop-up that asks for permission. Windows 11 (version 24H2 and later) also has its own \`sudo\` command, which you can switch on in *Settings → System → For developers*. The hosts file lives at \`C:\\Windows\\System32\\drivers\\etc\\hosts\`.
- In **WSL**, sudo works exactly as it does here, with the Linux password you chose when setting it up. A few Linux systems show a \`*\` for each key while you type a password.
`,
};

// ---------------------------------------------------------------------------
// Lesson: Installing software with apt

/** Put a package's programs on disk and register it as installed, the way `apt install` leaves things. */
function preinstall(env: LessonSetupEnv, name: string, programSize: number): void {
  const pkg = packageByName(name);
  if (!pkg) return;
  const ctx = { cwd: '/', creds: ROOT_CREDS, umask: 0o022 };
  const files = ['/.'];
  for (const c of pkg.commands) {
    const path = `${c.dir}/${c.name}`;
    const node = env.sys.fs.writeFile(path, { kind: 'native', command: c.name, size: programSize }, ctx, { mode: 0o755 });
    node.mode = 0o755;
    files.push(path);
  }
  env.sys.fs.writeFile(`/var/lib/dpkg/info/${pkg.name}.list`, files.join('\n') + '\n', ctx, { mode: 0o644 });
}

export const installingSoftware: Lesson = {
  id: 'installing-software',
  title: 'Installing software with apt',
  summary: 'Search for, install, use and remove programs with Ubuntu\'s package manager.',
  moduleId: 'permissions',
  minutes: 9,
  intro: `
On a phone you install apps from an app store. Linux had the same idea long before phones did: a **package manager** downloads software from a trusted online collection, installs it, keeps it up to date and removes it cleanly.

- A **package** is one piece of software bundled up for installing, such as \`nano\` or \`ncal\`.
- A **repository** is an online collection of packages. Ubuntu's main repositories hold tens of thousands of them.
- Ubuntu's package manager is called **apt**.

| Command | What it does | Needs sudo? |
| --- | --- | --- |
| \`apt search WORD\` | find packages | no |
| \`apt show PACKAGE\` | describe a package | no |
| \`sudo apt update\` | refresh the list of available packages | yes |
| \`sudo apt install PACKAGE\` | install a package | yes |
| \`apt list --installed\` | list what's installed | no |
| \`sudo apt remove PACKAGE\` | uninstall a package | yes |

Looking things up is safe for anyone; changing the system needs sudo.

Try a calendar program that isn't installed yet: \`$ cal\`. Ubuntu notices, and even tells you which package would provide it.

> [!HOW]
> apt keeps a local copy of each repository's catalog: every package, its version, and what else it needs. \`apt update\` downloads a fresh copy of that catalog (it doesn't install anything). \`apt install\` looks the package up, works out which other packages it needs to work (its **dependencies**), downloads them, checks that they are genuine, and hands them to a lower-level tool called \`dpkg\`, which unpacks the files into place, such as the program \`/usr/bin/cal\`.
`,
  steps: [
    {
      id: 'search',
      title: 'Search the catalog',
      instruction: 'Search for packages that have anything to do with calendars:\n\n`$ apt search calendar`',
      solution: ['apt search calendar'],
      explain:
        "Each result shows the package name, its version and a one-line description. `ncal` is the one that provides the `cal` command. On a real Ubuntu computer this list is much longer; add more words to narrow it down.",
      check: ran('apt', { args: ['search'], aliases: ['apt-cache'] }),
    },
    {
      id: 'show',
      title: 'Read about a package',
      instruction: 'Before installing anything, find out what it is:\n\n`$ apt show ncal`',
      solution: ['apt show ncal'],
      explain:
        "You get the version, the download size, what it **depends** on and a longer description. It's a good habit to read this before installing something new, especially when a name is unfamiliar.",
      check: ran('apt', { args: ['show'], aliases: ['apt-cache'] }),
    },
    {
      id: 'update',
      title: 'Refresh the package list',
      instruction:
        "Before installing, refresh apt's catalog so it knows about the newest versions. That changes the system, so it needs sudo. Type any password when asked, then press <kbd>Enter</kbd>:\n\n`$ sudo apt update`",
      hint: 'Without sudo, apt stops with *Permission denied* errors: only root may change the package lists.',
      solution: ['sudo apt update', PASSWORD],
      explain:
        "The `Hit` and `Get` lines are apt checking each repository. *packages can be upgraded* means newer versions of software you already have are available; `sudo apt upgrade` would install them. Run `update` every now and then, and always before installing.",
      check: ranAsRoot('apt', { args: ['update'], aliases: ['apt-get'], status: 0 }),
    },
    {
      id: 'install',
      title: 'Install it',
      instruction: 'Now install the package:\n\n`$ sudo apt install ncal`',
      hint: 'sudo remembers your password for a while. If it asks again, type anything and press Enter.',
      solution: ['sudo apt install ncal'],
      explain:
        "apt downloaded the package, unpacked it and set it up. Bigger programs often need other packages too; apt then lists them all and asks *Do you want to continue? [Y/n]* before going ahead.",
      check: packageInstalled('ncal'),
    },
    {
      id: 'use',
      title: 'Use your new program',
      instruction: 'Your new command is ready. Run it:\n\n`$ cal`',
      solution: ['cal'],
      explain:
        "It shows this month, with today highlighted. The program now lives in `/usr/bin` (check with `$ which cal`). Try `$ cal 12 2026` or `$ cal -3` too. If you want something sillier, install `cowsay` (a talking cow: `cowsay hello`) or `sl` (a steam train for anyone who mistypes `ls`) the same way.",
      check: ran('cal', { status: 0 }),
    },
    {
      id: 'list',
      title: "See what's installed",
      instruction: 'List every installed package:\n\n`$ apt list --installed`',
      solution: ['apt list --installed'],
      explain:
        "`ncal` is in the list, marked `[installed]`. Here the list is short, but on a real computer it runs to well over a thousand lines, so you'd usually narrow it down: `$ apt list --installed ncal` checks just one package.",
      check: ran('apt', { args: ['list', '--installed'] }),
    },
    {
      id: 'remove',
      title: 'Remove it again',
      instruction:
        'Uninstall `ncal`. apt asks for confirmation first: type `y` and press <kbd>Enter</kbd>. (The capital `Y` in `[Y/n]` is the default, so just pressing Enter also means yes.)\n\n`$ sudo apt remove ncal`',
      solution: ['sudo apt remove ncal', { keys: 'y\r', label: 'Type y and press Enter to confirm', delay: 1200 }],
      explain:
        "The package's files are gone. Try `cal` now and you get an error; bash may even complain that `/usr/bin/cal` doesn't exist, because it remembered where the program used to be. `sudo apt purge PACKAGE` would also delete the package's system-wide settings, and `sudo apt autoremove` cleans up extra packages that nothing needs any more.",
      check: all(not(packageInstalled('ncal')), everRanAsRoot('apt', { args: [/^(remove|purge)$/], aliases: ['apt-get'] })),
    },
  ],
  quizSetup: (env) => {
    preinstall(env, 'sl', 17_792);
  },
  quiz: [
    {
      kind: 'task',
      prompt: "You'd like a program that turns text into big banner letters, but you don't know what it's called. Search apt's catalog for one.",
      hint: 'apt can search the names and descriptions of every package. Looking things up needs no sudo.',
      solution: ['apt search banner'],
      explain: '`apt search` looks through the names and descriptions of all the packages: `figlet` makes large letters out of ordinary text. Searching only reads the catalog, so anyone may do it.',
      check: all(any(ran('apt', { args: ['search'] }), ran('apt-cache', { args: ['search'] })), outputIncludes('figlet')),
    },
    {
      kind: 'task',
      prompt: 'Before installing `htop`, find out how big its download is, without installing anything.',
      hint: 'apt can describe a package in detail, including its sizes.',
      solution: ['apt show htop'],
      explain: '`apt show` describes a package: its version, its download size, what it depends on and what it does. Like searching, it changes nothing, so it needs no sudo.',
      check: all(any(ran('apt', { args: ['show', 'htop'] }), ran('apt-cache', { args: ['show', 'htop'] })), outputIncludes('Download-Size')),
    },
    {
      prompt: 'What does `sudo apt update` do?',
      options: ["Refreshes apt's list of available packages, without installing anything", 'Installs the newest version of every program you have', 'Updates Ubuntu to its next release', 'Updates apt itself to its newest version'],
      answer: 0,
      explain: '`apt update` only downloads a fresh copy of the catalog, so that apt knows about the newest versions. Actually installing newer versions of your software is `sudo apt upgrade`.',
    },
    {
      kind: 'task',
      prompt: 'Install the package `cowsay`, then use it to make the cow say *moo*.',
      hint: 'Installing changes the system, so it needs sudo. apt asks before installing extra packages that cowsay needs: answer yes.',
      solution: ['sudo apt install cowsay', PASSWORD, { keys: 'y\r', label: 'Type y and press Enter to confirm', delay: 1200 }, 'cowsay moo'],
      explain: 'apt asked *Do you want to continue?* because cowsay needs one more package to work, and it installed both. The new command then works like any other: `cowsay` followed by what the cow should say.',
      check: all(packageInstalled('cowsay'), any(ran('cowsay', { status: 0 }), ran('cowthink', { status: 0 }))),
    },
    {
      kind: 'task',
      prompt: 'Someone installed the package `sl` on this computer: a steam train that rides across the screen whenever you mistype `ls`. Uninstall it.',
      hint: 'Removing software changes the system, so it needs sudo. If sudo asks for your password again, type anything and press Enter.',
      solution: ['sudo apt remove sl', { keys: 'y\r', label: 'Type y and press Enter to confirm', delay: 1200 }],
      explain: "apt removed the package's files, so `sl` is gone again. `sudo apt purge sl` would also have deleted its system-wide settings.",
      check: not(packageInstalled('sl')),
    },
  ],
  recap: `
- A **package manager** installs, updates and removes software from trusted **repositories**. On Ubuntu it's **apt**.
- Look things up freely: \`apt search\`, \`apt show\`, \`apt list --installed\`.
- Change things with sudo: \`sudo apt update\`, \`sudo apt install\`, \`sudo apt remove\`.
- When a command isn't found, Ubuntu often tells you which package provides it.
`,
  cheatsheet: [
    ['apt search WORD', 'find packages'],
    ['apt show PACKAGE', 'describe a package'],
    ['sudo apt update', 'refresh the package list'],
    ['sudo apt upgrade', 'install available updates'],
    ['sudo apt install PACKAGE', 'install a package'],
    ['apt list --installed', 'list installed packages'],
    ['sudo apt remove PACKAGE', 'uninstall a package'],
  ],
  realWorld: `
**macOS: Homebrew.** macOS has no package manager of its own for the command line, so most people install [Homebrew](https://brew.sh). It works without sudo (and you should never use sudo with it):

| Ubuntu | Homebrew |
| --- | --- |
| \`apt search tree\` | \`brew search tree\` |
| \`apt show tree\` | \`brew info tree\` |
| \`sudo apt update\` | \`brew update\` |
| \`sudo apt install tree\` | \`brew install tree\` |
| \`apt list --installed\` | \`brew list\` |
| \`sudo apt remove tree\` | \`brew uninstall tree\` |

**Windows: winget.** Windows 10 and 11 include \`winget\`, which you run in PowerShell or Command Prompt: \`winget search firefox\`, \`winget show Mozilla.Firefox\`, \`winget install Mozilla.Firefox\`, \`winget list\`, \`winget uninstall Mozilla.Firefox\`, and \`winget upgrade --all\` to update everything. Instead of sudo, Windows shows a pop-up when an installer needs administrator rights.

**Other Linux systems** use different package managers built on the same ideas, such as \`dnf\` on Fedora and \`pacman\` on Arch. Ubuntu also offers **snaps** (\`sudo snap install NAME\`), which bundle an app together with everything it needs.
`,
};

export const permissionsLessons: Lesson[] = [permissions, sudo, installingSoftware];

