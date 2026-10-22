// Module: Permissions and power.

import { HOSTS } from '../../shell/sampledata';
import { abs, all, any, fileContains, fileLineCount, fileText, isExecutable, isFile, lineMatches, missing, modeIs, not, outputIncludes, ownerIs, packageInstalled, ran } from '../checks';
import type { ExecEvent } from '../../shell/system';
import type { CheckContext, Lesson } from '../types';

type Check = (c: CheckContext) => boolean;

const ROOT_CTX = { cwd: '/', creds: { uid: 0, gid: 0, groups: [0] } };

/** Permission bits of a file (null if it doesn't exist). */
function modeOf(c: CheckContext, path: string): number | null {
  const n = c.sys.fs.tryStat(abs(path), ROOT_CTX);
  return n ? n.mode & 0o7777 : null;
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
  quiz: [
    {
      prompt: '`ls -l` shows this line:\n\n```\n-rw-rw-r-- 1 learner team 120 Oct 21 10:00 plan.txt\n```\n\nWhat may members of the group `team` do with `plan.txt`?',
      options: ['Read it and change it, but not run it', 'Only read it', 'Read it, change it and run it', 'Nothing: only the owner may use it'],
      answer: 0,
      explain: 'After the type character come three sets of three letters: `rw-` for the owner, `rw-` for the group and `r--` for everyone else. The group has `r` and `w`, but no `x`.',
    },
    {
      kind: 'command',
      prompt: "You try to run your own script:\n\n```\n$ ./backup.sh\nbash: ./backup.sh: Permission denied\n```\n\nType a `chmod` command that lets you, its owner, run it, without changing anyone else's permissions.",
      accept: ['chmod u+x backup.sh', /^chmod u(\+x|\+rx|\+xr|\+rwx|=rwx) (["']?)(\.\/)?backup\.sh\2$/],
      explain: 'Linux only runs a file that has `x` (execute) permission. `u+x` adds it for the **u**ser who owns the file and nobody else; `chmod +x` would give it to everyone.',
    },
    {
      prompt: 'Which permissions does `chmod 750 run.sh` give the file?',
      options: ['`rwxrw----`', '`rw-r-x---`', '`rwxr-x---`', '`---r-xrwx`'],
      answer: 2,
      explain: 'Each digit adds up r = 4, w = 2 and x = 1, in the order user, group, others: 7 = 4 + 2 + 1 = `rwx`, 5 = 4 + 1 = `r-x`, and 0 = `---`.',
    },
    {
      prompt: "You own the folder `photos`, but you can't go inside:\n\n```\n$ ls -l\ntotal 4\ndrw-r--r-- 2 learner learner 4096 Oct 21 10:00 photos\n$ cd photos\nbash: cd: photos: Permission denied\n```\n\nWhy?",
      options: ['You need `w` permission to go into a folder', 'The `d` at the start means the folder is disabled', 'The folder is empty, so there is nothing to go into', 'It has no `x` permission, which on a folder means *go inside*'],
      answer: 3,
      explain: "On a folder, `x` is the permission to enter it and use what's inside, and this one has no `x` for anybody. `chmod 755 photos` opens the door again. The `d` just means *directory*.",
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
  quiz: [
    {
      prompt: 'Why is this refused, even with sudo?\n\n```\n$ sudo echo "127.0.0.1 blog.test" >> /etc/hosts\nbash: /etc/hosts: Permission denied\n```',
      options: ['sudo did not accept your password', 'Your own shell opens the file for `>>` before sudo starts, and your shell is not root', 'Not even root may change `/etc/hosts`', 'It should have been `>` instead of `>>`'],
      answer: 1,
      explain: "Redirections are done by the shell you're typing into, which runs as you, before the command even starts. Here sudo never even ran; it would only have given root's power to `echo`, which doesn't need it.",
    },
    {
      kind: 'command',
      prompt: 'Type a command that adds the line `127.0.0.1 shop.test` to the end of the protected file `/etc/hosts`, using sudo in a way that works.',
      accept: [
        'echo "127.0.0.1 shop.test" | sudo tee -a /etc/hosts',
        /^echo (["']?)127\.0\.0\.1 shop\.test\1 ?\| ?sudo tee (-a|--append) \/etc\/hosts( ?> ?\/dev\/null)?$/,
        /^sudo (sh|bash) -c 'echo ("?)127\.0\.0\.1 shop\.test\2 ?>> ?\/etc\/hosts'$/,
        /^sudo (sh|bash) -c "echo ('?)127\.0\.0\.1 shop\.test\2 ?>> ?\/etc\/hosts"$/,
      ],
      explain: "Here the file is opened by `tee`, which runs as root. Don't forget the `-a`: without it, tee replaces the whole file instead of adding to the end.",
    },
    {
      prompt: 'sudo asks `[sudo] password for learner:`, but nothing shows up on the screen as you type. What should you do?',
      options: ['Keep typing your own password and press <kbd>Enter</kbd>: hiding it is normal', "Type root's password instead, since the command will run as root", 'Press <kbd>Ctrl</kbd>+<kbd>C</kbd>: the terminal has frozen'],
      answer: 0,
      explain: "sudo asks for **your** password, to check that it's really you at the keyboard, and it deliberately shows nothing while you type, not even dots.",
    },
    {
      prompt: 'In your home folder, you run `sudo touch notes.txt`. What is the catch?',
      options: ['There is none: the file belongs to you, as usual', "The file is created in root's home folder instead of yours", '`touch` refuses to run as root', "`notes.txt` belongs to root, so you can't change it without sudo"],
      answer: 3,
      explain: 'Anything a command creates while running as root belongs to root. You never need sudo in your own home folder; if a file there ends up belonging to root, `sudo chown learner:learner notes.txt` gives it back.',
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
> apt keeps a local copy of each repository's catalogue: every package, its version, and what else it needs. \`apt update\` downloads a fresh copy of that catalogue (it doesn't install anything). \`apt install\` looks the package up, works out which other packages it needs to work (its **dependencies**), downloads them, checks that they are genuine, and hands them to a lower-level tool called \`dpkg\`, which unpacks the files into place, such as the program \`/usr/bin/cal\`.
`,
  steps: [
    {
      id: 'search',
      title: 'Search the catalogue',
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
        "Before installing, refresh apt's catalogue so it knows about the newest versions. That changes the system, so it needs sudo. Type any password when asked, then press <kbd>Enter</kbd>:\n\n`$ sudo apt update`",
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
  quiz: [
    {
      prompt: 'What does `sudo apt update` do?',
      options: ['Installs the newest version of every program you have', "Refreshes apt's list of available packages, without installing anything", 'Updates Ubuntu to its next release', 'Updates apt itself to its newest version'],
      answer: 1,
      explain: '`apt update` only downloads a fresh copy of the catalogue, so that apt knows about the newest versions. Actually installing newer versions of your software is `sudo apt upgrade`.',
    },
    {
      kind: 'command',
      prompt: 'Type the command that installs the package `cowsay`.',
      accept: ['sudo apt install cowsay', 'sudo apt-get install cowsay', /^sudo apt(-get)?( -y| --yes)? install( -y| --yes)? cowsay( -y| --yes)?$/],
      explain: 'Installing changes the system, so it needs `sudo` in front. apt then downloads the package, plus anything it depends on, and sets it up.',
    },
    {
      prompt: 'Which of these commands works without sudo?',
      options: ['`apt install ncal`', '`apt remove ncal`', '`apt update`', '`apt search calendar`'],
      answer: 3,
      explain: 'Looking things up, with `apt search`, `apt show` or `apt list --installed`, is safe for anyone. Anything that changes the system, such as `update`, `install` and `remove`, needs sudo.',
    },
    {
      prompt: "What is Ubuntu telling you here?\n\n```\n$ cal\nCommand 'cal' not found, but can be installed with:\nsudo apt install ncal\n```",
      options: ["`cal` isn't installed, but the package `ncal` provides it", '`cal` is misspelled, and the right name is `ncal`', '`cal` only works when you run it with sudo', '`cal` was removed for safety reasons'],
      answer: 0,
      explain: 'A package can contain commands with other names: installing `ncal` gives you the `cal` command. Ubuntu found the missing command in its catalogue and tells you which package to install.',
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

