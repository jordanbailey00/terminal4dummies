// less, more, man, whatis, apropos — and the man page formatter.

import { BUILTIN_HELP } from '../builtins/registry';
import type { CommandContext, CommandDoc, NativeCommand } from '../types';
import { stringWidth } from '../wcwidth';
import { runPager } from './tui';
import { COMMANDS, defineCommand, errText, getopts } from './util';

// ---------------------------------------------------------------------------
// less / more

async function pagerCommand(ctx: CommandContext, more: boolean): Promise<number> {
  const opts = await getopts(ctx, { short: 'NSFRXEiI', long: { 'LINE-NUMBERS': 'N', 'chop-long-lines': 'S', 'quit-if-one-screen': 'F', 'RAW-CONTROL-CHARS': 'R', 'ignore-case': 'i' } }, false);
  if (!opts) return 1;
  let startLine: number | undefined;
  const files = opts.operands.filter((f) => {
    if (/^\+\d+$/.test(f)) {
      startLine = parseInt(f.slice(1), 10);
      return false;
    }
    return true;
  });
  let text = '';
  let name: string | null = null;
  let status = 0;
  if (files.length === 0) {
    if (ctx.stdin.isTTY) {
      await ctx.err(more ? 'more: bad usage\nTry \'more --help\' for more information.\n' : 'Missing filename ("less --help" for help)\n');
      return 1;
    }
    text = await ctx.stdin.readAll();
  } else {
    const sources: string[] = [];
    for (const f of files) {
      try {
        const node = ctx.fs.stat(f);
        if (node.type === 'dir') {
          await ctx.err(`${f} is a directory\n`);
          status = 1;
          continue;
        }
        sources.push(files.length > 1 ? `::::::::::::::\n${f}\n::::::::::::::\n` + ctx.fs.readFile(f) : ctx.fs.readFile(f));
      } catch (e) {
        await ctx.err(`${f}: ${errText(e)}\n`);
        status = 1;
      }
    }
    if (sources.length === 0) return status;
    text = sources.join('');
    name = files[0];
  }
  if (!ctx.stdout.isTTY || !ctx.tty) {
    await ctx.out(text);
    return status;
  }
  if (opts.has('F') && text.split('\n').length < ctx.tty.rows) {
    await ctx.out(text);
    return status;
  }
  await runPager(ctx, text, { name, more, lineNumbers: opts.has('N'), chop: opts.has('S'), startLine });
  return status;
}

defineCommand({
  name: 'less',
  pkg: 'less',
  size: 199752,
  doc: {
    category: 'viewing',
    summary: 'opposite of more',
    synopsis: ['less [options] [file...]'],
    description:
      'Less is a program similar to more, but which allows backward movement in the file as well as forward movement. It is ideal for reading long files and the output of commands.\n\n' +
      'While viewing: Space or f moves forward a page, b moves back a page, the arrow keys scroll one line, g goes to the top, G to the bottom, /word searches forward, n finds the next match, h shows help, and q quits.',
    options: [
      { flags: '-N, --LINE-NUMBERS', desc: 'Causes a line number to be displayed at the beginning of each line in the display.' },
      { flags: '-S, --chop-long-lines', desc: 'Causes lines longer than the screen width to be chopped (truncated) rather than wrapped.' },
      { flags: '-F, --quit-if-one-screen', desc: 'Causes less to automatically exit if the entire file can be displayed on the first screen.' },
      { flags: '+N', desc: 'Start at line N.' },
    ],
    examples: [
      { cmd: 'less /var/log/syslog', desc: 'Read a long log file one screen at a time.' },
      { cmd: 'ls -l /usr/bin | less', desc: 'Page through long command output.' },
    ],
    seeAlso: ['more', 'cat', 'head', 'tail'],
    tip: 'Press q to quit less. That is the single most useful thing to remember about it!',
  },
  gnu: false,
  run: (ctx) => pagerCommand(ctx, false),
});

