// The fun programs: cowsay, cowthink, fortune, sl, figlet and neofetch.

import { PACKAGES } from '../packages';
import type { CommandContext, CommandDoc } from '../types';
import { basename } from '../vfs/path';
import { stringWidth, stripAnsi } from '../wcwidth';
import { FullScreen, MEM_KB, NCPU } from './top';
import { expandTabs } from './tui';
import { defineCommand, gnuHelp } from './util';

// ---------------------------------------------------------------------------
// cowsay / cowthink (cowsay 3.03)

/** Perl's split(): like String.split but trailing empty fields are dropped. */
function perlSplit(s: string, re: RegExp): string[] {
  const parts = s.split(re);
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Text::Wrap::wrap('', '', text) with $Text::Wrap::columns = columns (lines get at most columns-1 characters). */
export function textWrap(text: string, columns: number): string {
  const ll = Math.max(1, columns - 1);
  const chars = [...expandTabs(text)];
  const len = chars.length;
  const isSpace = (c: string) => /\s/.test(c);
  let r = '';
  let pos = 0;
  let nl = '';
  let remainder = '';
  while (!chars.slice(pos).every(isSpace)) {
    let limit = 0;
    while (limit < ll && pos + limit < len && chars[pos + limit] !== '\n') limit++;
    let k = -1;
    for (let j = limit; j >= 0; j--) {
      const at = pos + j;
      if (at === len || isSpace(chars[at])) {
        k = j;
        break;
      }
    }
    if (k >= 0) {
      r += nl + chars.slice(pos, pos + k).join('');
      pos += k;
      if (pos >= len) remainder = '';
      else {
        remainder = chars[pos];
        pos++;
      }
    } else {
      // A word longer than the line: break it ($huge = 'wrap').
      r += nl + chars.slice(pos, pos + ll).join('');
      pos += ll;
      remainder = '\n';
    }
    nl = '\n';
  }
  return r + remainder;
}

/** Text::Wrap::fill(): paragraphs (split on a newline followed by whitespace) wrapped and joined by blank lines. */
function textFill(lines: string[], columns: number): string {
  return perlSplit(lines.join('\n'), /\n\s+/)
    .map((p) => textWrap(p.replace(/\s+/g, ' '), columns))
    .join('\n\n');
}

// The cows. § is $thoughts, ¤¤ is $eyes (« and » are the two eyes on their own) and ¦¦ is $tongue.
const COWS: Record<string, string> = {
  default: String.raw`
        §   ^__^
         §  (¤¤)\_______
            (__)\       )\/\
             ¦¦ ||----w |
                ||     ||
`,
  bunny: String.raw`
   §
    §   /|   |\
       / |   | \
       | |___| |
       /  «  »  \
      (   =v=   )
       \  ___  /
       (_/   \_)
`,
  dragon: String.raw`
   §
    §       __                 __
           /  \___  /\_/\  ___/  \
          / /\/\/ \( ¤¤  )/ \/\/\ \
         /_/       \ \vv / /      \_\
                    \_)  (_/
                     /    \
                    /_/  \_\
`,
  kitty: String.raw`
   §
    §     /\_/\
         / ¤¤  \
        (  =v=  )
         )     (
        (  ) (  )__
         \_)-(_/___)
`,
  owl: String.raw`
   §
    §    /\    /\
        /  \__/  \
       |  («)(»)  |
       |    \/    |
        \  /  \  /
         \/____\/
          ^^  ^^
`,
  sheep: String.raw`
   §
    §    .-~~~~-.
       _(  ~  ~  )_
      (¤¤ )  ~   ~ )
       \_/ ~  ~  ~)
         '-~~-~~-'
          ||    ||
`,
  turtle: String.raw`
   §
    §         .----.
        __   / \__/ \
       / ¤¤\/\__/\__/\
      (    _/      \__\__
       \__/|_|      |_|
`,
  tux: String.raw`
   §
    §      ____
         _/ ¤¤ \_
        / ( \/ ) \
       / /'----'\ \
      ( |        | )
       \ \      / /
        '-'----'-'
         _\    /_
`,
};

const COW_DIR = '/usr/share/cowsay/cows';

function fillCow(art: string, thoughts: string, eyes: string, tongue: string): string {
  // Replacer functions: eyes like "$$" (cowsay -g) must not be read as replacement patterns.
  return art
    .replace(/^\n/, '')
    .replace(/¤¤/g, () => eyes)
    .replace(/«/g, () => eyes[0] ?? '')
    .replace(/»/g, () => eyes[1] ?? '')
    .replace(/¦¦/g, () => tongue)
    .replace(/§/g, () => thoughts);
}

/** A cowfile from the disk: the $the_cow = <<EOC ... EOC here-document of the Perl source. */
function parseCowfile(src: string, thoughts: string, eyes: string, tongue: string): string | null {
  const m = /\$the_cow\s*=\s*<<\s*(["']?)(\w+)\1\s*;?[^\n]*\n([\s\S]*?)^\2[ \t]*$/m.exec(src);
  if (!m) return null;
  let body = m[3];
  if (m[1] !== "'") {
    // Interpolate like Perl: backslash escapes and the $thoughts/$eyes/$tongue variables, in one pass.
    body = body.replace(/\\(.)|\$\{?(thoughts|eyes|tongue)\}?/g, (_x, esc: string | undefined, v: string | undefined) =>
      esc !== undefined ? esc : v === 'thoughts' ? thoughts : v === 'eyes' ? eyes : tongue,
    );
  }
  return body;
}

function balloon(lines: string[], think: boolean): { text: string; thoughts: string } {
  const max = lines.length ? Math.max(...lines.map((l) => stringWidth(l))) : -1;
  const w = max < 0 ? 1 : max;
  const pad = (s: string) => s + ' '.repeat(Math.max(0, w - stringWidth(s)));
  let border: string[];
  let thoughts: string;
  if (think) {
    thoughts = 'o';
    border = ['(', ')', '(', ')', '(', ')'];
  } else if (lines.length < 2) {
    thoughts = '\\';
    border = ['<', '>'];
  } else {
    thoughts = '\\';
    border = ['/', '\\', '\\', '/', '|', '|'];
  }
  const fmt = (l: string, s: string, r: string) => `${l} ${pad(s)} ${r}\n`;
  let text = ' ' + '_'.repeat(max + 2) + ' \n';
  text += fmt(border[0], lines[0] ?? '', border[1]);
  if (lines.length >= 2) {
    for (const l of lines.slice(1, -1)) text += fmt(border[4], l, border[5]);
    text += fmt(border[2], lines[lines.length - 1], border[3]);
  }
  text += ' ' + '-'.repeat(max + 2) + ' \n';
  return { text, thoughts };
}

const COWSAY_DOC: CommandDoc = {
  category: 'fun',
  summary: 'configurable speaking/thinking cow (and a bit more)',
  synopsis: ['cowsay [-e eye_string] [-f cowfile] [-h] [-l] [-n] [-T tongue_string] [-W column] [-bdgpstwy] [message]'],
  description:
    'Cowsay generates an ASCII picture of a cow saying something provided by the user. If run with no arguments, it accepts standard input, word-wraps the message given at about 40 columns, and prints the cow saying the given message on standard output.\n\n' +
    'To aid in the use of arbitrary messages with arbitrary whitespace, use the -n option. If it is specified, the given message will not be word-wrapped. If the program is invoked as cowthink then the cow will think its message instead of saying it.\n\n' +
    'There are several provided modes which change the appearance of the cow depending on its particular emotional/physical state: -b (Borg), -d (dead), -g (greedy), -p (paranoid), -s (stoned), -t (tired), -w (wired) and -y (youthful).',
  options: [
    { flags: '-e eye_string', desc: 'Select the appearance of the cow\'s eyes; the first two characters of the string are used (default "oo").' },
    { flags: '-f cowfile', desc: 'Specify a particular cow picture: -f tux, -f dragon... Use -l to see them all.' },
    { flags: '-l', desc: 'List all cowfiles on the current COWPATH.' },
    { flags: '-n', desc: 'Do not word-wrap the message (it must then come from standard input).' },
    { flags: '-T tongue_string', desc: 'Like -e but for the tongue. The tongue is only visible with -d, -s or when you set it.' },
    { flags: '-W column', desc: 'Specify roughly where the message should be wrapped (default 40).' },
    { flags: '-b -d -g -p -s -t -w -y', desc: 'Borg, dead, greedy, paranoid, stoned, tired, wired or youthful cow.' },
  ],
  examples: [
    { cmd: 'cowsay Hello there', desc: 'A cow says hello.' },
    { cmd: 'cowthink -f tux Hmm...', desc: 'A thinking penguin.' },
    { cmd: 'fortune | cowsay', desc: 'A cow tells your fortune.' },
    { cmd: 'cowsay -d I ran rm -rf', desc: 'A dead cow (the -d mode).' },
  ],
  seeAlso: ['cowthink', 'fortune', 'figlet'],
  tip: 'cowsay is the classic example of a pipe: anything you send into it with | comes out of a cow\'s mouth.',
};

async function cowsayMain(ctx: CommandContext): Promise<number> {
  const prog = basename(ctx.argv[0] ?? ctx.name);
  const think = /think/i.test(ctx.argv[0] ?? ctx.name);
  const spec = 'bde:f:ghlLnNpstT:wW:y';
  const opts: Record<string, string> = { e: 'oo', f: 'default', T: '  ', W: '40' };
  const flags = new Set<string>();
  const args = [...ctx.args];
  const usage = async (): Promise<number> => {
    await ctx.err(`cow{say,think} version 3.03, (c) 1999 Tony Monroe\nUsage: ${prog} [-bdgpstwy] [-h] [-e eyes] [-f cowfile] \n          [-l] [-n] [-T tongue] [-W wrapcolumn] [message]\n`);
    return 1;
  };
  // Getopt::Std::getopts: options end at the first non-option; unknown ones are warned about and skipped.
  while (args.length) {
    const m = /^-(.)([\s\S]*)$/.exec(args[0]);
    if (!m) break;
    const [, first, rest] = m;
    if (args[0] === '--') {
      args.shift();
      break;
    }
    const pos = first === ':' ? -1 : spec.indexOf(first);
    if (pos >= 0) {
      if (spec[pos + 1] === ':') {
        args.shift();
        opts[first] = rest !== '' ? rest : (args.shift() ?? '');
      } else {
        flags.add(first);
        if (rest === '') args.shift();
        else args[0] = '-' + rest;
      }
      continue;
    }
    if (first === '-' && rest === 'help') {
      await ctx.out(gnuHelp({ name: prog, pkg: 'cowsay', doc: COWSAY_DOC, run: async () => 0 }));
      return 0;
    }
    if (first === '-' && rest === 'version') {
      await ctx.out(`${prog} (cowsay) 3.03\n`);
      return 0;
    }
    await ctx.err(`Unknown option: ${first}\n`);
    if (rest !== '') args[0] = '-' + rest;
    else args.shift();
  }
  if (flags.has('h')) return usage();
  const cowpath = (ctx.env.get('COWPATH') || COW_DIR).split(':');
  if (flags.has('l')) {
    let out = '';
    for (const d of cowpath) {
      const names: string[] = [];
      if (ctx.fs.isDir(d)) {
        for (const f of ctx.fs.readdir(d)) if (f.endsWith('.cow')) names.push(f.slice(0, -4));
      } else if (d !== COW_DIR) {
        await ctx.out(out + `Cow files in ${d}:\n`);
        await ctx.err(`${ctx.argv[0]}: Cannot open ${d}\n`);
        return 1;
      }
      if (d === COW_DIR) for (const n of Object.keys(COWS)) if (!names.includes(n)) names.push(n);
      out += `Cow files in ${d}:\n${textWrap(names.sort().join(' '), 76)}\n`;
    }
    await ctx.out(out);
    return 0;
  }
  let eyes = opts.e.slice(0, 2);
  let tongue = opts.T.slice(0, 2);
  let message: string[];
  if (args.length === 0 || args[0] === '') {
    const text = await ctx.stdin.readAll();
    message = text === '' ? [] : text.split('\n');
    if (text.endsWith('\n')) message.pop();
  } else {
    if (flags.has('n')) return usage();
    message = [args.join(' ')];
  }
  const width = Math.max(2, Math.floor(Number(opts.W)) || 0);
  const lines = flags.has('n') ? message.map((l) => expandTabs(l)) : perlSplit(textFill(message, width), /\n/);
  const { text, thoughts } = balloon(lines, think);
  if (flags.has('b')) eyes = '==';
  if (flags.has('d')) {
    eyes = 'xx';
    tongue = 'U ';
  }
  if (flags.has('g')) eyes = '$$';
  if (flags.has('p')) eyes = '@@';
  if (flags.has('s')) {
    eyes = '**';
    tongue = 'U ';
  }
  if (flags.has('t')) eyes = '--';
  if (flags.has('w')) eyes = 'OO';
  if (flags.has('y')) eyes = '..';
  // get_cow
  const f = opts.f;
  let cow: string | null = null;
  const fromDisk = (path: string): string | null => {
    try {
      return parseCowfile(ctx.fs.readFile(path), thoughts, eyes, tongue);
    } catch {
      return null;
    }
  };
  const builtinPath = /^(.*)\/([^/]+?)(\.cow)?$/.exec(f);
  if (f.includes('/') && !ctx.fs.isFile(f) && builtinPath && ctx.fs.abs(builtinPath[1] || '/') === COW_DIR && COWS[builtinPath[2]]) {
    cow = fillCow(COWS[builtinPath[2]], thoughts, eyes, tongue);
  } else if (f.includes('/')) {
    if (ctx.fs.isFile(f)) cow = fromDisk(f);
    else {
      await ctx.err(`${prog}: Could not find ${f} cowfile!\n`);
      return 1;
    }
  } else {
    for (const d of cowpath) {
      if (ctx.fs.isFile(`${d}/${f}`)) cow = fromDisk(`${d}/${f}`);
      else if (ctx.fs.isFile(`${d}/${f}.cow`)) cow = fromDisk(`${d}/${f}.cow`);
      else if (d === COW_DIR && COWS[f.replace(/\.cow$/, '')]) cow = fillCow(COWS[f.replace(/\.cow$/, '')], thoughts, eyes, tongue);
      if (cow !== null) break;
    }
    if (cow === null) {
      await ctx.err(`${prog}: Could not find ${f} cowfile!\n`);
      return 1;
    }
  }
  if (cow === null) {
    await ctx.err(`${prog}: syntax error in cowfile ${f}\n`);
    return 1;
  }
  await ctx.out(text + cow);
  return 0;
}

defineCommand({ name: 'cowsay', pkg: 'cowsay', dir: '/usr/games', size: 4640, doc: COWSAY_DOC, gnu: false, run: cowsayMain });
defineCommand({
  name: 'cowthink',
  pkg: 'cowsay',
  dir: '/usr/games',
  size: 4640,
  doc: { ...COWSAY_DOC, summary: 'configurable thinking cow', synopsis: COWSAY_DOC.synopsis.map((s) => s.replace('cowsay', 'cowthink')), examples: [{ cmd: 'cowthink I wonder...', desc: 'The cow thinks instead of speaking.' }, { cmd: 'cowthink -f tux Is it lunch yet?', desc: 'A thoughtful penguin.' }], seeAlso: ['cowsay', 'fortune'] },
  gnu: false,
  run: cowsayMain,
});

// ---------------------------------------------------------------------------
// fortune

const FORTUNE_DIR = '/usr/share/games/fortunes';

function wrapFortune(text: string): string {
  return text
    .split('\n')
    .map((para) => (para.length <= 72 || para.startsWith('\t') ? para : textWrap(para, 73)))
    .join('\n');
}

const FORTUNES: Record<string, string[]> = {
  tips: [
    'Press the Tab key to finish typing file and command names for you.\nPress it twice to see every possible choice.',
    'Lost? pwd prints the name of the directory you are in.',
    'cd with no arguments takes you home. cd - takes you back to the\ndirectory you were in before.',
    'The up arrow brings back the commands you typed before.\nCtrl+R searches through them as you type.',
    'Ctrl+C stops the program that is running. Ctrl+Z pauses it;\ntype fg to bring it back.',
    'ls -a shows hidden files too: the ones whose names start with a dot.',
    'man ls opens the manual page for ls. Press q to leave it.',
    'Almost every command will explain itself if you add --help.',
    'Put quotes around names that contain spaces:\n\n\tcat "my notes.txt"',
    'rm does not move files to a trash can. They are gone for good.\nThink twice, type once.',
    'Use > to save the output of a command in a file, and >> to add it\nto the end of a file that already exists.',
    'The | (pipe) feeds the output of one command into another.\nls | wc -l counts the files in a directory.',
    'history lists the commands you have typed. !! runs the last one again.',
    'less lets you scroll through long files: Space goes forward, b goes\nback, /word searches and q quits.',
    'grep -i searches without caring about upper and lower case.',
    'Ctrl+L clears the screen. So does the clear command.',
    'Ctrl+A jumps to the start of the line you are typing, Ctrl+E to the end.',
    'mkdir -p one/two/three creates all of those folders in one go.',
    'cp -r copies a folder together with everything inside it.',
    'tree -L 2 draws the folders below you as a tree, two levels deep.',
    'Wildcards save typing: *.txt matches every name that ends in .txt.',
    'echo $HOME prints the path of your home directory.\nNames that start with a $ are variables.',
    'Type exit, or press Ctrl+D at an empty prompt, to close the shell.',
    'which ls tells you where the ls program lives on the disk.',
    'chmod +x script.sh makes a script runnable. Then start it with ./script.sh',
    'head shows the beginning of a file and tail shows the end.\ntail -f keeps watching a file as it grows.',
    'wc -l counts lines, wc -w counts words and wc -c counts bytes.',
    'sort names.txt | uniq -c counts how many times each line appears.',
    'File names are case sensitive: Notes.txt and notes.txt are two\ndifferent files.',
    'Your shell reads ~/.bashrc every time it starts. That is where\naliases and other settings live.',
    'df -h shows how much disk space is free. du -sh * shows what is using it.',
    'top shows the programs that use the most CPU. Press q to quit it.',
    'kill sends a signal to a process. Try a plain kill first and keep\nkill -9 as the very last resort.',
    'The ~ (tilde) is short for your home directory: cd ~/Documents',
    'Two dots (..) mean the parent directory. One dot (.) means the\ndirectory you are in.',
    "alias ll='ls -l' gives a long command a short name.",
    'Not sure what a wildcard matches? Try it with ls first:\nls *.tmp, and only then rm *.tmp',
    'Ctrl+W deletes the word before the cursor.\nCtrl+U deletes everything before it.',
    'apt search finds programs to install; sudo apt install installs them.',
    'date +%A tells you the day of the week.',
    'file tells you what kind of data a file holds, whatever its name says.',
    'q quits less, man, top, htop and many other full-screen programs.',
    'Everything after a # on a command line is a comment and is ignored.',
    'cmd1 && cmd2 runs cmd2 only if cmd1 worked. cmd1 ; cmd2 runs both anyway.',
    'cat part1.txt part2.txt > whole.txt joins two files into one.',
    'echo $? shows the exit status of the last command. 0 means success.',
    'nano is a friendly text editor: Ctrl+O saves and Ctrl+X exits.',
    'To Linux, a file extension is just part of the name. file looks\ninside the file to find out what it really is.',
    'mv renames a file as well as moving it: mv draft.txt final.txt',
    'Ctrl+Shift+C and Ctrl+Shift+V copy and paste in most terminal windows.\nPlain Ctrl+C means "stop the program".',
    'A pipeline can be as long as you like. Here is a classic that finds the\nmost common words in a file:\n\n\ttr -s \' \' \'\\n\' < story.txt | sort | uniq -c | sort -rn | head -5\n\ntr puts each word on its own line, sort groups the copies together,\nuniq -c counts them and the final sort puts the biggest counts first.',
    'Every running program is a process with a number, its PID. ps shows the\nprocesses started from your terminal, ps aux shows all of them, and\ntop and htop show them live. Use kill PID to ask one to stop, and if it\nrefuses, kill -9 PID to stop it no matter what.',
    'Permissions come in three groups: the owner, the group and everybody\nelse. In ls -l output, -rw-r--r-- means the owner may read and write,\nwhile the group and everybody else may only read. chmod changes them:\nchmod u+x file lets the owner run the file as a program.',
    'Hidden files are not secret, they are just tidy. Programs keep their\nsettings in files and folders whose names start with a dot, such as\n~/.bashrc and ~/.config, so that ls does not show them unless you ask\nfor them with ls -a.',
  ],
  proverbs: [
    'A journey of a thousand miles begins with a single step.\n\t\t-- Lao Tzu',
    'Practice makes perfect.',
    'Rome was not built in a day.',
    'Measure twice, cut once.',
    'Look before you leap.',
    'Slow and steady wins the race.\n\t\t-- Aesop',
    'Little strokes fell great oaks.\n\t\t-- Benjamin Franklin',
    'Well begun is half done.',
    'Many hands make light work.',
    "Where there's a will, there's a way.",
    'Necessity is the mother of invention.',
    'A stitch in time saves nine.',
    'The early bird catches the worm.',
    "If at first you don't succeed, try, try again.",
    'Better late than never.',
    "Don't count your chickens before they are hatched.\n\t\t-- Aesop",
    'An ounce of prevention is worth a pound of cure.\n\t\t-- Benjamin Franklin',
    'Knowledge is power.\n\t\t-- Francis Bacon',
    'Fortune favors the bold.',
    'Patience is a virtue.',
    'Learning never exhausts the mind.\n\t\t-- Leonardo da Vinci',
    'Haste makes waste.',
    'Two heads are better than one.',
    'Experience is the best teacher.',
    'Fall seven times, stand up eight.\n\t\t-- Japanese proverb',
    'He who asks a question is a fool for five minutes; he who does not ask\nremains a fool forever.\n\t\t-- Chinese proverb',
    'Actions speak louder than words.',
    'The pen is mightier than the sword.\n\t\t-- Edward Bulwer-Lytton',
    'Lost time is never found again.\n\t\t-- Benjamin Franklin',
    'For want of a nail the shoe was lost; for want of a shoe the horse was\nlost; for want of a horse the rider was lost; for want of a rider the\nbattle was lost; for want of a battle the kingdom was lost. And all for\nthe want of a horseshoe nail.\n\t\t-- Old proverb',
  ],
  sandbox: [
    'The terminal is not scary. It just takes everything you say literally.',
    'Every expert at the command line once typed ls for the very first time.',
    'Computers do exactly what you tell them. That is both the problem and\nthe solution.',
    'Read the error message. Then read it again. It usually tells you\nexactly what went wrong.',
    'A little practice every day beats a lot of practice once a month.',
    'Mistakes made in a sandbox are free. Make lots of them.',
    'There are no stupid questions, only commands without --help.',
    'You can not break this computer. Go on, explore.',
    'Today is a good day to learn one new command.',
    'Your future self will thank you for the comments you write today.',
    'Typing is thinking you can undo. Pressing Enter is not.',
    'When in doubt, ls it out.',
  ],
};

const FORTUNE_DOC: CommandDoc = {
  category: 'fun',
  summary: 'print a random, hopefully interesting, adage',
  synopsis: ['fortune [-acefilosw] [-n length] [-m pattern] [[n%] file/dir/all]'],
  description:
    'When fortune is run with no arguments it prints out a random epigram. The epigrams are grouped in files: this computer has tips (friendly command line tips), proverbs (old sayings) and sandbox (thoughts about learning).\n\n' +
    'Name one or more files to choose only from them, for example fortune tips.',
  options: [
    { flags: '-a', desc: 'Choose from all lists of maxims.' },
    { flags: '-c', desc: 'Show the cookie file from which the fortune came.' },
    { flags: '-e', desc: 'Consider all fortune files to be of equal size.' },
    { flags: '-f', desc: 'Print out the list of files which would be searched, but do not print a fortune.' },
    { flags: '-l', desc: 'Long dictums only (longer than 160 characters, see -n).' },
    { flags: '-m pattern', desc: 'Print out all fortunes which match the basic regular expression pattern.' },
    { flags: '-i', desc: 'Ignore case for -m patterns.' },
    { flags: '-n length', desc: 'Set the longest fortune length (in characters) considered to be "short" (the default is 160).' },
    { flags: '-s', desc: 'Short apothegms only.' },
    { flags: '-w', desc: 'Wait before termination for an amount of time calculated from the number of characters in the message.' },
  ],
  examples: [
    { cmd: 'fortune', desc: 'A random saying or tip.' },
    { cmd: 'fortune tips', desc: 'A random command line tip.' },
    { cmd: 'fortune -s | cowsay', desc: 'A short fortune, told by a cow.' },
    { cmd: 'fortune -m pipe', desc: 'Every fortune that mentions pipes.' },
  ],
  seeAlso: ['cowsay', 'figlet'],
};

defineCommand({
  name: 'fortune',
  pkg: 'fortune-mod',
  dir: '/usr/games',
  size: 27416,
  doc: FORTUNE_DOC,
  gnu: false,
  run: async (ctx) => {
    let short = false;
    let long = false;
    let showFile = false;
    let listFiles = false;
    let ignoreCase = false;
    let offensive = false;
    let wait = false;
    let pattern: string | null = null;
    let slen = 160;
    const files: string[] = [];
    const args = ctx.args;
    const usage = async () => {
      await ctx.err('Usage: fortune [-afilosw] [-m pattern] [-n number] [ [#%] file/directory/all]\n');
      return 1;
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--help') {
        await ctx.out(gnuHelp({ name: 'fortune', pkg: 'fortune-mod', doc: FORTUNE_DOC, run: async () => 0 }));
        return 0;
      }
      if (a === '--version') {
        await ctx.out('fortune-mod version 1.99.1\n');
        return 0;
      }
      if (a.startsWith('-') && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          if (c === 'm' || c === 'n') {
            const v = a.slice(j + 1) || args[++i];
            if (v === undefined) return usage();
            if (c === 'm') pattern = v;
            else {
              slen = parseInt(v, 10);
              if (!(slen > 0)) return usage();
            }
            break;
          }
          if (c === 's') short = true;
          else if (c === 'l') long = true;
          else if (c === 'c') showFile = true;
          else if (c === 'f') listFiles = true;
          else if (c === 'i') ignoreCase = true;
          else if (c === 'o') offensive = true;
          else if (c === 'w') wait = true;
          else if (c === 'v') {
            await ctx.out('fortune-mod version 1.99.1\n');
            return 0;
          } else if (c === 'a' || c === 'e' || c === 'u' || c === 'E') continue;
          else {
            await ctx.err(`fortune: invalid option -- '${c}'\n`);
            return usage();
          }
        }
        continue;
      }
      if (/^\d+%$/.test(a)) continue;
      files.push(a);
    }
    let names = Object.keys(FORTUNES);
    if (files.length && !(files.length === 1 && files[0] === 'all')) {
      const chosen: string[] = [];
      for (const f of files) {
        const n = basename(f.replace(/\/+$/, ''));
        if (f === FORTUNE_DIR || f === FORTUNE_DIR + '/' || n === 'fortunes') chosen.push(...names);
        else if (FORTUNES[n]) chosen.push(n);
        else {
          await ctx.err(`${f}: No such file or directory\n`);
        }
      }
      names = [...new Set(chosen)];
    }
    if (offensive) names = [];
    if (names.length === 0) {
      await ctx.err('No fortunes found\n');
      return 1;
    }
    const all = names.flatMap((n) => FORTUNES[n].map((t) => ({ file: n, text: wrapFortune(t) + '\n' })));
    if (listFiles) {
      const total = all.length;
      let out = `100.00% ${FORTUNE_DIR}\n`;
      for (const n of names) out += `    ${((FORTUNES[n].length / total) * 100).toFixed(2).padStart(6)}% ${n}\n`;
      await ctx.err(out);
      return 0;
    }
    const fits = (t: string) => (short ? t.length <= slen : long ? t.length > slen : true);
    if (pattern !== null) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignoreCase ? 'i' : '');
      } catch {
        await ctx.err(`fortune: invalid pattern '${pattern}'\n`);
        return 1;
      }
      let found = false;
      for (const n of names) {
        const hits = all.filter((f) => f.file === n && fits(f.text) && re.test(f.text));
        if (!hits.length) continue;
        found = true;
        await ctx.err(`(${n})\n%\n`);
        await ctx.out(hits.map((h) => h.text + '%\n').join(''));
      }
      return found ? 0 : 1;
    }
    const pool = all.filter((f) => fits(f.text));
    if (!pool.length) {
      await ctx.err('No fortunes found\n');
      return 1;
    }
    const pick = pool[Math.floor(ctx.system.random() * pool.length) % pool.length];
    await ctx.out((showFile ? `(${pick.file})\n%\n` : '') + pick.text);
    if (wait) await ctx.sleep(Math.max(6, Math.floor(pick.text.length / 20)) * 1000);
    return 0;
  },
});

