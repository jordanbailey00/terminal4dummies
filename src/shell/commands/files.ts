// File and directory programs: cat, touch, mkdir, rmdir, rm, cp, mv, ln,
// chmod, chown, chgrp, stat, file, basename, dirname, realpath, readlink,
// pwd, du, df, truncate, mktemp, link, unlink, sync.

import type { CommandContext } from '../types';
import { FsError, VirtualFS, dataSize, inodeSize, isBinaryData, type FileData, type Inode } from '../vfs/fs';
import { basename, dirname, normalize, resolvePath } from '../vfs/path';
import { modeString } from './ls';
import { blocksFor, defineCommand, errText, getopts, humanSize, pad2, q, qf, ql, readLines, tzOffset } from './util';

// ---------------------------------------------------------------------------
// shared helpers

async function ask(ctx: CommandContext, prompt: string): Promise<boolean> {
  await ctx.err(prompt);
  const line = await ctx.stdin.readLine();
  if (line === null) return false;
  return /^\s*[yY]/.test(line);
}

function fileKind(node: Inode): string {
  switch (node.type) {
    case 'dir':
      return 'directory';
    case 'symlink':
      return 'symbolic link';
    case 'chardev':
      return 'character special file';
    case 'file':
      return dataSize(node.data) === 0 ? 'regular empty file' : 'regular file';
  }
}

async function missingOperand(ctx: CommandContext, what = 'missing operand'): Promise<number> {
  await ctx.error(what);
  await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// cat

function showNonprinting(s: string, tabs: boolean): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\t' && !tabs) out += ch;
    else if (c < 32) out += '^' + String.fromCharCode(c + 64);
    else if (c === 127) out += '^?';
    else out += ch;
  }
  return out;
}

defineCommand({
  name: 'cat',
  pkg: 'coreutils',
  size: 35280,
  doc: {
    category: 'viewing',
    summary: 'concatenate files and print on the standard output',
    synopsis: ['cat [OPTION]... [FILE]...'],
    description: 'Concatenate FILE(s) to standard output.\n\nWith no FILE, or when FILE is -, read standard input.',
    options: [
      { flags: '-A, --show-all', desc: 'equivalent to -vET' },
      { flags: '-b, --number-nonblank', desc: 'number nonempty output lines, overrides -n' },
      { flags: '-E, --show-ends', desc: 'display $ at end of each line' },
      { flags: '-n, --number', desc: 'number all output lines' },
      { flags: '-s, --squeeze-blank', desc: 'suppress repeated empty output lines' },
      { flags: '-T, --show-tabs', desc: 'display TAB characters as ^I' },
      { flags: '-v, --show-nonprinting', desc: 'use ^ and M- notation, except for LFD and TAB' },
    ],
    examples: [
      { cmd: 'cat notes.txt', desc: "Print a file's contents." },
      { cmd: 'cat -n notes.txt', desc: 'Print with line numbers.' },
      { cmd: 'cat part1.txt part2.txt > whole.txt', desc: 'Join files together into a new file.' },
    ],
    seeAlso: ['less', 'head', 'tail', 'tac'],
    tip: "If you run cat with no file name it waits for you to type. Press Ctrl+D to finish or Ctrl+C to cancel.",
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, {
      short: 'AbeEnstTuv',
      long: { 'show-all': 'A', 'number-nonblank': 'b', 'show-ends': 'E', number: 'n', 'squeeze-blank': 's', 'show-tabs': 'T', 'show-nonprinting': 'v' },
    });
    if (!opts) return 1;
    const has = (k: string) => opts.has(k);
    const showEnds = has('E') || has('A') || has('e');
    const showTabs = has('T') || has('A') || has('t');
    const nonprint = has('v') || has('A') || has('e') || has('t');
    const numberNonblank = has('b');
    const number = has('n') || numberNonblank;
    const squeeze = has('s');
    const plain = !showEnds && !showTabs && !nonprint && !number && !squeeze;
    let lineNo = 0;
    let prevBlank = false;
    let status = 0;
    const formatLine = (line: string, nl: boolean): string | null => {
      const blank = line === '';
      if (squeeze && blank && prevBlank && nl) return null;
      prevBlank = blank;
      let text = line;
      if (nonprint || showTabs) text = showNonprinting(text, showTabs);
      let prefix = '';
      if (number && !(numberNonblank && blank)) prefix = String(++lineNo).padStart(6) + '\t';
      return prefix + text + (nl ? (showEnds ? '$\n' : '\n') : '');
    };
    const files = opts.operands.length ? opts.operands : ['-'];
    for (const f of files) {
      await ctx.checkpoint();
      if (f === '-') {
        if (plain) {
          for (;;) {
            const chunk = await ctx.stdin.read();
            if (chunk === null) break;
            await ctx.out(chunk);
          }
        } else {
          for await (const { line, nl } of readLines(ctx.stdin)) {
            const t = formatLine(line, nl);
            if (t !== null) await ctx.out(t);
          }
        }
        continue;
      }
      let data: FileData;
      try {
        const node = ctx.fs.stat(f);
        if (node.type === 'dir') throw new FsError('EISDIR', f);
        data = ctx.fs.readData(f);
      } catch (e) {
        await ctx.error(`${qf(f)}: ${errText(e)}`);
        status = 1;
        continue;
      }
      const text = typeof data === 'string' ? data : ctx.fs.readFile(f);
      if (plain) {
        await ctx.out(text);
        continue;
      }
      const lines = text.split('\n');
      const endsWithNl = text.endsWith('\n');
      if (endsWithNl) lines.pop();
      let out = '';
      lines.forEach((l, i) => {
        const t = formatLine(l, i < lines.length - 1 || endsWithNl);
        if (t !== null) out += t;
      });
      await ctx.out(out);
    }
    return status;
  },
});

// ---------------------------------------------------------------------------
// touch

function parseTouchDate(s: string, now: number): number | null {
  const t = s.trim().toLowerCase();
  if (t === 'now' || t === 'today') return now;
  if (t === 'yesterday') return now - 86400000;
  if (t === 'tomorrow') return now + 86400000;
  const rel = /^([-+]?\d+)\s*(second|minute|hour|day|week|month|year)s?(\s+ago)?$/.exec(t);
  if (rel) {
    let n = parseInt(rel[1], 10);
    if (rel[3]) n = -n;
    const unit = { second: 1e3, minute: 6e4, hour: 3.6e6, day: 8.64e7, week: 6.048e8, month: 2.592e9, year: 3.1536e10 }[rel[2]]!;
    return now + n * unit;
  }
  const d = Date.parse(s.replace(' ', 'T'));
  if (!Number.isNaN(d)) return d;
  const d2 = Date.parse(s);
  return Number.isNaN(d2) ? null : d2;
}

defineCommand({
  name: 'touch',
  pkg: 'coreutils',
  size: 97488,
  doc: {
    category: 'files',
    summary: 'change file timestamps',
    synopsis: ['touch [OPTION]... FILE...'],
    description: 'Update the access and modification times of each FILE to the current time.\n\nA FILE argument that does not exist is created empty, unless -c is supplied.',
    options: [
      { flags: '-a', desc: 'change only the access time' },
      { flags: '-c, --no-create', desc: 'do not create any files' },
      { flags: '-d, --date=STRING', desc: 'parse STRING and use it instead of current time' },
      { flags: '-m', desc: 'change only the modification time' },
      { flags: '-r, --reference=FILE', desc: "use this file's times instead of current time" },
    ],
    examples: [
      { cmd: 'touch notes.txt', desc: 'Create an empty file (or update its time).' },
      { cmd: 'touch a.txt b.txt c.txt', desc: 'Create several files at once.' },
    ],
    seeAlso: ['mkdir', 'stat'],
    tip: 'touch is the quickest way to create an empty file.',
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, {
      short: 'acd:fhmr:t:',
      long: { 'no-create': 'c', date: { key: 'd', arg: 'required' }, reference: { key: 'r', arg: 'required' }, 'no-dereference': 'h', time: { key: 'time', arg: 'required' } },
    });
    if (!opts) return 1;
    if (opts.operands.length === 0) return missingOperand(ctx, 'missing file operand');
    let time: number | undefined;
    const now = ctx.system.now();
    if (opts.get('d')) {
      const t = parseTouchDate(opts.get('d')!, now);
      if (t === null) {
        await ctx.error(`invalid date format ${ql(opts.get('d')!)}`);
        return 1;
      }
      time = t;
    }
    if (opts.get('t')) {
      const m = /^(?:(\d\d)?(\d\d))?(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d\d))?$/.exec(opts.get('t')!);
      if (!m) {
        await ctx.error(`invalid date format ${ql(opts.get('t')!)}`);
        return 1;
      }
      const year = m[2] ? parseInt((m[1] ?? '20') + m[2], 10) : new Date(now).getFullYear();
      time = new Date(year, parseInt(m[3], 10) - 1, parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10), parseInt(m[7] ?? '0', 10)).getTime();
    }
    if (opts.get('r')) {
      try {
        time = ctx.fs.stat(opts.get('r')!).mtime;
      } catch (e) {
        await ctx.error(`failed to get attributes of ${q(opts.get('r')!)}: ${errText(e)}`);
        return 1;
      }
    }
    let status = 0;
    for (const f of opts.operands) {
      await ctx.checkpoint();
      try {
        const node = ctx.fs.tryStat(f);
        if (!node) {
          if (opts.has('c')) continue;
          ctx.fs.writeFile(f, '');
          if (time !== undefined) ctx.fs.setTimes(f, time, time);
          continue;
        }
        const t = time ?? now;
        if (time === undefined) {
          ctx.fs.touch(f);
        } else {
          ctx.fs.setTimes(f, opts.has('m') && !opts.has('a') ? node.atime : t, opts.has('a') && !opts.has('m') ? node.mtime : t);
        }
      } catch (e) {
        await ctx.error(`cannot touch ${q(f)}: ${errText(e)}`);
        status = 1;
      }
    }
    return status;
  },
});