defineCommand({
  name: 'more',
  pkg: 'util-linux',
  size: 43320,
  doc: {
    category: 'viewing',
    summary: 'display the contents of a file in a terminal',
    synopsis: ['more [options] file...'],
    description: 'more is a filter for paging through text one screenful at a time. Press Space for the next page, Enter for the next line, and q to quit. less is a more capable replacement.',
    seeAlso: ['less'],
  },
  gnu: false,
  run: (ctx) => pagerCommand(ctx, true),
});

// ---------------------------------------------------------------------------
// man page formatting

interface ManPage {
  name: string;
  section: number;
  title: string;
  footerLeft: string;
  footerDate: string;
  sections: { heading: string; blocks: ManBlock[] }[];
}

type ManBlock = { kind: 'para'; text: string } | { kind: 'tagged'; tag: string; text: string } | { kind: 'pre'; text: string };

const SECTION_TITLES: Record<number, string> = {
  1: 'User Commands',
  5: 'File Formats',
  7: 'Miscellaneous Information Manual',
  8: 'System Administration',
};

const PACKAGE_FOOTERS: Record<string, [string, string]> = {
  coreutils: ['GNU coreutils 9.4', 'April 2024'],
  findutils: ['', ''],
  grep: ['GNU grep 3.11', '2023-04-24'],
  sed: ['GNU sed 4.9', 'November 2022'],
  bash: ['GNU Bash 5.2', '2022 September 19'],
  procps: ['procps-ng', '2023-01-16'],
  less: ['Version 590', '23 Jun 2021'],
  nano: ['version 7.2', 'March 2023'],
  tar: ['TAR', 'January 16, 2023'],
};