// ---------------------------------------------------------------------------
// sl — a steam locomotive crosses the screen

const LOCO = [
  '      _______                              ',
  '      \\_____/                    ____________',
  '        | |      __       __     |  ______  |',
  '  ______| |_____|__|_____|__|____| |      | |',
  ' |  ___                          | |______| |',
  ' | |___|  _______________________|          |',
  ' |_______|_______________________|__________|',
  ' /|  _____    _____    _____    _____       |',
  '/_|_/ (-) \\__/ (-) \\__/ (-) \\__/ (-) \\______|',
  '     \\___/    \\___/    \\___/    \\___/       ',
];
const TENDER = [
  '                    ',
  '                    ',
  '   _________________',
  '  |  @@@@@@@@@@@@@  |',
  '  |_________________|',
  '  |                 |',
  '  |_________________|',
  '==|  _____    _____ |',
  '  |_/ (-) \\__/ (-) \\|',
  '     \\___/    \\___/  ',
];
const COACH = [
  '                              ',
  '                              ',
  '   _________________________  ',
  '  |  ____  ____  ____  ____ | ',
  '  | |    ||    ||    ||    || ',
  '  | |____||____||____||____|| ',
  '  |_________________________| ',
  '==|  _____           _____  | ',
  '  |_/ (-) \\_________/ (-) \\_| ',
  '     \\___/           \\___/    ',
];
const LITTLE = [
  '    ____                                        ',
  '    \\__/     ____                               ',
  '  ___||_____|    |_   ____________   ___________ ',
  ' |  []      |____| |=|  @@@@@@@@  |=| [] [] [] |',
  ' |_________________| |____________| |__________|',
  '  (-) (-)  (-) (-)    (-)      (-)   (-)    (-) ',
];