// ---------------------------------------------------------------------------
// mkdir / rmdir

defineCommand({
  name: 'mkdir',
  pkg: 'coreutils',
  size: 72488,
  doc: {
    category: 'files',
    summary: 'make directories',
    synopsis: ['mkdir [OPTION]... DIRECTORY...'],
    description: 'Create the DIRECTORY(ies), if they do not already exist.',
    options: [
      { flags: '-m, --mode=MODE', desc: 'set file mode (as in chmod), not a=rwx - umask' },
      { flags: '-p, --parents', desc: 'no error if existing, make parent directories as needed' },
      { flags: '-v, --verbose', desc: 'print a message for each created directory' },
    ],
    examples: [
      { cmd: 'mkdir projects', desc: 'Create a directory called projects.' },
      { cmd: 'mkdir -p website/css/themes', desc: 'Create nested directories in one go.' },
      { cmd: 'mkdir -p app/{src,tests,docs}', desc: 'Create several sibling directories with brace expansion.' },
    ],
    seeAlso: ['rmdir', 'ls', 'cd'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'm:pvZ', long: { mode: { key: 'm', arg: 'required' }, parents: 'p', verbose: 'v' } });
    if (!opts) return 1;
    if (opts.operands.length === 0) return missingOperand(ctx);
    let mode = 0o777;
    if (opts.get('m')) {
      const m = parseMode(opts.get('m')!, 0o777, 0, true);
      if (m === null) {
        await ctx.error(`invalid mode ${ql(opts.get('m')!)}`);
        return 1;
      }
      mode = m;
    }
    const verbose = opts.has('v');
    let status = 0;
    for (const d of opts.operands) {
      await ctx.checkpoint();
      if (opts.has('p')) {
        const abs = ctx.fs.abs(d);
        const parts = abs.split('/').filter(Boolean);
        let cur = '';
        let failed = false;
        const relParts = d.replace(/\/+$/, '').split('/');
        for (let i = 0; i < parts.length; i++) {
          cur += '/' + parts[i];
          const node = ctx.fs.tryStat(cur);
          if (node) {
            if (node.type !== 'dir') {
              await ctx.error(`cannot create directory ${ql(d.startsWith('/') ? cur : relParts.slice(0, i - (parts.length - relParts.length) + 1).join('/') || cur)}: ${i === parts.length - 1 ? 'File exists' : 'Not a directory'}`);
              failed = true;
              break;
            }
            continue;
          }
          try {
            ctx.fs.mkdir(cur, i === parts.length - 1 && opts.get('m') ? mode : 0o777);
            if (opts.get('m') && i === parts.length - 1) ctx.fs.chmod(cur, mode);
            if (verbose) {
              const label = d.startsWith('/') ? cur : relParts.slice(0, i - (parts.length - relParts.length) + 1).join('/');
              await ctx.out(`${ctx.name}: created directory ${q(label)}\n`);
            }
          } catch (e) {
            await ctx.error(`cannot create directory ${ql(d)}: ${errText(e)}`);
            failed = true;
            break;
          }
        }
        if (failed) status = 1;
        continue;
      }
      try {
        ctx.fs.mkdir(d, mode);
        if (opts.get('m')) ctx.fs.chmod(d, mode);
        if (verbose) await ctx.out(`${ctx.name}: created directory ${q(d.replace(/\/+$/, '') || d)}\n`);
      } catch (e) {
        await ctx.error(`cannot create directory ${ql(d)}: ${errText(e)}`);
        status = 1;
      }
    }
    return status;
  },
});

defineCommand({
  name: 'rmdir',
  pkg: 'coreutils',
  size: 51048,
  doc: {
    category: 'files',
    summary: 'remove empty directories',
    synopsis: ['rmdir [OPTION]... DIRECTORY...'],
    description: 'Remove the DIRECTORY(ies), if they are empty.',
    options: [
      { flags: '--ignore-fail-on-non-empty', desc: 'ignore each failure to remove a non-empty directory' },
      { flags: '-p, --parents', desc: "remove DIRECTORY and its ancestors; e.g., 'rmdir -p a/b' is similar to 'rmdir a/b a'" },
      { flags: '-v, --verbose', desc: 'output a diagnostic for every directory processed' },
    ],
    examples: [{ cmd: 'rmdir old_folder', desc: 'Remove an empty directory.' }],
    seeAlso: ['rm', 'mkdir'],
    tip: 'rmdir only removes empty directories. To delete a directory and everything in it, use rm -r (carefully!).',
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'pv', long: { parents: 'p', verbose: 'v', 'ignore-fail-on-non-empty': 'ignore' } });
    if (!opts) return 1;
    if (opts.operands.length === 0) return missingOperand(ctx);
    let status = 0;
    for (const d of opts.operands) {
      const targets = [d];
      if (opts.has('p')) {
        let cur = d.replace(/\/+$/, '');
        while (cur.includes('/')) {
          cur = cur.slice(0, cur.lastIndexOf('/'));
          if (cur) targets.push(cur);
        }
      }
      for (const t of targets) {
        if (opts.has('v')) await ctx.out(`${ctx.name}: removing directory, ${q(t)}\n`);
        try {
          ctx.fs.rmdir(t);
        } catch (e) {
          if (e instanceof FsError && e.code === 'ENOTEMPTY' && opts.has('ignore')) break;
          await ctx.error(`failed to remove ${q(t)}: ${errText(e)}`);
          status = 1;
          break;
        }
      }
    }
    return status;
  },
});

// ---------------------------------------------------------------------------
// rm

defineCommand({
  name: 'rm',
  pkg: 'coreutils',
  size: 76016,
  doc: {
    category: 'files',
    summary: 'remove files or directories',
    synopsis: ['rm [OPTION]... [FILE]...'],
    description:
      'This manual page documents the GNU version of rm. rm removes each specified file. By default, it does not remove directories.\n\n' +
      'If the -I or --interactive=once option is given, and there are more than three files or the -r, -R, or --recursive are given, then rm prompts the user for whether to proceed with the entire operation.\n\n' +
      'Note that if you use rm to remove a file, it might be possible to recover some of its contents, given sufficient expertise and/or time. Files deleted with rm do NOT go to a trash can.',
    options: [
      { flags: '-f, --force', desc: 'ignore nonexistent files and arguments, never prompt' },
      { flags: '-i', desc: 'prompt before every removal' },
      { flags: '-I', desc: 'prompt once before removing more than three files, or when removing recursively' },
      { flags: '-r, -R, --recursive', desc: 'remove directories and their contents recursively' },
      { flags: '-d, --dir', desc: 'remove empty directories' },
      { flags: '-v, --verbose', desc: 'explain what is being done' },
    ],
    examples: [
      { cmd: 'rm old.txt', desc: 'Delete a file (there is no undo!).' },
      { cmd: 'rm -i *.txt', desc: 'Ask before deleting each file.' },
      { cmd: 'rm -r old_project', desc: 'Delete a directory and everything inside it.' },
    ],
    seeAlso: ['rmdir', 'mv'],
    tip: 'There is no recycle bin in the terminal. Double-check before pressing Enter, especially with -r and wildcards.',
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, {
      short: 'dfiIrRv',
      long: { force: 'f', recursive: 'r', dir: 'd', verbose: 'v', interactive: { key: 'interactive', arg: 'optional' }, 'no-preserve-root': 'npr', 'preserve-root': 'pr', 'one-file-system': 'ofs' },
    });
    if (!opts) return 1;
    let force = false;
    let interactive: 'never' | 'once' | 'always' = 'never';
    for (const { key, value } of opts.list) {
      if (key === 'f') {
        force = true;
        interactive = 'never';
      } else if (key === 'i') {
        interactive = 'always';
        force = false;
      } else if (key === 'I') {
        interactive = 'once';
        force = false;
      } else if (key === 'interactive') {
        const v = value === true ? 'always' : value;
        interactive = v === 'once' ? 'once' : v === 'never' || v === 'no' || v === 'none' ? 'never' : 'always';
      }
    }
    const recursive = opts.has('r') || opts.has('R');
    const verbose = opts.has('v');
    const allowDir = opts.has('d');
    const operands = opts.operands;
    if (operands.length === 0) {
      if (force) return 0;
      return missingOperand(ctx);
    }
    if (interactive === 'once' && (operands.length > 3 || recursive)) {
      const msg = recursive
        ? `${ctx.name}: remove ${operands.length} argument${operands.length > 1 ? 's' : ''} recursively? `
        : `${ctx.name}: remove ${operands.length} arguments? `;
      if (!(await ask(ctx, msg))) return 0;
    }
    const stdinTTY = ctx.stdin.isTTY;
    let status = 0;

    const removeOne = async (path: string): Promise<boolean> => {
      await ctx.checkpoint();
      let node: Inode;
      try {
        node = ctx.fs.lstat(path);
      } catch (e) {
        if (force && e instanceof FsError && e.code === 'ENOENT') return true;
        await ctx.error(`cannot remove ${q(path)}: ${errText(e)}`);
        return false;
      }
      if (node.type === 'dir') {
        if (!recursive) {
          if (allowDir) {
            if (interactive === 'always' && !(await ask(ctx, `${ctx.name}: remove directory ${q(path)}? `))) return true;
            try {
              ctx.fs.rmdir(path);
              if (verbose) await ctx.out(`removed directory ${q(path)}\n`);
              return true;
            } catch (e) {
              await ctx.error(`cannot remove ${q(path)}: ${errText(e)}`);
              return false;
            }
          }
          await ctx.error(`cannot remove ${q(path)}: Is a directory`);
          return false;
        }
        if (interactive === 'always' && node.entries.size > 0 && !(await ask(ctx, `${ctx.name}: descend into directory ${q(path)}? `))) return true;
        let names: string[];
        try {
          names = ctx.fs.readdir(path);
        } catch (e) {
          await ctx.error(`cannot remove ${q(path)}: ${errText(e)}`);
          return false;
        }
        let ok = true;
        for (const name of names) {
          const child = path.endsWith('/') ? path + name : path + '/' + name;
          if (!(await removeOne(child))) ok = false;
        }
        if (!ok) return false;
        if (interactive === 'always' && !(await ask(ctx, `${ctx.name}: remove directory ${q(path)}? `))) return true;
        try {
          ctx.fs.rmdir(path);
          if (verbose) await ctx.out(`removed directory ${q(path)}\n`);
          return true;
        } catch (e) {
          await ctx.error(`cannot remove ${q(path)}: ${errText(e)}`);
          return false;
        }
      }
      const writable = node.type === 'symlink' || VirtualFS.canAccess(node, ctx.creds, 2);
      if (interactive === 'always') {
        const kind = node.type === 'symlink' ? 'symbolic link' : fileKind(node);
        const prot = writable ? '' : 'write-protected ';
        if (!(await ask(ctx, `${ctx.name}: remove ${prot}${kind} ${q(path)}? `))) return true;
      } else if (!force && !writable && stdinTTY) {
        if (!(await ask(ctx, `${ctx.name}: remove write-protected ${fileKind(node)} ${q(path)}? `))) return true;
      }
      try {
        ctx.fs.unlink(path);
        if (verbose) await ctx.out(`removed ${q(path)}\n`);
        return true;
      } catch (e) {
        await ctx.error(`cannot remove ${q(path)}: ${errText(e)}`);
        return false;
      }
    };

    for (const p of operands) {
      const base = basename(p);
      if (recursive && (base === '.' || base === '..')) {
        await ctx.error(`refusing to remove '.' or '..' directory: skipping ${q(p)}`);
        status = 1;
        continue;
      }
      if (recursive && normalize(ctx.fs.abs(p)) === '/' && !opts.has('npr')) {
        await ctx.error(`it is dangerous to operate recursively on ${q('/')}`);
        await ctx.error('use --no-preserve-root to override this failsafe');
        status = 1;
        continue;
      }
      if (!(await removeOne(p))) status = 1;
    }
    return status;
  },
});

