// `test` / `[` and the file/string/number checks shared with `[[ ]]`.

import { evaluateArithmetic } from '../arith';
import type { Shell } from '../interpreter';
import { VirtualFS } from '../vfs/fs';
import { defineBuiltin, type BuiltinContext } from './registry';

function intArg(s: string): number | null {
  const t = s.trim();
  if (!/^[-+]?\d+$/.test(t)) return null;
  return parseInt(t, 10);
}

export class TestSyntaxError extends Error {}

export function unaryTest(sh: Shell, op: string, arg: string): boolean {
  const fs = sh.system.fs;
  const ctx = sh.opCtx();
  switch (op) {
    case '-z':
      return arg === '';
    case '-n':
      return arg !== '';
    case '-v': {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\[(.+)\]$/s.exec(arg);
      if (!m) return sh.state.isSet(arg);
      const [, name, sub] = m;
      if (sub === '@' || sub === '*') return sh.state.entries(name).length > 0;
      try {
        const key = sh.state.isAssoc(name) ? sub : evaluateArithmetic(sub, sh.arithEnv());
        return (sh.state.getElement(name, key) ?? undefined) !== undefined;
      } catch {
        return false;
      }
    }
    case '-o':
      return false;
    case '-t':
      return false;
  }
  if (arg === '') return false;
  const follow = op !== '-L' && op !== '-h';
  const node = fs.tryStat(arg, ctx, follow);
  switch (op) {
    case '-e':
    case '-a':
      return node !== null;
    case '-f':
      return node?.type === 'file';
    case '-d':
      return node?.type === 'dir';
    case '-L':
    case '-h':
      return node?.type === 'symlink';
    case '-c':
      return node?.type === 'chardev';
    case '-b':
    case '-p':
    case '-S':
      return false;
    case '-s':
      return node !== null && node.type === 'file' && (typeof node.data === 'string' ? node.data.length > 0 : node.data.size > 0);
    case '-r':
      return node !== null && VirtualFS.canAccess(node, ctx.creds, 4);
    case '-w':
      return node !== null && VirtualFS.canAccess(node, ctx.creds, 2);
    case '-x':
      return node !== null && VirtualFS.canAccess(node, ctx.creds, 1);
    case '-O':
      return node !== null && node.uid === ctx.creds.uid;
    case '-G':
      return node !== null && node.gid === ctx.creds.gid;
    case '-u':
      return node !== null && (node.mode & 0o4000) !== 0;
    case '-g':
      return node !== null && (node.mode & 0o2000) !== 0;
    case '-k':
      return node !== null && (node.mode & 0o1000) !== 0;
    case '-N':
      return node !== null && node.mtime > node.atime;
  }
  throw new TestSyntaxError(`${op}: unary operator expected`);
}