interface TrainArt {
  lines: string[];
  chimney: number;
  /** Column ranges of passenger windows (for -a), row index and window starts. */
  windows: { row: number; cols: number[] };
  helpCol: number;
}

function trainArt(little: boolean): TrainArt {
  if (little) {
    const w = Math.max(...LITTLE.map((l) => l.length));
    return { lines: LITTLE.map((l) => l.padEnd(w)), chimney: 6, windows: { row: 3, cols: [38, 41, 44] }, helpCol: 39 };
  }
  const lw = Math.max(...LOCO.map((l) => l.length));
  const tw = TENDER[0].length;
  const lines = LOCO.map((l, i) => l.padEnd(lw) + TENDER[i].padEnd(tw) + COACH[i]);
  const coachAt = lw + tw;
  return { lines, chimney: 9, windows: { row: 4, cols: [coachAt + 5, coachAt + 11, coachAt + 17, coachAt + 23] }, helpCol: coachAt + 9 };
}

const SMOKE = ['o', 'oO', '(oO)', '( Oo )', '(  o  )', '(  .  )', '(     )', '.     .'];

defineCommand({
  name: 'sl',
  pkg: 'sl',
  dir: '/usr/games',
  size: 17792,
  doc: {
    category: 'fun',
    summary: 'display animations aimed to correct users who accidentally enter sl instead of ls',
    synopsis: ['sl [ -alFce ]'],
    description:
      'sl is a joke program: it shows a steam locomotive (SL) driving across the screen, to teach you to type ls correctly. While the train is running Ctrl+C does nothing, so you just have to wait a few seconds until it has passed.',
    options: [
      { flags: '-a', desc: 'An accident is occurring. People cry for help.' },
      { flags: '-l', desc: 'Little version.' },
      { flags: '-F', desc: 'It flies.' },
      { flags: '-c', desc: 'C51 type instead of D51 (draws the same engine here).' },
      { flags: '-e', desc: 'Allow interrupt by Ctrl+C.' },
    ],
    examples: [
      { cmd: 'sl', desc: 'Choo choo!' },
      { cmd: 'sl -F', desc: 'A flying train.' },
      { cmd: 'sl -la', desc: 'A little train with passengers calling for help.' },
    ],
    seeAlso: ['ls'],
    tip: 'The train ignores Ctrl+C on purpose. It is gone in a few seconds.',
  },
  run: async (ctx) => {
    let accident = false;
    let little = false;
    let fly = false;
    let interruptible = false;
    for (const a of ctx.args) {
      if (!a.startsWith('-')) continue;
      for (const c of a.slice(1)) {
        if (c === 'a') accident = true;
        else if (c === 'l') little = true;
        else if (c === 'F') fly = true;
        else if (c === 'e') interruptible = true;
      }
    }
    const art = trainArt(little);
    const width = art.lines[0].length;
    const height = art.lines.length;
    if (!ctx.tty || !ctx.stdout.isTTY) {
      await ctx.out(art.lines.map((l) => l.replace(/\(-\)/g, '(O)').replace(/\s+$/, '')).join('\n') + '\n');
      return 0;
    }
    const offs: (() => void)[] = [];
    if (!interruptible) offs.push(ctx.onSignal('SIGINT', () => {}));
    const scr = new FullScreen(ctx, { name: 'sl', alt: true, raw: false, hideCursor: true });
    await scr.start();
    try {
      const puffs: { x: number; y: number; age: number }[] = [];
      let frame = 0;
      for (let x = scr.cols - 1; x > -width; x--, frame++) {
        await scr.sync();
        const cols = scr.cols;
        const rows = scr.rows;
        const grid: string[][] = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '));
        const put = (row: number, col: number, s: string) => {
          if (row < 0 || row >= rows) return;
          for (let i = 0; i < s.length; i++) {
            const c = col + i;
            if (c >= 0 && c < cols && s[i] !== '\0') grid[row][c] = s[i];
          }
        };
        const y = fly ? Math.floor(x / 6) + rows - Math.floor(cols / 6) - height : Math.floor(rows / 2) - Math.floor(height / 2);
        const hub = ['-', '\\', '|', '/'][frame % 4];
        art.lines.forEach((l, i) => put(y + i, x, l.replace(/\(-\)/g, `(${hub})`)));
        if (accident) {
          const up = Math.floor(frame / 4) % 2 === 0;
          for (const c of art.windows.cols) put(y + art.windows.row, x + c, up ? '\\o/' : '|o|');
          if (up) put(y + (little ? 0 : 1), x + art.helpCol, 'Help!');
        }
        if (frame % 3 === 0) puffs.push({ x: x + art.chimney, y: y - 1, age: 0 });
        for (const p of puffs) {
          const s = SMOKE[Math.min(SMOKE.length - 1, Math.floor(p.age / 2))];
          put(p.y, p.x - Math.floor(s.length / 2), s.replace(/ /g, '\0'));
          p.age++;
          if (p.age % 3 === 0) p.y--;
        }
        while (puffs.length && (puffs[0].age >= SMOKE.length * 2 || puffs[0].y < 0)) puffs.shift();
        let out = '';
        for (let r = 0; r < rows; r++) out += `\x1b[${r + 1};1H` + grid[r].join('').replace(/\s+$/, '') + '\x1b[K';
        await scr.write(out);
        await ctx.sleep(40);
      }
    } finally {
      for (const off of offs) off();
      await scr.finish();
    }
    return 0;
  },
});