// ---------------------------------------------------------------------------
// cp / mv

interface CopyOpts {
  recursive: boolean;
  interactive: boolean;
  noClobber: boolean;
  verbose: boolean;
  preserve: boolean;
  update: boolean;
  force: boolean;
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}

async function copyNode(ctx: CommandContext, src: string, dst: string, o: CopyOpts, label: { src: string; dst: string }): Promise<boolean> {
  await ctx.checkpoint();
  const fs = ctx.fs;
  let node: Inode;
  try {
    node = o.recursive ? fs.lstat(src) : fs.stat(src);
  } catch (e) {
    await ctx.error(`cannot stat ${q(label.src)}: ${errText(e)}`);
    return false;
  }
  if (node.type === 'dir') {
    if (!o.recursive) {
      await ctx.error(`-r not specified; omitting directory ${q(label.src)}`);
      return false;
    }
    const srcReal = fs.realpath(src);
    const dstAbs = resolvePath(ctx.cwd, dst);
    if (isInside(dstAbs, srcReal)) {
      await ctx.error(`cannot copy a directory, ${q(label.src)}, into itself, ${q(label.dst)}`);
      return false;
    }
    const existing = fs.tryStat(dst);
    if (existing && existing.type !== 'dir') {
      await ctx.error(`cannot overwrite non-directory ${q(label.dst)} with directory ${q(label.src)}`);
      return false;
    }
    if (!existing) {
      try {
        fs.mkdir(dst, node.mode);
        if (o.verbose) await ctx.out(`${q(label.src)} -> ${q(label.dst)}\n`);
      } catch (e) {
        await ctx.error(`cannot create directory ${q(label.dst)}: ${errText(e)}`);
        return false;
      }
    }
    let names: string[];
    try {
      names = fs.readdir(src);
    } catch (e) {
      await ctx.error(`cannot access ${q(label.src)}: ${errText(e)}`);
      return false;
    }
    let ok = true;
    for (const name of names) {
      const s = src.replace(/\/+$/, '') + '/' + name;
      const d = dst.replace(/\/+$/, '') + '/' + name;
      if (!(await copyNode(ctx, s, d, o, { src: label.src.replace(/\/+$/, '') + '/' + name, dst: label.dst.replace(/\/+$/, '') + '/' + name }))) ok = false;
    }
    if (o.preserve) {
      try {
        fs.setTimes(dst, node.atime, node.mtime);
      } catch {
        /* ignore */
      }
    }
    return ok;
  }
  if (node.type === 'symlink') {
    try {
      const existing = fs.tryStat(dst, false);
      if (existing) fs.unlink(dst);
      fs.symlink(node.target, dst);
      if (o.verbose) await ctx.out(`${q(label.src)} -> ${q(label.dst)}\n`);
      return true;
    } catch (e) {
      await ctx.error(`cannot create symbolic link ${q(label.dst)}: ${errText(e)}`);
      return false;
    }
  }
  const existing = fs.tryStat(dst);
  if (existing) {
    if (existing === node) {
      await ctx.error(`${q(label.src)} and ${q(label.dst)} are the same file`);
      return false;
    }
    if (existing.type === 'dir') {
      await ctx.error(`cannot overwrite directory ${q(label.dst)} with non-directory`);
      return false;
    }
    if (o.noClobber) return true;
    if (o.update && existing.mtime >= node.mtime) return true;
    if (o.interactive && !(await ask(ctx, `${ctx.name}: overwrite ${q(label.dst)}? `))) return true;
  }
  let data: FileData;
  try {
    data = fs.readData(src);
  } catch (e) {
    await ctx.error(`cannot open ${q(label.src)} for reading: ${errText(e)}`);
    return false;
  }
  try {
    if (existing && o.force && !VirtualFS.canAccess(existing, ctx.creds, 2)) fs.unlink(dst);
    // a new file gets the source's mode minus the umask; an existing one keeps its mode
    fs.writeFile(dst, isBinaryData(data) ? { ...data } : data, { mode: node.mode & 0o777 });
    if (o.preserve) {
      fs.chmod(dst, node.mode);
      fs.setTimes(dst, node.atime, node.mtime);
      if (ctx.creds.uid === 0) fs.chown(dst, node.uid, node.gid);
    }
    if (o.verbose) await ctx.out(`${q(label.src)} -> ${q(label.dst)}\n`);
    return true;
  } catch (e) {
    await ctx.error(`cannot create regular file ${q(label.dst)}: ${errText(e)}`);
    return false;
  }
}

defineCommand({
  name: 'cp',
  pkg: 'coreutils',
  size: 141832,
  doc: {
    category: 'files',
    summary: 'copy files and directories',
    synopsis: ['cp [OPTION]... [-T] SOURCE DEST', 'cp [OPTION]... SOURCE... DIRECTORY'],
    description: 'Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.',
    options: [
      { flags: '-a, --archive', desc: 'same as -dR --preserve=all' },
      { flags: '-f, --force', desc: 'if an existing destination file cannot be opened, remove it and try again' },
      { flags: '-i, --interactive', desc: 'prompt before overwrite' },
      { flags: '-n, --no-clobber', desc: 'do not overwrite an existing file' },
      { flags: '-p', desc: 'same as --preserve=mode,ownership,timestamps' },
      { flags: '-R, -r, --recursive', desc: 'copy directories recursively' },
      { flags: '-u, --update', desc: 'copy only when the SOURCE file is newer than the destination file or when the destination file is missing' },
      { flags: '-v, --verbose', desc: 'explain what is being done' },
    ],
    examples: [
      { cmd: 'cp report.txt report-backup.txt', desc: 'Make a copy with a new name.' },
      { cmd: 'cp photo.jpg Pictures/', desc: 'Copy a file into a directory.' },
      { cmd: 'cp -r project project-copy', desc: 'Copy a whole directory.' },
    ],
    seeAlso: ['mv', 'rsync', 'ln'],
    tip: 'cp silently overwrites files that already exist. Use cp -i to be asked first.',
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, {
      short: 'abdfHilLnpPrRsStTuvx',
      long: { archive: 'a', force: 'f', interactive: 'i', 'no-clobber': 'n', recursive: 'R', update: { key: 'u', arg: 'optional' }, verbose: 'v', preserve: { key: 'p', arg: 'optional' }, 'no-target-directory': 'T', 'target-directory': { key: 't', arg: 'required' }, dereference: 'L', 'no-dereference': 'P' },
    });
    if (!opts) return 1;
    const o: CopyOpts = {
      recursive: opts.has('r') || opts.has('R') || opts.has('a'),
      interactive: false,
      noClobber: false,
      verbose: opts.has('v'),
      preserve: opts.has('p') || opts.has('a'),
      update: opts.has('u'),
      force: opts.has('f'),
    };
    for (const { key } of opts.list) {
      if (key === 'i') {
        o.interactive = true;
        o.noClobber = false;
      } else if (key === 'n') {
        o.noClobber = true;
        o.interactive = false;
      }
    }
    return copyOrMove(ctx, opts.operands, opts.get('t') ?? null, opts.has('T'), (src, dst, label) => copyNode(ctx, src, dst, o, label));
  },
});