export function binaryTest(sh: Shell, op: string, a: string, b: string): boolean {
  switch (op) {
    case '=':
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
  }
  if (op === '-nt' || op === '-ot' || op === '-ef') {
    const fs = sh.system.fs;
    const ctx = sh.opCtx();
    const na = fs.tryStat(a, ctx);
    const nb = fs.tryStat(b, ctx);
    if (op === '-ef') return na !== null && na === nb;
    if (op === '-nt') return na !== null && (nb === null || na.mtime > nb.mtime);
    return nb !== null && (na === null || na.mtime < nb.mtime);
  }
  const x = intArg(a);
  const y = intArg(b);
  if (['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(op)) {
    if (x === null) throw new TestSyntaxError(`${a}: integer expression expected`);
    if (y === null) throw new TestSyntaxError(`${b}: integer expression expected`);
    switch (op) {
      case '-eq':
        return x === y;
      case '-ne':
        return x !== y;
      case '-lt':
        return x < y;
      case '-le':
        return x <= y;
      case '-gt':
        return x > y;
      case '-ge':
        return x >= y;
    }
  }
  throw new TestSyntaxError(`${op}: binary operator expected`);
}

const UNARY = new Set([
  '-a', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-k', '-p', '-r', '-s', '-t', '-u', '-w', '-x', '-G', '-L', '-N',
  '-O', '-S', '-z', '-n', '-v', '-o',
]);
const BINARY = new Set(['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);

/** Evaluate `test` arguments (POSIX rules for 0-4 args, then a recursive parser). */
export function evalTestArgs(sh: Shell, args: string[]): boolean {
  let i = 0;
  const peek = () => args[i];
  const parseOr = (): boolean => {
    let v = parseAnd();
    while (peek() === '-o') {
      i++;
      const r = parseAnd();
      v = v || r;
    }
    return v;
  };
  const parseAnd = (): boolean => {
    let v = parseNot();
    while (peek() === '-a') {
      i++;
      const r = parseNot();
      v = v && r;
    }
    return v;
  };
  const parseNot = (): boolean => {
    if (peek() === '!' && i + 1 < args.length) {
      i++;
      return !parseNot();
    }
    return parsePrimary();
  };
  const parsePrimary = (): boolean => {
    const a = args[i];
    if (a === undefined) throw new TestSyntaxError('argument expected');
    if (a === '(' ) {
      i++;
      const v = parseOr();
      if (args[i] !== ')') throw new TestSyntaxError(`\`)' expected`);
      i++;
      return v;
    }
    if (i + 2 < args.length + 0 && BINARY.has(args[i + 1]) && args[i + 2] !== undefined) {
      const v = binaryTest(sh, args[i + 1], a, args[i + 2]);
      i += 3;
      return v;
    }
    if (UNARY.has(a) && args[i + 1] !== undefined) {
      const v = unaryTest(sh, a, args[i + 1]);
      i += 2;
      return v;
    }
    i++;
    return a !== '';
  };
  // POSIX special cases
  if (args.length === 0) return false;
  if (args.length === 1) return args[0] !== '';
  if (args.length === 2) {
    if (args[0] === '!') return args[1] === '';
    if (UNARY.has(args[0])) return unaryTest(sh, args[0], args[1]);
    throw new TestSyntaxError(`${args[0]}: unary operator expected`);
  }
  if (args.length === 3) {
    if (BINARY.has(args[1])) return binaryTest(sh, args[1], args[0], args[2]);
    if (args[0] === '!') return !evalTestArgs(sh, args.slice(1));
    if (args[0] === '(' && args[2] === ')') return args[1] !== '';
    if (args[1] === '-a') return args[0] !== '' && args[2] !== '';
    if (args[1] === '-o') return args[0] !== '' || args[2] !== '';
    throw new TestSyntaxError(`${args[1]}: binary operator expected`);
  }
  const v = parseOr();
  if (i < args.length) throw new TestSyntaxError('too many arguments');
  return v;
}

async function runTest(ctx: BuiltinContext, bracket: boolean): Promise<number> {
  let args = ctx.args;
  if (bracket) {
    if (args[args.length - 1] !== ']') {
      await ctx.error("missing `]'");
      return 2;
    }
    args = args.slice(0, -1);
  }
  try {
    return evalTestArgs(ctx.sh, args) ? 0 : 1;
  } catch (e) {
    if (e instanceof TestSyntaxError) {
      await ctx.error(e.message);
      return 2;
    }
    throw e;
  }
}

defineBuiltin(
  'test',
  {
    usage: 'test [expr]',
    summary: 'Evaluate conditional expression.',
    body:
      'Exits with a status of 0 (true) or 1 (false) depending on the evaluation of EXPR.\n\n' +
      'File operators:\n  -e FILE        True if file exists.\n  -f FILE        True if file exists and is a regular file.\n' +
      '  -d FILE        True if file is a directory.\n  -r FILE        True if file is readable by you.\n' +
      '  -w FILE        True if the file is writable by you.\n  -x FILE        True if the file is executable by you.\n' +
      '  -s FILE        True if file exists and is not empty.\n\nString operators:\n  -z STRING      True if string is empty.\n' +
      '  -n STRING      True if string is not empty.\n  STRING1 = STRING2   True if the strings are equal.\n' +
      '  STRING1 != STRING2  True if the strings are not equal.\n\nArithmetic: arg1 OP arg2 where OP is one of -eq, -ne, -lt, -le, -gt, or -ge.',
  },
  (ctx) => runTest(ctx, false),
);

defineBuiltin(
  '[',
  { usage: '[ arg... ]', summary: 'Evaluate conditional expression.', body: 'This is a synonym for the "test" builtin, but the last argument must be a literal `]\', to match the opening `[\'.' },
  (ctx) => runTest(ctx, true),
);