// ---------------------------------------------------------------------------
// figlet

// Original "standard-looking" FIGlet font for this simulator: '== X' starts a glyph,
// every row ends with '@', '$' is a hardblank.
const STANDARD_FONT = String.raw`
== space
$$@
$$@
$$@
$$@
$$@
$$@
== A
  ___  @
 / _ \ @
| |_| |@
|  _  |@
|_| |_|@
       @
== B
 ____  @
|  _ \ @
| |_) )@
|  _ ( @
|____) @
       @
== C
  ____ @
 / ___)@
| |    @
| |___ @
 \____)@
       @
== D
 ____   @
|  _ \  @
| | \ \ @
| |_/ / @
|____/  @
        @
== E
 _____ @
|  ___|@
| |__  @
|  __| @
|_____|@
       @
== F
 _____ @
|  ___|@
| |__  @
|  __| @
|_|    @
       @
== G
  ____ @
 / ___)@
| |  _ @
| |_| |@
 \____|@
       @
== H
 _   _ @
| | | |@
| |_| |@
|  _  |@
|_| |_|@
       @
== I
 ___ @
|_ _|@
 | | @
 | | @
|___|@
     @
== J
   ____ @
  |_  _|@
    | | @
 _  | | @
( \_/ / @
 \___/  @
== K
 _   __@
| | / /@
| |/ / @
| |\ \ @
|_| \_\@
       @
== L
 _     @
| |    @
| |    @
| |___ @
|_____|@
       @
== M
 _     _ @
|  \ /  |@
| \ V / |@
| |\_/| |@
|_|   |_|@
         @
== N
 _   _ @
|  \| |@
| \ ' |@
| |\  |@
|_| \_|@
       @
== O
  ____  @
 / __ \ @
| |  | |@
| |__| |@
 \____/ @
        @
== P
 ____  @
|  _ \ @
| |_) )@
|  __/ @
|_|    @
       @
== Q
  ____  @
 / __ \ @
| |  | |@
| |__| |@
 \___\_\@
        @
== R
 ____  @
|  _ \ @
| |_) )@
|  _ ( @
|_| \_\@
       @
== S
  ____ @
 / ___)@
 \___ \@
 ____) )@
(_____/ @
        @
== T
 _____ @
|_   _|@
  | |  @
  | |  @
  |_|  @
       @
== U
 _    _ @
| |  | |@
| |  | |@
| |__| |@
 \____/ @
        @
== V
__     __@
\ \   / /@
 \ \ / / @
  \ v /  @
   \_/   @
         @
== W
 _     _ @
| |   | |@
| | _ | |@
| |/ \| |@
|__/ \__|@
         @
== X
__   __@
\ \ / /@
 \ V / @
 / ^ \ @
/_/ \_\@
       @
== Y
__   __@
\ \ / /@
 \ v / @
  | |  @
  |_|  @
       @
== Z
 ______@
|___  /@
   / / @
  / /__@
 /_____|@
        @
== a
       @
  ____ @
 / _  |@
| (_| |@
 \__,_|@
       @
== b
 _     @
| |__  @
|  _ \ @
| |_) )@
|____/ @
       @
== c
      @
  ___ @
 / __)@
| (__ @
 \___)@
      @
== d
     _ @
  __| |@
 / _  |@
| (_| |@
 \____|@
       @
== e
      @
  ___ @
 / _ \@
|  __/@
 \___)@
      @
== f
  __ @
 / _)@
| |_ @
|  _)@
|_|  @
     @
== g
       @
  ____ @
 / _  |@
| (_| |@
 \__, |@
 (___/ @
== h
 _     @
| |__  @
|  _ \ @
| | | |@
|_| |_|@
       @
== i
 _ @
(_)@
| |@
| |@
|_|@
   @
== j
   _ @
  (_)@
  | |@
  | |@
 _| |@
(__/ @
== k
 _    @
| | _ @
| |/ )@
|   ( @
|_|\_)@
      @
== l
 _ @
| |@
| |@
| |@
|_|@
   @
== m
           @
 _ __ __   @
|  _ ' _ \ @
| | | | | |@
|_| |_| |_|@
           @
== n
       @
 _ __  @
|  _ \ @
| | | |@
|_| |_|@
       @
== o
      @
  __  @
 /  \ @
| () |@
 \__/ @
      @
== p
       @
 _ __  @
|  _ \ @
| |_) )@
|  __/ @
|_|    @
== q
       @
  ____ @
 / _  |@
( (_| |@
 \__, |@
    |_|@
== r
      @
 _ __ @
|  __)@
| |   @
|_|   @
      @
== s
      @
 ____ @
/ ___)@
\__ \ @
(___/ @
      @
== t
 _   @
| |_ @
|  _)@
| |_ @
 \__)@
     @
== u
       @
 _   _ @
| | | |@
| |_| |@
 \____)@
       @
== v
       @
__   __@
\ \ / /@
 \ v / @
  \_/  @
       @
== w
         @
 _     _ @
| | _ | |@
| |/ \| |@
|__/ \__|@
         @
== x
      @
__  __@
\ \/ /@
 )  ( @
/_/\_\@
      @
== y
       @
__   __@
\ \ / /@
 \ v / @
  / /  @
 /_/   @
== z
     @
 ____@
(_  /@
 / / @
/___)@
     @
== 0
  ____  @
 / __ \ @
| | /| |@
| |/_| |@
 \____/ @
        @
== 1
  _  @
 / | @
/_ | @
 | | @
 |_| @
     @
== 2
 ____  @
(___ \ @
  __) )@
 / __/ @
(_____)@
       @
== 3
 ____  @
(__  ) @
  (_ \ @
 ___) )@
(____/ @
       @
== 4
   ___  @
  /   | @
 / /| |_@
/__   _)@
   |_|  @
        @
== 5
 _____ @
| ____)@
|____ \@
 ____) )@
(_____/ @
        @
== 6
  ___  @
 / __) @
| /_   @
| (_) )@
 \___/ @
       @
== 7
 _____ @
(___  )@
   / / @
  / /  @
 (_/   @
       @
== 8
  ___  @
 ( _ ) @
 ) _ ( @
( (_) )@
 \___/ @
       @
== 9
  ___  @
 / _ \ @
( (_) |@
 \__  |@
 (___/ @
       @
== !
 _ @
| |@
| |@
|_|@
(_)@
   @
== "
 _  _ @
| || |@
|_||_|@
      @
      @
      @
== #
   __ __  @
 _/ // /_ @
/_  _  _/ @
/_  _  _/ @
 /_//_/   @
          @
== $
   _   @
 _| |_ @
/  ___)@
\___  \@
(_   _/@
  |_|  @
== %
 _   __@
(_) / /@
   / / @
  / /_ @
 /_/(_)@
       @
== &
  __     @
 / _)    @
 ) _ \/\ @
( (_>  < @
 \___/\/ @
         @
== '
 _ @
| |@
|/ @
   @
   @
   @
== (
  __@
 / /@
| | @
| | @
 \_\@
    @
== )
__  @
\ \ @
 | |@
 | |@
 /_/@
    @
== *
     @
 \|/ @
--*--@
 /|\ @
     @
     @
== +
       @
   _   @
 _| |_ @
|_   _|@
  |_|  @
       @
== ,
   @
   @
   @
 _ @
| |@
|/ @
== -
      @
      @
 ____ @
|____|@
      @
      @
== .
   @
   @
   @
 _ @
|_|@
   @
== /
    __@
   / /@
  / / @
 / /  @
/_/   @
      @
== :
   @
 _ @
|_|@
 _ @
|_|@
   @
== ;
   @
 _ @
|_|@
 _ @
| |@
|/ @
== <
   __@
  / /@
 < < @
  \ \@
   \_\@
     @
== =
      @
 ____ @
|____|@
|____|@
      @
      @
== >
__   @
\ \  @
 > > @
/ /  @
/_/   @
      @
== ?
 ____ @
(__  )@
  / / @
 |_|  @
 (_)  @
      @
== @
   _____  @
  / ___ \ @
 / / _  | @
| | (_| | @
 \ \__,_/ @
  \_____) @
== [
 __ @
| _|@
| | @
| |_@
|__|@
    @
== \
__    @
\ \   @
 \ \  @
  \ \ @
   \_\@
      @
== ]
 __ @
|_ |@
 | |@
 _| |@
|__|@
    @
== ^
  __  @
 /  \ @
/_/\_\@
      @
      @
      @
== _
      @
      @
      @
      @
 ____ @
|____|@
== grave
 _ @
\ |@
 \|@
   @
   @
   @
== {
   __ @
  / _)@
 / /  @
< <   @
 \ \_ @
  \__)@
== |
 _ @
| |@
| |@
| |@
| |@
|_|@
== }
 __   @
(_ \  @
  \ \ @
   > >@
  / / @
 (_/  @
== ~
       @
 __  _ @
/  \/ )@
\_/\_/ @
       @
       @
`;