async function copyOrMove(
  ctx: CommandContext,
  operands: string[],
  targetDir: string | null,
  noTargetDir: boolean,
  act: (src: string, dst: string, label: { src: string; dst: string }) => Promise<boolean>,
): Promise<number> {
  if (operands.length === 0) return missingOperand(ctx, 'missing file operand');
  let sources: string[];
  let dest: string;
  if (targetDir !== null) {
    sources = operands;
    dest = targetDir;
  } else {
    if (operands.length === 1) return missingOperand(ctx, `missing destination file operand after ${q(operands[0])}`);
    sources = operands.slice(0, -1);
    dest = operands[operands.length - 1];
  }
  const destNode = ctx.fs.tryStat(dest);
  const destIsDir = destNode?.type === 'dir' && !noTargetDir;
  if (!destIsDir && (sources.length > 1 || targetDir !== null)) {
    if (destNode || targetDir !== null) await ctx.error(`target ${q(dest)} is not a directory`);
    else await ctx.error(`target ${q(dest)}: No such file or directory`);
    return 1;
  }
  if (!destIsDir && dest.endsWith('/') && !destNode) {
    const srcNode = ctx.fs.tryStat(sources[0]);
    if (srcNode && srcNode.type !== 'dir') {
      await ctx.error(`cannot create regular file ${q(dest)}: Not a directory`);
      return 1;
    }
  }
  let status = 0;
  for (const src of sources) {
    const target = destIsDir ? dest.replace(/\/+$/, '') + '/' + basename(src) : dest;
    const label = { src, dst: destIsDir ? (dest.endsWith('/') ? dest + basename(src) : dest + '/' + basename(src)) : dest };
    if (!(await act(src, target, label))) status = 1;
  }
  return status;
}

defineCommand({
  name: 'mv',
  pkg: 'coreutils',
  size: 137400,
  doc: {
    category: 'files',
    summary: 'move (rename) files',
    synopsis: ['mv [OPTION]... [-T] SOURCE DEST', 'mv [OPTION]... SOURCE... DIRECTORY'],
    description: 'Rename SOURCE to DEST, or move SOURCE(s) to DIRECTORY.',
    options: [
      { flags: '-f, --force', desc: 'do not prompt before overwriting' },
      { flags: '-i, --interactive', desc: 'prompt before overwrite' },
      { flags: '-n, --no-clobber', desc: 'do not overwrite an existing file' },
      { flags: '-u, --update', desc: 'move only when the SOURCE file is newer than the destination file or when the destination file is missing' },
      { flags: '-v, --verbose', desc: 'explain what is being done' },
    ],
    examples: [
      { cmd: 'mv draft.txt final.txt', desc: 'Rename a file.' },
      { cmd: 'mv final.txt Documents/', desc: 'Move a file into a directory.' },
      { cmd: 'mv *.jpg Pictures/', desc: 'Move all JPEG files at once.' },
    ],
    seeAlso: ['cp', 'rename'],
    tip: 'Renaming and moving are the same operation in the terminal: both are done with mv.',
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, {
      short: 'bfinStT:uvZ',
      long: { force: 'f', interactive: 'i', 'no-clobber': 'n', update: { key: 'u', arg: 'optional' }, verbose: 'v', 'target-directory': { key: 't', arg: 'required' }, 'no-target-directory': 'T' },
    });
    if (!opts) return 1;
    let interactive = false;
    let noClobber = false;
    for (const { key } of opts.list) {
      if (key === 'i') {
        interactive = true;
        noClobber = false;
      } else if (key === 'n') {
        noClobber = true;
        interactive = false;
      } else if (key === 'f') {
        interactive = false;
        noClobber = false;
      }
    }
    const verbose = opts.has('v');
    const update = opts.has('u');
    const stdinTTY = ctx.stdin.isTTY;
    return copyOrMove(ctx, opts.operands, opts.get('t') ?? null, opts.has('T'), async (src, dst, label) => {
      await ctx.checkpoint();
      const fs = ctx.fs;
      let node: Inode;
      try {
        node = fs.lstat(src);
      } catch (e) {
        await ctx.error(`cannot stat ${q(label.src)}: ${errText(e)}`);
        return false;
      }
      const existing = fs.tryStat(dst, false);
      if (existing) {
        if (existing === node) {
          await ctx.error(`${q(label.src)} and ${q(label.dst)} are the same file`);
          return false;
        }
        if (noClobber) return true;
        if (update && existing.mtime >= node.mtime) return true;
        if (node.type === 'dir' && existing.type !== 'dir') {
          await ctx.error(`cannot overwrite non-directory ${q(label.dst)} with directory ${q(label.src)}`);
          return false;
        }
        if (node.type !== 'dir' && existing.type === 'dir') {
          await ctx.error(`cannot overwrite directory ${q(label.dst)} with non-directory`);
          return false;
        }
        const writable = VirtualFS.canAccess(existing, ctx.creds, 2) || existing.type === 'symlink';
        if (interactive) {
          if (!(await ask(ctx, `${ctx.name}: overwrite ${q(label.dst)}? `))) return true;
        } else if (!writable && stdinTTY && !opts.has('f')) {
          const mode = (existing.mode & 0o7777).toString(8).padStart(4, '0');
          if (!(await ask(ctx, `${ctx.name}: replace ${q(label.dst)}, overriding mode ${mode} (${modeString(existing).slice(1)})? `))) return true;
        }
      }
      if (node.type === 'dir') {
        const srcAbs = fs.realpath(src);
        const dstAbs = resolvePath(ctx.cwd, dst);
        if (isInside(dstAbs, srcAbs) && dstAbs !== srcAbs) {
          await ctx.error(`cannot move ${q(label.src)} to a subdirectory of itself, ${q(label.dst)}`);
          return false;
        }
      }
      try {
        fs.rename(src, dst);
      } catch (e) {
        if (e instanceof FsError && e.code === 'ENOTEMPTY') {
          await ctx.error(`cannot move ${q(label.src)} to ${q(label.dst)}: Directory not empty`);
        } else if (e instanceof FsError && (e.code === 'EACCES' || e.code === 'EPERM')) {
          await ctx.error(`cannot move ${q(label.src)} to ${q(label.dst)}: ${e.reason}`);
        } else {
          await ctx.error(`cannot move ${q(label.src)} to ${q(label.dst)}: ${errText(e)}`);
        }
        return false;
      }
      if (verbose) await ctx.out(`renamed ${q(label.src)} -> ${q(label.dst)}\n`);
      return true;
    });
  },
});

// ---------------------------------------------------------------------------
// ln

defineCommand({
  name: 'ln',
  pkg: 'coreutils',
  size: 76080,
  doc: {
    category: 'files',
    summary: 'make links between files',
    synopsis: ['ln [OPTION]... [-T] TARGET LINK_NAME', 'ln [OPTION]... TARGET', 'ln [OPTION]... TARGET... DIRECTORY'],
    description: 'In the 1st form, create a link to TARGET with the name LINK_NAME. In the 2nd form, create a link to TARGET in the current directory. In the 3rd form, create links to each TARGET in DIRECTORY. Create hard links by default, symbolic links with --symbolic.',
    options: [
      { flags: '-f, --force', desc: 'remove existing destination files' },
      { flags: '-n, --no-dereference', desc: 'treat LINK_NAME as a normal file if it is a symbolic link to a directory' },
      { flags: '-s, --symbolic', desc: 'make symbolic links instead of hard links' },
      { flags: '-v, --verbose', desc: 'print name of each linked file' },
    ],
    examples: [{ cmd: 'ln -s /var/log logs', desc: 'Create a shortcut called logs pointing at /var/log.' }],
    seeAlso: ['readlink', 'ls'],
    tip: 'A symbolic link (ln -s) is like a shortcut: it stores the path of another file.',
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'bfinrsStT:v', long: { force: 'f', 'no-dereference': 'n', symbolic: 's', verbose: 'v', relative: 'r', 'target-directory': { key: 't', arg: 'required' } } });
    if (!opts) return 1;
    const ops = opts.operands;
    if (ops.length === 0) return missingOperand(ctx, 'missing file operand');
    const symbolic = opts.has('s');
    let targets: string[];
    let linkDir: string | null = null;
    let linkName: string | null = null;
    if (opts.get('t')) {
      targets = ops;
      linkDir = opts.get('t')!;
    } else if (ops.length === 1) {
      targets = ops;
      linkDir = '.';
    } else {
      const last = ops[ops.length - 1];
      const lastNode = opts.has('n') ? ctx.fs.tryStat(last, false) : ctx.fs.tryStat(last);
      if (lastNode?.type === 'dir') {
        targets = ops.slice(0, -1);
        linkDir = last;
      } else {
        if (ops.length > 2) {
          await ctx.error(`target ${q(last)} is not a directory`);
          return 1;
        }
        targets = [ops[0]];
        linkName = last;
      }
    }
    let status = 0;
    for (const t of targets) {
      const name = linkName ?? (linkDir === '.' ? basename(t) : linkDir!.replace(/\/+$/, '') + '/' + basename(t));
      try {
        if (opts.has('f') && ctx.fs.tryStat(name, false)) ctx.fs.unlink(name);
        if (symbolic) {
          ctx.fs.symlink(t, name);
          if (opts.has('v')) await ctx.out(`${q(name)} -> ${q(t)}\n`);
        } else {
          const node = ctx.fs.tryStat(t);
          if (!node) throw new FsError('ENOENT', t);
          if (node.type === 'dir') {
            await ctx.error(`${q(t)}: hard link not allowed for directory`);
            status = 1;
            continue;
          }
          ctx.fs.link(t, name);
          if (opts.has('v')) await ctx.out(`${q(name)} => ${q(t)}\n`);
        }
      } catch (e) {
        if (!symbolic && e instanceof FsError && e.code === 'ENOENT' && !ctx.fs.tryStat(t)) {
          await ctx.error(`failed to access ${q(t)}: No such file or directory`);
        } else {
          await ctx.error(`failed to create ${symbolic ? 'symbolic' : 'hard'} link ${q(name)}${symbolic ? '' : ` => ${q(t)}`}: ${errText(e)}`);
        }
        status = 1;
      }
    }
    return status;
  },
});

// ---------------------------------------------------------------------------
// chmod / chown / chgrp

/**
 * Parse a chmod mode (octal or symbolic) relative to the current mode.
 * Returns null when the mode is invalid.
 */