/** Inline markup: *bold*, _underline_ — command names and options get bold automatically. */
function styleInline(text: string): string {
  return text
    .replace(/(^|[\s(,])(--?[A-Za-z][\w-]*(?:=[A-Z]+)?)/g, (_m, pre: string, opt: string) => `${pre}\x1b[1m${opt}\x1b[22m`)
    .replace(/\b([A-Z]{2,}(?:_[A-Z]+)*)\b/g, (m) => (/^(GNU|POSIX|UTF|ASCII|TAB|CR|LF|ID|IDs|USER|PATH|HOME|SHELL|TERM|LANG|PWD|ESC|CPU|RAM|URL|URLS|HTTP|HTTPS|FTP|JSON|CSV|SSH|PID|UID|GID|ISO|RFC|LSB|NUMBER|DNS|EOF|IP|KEY|CR)$/.test(m) ? m : `\x1b[4m${m}\x1b[24m`));
}

function justify(words: string[], width: number, last: boolean): string {
  if (last || words.length === 1) return words.join(' ');
  const visible = words.reduce((n, w) => n + stringWidth(w), 0);
  let gaps = words.length - 1;
  let spaces = width - visible;
  let out = '';
  for (let i = 0; i < words.length; i++) {
    out += words[i];
    if (i < words.length - 1) {
      const n = Math.ceil(spaces / gaps);
      out += ' '.repeat(Math.max(1, n));
      spaces -= n;
      gaps--;
    }
  }
  return out;
}

function fill(text: string, indent: number, width: number, firstIndent = indent, doJustify = true): string[] {
  const words = text.split(/\s+/).filter(Boolean).map(styleInline);
  const lines: string[] = [];
  let cur: string[] = [];
  let curWidth = 0;
  let ind = firstIndent;
  const avail = () => width - ind;
  for (const w of words) {
    const ww = stringWidth(w);
    if (cur.length && curWidth + 1 + ww > avail()) {
      lines.push(' '.repeat(ind) + (doJustify ? justify(cur, avail(), false) : cur.join(' ')));
      cur = [];
      curWidth = 0;
      ind = indent;
    }
    curWidth += (cur.length ? 1 : 0) + ww;
    cur.push(w);
  }
  if (cur.length) lines.push(' '.repeat(ind) + cur.join(' '));
  return lines;
}

export function renderManPage(page: ManPage, cols: number): string {
  const width = Math.max(40, Math.min(cols - 1, 110));
  const head = `${page.name.toUpperCase()}(${page.section})`;
  const center = page.title;
  const gap = Math.max(1, width - head.length * 2 - center.length);
  const leftGap = Math.floor(gap / 2);
  let out = head + ' '.repeat(leftGap) + center + ' '.repeat(gap - leftGap) + head + '\n\n';
  for (const s of page.sections) {
    out += `\x1b[1m${s.heading}\x1b[22m\n`;
    s.blocks.forEach((b, i) => {
      if (i > 0) out += '\n';
      if (b.kind === 'para') {
        for (const para of b.text.split(/\n\s*\n/)) out += fill(para, 7, width).join('\n') + '\n';
      } else if (b.kind === 'pre') {
        out += b.text.split('\n').map((l) => '       ' + l).join('\n') + '\n';
      } else {
        const tag = `\x1b[1m${b.tag}\x1b[22m`;
        const tagWidth = stringWidth(b.tag);
        if (tagWidth < 7) {
          const lines = fill(b.text, 14, width);
          out += '       ' + tag + lines[0].slice(7 + tagWidth) + '\n' + lines.slice(1).map((l) => l + '\n').join('');
        } else {
          out += '       ' + tag + '\n' + fill(b.text, 14, width).map((l) => l + '\n').join('');
        }
      }
    });
    out += '\n';
  }
  const footLeft = page.footerLeft;
  const footDate = page.footerDate;
  const fgap = Math.max(1, width - footLeft.length - footDate.length - head.length);
  const fl = Math.floor(fgap / 2);
  out += footLeft + ' '.repeat(fl) + footDate + ' '.repeat(fgap - fl) + head + '\n';
  return out;
}

export function manPageFor(cmd: { name: string; pkg: string; doc: CommandDoc }): ManPage {
  const d = cmd.doc;
  const section = d.section ?? 1;
  const [footerLeft, footerDate] = PACKAGE_FOOTERS[cmd.pkg] ?? [cmd.pkg, '2024'];
  const sections: ManPage['sections'] = [
    { heading: 'NAME', blocks: [{ kind: 'para', text: `${cmd.name} - ${d.summary}` }] },
    { heading: 'SYNOPSIS', blocks: d.synopsis.map((s) => ({ kind: 'pre' as const, text: s.replace(/^(\S+)/, '\x1b[1m$1\x1b[22m') })) },
    { heading: 'DESCRIPTION', blocks: d.description.split(/\n\s*\n/).map((p) => ({ kind: 'para' as const, text: p })) },
  ];
  if (d.options?.length) {
    sections.push({ heading: 'OPTIONS', blocks: d.options.map((o) => ({ kind: 'tagged' as const, tag: o.flags, text: o.desc })) });
  }
  if (d.examples?.length) {
    sections.push({ heading: 'EXAMPLES', blocks: d.examples.map((e) => ({ kind: 'tagged' as const, tag: e.cmd, text: e.desc })) });
  }
  if (d.seeAlso?.length) {
    sections.push({ heading: 'SEE ALSO', blocks: [{ kind: 'para', text: d.seeAlso.map((s) => `${s}(1)`).join(', ') }] });
  }
  return { name: cmd.name, section, title: SECTION_TITLES[section] ?? 'User Commands', footerLeft, footerDate, sections };
}

// Extra pages that are not commands.
const SPECIAL_PAGES: Record<string, () => ManPage> = {
  hier: () => ({
    name: 'hier',
    section: 7,
    title: 'Miscellaneous Information Manual',
    footerLeft: 'Linux man-pages 6.7',
    footerDate: '2023-10-31',
    sections: [
      { heading: 'NAME', blocks: [{ kind: 'para', text: 'hier - description of the filesystem hierarchy' }] },
      {
        heading: 'DESCRIPTION',
        blocks: [
          { kind: 'para', text: 'A typical Linux system has, among others, the following directories:' },
          { kind: 'tagged', tag: '/', text: 'This is the root directory. This is where the whole tree starts.' },
          { kind: 'tagged', tag: '/bin', text: 'This directory contains executable programs which are needed in single user mode and to bring the system up or repair it. On modern systems it is a link to /usr/bin.' },
          { kind: 'tagged', tag: '/boot', text: 'Contains static files for the boot loader, including the Linux kernel.' },
          { kind: 'tagged', tag: '/dev', text: 'Special or device files, which refer to physical devices. /dev/null is a special file that discards anything written to it.' },
          { kind: 'tagged', tag: '/etc', text: 'Contains configuration files which are local to the machine, such as /etc/passwd (user accounts) and /etc/hostname.' },
          { kind: 'tagged', tag: '/home', text: 'On machines with home directories for users, these are usually beneath this directory, directly or not. Your files live in /home/yourname.' },
          { kind: 'tagged', tag: '/lib', text: 'This directory should hold those shared libraries that are necessary to boot the system and to run the commands in the root filesystem.' },
          { kind: 'tagged', tag: '/media', text: 'This directory contains mount points for removable media such as USB drives.' },
          { kind: 'tagged', tag: '/mnt', text: 'This directory is a mount point for a temporarily mounted filesystem.' },
          { kind: 'tagged', tag: '/opt', text: 'This directory should contain add-on packages that contain static files.' },
          { kind: 'tagged', tag: '/proc', text: 'This is a mount point for the proc filesystem, which provides information about running processes and the kernel.' },
          { kind: 'tagged', tag: '/root', text: 'This directory is usually the home directory for the root user.' },
          { kind: 'tagged', tag: '/sbin', text: 'Like /bin, this directory holds commands needed to boot the system, but which are usually not executed by normal users.' },
          { kind: 'tagged', tag: '/tmp', text: 'This directory contains temporary files which may be deleted with no notice, such as by a regular job or at system boot up.' },
          { kind: 'tagged', tag: '/usr', text: 'This directory is usually mounted from a separate partition. It holds most user programs (/usr/bin), libraries (/usr/lib) and shared data (/usr/share).' },
          { kind: 'tagged', tag: '/usr/local', text: 'This is where programs which are local to the site typically go.' },
          { kind: 'tagged', tag: '/var', text: 'This directory contains files which may change in size, such as spool and log files (/var/log).' },
        ],
      },
      { heading: 'SEE ALSO', blocks: [{ kind: 'para', text: 'find(1), ln(1), proc(5)' }] },
    ],
  }),
  sudo_root: () => ({
    name: 'sudo_root',
    section: 8,
    title: 'System Administration',
    footerLeft: '',
    footerDate: 'February 8, 2006',
    sections: [
      { heading: 'NAME', blocks: [{ kind: 'para', text: 'sudo_root - How to run administrative commands' }] },
      { heading: 'SYNOPSIS', blocks: [{ kind: 'pre', text: '\x1b[1msudo\x1b[22m command' }] },
      {
        heading: 'INTRODUCTION',
        blocks: [
          { kind: 'para', text: 'By default, the password for the user "root" (the system administrator) is locked. This means you cannot login as root or use su. Instead, the installer will set up sudo to allow the user that is created during install to run all administrative commands.' },
          { kind: 'para', text: 'This means that in the terminal you can use sudo for commands that require root privileges. All programs started with sudo will run with root privileges, so be careful what you type.' },
          { kind: 'para', text: 'When sudo asks for a password, it needs your own password, not a root password. While you type it, nothing appears on the screen: that is normal.' },
        ],
      },
      { heading: 'EXAMPLES', blocks: [{ kind: 'tagged', tag: 'sudo apt install cowsay', text: 'Install a program from the package archive.' }, { kind: 'tagged', tag: 'sudo nano /etc/hosts', text: 'Edit a system configuration file.' }] },
      { heading: 'SEE ALSO', blocks: [{ kind: 'para', text: 'sudo(8)' }] },
    ],
  }),
  intro: () => ({
    name: 'intro',
    section: 1,
    title: 'User Commands',
    footerLeft: 'Linux man-pages 6.7',
    footerDate: '2023-10-31',
    sections: [
      { heading: 'NAME', blocks: [{ kind: 'para', text: 'intro - introduction to user commands' }] },
      {
        heading: 'DESCRIPTION',
        blocks: [
          { kind: 'para', text: 'Section 1 of the manual describes user commands and tools, for example, file manipulation tools, shells, compilers, web browsers, file and image viewers and editors, and so on.' },
          { kind: 'para', text: 'A Linux system presents a number of user interfaces. The classical one is the command line: you type a command, press Enter, and the shell runs it. Commands usually take options (which start with a dash, like -l) and arguments (like file names).' },
          { kind: 'para', text: 'Use ls to list files, cd to change directory, cat to print a file, and man to read the manual page of any command. Most commands also accept --help.' },
        ],
      },
      { heading: 'SEE ALSO', blocks: [{ kind: 'para', text: 'man(1), bash(1), hier(7)' }] },
    ],
  }),
  bash: () => {
    const builtins = [...BUILTIN_HELP.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return {
      name: 'bash',
      section: 1,
      title: 'General Commands Manual',
      footerLeft: 'GNU Bash 5.2',
      footerDate: '2022 September 19',
      sections: [
        { heading: 'NAME', blocks: [{ kind: 'para', text: 'bash - GNU Bourne-Again SHell' }] },
        { heading: 'SYNOPSIS', blocks: [{ kind: 'pre', text: '\x1b[1mbash\x1b[22m [options] [command_string | file]' }] },
        { heading: 'DESCRIPTION', blocks: [{ kind: 'para', text: 'Bash is an sh-compatible command language interpreter that executes commands read from the standard input or from a file. It reads what you type, expands it (variables, wildcards, ~), and runs the resulting command.' }] },
        {
          heading: 'SHELL GRAMMAR',
          blocks: [
            { kind: 'para', text: 'A simple command is a sequence of optional variable assignments followed by blank-separated words and redirections. The first word specifies the command to be executed, and is passed as argument zero.' },
            { kind: 'para', text: 'A pipeline is a sequence of one or more commands separated by |. The standard output of each command is connected to the standard input of the next.' },
            { kind: 'para', text: 'A list is a sequence of pipelines separated by ;, &, &&, or ||. cmd1 && cmd2 runs cmd2 only if cmd1 succeeds; cmd1 || cmd2 runs cmd2 only if cmd1 fails; & runs a command in the background.' },
          ],
        },
        {
          heading: 'QUOTING',
          blocks: [
            { kind: 'para', text: 'Enclosing characters in single quotes preserves the literal value of each character within the quotes. Enclosing characters in double quotes preserves the literal value of all characters within the quotes, with the exception of $, `, and \\. A backslash escapes the next character.' },
          ],
        },
        {
          heading: 'EXPANSION',
          blocks: [
            { kind: 'tagged', tag: 'Brace expansion', text: 'a{b,c}d becomes abd acd; {1..5} becomes 1 2 3 4 5.' },
            { kind: 'tagged', tag: 'Tilde expansion', text: '~ becomes your home directory.' },
            { kind: 'tagged', tag: 'Parameter expansion', text: '$name or ${name} is replaced by the value of the variable. ${name:-word} uses word if name is unset or empty.' },
            { kind: 'tagged', tag: 'Command substitution', text: '$(command) is replaced by the output of the command.' },
            { kind: 'tagged', tag: 'Arithmetic expansion', text: '$((expression)) is replaced by the result of the arithmetic expression.' },
            { kind: 'tagged', tag: 'Pathname expansion', text: '* matches any string, ? matches any single character, and [...] matches any one of the enclosed characters.' },
          ],
        },
        {
          heading: 'REDIRECTION',
          blocks: [
            { kind: 'tagged', tag: '> file', text: 'Send standard output to file (overwriting it).' },
            { kind: 'tagged', tag: '>> file', text: 'Append standard output to file.' },
            { kind: 'tagged', tag: '< file', text: 'Read standard input from file.' },
            { kind: 'tagged', tag: '2> file', text: 'Send standard error to file.' },
            { kind: 'tagged', tag: '&> file', text: 'Send both standard output and standard error to file.' },
            { kind: 'tagged', tag: '<<WORD', text: 'Here document: read input lines until a line containing only WORD.' },
          ],
        },
        { heading: 'SHELL BUILTIN COMMANDS', blocks: builtins.map(([, h]) => ({ kind: 'tagged' as const, tag: h.usage, text: h.summary })) },
        { heading: 'SEE ALSO', blocks: [{ kind: 'para', text: 'sh(1), ksh(1), csh(1), emacs(1), vi(1)' }] },
      ],
    };
  },
};

const SPECIAL_SECTIONS: Record<string, number> = { hier: 7, sudo_root: 8, intro: 1, bash: 1 };
const SPECIAL_SUMMARIES: Record<string, string> = {
  hier: 'description of the filesystem hierarchy',
  sudo_root: 'How to run administrative commands',
  intro: 'introduction to user commands',
  bash: 'GNU Bourne-Again SHell',
};

function commandsWithDocs(): NativeCommand[] {
  return COMMANDS.filter((c) => c.doc);
}

/** Is the manual page installed on this (simulated) system? */
function manInstalled(ctx: CommandContext, name: string, section: number): boolean {
  return ctx.fs.exists(`/usr/share/man/man${section}/${name}.${section}.gz`);
}

function findPage(ctx: CommandContext, name: string, section: number | null): ManPage | null {
  if (SPECIAL_PAGES[name] && (section === null || section === SPECIAL_SECTIONS[name])) return SPECIAL_PAGES[name]();
  const cmd = commandsWithDocs().find((c) => c.name === name);
  if (!cmd || !cmd.doc) return null;
  const sec = cmd.doc.section ?? 1;
  if (section !== null && section !== sec) return null;
  if (!manInstalled(ctx, name, sec)) return null;
  return manPageFor({ name: cmd.name, pkg: cmd.pkg, doc: cmd.doc });
}

function whatisLine(name: string, section: number, summary: string): string {
  return `${`${name} (${section})`.padEnd(21)}- ${summary}\n`;
}

async function apropos(ctx: CommandContext, words: string[], exact: boolean): Promise<number> {
  let out = '';
  let status = 0;
  const entries: [string, number, string][] = [];
  for (const c of commandsWithDocs()) {
    const sec = c.doc!.section ?? 1;
    if (manInstalled(ctx, c.name, sec)) entries.push([c.name, sec, c.doc!.summary]);
  }
  for (const [n, s] of Object.entries(SPECIAL_SECTIONS)) entries.push([n, s, SPECIAL_SUMMARIES[n]]);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  for (const w of words) {
    const lw = w.toLowerCase();
    const hits = entries.filter(([n, , s]) => (exact ? n === w : n.toLowerCase().includes(lw) || s.toLowerCase().includes(lw)));
    if (hits.length === 0) {
      await ctx.out(`${w}: nothing appropriate.\n`);
      status = 16;
      continue;
    }
    for (const [n, s, sum] of hits) out += whatisLine(n, s, sum);
  }
  await ctx.out(out);
  return status;
}

defineCommand({
  name: 'man',
  pkg: 'man-db',
  size: 128696,
  doc: {
    category: 'help',
    summary: 'an interface to the system reference manuals',
    synopsis: ['man [man options] [[section] page ...] ...', 'man -k [apropos options] regexp ...', 'man -f [whatis options] page ...'],
    description:
      'man is the system\'s manual pager. Each page argument given to man is normally the name of a program, utility or function. The manual page associated with each of these arguments is then found and displayed.\n\n' +
      'Pages open in the less pager: use the arrow keys or Space to scroll, /word to search, and q to quit.\n\n' +
      'Shell builtins such as cd do not have their own manual pages; use help cd instead.',
    options: [
      { flags: '-k, --apropos', desc: 'Equivalent to apropos. Search the short manual page descriptions for keywords.' },
      { flags: '-f, --whatis', desc: 'Equivalent to whatis. Display a short description from the manual page, if available.' },
    ],
    examples: [
      { cmd: 'man ls', desc: 'Read the manual for ls (q to quit).' },
      { cmd: 'man -k copy', desc: 'Find commands related to copying.' },
      { cmd: 'man hier', desc: 'Learn what the standard directories are for.' },
    ],
    seeAlso: ['apropos', 'whatis', 'less', 'help'],
    tip: 'Inside man, type /pattern and press Enter to search, n for the next match, and q to quit.',
  },
  gnu: false,
  run: async (ctx) => {
    const args = ctx.args;
    if (args[0] === '-k' || args[0] === '--apropos') return apropos(ctx, args.slice(1), false);
    if (args[0] === '-f' || args[0] === '--whatis') return apropos(ctx, args.slice(1), true);
    const names = args.filter((a) => !a.startsWith('-'));
    if (names.length === 0) {
      await ctx.err("What manual page do you want?\nFor example, try 'man man'.\n");
      return 1;
    }
    let section: number | null = null;
    if (/^[1-9]$/.test(names[0]) && names.length > 1) {
      section = parseInt(names[0], 10);
      names.shift();
    }
    let status = 0;
    for (const name of names) {
      const page = findPage(ctx, name, section);
      if (!page) {
        await ctx.err(section !== null ? `No manual entry for ${name} in section ${section}\n` : `No manual entry for ${name}\n`);
        status = 16;
        continue;
      }
      const text = renderManPage(page, ctx.tty?.cols ?? 80);
      if (!ctx.stdout.isTTY || !ctx.tty) {
        await ctx.out(text.replace(/\x1b\[[0-9;]*m/g, ''));
        continue;
      }
      await runPager(ctx, text, { name, manTitle: `Manual page ${name}(${page.section})` });
    }
    return status;
  },
});

defineCommand({
  name: 'whatis',
  pkg: 'man-db',
  size: 47528,
  doc: { category: 'help', summary: 'display one-line manual page descriptions', synopsis: ['whatis [-r] name ...'], description: "Each manual page has a short description available within it. whatis searches the manual page names and displays the manual page descriptions of any name matched.", examples: [{ cmd: 'whatis ls cp mv', desc: 'What do these commands do?' }], seeAlso: ['apropos', 'man'] },
  gnu: false,
  run: async (ctx) => {
    if (ctx.args.length === 0) {
      await ctx.err('whatis what?\n');
      return 1;
    }
    return apropos(ctx, ctx.args, true);
  },
});

defineCommand({
  name: 'apropos',
  pkg: 'man-db',
  size: 47528,
  doc: { category: 'help', summary: 'search the manual page names and descriptions', synopsis: ['apropos keyword ...'], description: 'Each manual page has a short description available within it. apropos searches the descriptions for instances of keyword. Same as man -k.', examples: [{ cmd: 'apropos directory', desc: 'Find commands that have to do with directories.' }], seeAlso: ['whatis', 'man'] },
  gnu: false,
  run: async (ctx) => {
    if (ctx.args.length === 0) {
      await ctx.err('apropos what?\n');
      return 1;
    }
    return apropos(ctx, ctx.args, false);
  },
});