// 5x5 bitmaps used by the block and banner fonts ('#' = ink).
const BITMAPS: Record<string, string[]> = {
  "!": ["#", "#", "#", " ", "#"],
  "\"": ["# #", "# #", "   ", "   ", "   "],
  "#": [" # # ", "#####", " # # ", "#####", " # # "],
  "$": [" ####", "# #  ", " ### ", "  # #", "#### "],
  "%": ["#   #", "   # ", "  #  ", " #   ", "#   #"],
  "&": [" ##  ", "#  # ", " ## #", "#  # ", " ## #"],
  "'": ["#", "#", " ", " ", " "],
  "(": [" #", "# ", "# ", "# ", " #"],
  ")": ["# ", " #", " #", " #", "# "],
  "*": ["     ", "# # #", " ### ", "# # #", "     "],
  "+": ["     ", "  #  ", "#####", "  #  ", "     "],
  ",": ["  ", "  ", "  ", " #", "# "],
  "-": ["     ", "     ", "#####", "     ", "     "],
  ".": [" ", " ", " ", " ", "#"],
  "/": ["    #", "   # ", "  #  ", " #   ", "#    "],
  "0": [" ### ", "#  ##", "# # #", "##  #", " ### "],
  "1": [" # ", "## ", " # ", " # ", "###"],
  "2": [" ### ", "#   #", "  ## ", " #   ", "#####"],
  "3": ["#### ", "    #", " ### ", "    #", "#### "],
  "4": ["#  # ", "#  # ", "#####", "   # ", "   # "],
  "5": ["#####", "#    ", "#### ", "    #", "#### "],
  "6": [" ### ", "#    ", "#### ", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", "  #  "],
  "8": [" ### ", "#   #", " ### ", "#   #", " ### "],
  "9": [" ### ", "#   #", " ####", "    #", " ### "],
  ":": [" ", "#", " ", "#", " "],
  ";": ["  ", " #", "  ", " #", "# "],
  "<": ["  #", " # ", "#  ", " # ", "  #"],
  "=": ["     ", "#####", "     ", "#####", "     "],
  ">": ["#  ", " # ", "  #", " # ", "#  "],
  "?": [" ### ", "#   #", "  ## ", "     ", "  #  "],
  "@": [" ### ", "# # #", "# ###", "#    ", " ####"],
  "A": [" ### ", "#   #", "#####", "#   #", "#   #"],
  "B": ["#### ", "#   #", "#### ", "#   #", "#### "],
  "C": [" ####", "#    ", "#    ", "#    ", " ####"],
  "D": ["#### ", "#   #", "#   #", "#   #", "#### "],
  "E": ["#####", "#    ", "#### ", "#    ", "#####"],
  "F": ["#####", "#    ", "#### ", "#    ", "#    "],
  "G": [" ####", "#    ", "#  ##", "#   #", " ####"],
  "H": ["#   #", "#   #", "#####", "#   #", "#   #"],
  "I": ["###", " # ", " # ", " # ", "###"],
  "J": ["  ###", "    #", "    #", "#   #", " ### "],
  "K": ["#   #", "#  # ", "###  ", "#  # ", "#   #"],
  "L": ["#    ", "#    ", "#    ", "#    ", "#####"],
  "M": ["#   #", "## ##", "# # #", "#   #", "#   #"],
  "N": ["#   #", "##  #", "# # #", "#  ##", "#   #"],
  "O": [" ### ", "#   #", "#   #", "#   #", " ### "],
  "P": ["#### ", "#   #", "#### ", "#    ", "#    "],
  "Q": [" ### ", "#   #", "# # #", "#  # ", " ## #"],
  "R": ["#### ", "#   #", "#### ", "#  # ", "#   #"],
  "S": [" ####", "#    ", " ### ", "    #", "#### "],
  "T": ["#####", "  #  ", "  #  ", "  #  ", "  #  "],
  "U": ["#   #", "#   #", "#   #", "#   #", " ### "],
  "V": ["#   #", "#   #", "#   #", " # # ", "  #  "],
  "W": ["#   #", "#   #", "# # #", "## ##", "#   #"],
  "X": ["#   #", " # # ", "  #  ", " # # ", "#   #"],
  "Y": ["#   #", " # # ", "  #  ", "  #  ", "  #  "],
  "Z": ["#####", "   # ", "  #  ", " #   ", "#####"],
  "[": ["##", "# ", "# ", "# ", "##"],
  "\\": ["#    ", " #   ", "  #  ", "   # ", "    #"],
  "]": ["##", " #", " #", " #", "##"],
  "^": [" # ", "# #", "   ", "   ", "   "],
  "_": ["     ", "     ", "     ", "     ", "#####"],
  "`": ["# ", " #", "  ", "  ", "  "],
  "{": [" ##", " # ", "#  ", " # ", " ##"],
  "|": ["#", "#", "#", "#", "#"],
  "}": ["## ", " # ", "  #", " # ", "## "],
  "~": ["     ", " #   ", "# # #", "   # ", "     "],
};

interface FigFont {
  name: string;
  height: number;
  hardblank: string;
  /** Default layout: smushmode bits as in figlet.c (128 smush, 64 kern, 1..32 rules). */
  layout: number;
  glyphs: Map<string, string[]>;
}

const SM_SMUSH = 128;
const SM_KERN = 64;

function parseStandard(): FigFont {
  const glyphs = new Map<string, string[]>();
  let cur: string | null = null;
  let rows: string[] = [];
  const finish = () => {
    if (cur === null) return;
    const w = Math.max(...rows.map((r) => r.length));
    glyphs.set(cur, rows.map((r) => r.padEnd(w)));
  };
  for (const line of STANDARD_FONT.split('\n')) {
    if (line.startsWith('== ')) {
      finish();
      const name = line.slice(3);
      cur = name === 'space' ? ' ' : name === 'grave' ? '`' : name;
      rows = [];
    } else if (cur !== null && line.endsWith('@')) rows.push(line.slice(0, -1));
  }
  finish();
  return { name: 'standard', height: 6, hardblank: '$', layout: SM_SMUSH | 15, glyphs };
}

function bitmapFont(name: string, ink: string): FigFont {
  const glyphs = new Map<string, string[]>();
  const px = ink.length;
  const make = (rows: string[]) => {
    const out = rows.map((r) => [...r].map((c) => (c === '#' ? ink : ' '.repeat(px))).join('') + ' '.repeat(px));
    out.push(' '.repeat(out[0].length));
    return out;
  };
  for (const [ch, rows] of Object.entries(BITMAPS)) {
    glyphs.set(ch, make(rows));
    if (/[A-Z]/.test(ch)) glyphs.set(ch.toLowerCase(), make(rows));
  }
  glyphs.set(' ', make(['   ', '   ', '   ', '   ', '   ']));
  return { name, height: 6, hardblank: '$', layout: 0, glyphs };
}

function termFont(): FigFont {
  const glyphs = new Map<string, string[]>();
  for (let c = 32; c < 127; c++) glyphs.set(String.fromCharCode(c), [String.fromCharCode(c)]);
  return { name: 'term', height: 1, hardblank: '\0', layout: 0, glyphs };
}

/** A real FIGfont (.flf) read from the disk. */
function parseFlf(name: string, src: string): FigFont | null {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const m = /^[ft]lf2a(.) (\d+) \d+ \d+ (-?\d+) (\d+)(?: \d+ (\d+))?/.exec(lines[0] ?? '');
  if (!m) return null;
  const hardblank = m[1];
  const height = parseInt(m[2], 10);
  const old = parseInt(m[3], 10);
  const comments = parseInt(m[4], 10);
  const full = m[5] !== undefined ? parseInt(m[5], 10) : null;
  let layout: number;
  if (full !== null) layout = (full & 128 ? SM_SMUSH : full & 64 ? SM_KERN : 0) | (full & 63);
  else layout = old === -1 ? 0 : old === 0 ? SM_KERN : SM_SMUSH | old;
  const glyphs = new Map<string, string[]>();
  let i = 1 + comments;
  const readGlyph = (): string[] | null => {
    if (i + height > lines.length) return null;
    const rows: string[] = [];
    for (let r = 0; r < height; r++) {
      const l = lines[i++];
      const end = l.length ? l[l.length - 1] : '';
      let s = l;
      while (s.length && s[s.length - 1] === end) s = s.slice(0, -1);
      rows.push(s);
    }
    const w = Math.max(...rows.map((r) => r.length));
    return rows.map((r) => r.padEnd(w));
  };
  const codes = [...Array.from({ length: 95 }, (_, k) => 32 + k), 196, 214, 220, 228, 246, 252, 223];
  for (const c of codes) {
    const g = readGlyph();
    if (!g) break;
    glyphs.set(String.fromCharCode(c), g);
  }
  while (i < lines.length) {
    const tag = /^\s*(-?(?:0x[0-9a-f]+|0[0-7]*|\d+))/i.exec(lines[i]);
    if (!tag) break;
    i++;
    const g = readGlyph();
    if (!g) break;
    const v = parseInt(tag[1], tag[1].toLowerCase().startsWith('0x') ? 16 : /^0\d/.test(tag[1]) ? 8 : 10);
    if (v >= 0) glyphs.set(String.fromCodePoint(v), g);
  }
  return { name, height, hardblank, layout, glyphs };
}

let builtinFonts: Map<string, FigFont> | null = null;

function builtins(): Map<string, FigFont> {
  if (!builtinFonts) {
    builtinFonts = new Map([
      ['standard', parseStandard()],
      ['block', bitmapFont('block', '\u2588\u2588')],
      ['banner', bitmapFont('banner', '#')],
      ['term', termFont()],
    ]);
  }
  return builtinFonts;
}

/** The FIGlet layout engine (figlet.c: addchar, smushamt, smushem, splitline, printline). */
class FigRenderer {
  private out: string[][] = [];
  private inChars: string[] = [];
  private prevWidth = 0;
  private curWidth = 0;
  private wordbreak = 0;
  readonly lines: string[] = [];
  private readonly font: FigFont;
  private readonly width: number;
  private readonly justify: number;
  private readonly smush: number;

  constructor(font: FigFont, width: number, justify: number, smush: number) {
    this.font = font;
    this.width = width;
    this.justify = justify;
    this.smush = smush;
    this.clear();
  }

  private get limit(): number {
    return this.width - 1;
  }

  private clear(): void {
    this.out = Array.from({ length: this.font.height }, () => []);
    this.inChars = [];
  }

  private letter(c: string): string[] {
    const g = this.font.glyphs.get(c) ?? this.font.glyphs.get('\0') ?? Array.from({ length: this.font.height }, () => '');
    this.prevWidth = this.curWidth;
    this.curWidth = g[0]?.length ?? 0;
    return g;
  }

  private smushem(l: string, r: string): string | null {
    const hb = this.font.hardblank;
    if (l === ' ') return r;
    if (r === ' ') return l;
    if (this.prevWidth < 2 || this.curWidth < 2) return null;
    if ((this.smush & SM_SMUSH) === 0) return null;
    if ((this.smush & 63) === 0) {
      if (l === hb) return r;
      if (r === hb) return l;
      return r;
    }
    if (this.smush & 32 && l === hb && r === hb) return l;
    if (l === hb || r === hb) return null;
    if (this.smush & 1 && l === r) return l;
    if (this.smush & 2) {
      if (l === '_' && '|/\\[]{}()<>'.includes(r)) return r;
      if (r === '_' && '|/\\[]{}()<>'.includes(l)) return l;
    }
    if (this.smush & 4) {
      const classes = ['|', '/\\', '[]', '{}', '()', '<>'];
      const cl = classes.findIndex((k) => k.includes(l));
      const cr = classes.findIndex((k) => k.includes(r));
      if (cl >= 0 && cr >= 0 && cl !== cr) return cl > cr ? l : r;
    }
    if (this.smush & 8) {
      const pair = l + r;
      if (pair === '[]' || pair === '][' || pair === '{}' || pair === '}{' || pair === '()' || pair === ')(') return '|';
    }
    if (this.smush & 16) {
      if (l === '/' && r === '\\') return '|';
      if (l === '\\' && r === '/') return 'Y';
      if (l === '>' && r === '<') return 'X';
    }
    return null;
  }

  private smushAmount(g: string[]): number {
    if ((this.smush & (SM_SMUSH | SM_KERN)) === 0) return 0;
    let max = this.curWidth;
    const len = this.out[0].length;
    for (let row = 0; row < this.font.height; row++) {
      const line = this.out[row];
      let lb = len;
      let ch1 = line[lb];
      while (lb > 0 && (ch1 === undefined || ch1 === ' ')) ch1 = line[--lb];
      let cb = 0;
      while (cb < g[row].length && g[row][cb] === ' ') cb++;
      const ch2 = g[row][cb];
      let amt = cb + len - 1 - lb;
      if (ch1 === undefined || ch1 === ' ') amt++;
      else if (ch2 !== undefined && this.smushem(ch1, ch2) !== null) amt++;
      if (amt < max) max = amt;
    }
    return max;
  }

  private addChar(c: string): boolean {
    const g = this.letter(c);
    const amt = this.smushAmount(g);
    const len = this.out[0].length;
    if (len + this.curWidth - amt > this.limit) return false;
    for (let row = 0; row < this.font.height; row++) {
      const line = this.out[row];
      for (let k = 0; k < amt; k++) {
        const idx = len - amt + k;
        if (idx >= 0) line[idx] = this.smushem(line[idx], g[row][k] ?? ' ') ?? line[idx];
      }
      line.push(...g[row].slice(amt));
    }
    this.inChars.push(c);
    return true;
  }

  private putString(s: string): void {
    let text = s;
    if (this.width > 1 && text.length > this.width - 1) text = text.slice(0, this.width - 1);
    let pad = '';
    if (this.justify > 0 && this.width > 1) {
      let i = 1;
      while ((3 - this.justify) * i + text.length + this.justify - 2 < this.width) {
        pad += ' ';
        i++;
      }
    }
    const hb = this.font.hardblank;
    this.lines.push(pad + text.split(hb).join(' '));
  }

  printLine(): void {
    for (const row of this.out) this.putString(row.join(''));
    this.clear();
  }

  private splitLine(): void {
    let gotSpace = false;
    let lastSpace = this.inChars.length - 1;
    let i = this.inChars.length - 1;
    for (; i >= 0; i--) {
      if (!gotSpace && this.inChars[i] === ' ') {
        gotSpace = true;
        lastSpace = i;
      }
      if (gotSpace && this.inChars[i] !== ' ') break;
    }
    const part1 = this.inChars.slice(0, i + 1);
    const part2 = this.inChars.slice(lastSpace + 1);
    this.clear();
    for (const c of part1) this.addChar(c);
    this.printLine();
    for (const c of part2) this.addChar(c);
  }

  feed(input: string): void {
    let c = input;
    if (c === '\t' || c === ' ') c = ' ';
    else if (/[\n\v\f\r]/.test(c)) c = '\n';
    if ((c < ' ' && c !== '\n') || c === '\x7f') return;
    let notAdded: boolean;
    do {
      notAdded = false;
      if (this.wordbreak === -1) {
        if (c === ' ') break;
        if (c === '\n') {
          this.wordbreak = 0;
          break;
        }
        this.wordbreak = 0;
      }
      if (c === '\n') {
        this.printLine();
        this.wordbreak = 0;
      } else if (this.addChar(c)) {
        if (c !== ' ') this.wordbreak = this.wordbreak >= 2 ? 3 : 1;
        else this.wordbreak = this.wordbreak > 0 ? 2 : 0;
      } else if (this.out[0].length === 0) {
        const g = this.letter(c);
        for (const row of g) this.putString(row);
        this.wordbreak = -1;
      } else if (c === ' ') {
        if (this.wordbreak === 2) this.splitLine();
        else this.printLine();
        this.wordbreak = -1;
      } else {
        if (this.wordbreak >= 2) this.splitLine();
        else this.printLine();
        this.wordbreak = this.wordbreak === 3 ? 1 : 0;
        notAdded = true;
      }
    } while (notAdded);
  }

  end(): void {
    if (this.out[0].length) this.printLine();
  }

  take(): string {
    const s = this.lines.map((l) => l + '\n').join('');
    this.lines.length = 0;
    return s;
  }
}

const FIGLET_USAGE = 'Usage: figlet [ -cklnoprstvxDELNRSWX ] [ -d fontdirectory ]\n              [ -f fontfile ] [ -m smushmode ] [ -w outputwidth ]\n              [ -C controlfile ] [ -I infocode ] [ message ]\n';

const FIGLET_DOC: CommandDoc = {
  category: 'fun',
  summary: 'display large characters made up of ordinary screen characters',
  synopsis: ['figlet [ -clnprtvxkSW ] [ -f fontfile ] [ -w outputwidth ] [ -I infocode ] [ message ]'],
  description:
    'FIGlet prints its input using large characters (called "FIGcharacters") made up of ordinary screen characters. The message comes from the arguments or, if there are none, from standard input, one line at a time.\n\n' +
    'The fonts available here are standard (the default), block, banner and term. figlet wraps long messages to fit in 80 columns (see -w and -t).',
  options: [
    { flags: '-f fontfile', desc: 'Select the font: standard, block, banner or term.' },
    { flags: '-c', desc: 'Center the output horizontally.' },
    { flags: '-r', desc: 'Make the output flush-right.' },
    { flags: '-l', desc: 'Make the output flush-left (the default).' },
    { flags: '-w outputwidth', desc: 'Set the width figlet assumes the screen has (default 80).' },
    { flags: '-t', desc: 'Use the width of the terminal.' },
    { flags: '-k', desc: 'Kerning: letters are moved together until they touch, but not smushed.' },
    { flags: '-S', desc: 'Force smushing: letters are moved together until they overlap.' },
    { flags: '-W', desc: 'Full width: every letter keeps its full width.' },
    { flags: '-p', desc: 'Paragraph mode: line breaks in the input are treated as spaces unless followed by a space or another line break.' },
    { flags: '-I infocode', desc: 'Print information instead of a banner, e.g. -I2 prints the font directory and -I3 the font name.' },
    { flags: '-v', desc: 'Print version and copyright information.' },
  ],
  examples: [
    { cmd: 'figlet Hello', desc: 'Hello in big letters.' },
    { cmd: 'figlet -f block HI', desc: 'Solid block letters.' },
    { cmd: 'figlet -c -w 60 Welcome', desc: 'Centered in 60 columns.' },
    { cmd: 'date +%H:%M | figlet', desc: 'A big clock.' },
  ],
  seeAlso: ['cowsay', 'fortune', 'echo'],
  tip: 'Pipe anything into figlet to make a banner of it, for example: whoami | figlet',
};

defineCommand({
  name: 'figlet',
  pkg: 'figlet',
  size: 85512,
  doc: FIGLET_DOC,
  gnu: false,
  run: async (ctx) => {
    let fontName = 'standard';
    let fontDir = '/usr/share/figlet';
    let width = 80;
    let justify = -1;
    let layout: number | null = null;
    let paragraph = false;
    let rtl = false;
    let info: number | null = null;
    const args = ctx.args;
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        i++;
        break;
      }
      if (a === '--help') {
        await ctx.out(gnuHelp({ name: 'figlet', pkg: 'figlet', doc: FIGLET_DOC, run: async () => 0 }));
        return 0;
      }
      if (!a.startsWith('-') || a === '-') break;
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if ('fdwmCI'.includes(c)) {
          const v = a.slice(j + 1) || args[++i];
          if (v === undefined) {
            await ctx.err(`figlet: option requires an argument -- '${c}'\n${FIGLET_USAGE}`);
            return 1;
          }
          if (c === 'f') fontName = v;
          else if (c === 'd') fontDir = v;
          else if (c === 'w') width = Math.max(1, parseInt(v, 10) || 80);
          else if (c === 'I') info = parseInt(v, 10) || 0;
          else if (c === 'm') {
            const n = parseInt(v, 10);
            layout = n < -1 ? null : n === -1 ? 0 : n === 0 ? SM_KERN : SM_SMUSH | (n & 63);
          }
          break;
        }
        switch (c) {
          case 'c': justify = 1; break;
          case 'l': justify = 0; break;
          case 'r': justify = 2; break;
          case 'x': justify = -1; break;
          case 't': width = ctx.tty && ctx.stdout.isTTY ? ctx.tty.cols : 80; break;
          case 'k': layout = SM_KERN; break;
          case 'W': layout = 0; break;
          case 'S': layout = -2; break;
          case 's': layout = null; break;
          case 'o': layout = SM_SMUSH; break;
          case 'p': paragraph = true; break;
          case 'n': paragraph = false; break;
          case 'L': case 'X': rtl = false; break;
          case 'R': rtl = true; break;
          case 'D': case 'E': case 'N': break;
          case 'v':
            info = 0;
            break;
          default:
            await ctx.err(`figlet: invalid option -- '${c}'\n${FIGLET_USAGE}`);
            return 1;
        }
      }
    }
    // Find the font: a .flf file on the disk, or one of the built-in fonts.
    const base = fontName.replace(/\.[ft]lf$/, '');
    let font: FigFont | null = null;
    const candidates = fontName.includes('/') ? [fontName, fontName + '.flf'] : [`${fontDir}/${base}.flf`, `${fontDir}/${base}.tlf`];
    for (const p of candidates) {
      if (ctx.fs.isFile(p)) {
        font = parseFlf(basename(p).replace(/\.[ft]lf$/, ''), ctx.fs.readFile(p));
        if (!font) {
          await ctx.err(`figlet: ${fontName}: Not a FIGlet 2 font file\n`);
          return 1;
        }
        break;
      }
    }
    if (!font) font = builtins().get(basename(base)) ?? null;
    if (!font) {
      await ctx.err(`figlet: ${fontName}: Unable to open font file\n`);
      return 1;
    }
    if (info !== null) {
      const texts: Record<number, string> = {
        0: 'FIGlet Copyright (C) 1991-2012 Glenn Chappell, Ian Chai, John Cowan,\nChristiaan Keet and Claudio Matsuoka\nInternet: <info@figlet.org> Version: 2.2.5, date: 31 May 2012\n\nFIGlet, along with the various FIGlet fonts and documentation, may be\nfreely copied and distributed.\n\nIf you use FIGlet, please send an e-mail message to <info@figlet.org>.\n\nThe latest version of FIGlet is available from the web site,\n\thttp://www.figlet.org/\n\n' + FIGLET_USAGE,
        1: '20205\n',
        2: fontDir + '\n',
        3: font.name + '\n',
        4: width + '\n',
        5: 'flf2 tlf2\n',
      };
      await ctx.out(texts[info] ?? '');
      return 0;
    }
    let smush = layout === null ? font.layout : layout === -2 ? SM_SMUSH | (font.layout & 63 || 0) : layout;
    if (layout === -2 && (font.layout & 63) === 0) smush = SM_SMUSH;
    const just = justify === -1 ? (rtl ? 2 : 0) : justify;
    const r = new FigRenderer(font, width, just, smush);
    const render = (text: string) => {
      const t = rtl ? text.split('\n').map((l) => [...l].reverse().join('')).join('\n') : text;
      for (const ch of t) r.feed(ch);
    };
    const operands = args.slice(i);
    if (operands.length) {
      // Words are joined with spaces; an empty argument forces a line break.
      let text = '';
      operands.forEach((w, k) => {
        text += w === '' ? '\n' : w;
        if (k < operands.length - 1 && w !== '') text += ' ';
      });
      render(text);
      r.end();
      await ctx.out(r.take());
      return 0;
    }
    if (paragraph) {
      const all = await ctx.stdin.readAll();
      render(all.replace(/\n(?=[^\s])/g, ' '));
      r.end();
      await ctx.out(r.take());
      return 0;
    }
    for (;;) {
      const line = await ctx.stdin.readLine();
      if (line === null) break;
      render(line);
      await ctx.out(r.take());
    }
    r.end();
    await ctx.out(r.take());
    return 0;
  },
});