export function parseMode(spec: string, current: number, umask: number, isDir: boolean): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) {
    const v = parseInt(spec, 8);
    // chmod keeps setuid/setgid on directories unless 5+ digits are given
    if (isDir && spec.length < 4) return (v & 0o777) | (current & 0o6000);
    return v;
  }
  let mode = current & 0o7777;
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)((?:[-+=](?:[rwxXst]*|[ugo]))+)$/.exec(clause);
    if (!m) return null;
    const whoStr = m[1];
    const noWho = whoStr === '';
    let who = noWho ? 0o7777 : 0;
    for (const w of whoStr) who |= w === 'u' ? 0o4700 : w === 'g' ? 0o2070 : w === 'o' ? 0o1007 : 0o7777;
    // without u/g/o/a, bits set in the umask are left alone
    const allowed = noWho ? ~umask & 0o7777 : 0o7777;
    for (const act of m[2].match(/[-+=](?:[rwxXst]*|[ugo])/g) ?? []) {
      const op = act[0];
      const perms = act.slice(1);
      let bits = 0;
      if (perms === 'u' || perms === 'g' || perms === 'o') {
        const src = perms === 'u' ? (mode >> 6) & 7 : perms === 'g' ? (mode >> 3) & 7 : mode & 7;
        bits = (src << 6) | (src << 3) | src;
      } else {
        for (const p of perms) {
          if (p === 'r') bits |= 0o444;
          else if (p === 'w') bits |= 0o222;
          else if (p === 'x') bits |= 0o111;
          else if (p === 'X' && (isDir || (current & 0o111) !== 0)) bits |= 0o111;
          else if (p === 's') bits |= 0o6000;
          else if (p === 't') bits |= 0o1000;
        }
      }
      bits &= who;
      if (op === '+') mode |= bits & allowed;
      else if (op === '-') mode &= ~(bits & allowed);
      else mode = (mode & ~(noWho ? 0o777 : who)) | (bits & allowed);
    }
  }
  return mode;
}

function modeDesc(mode: number): string {
  const fake: Inode = { ino: 0, type: 'file', mode, uid: 0, gid: 0, atime: 0, mtime: 0, ctime: 0, nlink: 1, data: '' };
  return modeString(fake).slice(1);
}

defineCommand({
  name: 'chmod',
  pkg: 'coreutils',
  size: 64016,
  doc: {
    category: 'permissions',
    summary: 'change file mode bits',
    synopsis: ['chmod [OPTION]... MODE[,MODE]... FILE...', 'chmod [OPTION]... OCTAL-MODE FILE...'],
    description:
      'chmod changes the file mode bits of each given file according to mode, which can be either a symbolic representation of changes to make, or an octal number representing the bit pattern for the new mode bits.\n\n' +
      'The format of a symbolic mode is [ugoa...][[-+=][perms...]...], where perms is either zero or more letters from the set rwxXst. u is the user who owns the file, g other users in the file\'s group, o other users not in the file\'s group, and a all users.\n\n' +
      'A numeric mode is from one to four octal digits (0-7), derived by adding up the bits with values 4 (read), 2 (write), and 1 (execute) for the user, the group, and others. For example 755 means rwxr-xr-x and 644 means rw-r--r--.',
    options: [
      { flags: '-c, --changes', desc: 'like verbose but report only when a change is made' },
      { flags: '-f, --silent, --quiet', desc: 'suppress most error messages' },
      { flags: '-v, --verbose', desc: 'output a diagnostic for every file processed' },
      { flags: '-R, --recursive', desc: 'change files and directories recursively' },
    ],
    examples: [
      { cmd: 'chmod +x script.sh', desc: 'Make a script executable.' },
      { cmd: 'chmod 644 notes.txt', desc: 'Owner can read/write; everyone else can read.' },
      { cmd: 'chmod go-r secret.txt', desc: 'Remove read permission for group and others.' },
    ],
    seeAlso: ['chown', 'ls', 'umask'],
  },
  run: async (ctx) => {
    // chmod accepts modes like -w that look like options
    const args = ctx.args;
    const flags = new Set<string>();
    const rest: string[] = [];
    let modeArg: string | null = null;
    let endOpts = false;
    for (const a of args) {
      if (!endOpts && a === '--') {
        endOpts = true;
        continue;
      }
      if (!endOpts && /^-[cfvR]+$/.test(a)) {
        for (const c of a.slice(1)) flags.add(c);
        continue;
      }
      if (!endOpts && ['--changes', '--silent', '--quiet', '--verbose', '--recursive'].includes(a)) {
        flags.add({ '--changes': 'c', '--silent': 'f', '--quiet': 'f', '--verbose': 'v', '--recursive': 'R' }[a]!);
        continue;
      }
      if (!endOpts && a.startsWith('--')) {
        await ctx.error(`unrecognized option '${a}'`);
        await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
        return 1;
      }
      if (modeArg === null) modeArg = a;
      else rest.push(a);
    }
    if (modeArg === null) return missingOperand(ctx);
    if (rest.length === 0) return missingOperand(ctx, `missing operand after ${ql(modeArg)}`);
    if (parseMode(modeArg, 0o644, ctx.umask, false) === null) {
      await ctx.error(`invalid mode: ${ql(modeArg)}`);
      await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
      return 1;
    }
    let status = 0;
    const apply = async (path: string): Promise<void> => {
      await ctx.checkpoint();
      let node: Inode;
      try {
        node = ctx.fs.stat(path);
      } catch (e) {
        if (!flags.has('f')) await ctx.error(`cannot access ${q(path)}: ${errText(e)}`);
        status = 1;
        return;
      }
      const before = node.mode & 0o7777;
      const after = parseMode(modeArg!, before, ctx.umask, node.type === 'dir')!;
      try {
        ctx.fs.chmod(path, after);
      } catch (e) {
        if (!flags.has('f')) await ctx.error(`changing permissions of ${q(path)}: ${errText(e)}`);
        status = 1;
        return;
      }
      const o = (n: number) => n.toString(8).padStart(4, '0');
      if (flags.has('v') || (flags.has('c') && before !== after)) {
        if (before === after) await ctx.out(`mode of ${q(path)} retained as ${o(after)} (${modeDesc(after)})\n`);
        else await ctx.out(`mode of ${q(path)} changed from ${o(before)} (${modeDesc(before)}) to ${o(after)} (${modeDesc(after)})\n`);
      }
      if (flags.has('R') && node.type === 'dir') {
        let names: string[] = [];
        try {
          names = ctx.fs.readdir(path);
        } catch (e) {
          await ctx.error(`cannot read directory ${q(path)}: ${errText(e)}`);
          status = 1;
        }
        for (const n of names) {
          const child = path.replace(/\/+$/, '') + '/' + n;
          const cn = ctx.fs.tryStat(child, false);
          if (cn?.type === 'symlink') continue;
          await apply(child);
        }
      }
    };
    for (const p of rest) await apply(p);
    return status;
  },
});

async function chownLike(ctx: CommandContext, groupOnly: boolean): Promise<number> {
  const opts = await getopts(ctx, { short: 'cfhvR', long: { changes: 'c', silent: 'f', quiet: 'f', verbose: 'v', recursive: 'R', 'no-dereference': 'h', reference: { key: 'reference', arg: 'required' } } });
  if (!opts) return 1;
  const ops = opts.operands;
  if (ops.length === 0) return missingOperand(ctx);
  if (ops.length === 1) return missingOperand(ctx, `missing operand after ${ql(ops[0])}`);
  const spec = ops[0];
  const sys = ctx.system;
  let uid: number | null = null;
  let gid: number | null = null;
  if (groupOnly) {
    const g = /^\d+$/.test(spec) ? sys.groupByGid(+spec) : sys.groupByName(spec);
    if (!g) {
      await ctx.error(`invalid group: ${ql(spec)}`);
      return 1;
    }
    gid = g.gid;
  } else {
    const m = /^([^:.]*)(?:[:.](.*))?$/.exec(spec)!;
    if (m[1]) {
      const u = /^\d+$/.test(m[1]) ? sys.userByUid(+m[1]) ?? { uid: +m[1], gid: +m[1] } : sys.userByName(m[1]);
      if (!u) {
        await ctx.error(`invalid user: ${ql(spec)}`);
        return 1;
      }
      uid = u.uid;
      if (m[2] === '') gid = u.gid;
    }
    if (m[2]) {
      const g = /^\d+$/.test(m[2]) ? sys.groupByGid(+m[2]) ?? { gid: +m[2] } : sys.groupByName(m[2]);
      if (!g) {
        await ctx.error(`invalid group: ${ql(spec)}`);
        return 1;
      }
      gid = g.gid;
    }
  }
  let status = 0;
  const apply = async (path: string): Promise<void> => {
    let node: Inode;
    try {
      node = ctx.fs.stat(path);
    } catch (e) {
      if (!opts.has('f')) await ctx.error(`cannot access ${q(path)}: ${errText(e)}`);
      status = 1;
      return;
    }
    try {
      ctx.fs.chown(path, uid, gid);
      if (opts.has('v')) {
        const what = groupOnly ? `group of ${q(path)}` : `ownership of ${q(path)}`;
        await ctx.out(`changed ${what} to ${groupOnly ? sys.groupName(gid!) : `${sys.userName(uid ?? node.uid)}${gid !== null ? ':' + sys.groupName(gid) : ''}`}\n`);
      }
    } catch (e) {
      if (!opts.has('f')) await ctx.error(`changing ${groupOnly ? 'group' : 'ownership'} of ${q(path)}: ${errText(e)}`);
      status = 1;
      return;
    }
    if (opts.has('R') && node.type === 'dir') {
      for (const n of ctx.fs.readdir(path)) await apply(path.replace(/\/+$/, '') + '/' + n);
    }
  };
  for (const p of ops.slice(1)) await apply(p);
  return status;
}

defineCommand({
  name: 'chown',
  pkg: 'coreutils',
  size: 72192,
  doc: {
    category: 'permissions',
    summary: 'change file owner and group',
    synopsis: ['chown [OPTION]... [OWNER][:[GROUP]] FILE...'],
    description: 'This manual page documents the GNU version of chown. chown changes the user and/or group ownership of each given file. Only the superuser (root) can give a file away to another user.',
    options: [
      { flags: '-R, --recursive', desc: 'operate on files and directories recursively' },
      { flags: '-v, --verbose', desc: 'output a diagnostic for every file processed' },
    ],
    examples: [{ cmd: 'sudo chown learner:learner file.txt', desc: 'Make learner the owner of file.txt.' }],
    seeAlso: ['chmod', 'chgrp'],
  },
  run: (ctx) => chownLike(ctx, false),
});

defineCommand({
  name: 'chgrp',
  pkg: 'coreutils',
  size: 68112,
  doc: {
    category: 'permissions',
    summary: 'change group ownership',
    synopsis: ['chgrp [OPTION]... GROUP FILE...'],
    description: 'Change the group of each FILE to GROUP.',
    options: [{ flags: '-R, --recursive', desc: 'operate on files and directories recursively' }],
    seeAlso: ['chown', 'chmod'],
  },
  run: (ctx) => chownLike(ctx, true),
});

// ---------------------------------------------------------------------------
// stat

function statTime(t: number): string {
  const d = new Date(t);
  const ns = String((t % 1000) * 1000000 + 427611).padStart(9, '0').slice(0, 9);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${ns} ${tzOffset(d)}`;
}

defineCommand({
  name: 'stat',
  pkg: 'coreutils',
  size: 88632,
  doc: {
    category: 'files',
    summary: 'display file or file system status',
    synopsis: ['stat [OPTION]... FILE...'],
    description: 'Display file or file system status: size, permissions, owner and timestamps.',
    options: [
      { flags: '-c  --format=FORMAT', desc: 'use the specified FORMAT instead of the default; %n name, %s size, %a octal permissions, %A human permissions, %U owner, %G group, %y modification time' },
      { flags: '-L, --dereference', desc: 'follow links' },
    ],
    examples: [
      { cmd: 'stat notes.txt', desc: 'Show everything the system knows about a file.' },
      { cmd: "stat -c '%a %n' *", desc: 'Show octal permissions for each file.' },
    ],
    seeAlso: ['ls', 'file'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'c:Lft', long: { format: { key: 'c', arg: 'required' }, printf: { key: 'printf', arg: 'required' }, dereference: 'L', terse: 't' } });
    if (!opts) return 1;
    if (opts.operands.length === 0) return missingOperand(ctx);
    const sys = ctx.system;
    let status = 0;
    for (const f of opts.operands) {
      let node: Inode;
      try {
        node = opts.has('L') ? ctx.fs.stat(f) : ctx.fs.lstat(f);
      } catch (e) {
        await ctx.error(`cannot statx ${q(f)}: ${errText(e)}`);
        status = 1;
        continue;
      }
      const size = inodeSize(node);
      const blocks = blocksFor(size, node.type === 'dir') * 2;
      const typeName = node.type === 'dir' ? 'directory' : node.type === 'symlink' ? 'symbolic link' : node.type === 'chardev' ? 'character special file' : size === 0 ? 'regular empty file' : 'regular file';
      const fmt = opts.get('c') ?? opts.get('printf');
      if (fmt !== undefined) {
        const out = fmt.replace(/%([%nNsaAuUgGFiybhxzwXYZ])/g, (_m, c: string) => {
          switch (c) {
            case '%': return '%';
            case 'n': return f;
            case 'N': return node.type === 'symlink' ? `'${f}' -> '${(node as { target: string }).target}'` : `'${f}'`;
            case 's': return String(size);
            case 'a': return (node.mode & 0o7777).toString(8);
            case 'A': return modeString(node);
            case 'u': return String(node.uid);
            case 'U': return sys.userName(node.uid);
            case 'g': return String(node.gid);
            case 'G': return sys.groupName(node.gid);
            case 'F': return typeName;
            case 'i': return String(node.ino);
            case 'h': return String(node.nlink);
            case 'b': return String(blocks);
            case 'y': return statTime(node.mtime);
            case 'x': return statTime(node.atime);
            case 'z': return statTime(node.ctime);
            case 'w': return statTime(node.ctime);
            case 'Y': return String(Math.floor(node.mtime / 1000));
            case 'X': return String(Math.floor(node.atime / 1000));
            case 'Z': return String(Math.floor(node.ctime / 1000));
          }
          return '';
        });
        await ctx.out(out + (opts.get('printf') !== undefined ? '' : '\n'));
        continue;
      }
      const nameLine = node.type === 'symlink' ? `${f} -> ${(node as { target: string }).target}` : f;
      const perm = `(${(node.mode & 0o7777).toString(8).padStart(4, '0')}/${modeString(node)})`;
      const uid = `( ${String(node.uid).padStart(4)}/${sys.userName(node.uid).padStart(8)})`;
      const gid = `( ${String(node.gid).padStart(4)}/${sys.groupName(node.gid).padStart(8)})`;
      let out = `  File: ${nameLine}\n`;
      out += `  Size: ${String(size).padEnd(10)}\tBlocks: ${String(blocks).padEnd(10)} IO Block: 4096   ${typeName}\n`;
      const dev = node.type === 'chardev' ? 'Device: 0,5\t' : 'Device: 8,1\t';
      out += `${dev}Inode: ${String(node.ino).padEnd(11)} Links: ${node.nlink}${node.type === 'chardev' ? '     Device type: 1,3' : ''}\n`;
      out += `Access: ${perm}  Uid: ${uid}   Gid: ${gid}\n`;
      out += `Access: ${statTime(node.atime)}\nModify: ${statTime(node.mtime)}\nChange: ${statTime(node.ctime)}\n Birth: ${statTime(Math.min(node.ctime, node.mtime))}\n`;
      await ctx.out(out);
    }
    return status;
  },
});

// ---------------------------------------------------------------------------
// file

export function describeFile(ctx: CommandContext, path: string, node: Inode): string {
  switch (node.type) {
    case 'dir':
      return (node.mode & 0o1000) && (node.mode & 0o002) ? 'sticky, directory' : 'directory';
    case 'symlink': {
      const target = ctx.fs.tryStat(path, true);
      return target ? `symbolic link to ${node.target}` : `broken symbolic link to ${node.target}`;
    }
    case 'chardev': {
      const minor = { null: 3, zero: 5, tty: 0, random: 8, stdin: 0, stdout: 1, stderr: 2 }[node.device];
      return `character special (${node.device === 'tty' ? 5 : 1}/${minor})`;
    }
  }
  const data = node.data;
  if (typeof data !== 'string') {
    if (data.kind === 'native') {
      return 'ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, BuildID[sha1]=' + hashHex(data.command) + ', for GNU/Linux 3.2.0, stripped';
    }
    return data.description;
  }
  if (data.length === 0) return 'empty';
  const exec = (node.mode & 0o111) !== 0;
  const first = data.split('\n', 1)[0];
  let charset = /[^\x00-\x7f]/.test(data) ? 'Unicode text, UTF-8 text' : 'ASCII text';
  if (/[\x00-\x08\x0e-\x1a\x1c-\x1f]/.test(data)) return 'data';
  const longLines = data.split('\n').some((l) => l.length > 300);
  if (longLines) charset += ', with very long lines';
  if (data.includes('\r\n')) charset += ', with CRLF line terminators';
  if (!data.endsWith('\n') && !data.includes('\n')) charset += ', with no line terminators';
  if (first.startsWith('#!')) {
    const interp = first.slice(2).trim();
    let kind = 'a ' + interp.split(/\s+/)[0] + ' script';
    if (/\bbash\b/.test(interp)) kind = 'Bourne-Again shell script';
    else if (/\bsh\b/.test(interp)) kind = 'POSIX shell script';
    else if (/python/.test(interp)) kind = 'Python script';
    else if (/node/.test(interp)) kind = 'Node.js script';
    return `${kind}, ${charset} executable`;
  }
  const lower = path.toLowerCase();
  if (lower.endsWith('.json') && /^\s*[[{]/.test(data)) return 'JSON text data';
  if (lower.endsWith('.html') || /^\s*<!doctype html/i.test(data)) return `HTML document, ${charset}`;
  if (lower.endsWith('.csv')) return `CSV text`;
  if (lower.endsWith('.py')) return `Python script, ${charset}${exec ? ' executable' : ''}`;
  if (lower.endsWith('.md')) return charset;
  return charset + (exec ? ' executable' : '');
}

function hashHex(s: string): string {
  let h1 = 0x811c9dc5;
  let out = '';
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < s.length; i++) h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h1 = Math.imul(h1 ^ round, 2246822519) >>> 0;
    out += h1.toString(16).padStart(8, '0');
  }
  return out;
}

defineCommand({
  name: 'file',
  pkg: 'file',
  size: 26952,
  doc: {
    category: 'files',
    summary: 'determine file type',
    synopsis: ['file [-bLz] [file ...]'],
    description: 'file tests each argument in an attempt to classify it: text, executable, directory, image, archive and so on. Unlike Windows, Linux does not rely on file name extensions to know what a file contains.',
    options: [
      { flags: '-b, --brief', desc: 'Do not prepend filenames to output lines (brief mode).' },
      { flags: '-L, --dereference', desc: 'Follow symlinks.' },
    ],
    examples: [{ cmd: 'file *', desc: 'Describe every file in the current directory.' }],
    seeAlso: ['stat', 'ls'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'bLhiz', long: { brief: 'b', dereference: 'L', 'no-dereference': 'h', mime: 'i' } });
    if (!opts) return 1;
    const files = opts.operands;
    if (files.length === 0) {
      await ctx.err('Usage: file [-bcdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]\n            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]\n            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]\n            <file> ...\n       file -C [-m <magicfiles>]\n       file [--help]\n');
      return 1;
    }
    const width = Math.max(...files.map((f) => f.length)) + 1;
    for (const f of files) {
      const label = opts.has('b') ? '' : (f + ':').padEnd(width + 1);
      const node = opts.has('L') ? ctx.fs.tryStat(f) : ctx.fs.tryStat(f, false);
      if (!node) {
        await ctx.out(`${label}cannot open \`${f}' (No such file or directory)\n`);
        continue;
      }
      let desc: string;
      try {
        desc = describeFile(ctx, f, node);
      } catch (e) {
        desc = `cannot open \`${f}' (${errText(e)})`;
      }
      if (node.type === 'file' && !ctx.fs.canAccess(node, 4)) desc = `regular file, no read permission`;
      await ctx.out(`${label}${desc}\n`);
    }
    return 0;
  },
});