// ---------------------------------------------------------------------------
// neofetch

const LOGO_FRAME = '\x1b[37m';
const LOGO_PROMPT = '\x1b[1;32m';
// An original ">_" terminal-window logo (24 columns inside the frame).
const NEOFETCH_LOGO = (() => {
  const inner = [
    ` \x1b[31m●\x1b[33m ●\x1b[32m ●${LOGO_FRAME}`,
    null,
    '',
    `  ${LOGO_PROMPT}██${LOGO_FRAME}`,
    `    ${LOGO_PROMPT}██${LOGO_FRAME}`,
    `      ${LOGO_PROMPT}██${LOGO_FRAME}`,
    `    ${LOGO_PROMPT}██${LOGO_FRAME}`,
    `  ${LOGO_PROMPT}██${LOGO_FRAME}     ${LOGO_PROMPT}████████${LOGO_FRAME}`,
    '',
  ];
  const rows = [`${LOGO_FRAME}╭${'─'.repeat(24)}╮`];
  for (const r of inner) {
    if (r === null) rows.push(`${LOGO_FRAME}├${'─'.repeat(24)}┤`);
    else rows.push(`${LOGO_FRAME}│${r}${' '.repeat(24 - stringWidth(r))}│`);
  }
  rows.push(`${LOGO_FRAME}╰${'─'.repeat(24)}╯`);
  return rows;
})();

function neofetchUptime(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} day${d === 1 ? '' : 's'}`);
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m || !parts.length) parts.push(`${m} min${m === 1 ? '' : 's'}`);
  return parts.join(', ');
}

defineCommand({
  name: 'neofetch',
  pkg: 'neofetch',
  size: 359552,
  gnu: false,
  doc: {
    category: 'fun',
    summary: 'a fast, highly customizable system info script',
    synopsis: ['neofetch [--off] [--stdout] [--color_blocks on|off]'],
    description:
      'Neofetch is a command-line system information tool. It displays information about your operating system, software and hardware next to a logo: the operating system, host, kernel, uptime, number of installed packages, shell, screen resolution, terminal, CPU and memory.\n\n' +
      'People like to post screenshots of neofetch to show off their setup.',
    options: [
      { flags: '--off', desc: 'Do not show the logo, only the information.' },
      { flags: '-L, --logo', desc: 'Hide the info text and only show the logo.' },
      { flags: '--stdout', desc: 'Turn off the logo and all colors: plain text output, handy in scripts.' },
      { flags: '--color_blocks on|off', desc: 'Show or hide the row of color blocks.' },
      { flags: '--version', desc: 'Show the neofetch version.' },
    ],
    examples: [
      { cmd: 'neofetch', desc: 'System information next to a logo.' },
      { cmd: 'neofetch --stdout', desc: 'The same information as plain text.' },
    ],
    seeAlso: ['uname', 'free', 'lsb_release'],
    tip: 'Everything neofetch shows can be found with other commands too: uname -r, uptime, free -m and cat /etc/os-release.',
  },
  run: async (ctx) => {
    let logo = true;
    let info = true;
    let colors = true;
    let blocks = true;
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--help' || a === '-h') {
        await ctx.out(gnuHelp({ name: 'neofetch', pkg: 'neofetch', doc: { category: 'fun', summary: '', synopsis: ['neofetch func_name --option "value" --option "value"'], description: 'Neofetch is a CLI system information tool written in BASH. Neofetch displays information about your system next to an image, your OS logo, or any ASCII file of your choice.', options: [{ flags: '--off', desc: 'Disable the logo.' }, { flags: '-L, --logo', desc: 'Hide the info text and only show the logo.' }, { flags: '--stdout', desc: 'Turn off all colors and disables any ASCII/image backend.' }, { flags: '--color_blocks on/off', desc: 'Enable/Disable the color blocks.' }, { flags: '-v, --version', desc: 'Show neofetch version.' }] }, run: async () => 0 }).replace(/--help {8}display this help and exit\n {6}--version {5}output version information and exit\n/, ''));
        return 0;
      }
      if (a === '--version' || a === '-v') {
        await ctx.out('Neofetch 7.1.0\n');
        return 0;
      }
      if (a === '--off') logo = false;
      else if (a === '--logo' || a === '-L') info = false;
      else if (a === '--stdout') {
        logo = false;
        colors = false;
        blocks = false;
      } else if (a === '--color_blocks') blocks = args[++i] !== 'off';
      else if (a === '--ascii_distro' || a === '--backend' || a === '--source' || a === '--ascii') i++;
    }
    if (!ctx.stdout.isTTY) colors = false;
    const sys = ctx.system;
    const user = sys.userName(ctx.creds.uid);
    const host = sys.hostname;
    const readOr = (path: string, fallback: string) => {
      try {
        return ctx.fs.readFile(path);
      } catch {
        return fallback;
      }
    };
    const osRelease = readOr('/etc/os-release', '');
    const pretty = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(osRelease)?.[1] ?? 'Linux';
    const kernel = /Linux version (\S+)/.exec(readOr('/proc/version', ''))?.[1] ?? '6.8.0-45-generic';
    const cpuinfo = readOr('/proc/cpuinfo', '');
    const model = (/^model name\s*:\s*(.*)$/m.exec(cpuinfo)?.[1] ?? 'Unknown CPU')
      .replace(/\((TM|tm|R|r)\)/g, '')
      .replace(/\bCPU\b|\bProcessor\b/g, '')
      .replace(/Core /g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const cores = (cpuinfo.match(/^processor\s*:/gm) ?? []).length || NCPU;
    const mhz = parseFloat(/^cpu MHz\s*:\s*([\d.]+)/m.exec(cpuinfo)?.[1] ?? '2496');
    const packages = PACKAGES.filter((p) => ctx.fs.exists(`/var/lib/dpkg/info/${p.name}.list`)).length;
    const shellPath = ctx.env.get('SHELL') ?? '/bin/bash';
    const shellName = basename(shellPath);
    const c = (code: string, s: string) => (colors ? `\x1b[${code}m${s}\x1b[0m` : s);
    const key = (k: string, v: string) => `${c('1;32', k)}: ${v}`;
    const title = `${c('1;32', user)}@${c('1;32', host)}`;
    const lines = [
      title,
      '-'.repeat(user.length + 1 + host.length),
      key('OS', `${pretty} x86_64`),
      key('Host', 'terminal4dummies Virtual Machine'),
      key('Kernel', kernel),
      key('Uptime', neofetchUptime(sys.now() - sys.bootTime)),
      key('Packages', `${packages} (dpkg)`),
      key('Shell', shellName === 'bash' ? 'bash 5.2.21' : shellName),
      key('Resolution', '1920x1080'),
      key('Terminal', ctx.tty ? `/dev/${ctx.tty.name}` : 'none'),
      key('CPU', `${model} (${cores}) @ ${(mhz / 1000).toFixed(3)}GHz`),
      key('Memory', `${Math.floor(MEM_KB.used / 1024)}MiB / ${Math.floor(MEM_KB.total / 1024)}MiB`),
    ];
    if (blocks) {
      lines.push('');
      let row1 = '';
      let row2 = '';
      for (let n = 0; n < 8; n++) row1 += colors ? `\x1b[3${n}m\x1b[4${n}m   ` : '   ';
      for (let n = 8; n < 16; n++) row2 += colors ? `\x1b[38;5;${n}m\x1b[48;5;${n}m   ` : '   ';
      if (colors) {
        lines.push(row1 + '\x1b[0m');
        lines.push(row2 + '\x1b[0m');
      }
    }
    const art = logo ? NEOFETCH_LOGO.map((l) => (colors ? l + '\x1b[0m' : stripAnsi(l))) : [];
    const artWidth = art.length ? Math.max(...art.map((l) => stringWidth(l))) : 0;
    const shown = info ? lines : [];
    const out: string[] = [];
    const count = Math.max(art.length, shown.length);
    for (let r = 0; r < count; r++) {
      const left = art[r] ?? '';
      const right = shown[r] ?? '';
      if (!logo) out.push(right);
      else out.push(right ? left + ' '.repeat(artWidth - stringWidth(left)) + '   ' + right : left);
    }
    await ctx.out(out.map((l) => l.replace(/\s+$/, '')).join('\n') + '\n\n');
    return 0;
  },
});

// Exported for the tests.
export const _internals = { COWS, FORTUNES, builtins };