// ---------------------------------------------------------------------------
// path utilities

defineCommand({
  name: 'basename',
  pkg: 'coreutils',
  size: 35592,
  doc: {
    category: 'files',
    summary: 'strip directory and suffix from filenames',
    synopsis: ['basename NAME [SUFFIX]', 'basename OPTION... NAME...'],
    description: 'Print NAME with any leading directory components removed. If specified, also remove a trailing SUFFIX.',
    options: [
      { flags: '-a, --multiple', desc: 'support multiple arguments and treat each as a NAME' },
      { flags: '-s, --suffix=SUFFIX', desc: 'remove a trailing SUFFIX; implies -a' },
    ],
    examples: [
      { cmd: 'basename /home/learner/notes.txt', desc: 'Prints notes.txt' },
      { cmd: 'basename notes.txt .txt', desc: 'Prints notes' },
    ],
    seeAlso: ['dirname', 'realpath'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'as:z', long: { multiple: 'a', suffix: { key: 's', arg: 'required' }, zero: 'z' } });
    if (!opts) return 1;
    const ops = opts.operands;
    if (ops.length === 0) return missingOperand(ctx);
    const multiple = opts.has('a') || opts.has('s');
    if (!multiple && ops.length > 2) {
      await ctx.error(`extra operand ${q(ops[2])}`);
      await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
      return 1;
    }
    const suffix = opts.get('s') ?? (!multiple ? ops[1] : undefined);
    const names = multiple ? ops : [ops[0]];
    let out = '';
    for (const n of names) {
      let b = basename(n);
      if (suffix && b !== suffix && b.endsWith(suffix)) b = b.slice(0, -suffix.length);
      out += b + (opts.has('z') ? '\0' : '\n');
    }
    await ctx.out(out);
    return 0;
  },
});

defineCommand({
  name: 'dirname',
  pkg: 'coreutils',
  size: 35464,
  doc: {
    category: 'files',
    summary: 'strip last component from file name',
    synopsis: ['dirname [OPTION] NAME...'],
    description: "Output each NAME with its last non-slash component and trailing slashes removed; if NAME contains no /'s, output '.' (meaning the current directory).",
    examples: [{ cmd: 'dirname /home/learner/notes.txt', desc: 'Prints /home/learner' }],
    seeAlso: ['basename', 'realpath'],
  },
  run: async (ctx) => {
    const ops = ctx.args.filter((a) => a !== '--');
    if (ops.length === 0) return missingOperand(ctx);
    await ctx.out(ops.map((o) => dirname(o) + '\n').join(''));
    return 0;
  },
});

defineCommand({
  name: 'realpath',
  pkg: 'coreutils',
  size: 51048,
  doc: {
    category: 'files',
    summary: 'print the resolved path',
    synopsis: ['realpath [OPTION]... FILE...'],
    description: 'Print the resolved absolute file name; all but the last component must exist.',
    options: [
      { flags: '-e, --canonicalize-existing', desc: 'all components of the path must exist' },
      { flags: '-m, --canonicalize-missing', desc: 'no path components need exist or be a directory' },
      { flags: '-s, --strip, --no-symlinks', desc: "don't expand symlinks" },
    ],
    examples: [{ cmd: 'realpath ../notes.txt', desc: 'Show the full path of a file.' }],
    seeAlso: ['readlink', 'pwd'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'emqsLPz', long: { 'canonicalize-existing': 'e', 'canonicalize-missing': 'm', quiet: 'q', strip: 's', 'no-symlinks': 's' } });
    if (!opts) return 1;
    if (opts.operands.length === 0) return missingOperand(ctx);
    let status = 0;
    for (const f of opts.operands) {
      const abs = ctx.fs.abs(f);
      if (opts.has('s') || opts.has('m')) {
        await ctx.out(abs + '\n');
        continue;
      }
      try {
        await ctx.out(ctx.fs.realpath(f) + '\n');
      } catch (e) {
        const parent = dirname(abs);
        if (!opts.has('e') && e instanceof FsError && e.code === 'ENOENT' && ctx.fs.isDir(parent)) {
          await ctx.out(ctx.fs.realpath(parent).replace(/\/$/, '') + '/' + basename(abs) + '\n');
          continue;
        }
        if (!opts.has('q')) await ctx.error(`${qf(f)}: ${errText(e)}`);
        status = 1;
      }
    }
    return status;
  },
});

defineCommand({
  name: 'readlink',
  pkg: 'coreutils',
  size: 51048,
  doc: {
    category: 'files',
    summary: 'print resolved symbolic links or canonical file names',
    synopsis: ['readlink [OPTION]... FILE...'],
    description: 'Print value of a symbolic link or canonical file name.',
    options: [{ flags: '-f, --canonicalize', desc: 'canonicalize by following every symlink in every component of the given name recursively' }],
    seeAlso: ['realpath', 'ln'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'femnqsvz', long: { canonicalize: 'f', 'canonicalize-existing': 'e', 'canonicalize-missing': 'm', 'no-newline': 'n', verbose: 'v' } });
    if (!opts) return 1;
    if (opts.operands.length === 0) return missingOperand(ctx);
    let status = 0;
    for (const f of opts.operands) {
      try {
        const v = opts.has('f') || opts.has('e') || opts.has('m') ? ctx.fs.realpath(f) : ctx.fs.readlink(f);
        await ctx.out(v + (opts.has('n') ? '' : '\n'));
      } catch (e) {
        if (opts.has('m') || (opts.has('f') && e instanceof FsError && e.code === 'ENOENT')) {
          await ctx.out(ctx.fs.abs(f) + '\n');
          continue;
        }
        if (opts.has('v')) await ctx.error(`${f}: ${errText(e)}`);
        status = 1;
      }
    }
    return status;
  },
});

defineCommand({
  name: 'pwd',
  pkg: 'coreutils',
  size: 35464,
  doc: {
    category: 'navigation',
    summary: 'print name of current/working directory',
    synopsis: ['pwd [OPTION]...'],
    description: 'Print the full filename of the current working directory.\n\nNOTE: your shell may have its own version of pwd, which usually supersedes the version described here.',
    options: [
      { flags: '-L, --logical', desc: 'use PWD from environment, even if it contains symlinks' },
      { flags: '-P, --physical', desc: 'avoid all symlinks' },
    ],
    examples: [{ cmd: 'pwd', desc: 'Show where you are in the filesystem.' }],
    seeAlso: ['cd', 'ls'],
  },
  run: async (ctx) => {
    const logical = ctx.args.includes('-L') || ctx.args.includes('--logical');
    if (logical) {
      const p = ctx.env.get('PWD');
      if (p && p.startsWith('/')) {
        await ctx.out(p + '\n');
        return 0;
      }
    }
    try {
      await ctx.out(ctx.fs.realpath(ctx.cwd) + '\n');
      return 0;
    } catch {
      await ctx.error("couldn't find directory entry in '..' with matching inode");
      return 1;
    }
  },
});

// ---------------------------------------------------------------------------
// du / df

defineCommand({
  name: 'du',
  pkg: 'coreutils',
  size: 106072,
  doc: {
    category: 'system',
    summary: 'estimate file space usage',
    synopsis: ['du [OPTION]... [FILE]...'],
    description: 'Summarize device usage of the set of FILEs, recursively for directories.',
    options: [
      { flags: '-a, --all', desc: 'write counts for all files, not just directories' },
      { flags: '-c, --total', desc: 'produce a grand total' },
      { flags: '-d, --max-depth=N', desc: 'print the total for a directory only if it is N or fewer levels below the command line argument' },
      { flags: '-h, --human-readable', desc: 'print sizes in human readable format (e.g., 1K 234M 2G)' },
      { flags: '-s, --summarize', desc: 'display only a total for each argument' },
    ],
    examples: [
      { cmd: 'du -sh Documents', desc: 'How big is the Documents folder?' },
      { cmd: 'du -h --max-depth=1', desc: 'Size of each folder here.' },
    ],
    seeAlso: ['df', 'ls'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'abcd:hksSx', long: { all: 'a', total: 'c', 'max-depth': { key: 'd', arg: 'required' }, 'human-readable': 'h', summarize: 's', bytes: 'b' } });
    if (!opts) return 1;
    const human = opts.has('h');
    const fmt = (blocks: number) => (opts.has('b') ? String(blocks) : human ? (blocks === 0 ? '0' : humanSize(blocks * 1024)) : String(blocks));
    const maxDepth = opts.has('s') ? 0 : opts.get('d') !== undefined ? parseInt(opts.get('d')!, 10) : Infinity;
    const roots = opts.operands.length ? opts.operands : ['.'];
    let out = '';
    let grand = 0;
    let status = 0;
    const seen = new Set<number>();
    const walk = async (path: string, depth: number): Promise<number> => {
      await ctx.checkpoint();
      let node: Inode;
      try {
        node = ctx.fs.lstat(path);
      } catch (e) {
        await ctx.error(`cannot access ${q(path)}: ${errText(e)}`);
        status = 1;
        return 0;
      }
      if (seen.has(node.ino)) return 0;
      seen.add(node.ino);
      if (node.type !== 'dir') {
        const b = opts.has('b') ? inodeSize(node) : blocksFor(inodeSize(node));
        if (opts.has('a') && depth <= maxDepth) out += `${fmt(b)}\t${path}\n`;
        return b;
      }
      let total = opts.has('b') ? 4096 : 4;
      let names: string[] = [];
      try {
        names = ctx.fs.readdir(path);
      } catch (e) {
        await ctx.error(`cannot read directory ${q(path)}: ${errText(e)}`);
        status = 1;
      }
      for (const n of names) total += await walk(path === '/' ? '/' + n : path.replace(/\/+$/, '') + '/' + n, depth + 1);
      if (depth <= maxDepth) out += `${fmt(total)}\t${path}\n`;
      if (out.length > 16384) {
        await ctx.out(out);
        out = '';
      }
      return total;
    };
    for (const r of roots) grand += await walk(r, 0);
    if (opts.has('c')) out += `${fmt(grand)}\ttotal\n`;
    await ctx.out(out);
    return status;
  },
});

defineCommand({
  name: 'df',
  pkg: 'coreutils',
  size: 101496,
  doc: {
    category: 'system',
    summary: 'report file system space usage',
    synopsis: ['df [OPTION]... [FILE]...'],
    description: 'Show information about the file system on which each FILE resides, or all file systems by default.',
    options: [
      { flags: '-h, --human-readable', desc: 'print sizes in powers of 1024 (e.g., 1023M)' },
      { flags: '-T, --print-type', desc: 'print file system type' },
    ],
    examples: [{ cmd: 'df -h', desc: 'How much disk space is free?' }],
    seeAlso: ['du', 'free'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'ahHiklPTt:x:', long: { 'human-readable': 'h', si: 'H', 'print-type': 'T', all: 'a' } });
    if (!opts) return 1;
    const usedRoot = 9876212 + Math.ceil(ctx.system.fs.usedBytes / 1024);
    const rows: [string, string, number, number, string][] = [
      ['tmpfs', 'tmpfs', 402300, 1520, '/run'],
      ['/dev/sda1', 'ext4', 30298176, usedRoot, '/'],
      ['tmpfs', 'tmpfs', 2011488, 0, '/dev/shm'],
      ['tmpfs', 'tmpfs', 5120, 4, '/run/lock'],
      ['/dev/sda15', 'vfat', 106858, 6186, '/boot/efi'],
      ['tmpfs', 'tmpfs', 402296, 96, '/run/user/1000'],
    ];
    const human = opts.has('h') || opts.has('H');
    const fmt = (kb: number) => (human ? (kb === 0 ? '0' : humanSize(kb * 1024, opts.has('H'))) : String(kb));
    const table: string[][] = [[ 'Filesystem', ...(opts.has('T') ? ['Type'] : []), human ? 'Size' : '1K-blocks', 'Used', human ? 'Avail' : 'Available', 'Use%', 'Mounted on']];
    let list = rows;
    if (opts.operands.length) {
      list = [];
      for (const f of opts.operands) {
        if (!ctx.fs.exists(f)) {
          await ctx.error(`${f}: No such file or directory`);
          continue;
        }
        const abs = ctx.fs.abs(f);
        const best = [...rows].filter((r) => abs === r[4] || abs.startsWith(r[4] === '/' ? '/' : r[4] + '/')).sort((a, b) => b[4].length - a[4].length)[0];
        if (best) list.push(best);
      }
    }
    for (const [fs, type, size, used, mnt] of list) {
      const avail = Math.max(0, Math.floor(size * 0.95) - used);
      const pct = size === 0 ? '-' : `${Math.ceil((used / (used + avail || 1)) * 100)}%`;
      table.push([fs, ...(opts.has('T') ? [type] : []), fmt(size), fmt(used), fmt(avail), pct, mnt]);
    }
    const widths = table[0].map((_, c) => Math.max(...table.map((r) => r[c].length)));
    let out = '';
    for (const r of table) {
      out += r
        .map((cell, c) => {
          if (c === r.length - 1) return cell;
          const isNum = c > 0 && !(opts.has('T') && c === 1);
          const w = c === 0 ? Math.max(widths[0], 14) : widths[c];
          return isNum ? cell.padStart(w) : cell.padEnd(w);
        })
        .join(' ') + '\n';
    }
    await ctx.out(out);
    return 0;
  },
});

// ---------------------------------------------------------------------------
// small file utilities

defineCommand({
  name: 'truncate',
  pkg: 'coreutils',
  size: 39432,
  doc: {
    category: 'files',
    summary: 'shrink or extend the size of a file to the specified size',
    synopsis: ['truncate OPTION... FILE...'],
    description: 'Shrink or extend the size of each FILE to the specified size. A FILE argument that does not exist is created.',
    options: [{ flags: '-s, --size=SIZE', desc: 'set or adjust the file size by SIZE bytes' }],
    seeAlso: ['dd'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'cors:', long: { size: { key: 's', arg: 'required' }, 'no-create': 'c' } });
    if (!opts) return 1;
    const spec = opts.get('s');
    if (spec === undefined) {
      await ctx.error('you must specify either --size or --reference');
      await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
      return 1;
    }
    let status = 0;
    for (const f of opts.operands) {
      try {
        const existing = ctx.fs.tryStat(f);
        if (!existing && opts.has('c')) continue;
        const cur = existing && existing.type === 'file' && typeof existing.data === 'string' ? existing.data : '';
        const m = /^([+-]?)(\d+)([KMG]?)$/.exec(spec);
        if (!m) {
          await ctx.error(`Invalid number: ${ql(spec)}`);
          return 1;
        }
        const n = parseInt(m[2], 10) * ({ '': 1, K: 1024, M: 1048576, G: 1073741824 }[m[3]] ?? 1);
        const target = m[1] === '+' ? cur.length + n : m[1] === '-' ? Math.max(0, cur.length - n) : n;
        const next = target <= cur.length ? cur.slice(0, target) : cur + '\0'.repeat(target - cur.length);
        ctx.fs.writeFile(f, next);
      } catch (e) {
        await ctx.error(`cannot open ${q(f)} for writing: ${errText(e)}`);
        status = 1;
      }
    }
    return status;
  },
});

defineCommand({
  name: 'mktemp',
  pkg: 'coreutils',
  size: 43656,
  doc: {
    category: 'files',
    summary: 'create a temporary file or directory',
    synopsis: ['mktemp [OPTION]... [TEMPLATE]'],
    description: 'Create a temporary file or directory, safely, and print its name. TEMPLATE must contain at least 3 consecutive \'X\'s in last component. If TEMPLATE is not specified, use tmp.XXXXXXXXXX, and --tmpdir is implied.',
    options: [{ flags: '-d, --directory', desc: 'create a directory, not a file' }],
    seeAlso: ['touch', 'mkdir'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'dqtup:', long: { directory: 'd', quiet: 'q', tmpdir: { key: 'p', arg: 'optional' }, 'dry-run': 'u' } });
    if (!opts) return 1;
    let template = opts.operands[0] ?? 'tmp.XXXXXXXXXX';
    const useTmp = !opts.operands[0] || opts.has('p') || opts.has('t');
    if (useTmp && !template.includes('/')) template = (typeof opts.flags.get('p') === 'string' ? opts.get('p')! : ctx.env.get('TMPDIR') ?? '/tmp') + '/' + template;
    const m = /X{3,}$/.exec(template);
    if (!m) {
      await ctx.error(`too few X's in template ${q(template)}`);
      return 1;
    }
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let name = '';
    for (let tries = 0; tries < 100; tries++) {
      let rnd = '';
      for (let i = 0; i < m[0].length; i++) rnd += chars[Math.floor(ctx.system.random() * chars.length)];
      name = template.slice(0, m.index) + rnd;
      if (!ctx.fs.tryStat(name)) break;
    }
    try {
      if (!opts.has('u')) {
        if (opts.has('d')) {
          ctx.fs.mkdir(name, 0o700);
          ctx.fs.chmod(name, 0o700);
        } else {
          ctx.fs.writeFile(name, '');
          ctx.fs.chmod(name, 0o600);
        }
      }
    } catch (e) {
      await ctx.error(`failed to create ${opts.has('d') ? 'directory' : 'file'} via template ${q(template)}: ${errText(e)}`);
      return 1;
    }
    await ctx.out(name + '\n');
    return 0;
  },
});

defineCommand({
  name: 'unlink',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'files', summary: 'call the unlink function to remove the specified file', synopsis: ['unlink FILE'], description: 'Call the unlink function to remove the specified FILE.', seeAlso: ['rm'] },
  run: async (ctx) => {
    if (ctx.args.length !== 1) return missingOperand(ctx);
    try {
      ctx.fs.unlink(ctx.args[0]);
      return 0;
    } catch (e) {
      await ctx.error(`cannot unlink ${q(ctx.args[0])}: ${errText(e)}`);
      return 1;
    }
  },
});

defineCommand({
  name: 'link',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'files', summary: 'call the link function to create a link to a file', synopsis: ['link FILE1 FILE2'], description: 'Call the link function to create a link named FILE2 to an existing FILE1.', seeAlso: ['ln'] },
  run: async (ctx) => {
    if (ctx.args.length !== 2) return missingOperand(ctx);
    try {
      ctx.fs.link(ctx.args[0], ctx.args[1]);
      return 0;
    } catch (e) {
      await ctx.error(`cannot create link ${q(ctx.args[1])} to ${q(ctx.args[0])}: ${errText(e)}`);
      return 1;
    }
  },
});

defineCommand({
  name: 'sync',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'system', summary: 'Synchronize cached writes to persistent storage', synopsis: ['sync [OPTION] [FILE]...'], description: 'Synchronize cached writes to persistent storage.' },
  run: async () => 0,
});
