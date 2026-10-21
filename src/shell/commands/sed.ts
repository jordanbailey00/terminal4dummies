// GNU sed 4.9 — the stream editor — plus a POSIX regular expression
// translator shared with awk.

import { CaptureOutput, type InputStream, type OutputStream } from '../streams';
import type { CommandContext } from '../types';
import { FsError } from '../vfs/fs';
import { basename, dirname } from '../vfs/path';
import { defineCommand, errText, parseOpts, OptError, type CommandDef } from './util';
import { openOutput } from './findutils';

// ---------------------------------------------------------------------------
// POSIX regular expressions -> JavaScript

export class PosixRegexError extends Error {}

export interface PosixRegexOptions {
  extended: boolean;
  /**
   * sed: GNU extensions, POSIX bracket semantics. awk: escapes everywhere, no
   * back-references. emacs: find's default syntax (\( \| groups, + and ?
   * operators, no intervals or character classes).
   */
  dialect: 'sed' | 'awk' | 'emacs';
  /** ERE: an unmatched ')' is an ordinary character (glibc RE_UNMATCHED_RIGHT_PAREN_ORD). */
  rparenOrd?: boolean;
}

export interface ConvertedRegex {
  source: string;
  groups: number;
}

const CLASS_RANGES: Record<string, string> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: 'A-Za-z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  cntrl: '\\x00-\\x1f\\x7f',
  print: ' -~',
  graph: '!-~',
};

const SIMPLE_ESCAPES: Record<string, string> = { a: '\x07', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

function jsEscapeChar(c: string): string {
  if (/[\\^$.*+?()[\]{}|/]/.test(c)) return '\\' + c;
  if (c === '\n') return '\\n';
  if (c === '\r') return '\\r';
  if (c === '\t') return '\\t';
  const code = c.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return '\\x' + code.toString(16).padStart(2, '0');
  return c;
}

function jsClassChar(c: string): string {
  if (c === '\\' || c === ']' || c === '[' || c === '^' || c === '-') return '\\' + c;
  if (c === '\n') return '\\n';
  if (c === '\t') return '\\t';
  const code = c.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return '\\x' + code.toString(16).padStart(2, '0');
  return c;
}

/** awk escape sequence after a backslash at src[i] (the char after '\'). Returns [char, length]. */
function awkEscape(src: string, i: number): [string, number] {
  const c = src[i];
  if (c in SIMPLE_ESCAPES) return [SIMPLE_ESCAPES[c], 1];
  if (c === 'b') return ['\b', 1];
  if (/[0-7]/.test(c)) {
    const m = /^[0-7]{1,3}/.exec(src.slice(i))!;
    return [String.fromCharCode(parseInt(m[0], 8) & 255), m[0].length];
  }
  return [c, 1];
}

/**
 * Translate a POSIX BRE/ERE (with GNU extensions) into a JavaScript regular
 * expression source. Throws PosixRegexError with glibc's message on errors.
 */
export function convertPosixRegex(src: string, o: PosixRegexOptions): ConvertedRegex {
  const emacs = o.dialect === 'emacs';
  const ere = o.extended && !emacs;
  const awk = o.dialect === 'awk';
  const out: string[] = [];
  // index into `out` where the most recent atom starts; -1 when there is none
  let atom = -1;
  let quantified = false;
  let atStart = true;
  let groups = 0;
  const closed: number[] = [];
  const stack: { outIndex: number; num: number }[] = [];
  const err = (m: string): never => {
    throw new PosixRegexError(m);
  };
  const pushAtom = (s: string) => {
    atom = out.length;
    out.push(s);
    quantified = false;
    atStart = false;
  };
  const pushAnchor = (s: string) => {
    out.push(s);
    atom = -1;
    quantified = false;
  };
  const quantify = (q: string, literal: string) => {
    if (atom === -1) {
      if (!ere) {
        // BRE: a leading '*' is an ordinary character
        pushAtom(literal);
        return;
      }
      err(awk ? 'missing operand' : 'Invalid preceding regular expression');
    }
    if (quantified) {
      if (!ere && !awk && !emacs) err('Invalid preceding regular expression');
      const inner = out.splice(atom).join('');
      out.push('(?:' + inner + ')');
    }
    out.push(q);
    quantified = true;
    atStart = false;
  };
  const parseInterval = (i: number, close: string): { q: string; end: number } | null => {
    // src[i] is just after '{' (or '\{'); returns the quantifier and index after the close
    const rest = src.slice(i);
    const re = close === '}' ? /^(\d*)(,(\d*))?\}/ : /^(\d*)(,(\d*))?\\\}/;
    const m = re.exec(rest);
    if (!m) return null;
    if (m[1] === '' && m[2] === undefined) return null;
    const min = m[1] === '' ? 0 : parseInt(m[1], 10);
    const max = m[2] === undefined ? min : m[3] === '' ? Infinity : parseInt(m[3], 10);
    if (min > 32767 || (max !== Infinity && max > 32767)) err('Regular expression too big');
    if (max < min) err('Invalid content of \\{\\}');
    const q = max === Infinity ? `{${min},}` : max === min ? `{${min}}` : `{${min},${max}}`;
    return { q, end: i + m[0].length };
  };
  const bracket = (i: number): number => {
    // src[i] === '['
    let j = i + 1;
    let neg = false;
    if (src[j] === '^') {
      neg = true;
      j++;
    }
    let body = '';
    let first = true;
    let prev: string | null = null; // last single char added (for ranges)
    const readChar = (): string | null => {
      // read one element; returns a single char, or null if a class was consumed
      const c = src[j];
      if (c === '[' && !emacs && (src[j + 1] === ':' || src[j + 1] === '.' || src[j + 1] === '=')) {
        const kind = src[j + 1];
        const close = src.indexOf(kind + ']', j + 2);
        if (close === -1) err(awk ? 'bad class -- [], [^] or [' : 'Unmatched [, [^, [:, [., or [=');
        const name = src.slice(j + 2, close);
        j = close + 2;
        if (kind === ':') {
          const r = CLASS_RANGES[name];
          if (!r) err(awk ? 'bad class -- [], [^] or [' : 'Invalid character class name');
          body += r;
          return null;
        }
        if ([...name].length !== 1) err('Invalid collation character');
        return name;
      }
      if (c === '\\' && !emacs) {
        if (awk) {
          const [ch, len] = awkEscape(src, j + 1);
          if (j + 1 >= src.length) {
            j++;
            return '\\';
          }
          j += 1 + len;
          return ch;
        }
        const n = src[j + 1];
        if (n !== undefined && n in SIMPLE_ESCAPES) {
          j += 2;
          return SIMPLE_ESCAPES[n];
        }
        j++;
        return '\\';
      }
      j++;
      return c;
    };
    for (;;) {
      if (j >= src.length) err(awk ? 'bad class -- [], [^] or [' : emacs ? 'Invalid regular expression' : 'Unmatched [, [^, [:, [., or [=');
      const c = src[j];
      if (c === ']' && !first) break;
      first = false;
      const ch = readChar();
      if (ch === null) {
        prev = null;
        continue;
      }
      if (src[j] === '-' && src[j + 1] !== undefined && src[j + 1] !== ']') {
        j++;
        const end = readChar();
        if (end === null) err('Invalid range end');
        if (end!.charCodeAt(0) < ch.charCodeAt(0)) {
          if (emacs) continue; // an empty range matches nothing
          err('Invalid range end');
        }
        body += jsClassChar(ch) + '-' + jsClassChar(end!);
        prev = null;
        continue;
      }
      body += jsClassChar(ch);
      prev = ch;
    }
    void prev;
    pushAtom('[' + (neg ? '^' : '') + body + ']');
    return j + 1;
  };

  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '[') {
      i = bracket(i);
      continue;
    }
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) {
        if (awk) {
          pushAtom('\\\\');
          i++;
          continue;
        }
        err('Trailing backslash');
      }
      if (!ere && !awk) {
        if (n === '(') {
          stack.push({ outIndex: out.length, num: ++groups });
          out.push('(');
          atom = -1;
          quantified = false;
          atStart = true;
          i += 2;
          continue;
        }
        if (n === ')') {
          const g = stack.pop();
          if (!g) err('Unmatched ) or \\)');
          out.push(')');
          closed.push(g!.num);
          atom = g!.outIndex;
          quantified = false;
          atStart = false;
          i += 2;
          continue;
        }
        if (n === '|') {
          out.push('|');
          atom = -1;
          quantified = false;
          atStart = true;
          i += 2;
          continue;
        }
        if (emacs && (n === '{' || n === '}' || n === '+' || n === '?')) {
          pushAtom('\\' + n);
          i += 2;
          continue;
        }
        if (n === '{') {
          if (atom === -1) err('Invalid preceding regular expression');
          const iv = parseInterval(i + 2, '\\}');
          if (!iv) {
            if (src.indexOf('\\}', i + 2) === -1) err('Unmatched \\{');
            err('Invalid content of \\{\\}');
          }
          quantify(iv!.q, '');
          i = iv!.end;
          continue;
        }
        if (n === '}') err('Unmatched \\{');
        if (n === '+' || n === '?') {
          if (atom === -1) pushAtom('\\' + n);
          else quantify(n, '');
          i += 2;
          continue;
        }
      }
      if (!awk && /[1-9]/.test(n)) {
        const num = parseInt(n, 10);
        if (!closed.includes(num)) err('Invalid back reference');
        pushAtom('\\' + n);
        i += 2;
        continue;
      }
      if (!awk) {
        switch (n) {
          case 'w':
          case 'W':
          case 's':
          case 'S':
            pushAtom('\\' + n);
            i += 2;
            continue;
          case 'b':
          case 'B':
            pushAnchor('\\' + n);
            i += 2;
            continue;
          case '<':
            pushAnchor('\\b(?=\\w)');
            i += 2;
            continue;
          case '>':
            pushAnchor('\\b(?<=\\w)');
            i += 2;
            continue;
          case '`':
            pushAnchor('(?<![\\s\\S])');
            i += 2;
            continue;
          case "'":
            pushAnchor('(?![\\s\\S])');
            i += 2;
            continue;
          case 'n':
            pushAtom('\\n');
            i += 2;
            continue;
          default:
            if (n in SIMPLE_ESCAPES) {
              pushAtom(jsEscapeChar(SIMPLE_ESCAPES[n]));
              i += 2;
              continue;
            }
            pushAtom(jsEscapeChar(n));
            i += 2;
            continue;
        }
      }
      // awk escapes
      const [ch, len] = awkEscape(src, i + 1);
      pushAtom(jsEscapeChar(ch));
      i += 1 + len;
      continue;
    }
    if (ere || awk) {
      if (c === '(') {
        stack.push({ outIndex: out.length, num: ++groups });
        out.push('(');
        atom = -1;
        quantified = false;
        atStart = true;
        i++;
        continue;
      }
      if (c === ')') {
        if (!stack.length && o.rparenOrd) {
          pushAtom('\\)');
          i++;
          continue;
        }
        const g = stack.pop();
        if (!g) {
          if (awk) err("missing '('");
          err('Unmatched ) or \\)');
        }
        if (out.length === g!.outIndex + 1 && awk) err('missing operand');
        out.push(')');
        closed.push(g!.num);
        atom = g!.outIndex;
        quantified = false;
        atStart = false;
        i++;
        continue;
      }
      if (c === '|') {
        out.push('|');
        atom = -1;
        quantified = false;
        atStart = true;
        i++;
        continue;
      }
      if (c === '*' || c === '+' || c === '?') {
        quantify(c, '\\' + c);
        i++;
        continue;
      }
      if (c === '{') {
        const iv = parseInterval(i + 1, '}');
        if (iv && atom !== -1) {
          quantify(iv.q, '');
          i = iv.end;
          continue;
        }
        if (!awk) {
          if (atom === -1) err('Invalid preceding regular expression');
          if (src.indexOf('}', i + 1) === -1) err('Unmatched \\{');
          err('Invalid content of \\{\\}');
        }
        if (iv && atom === -1) err('missing operand');
        pushAtom('\\{');
        i++;
        continue;
      }
      if (c === '^') {
        pushAnchor('^');
        atStart = true;
        i++;
        continue;
      }
      if (c === '$') {
        pushAnchor('$');
        i++;
        continue;
      }
    } else {
      if (c === '*' || (emacs && (c === '+' || c === '?'))) {
        if (atom === -1) pushAtom('\\' + c);
        else quantify(c, '\\' + c);
        i++;
        continue;
      }
      if (c === '^') {
        if (atStart) {
          pushAnchor('^');
          atStart = true;
        } else pushAtom('\\^');
        i++;
        continue;
      }
      if (c === '$') {
        const rest = src.slice(i + 1);
        if (rest === '' || rest.startsWith('\\)') || rest.startsWith('\\|')) pushAnchor('$');
        else pushAtom('\\$');
        i++;
        continue;
      }
    }
    if (c === '.') {
      pushAtom('.');
      i++;
      continue;
    }
    pushAtom(jsEscapeChar(c));
    i++;
  }
  if (stack.length) err(awk ? "missing ')'" : 'Unmatched ( or \\(');
  return { source: out.join(''), groups };
}

// ---------------------------------------------------------------------------
// sed: data structures

interface Addr {
  kind: 'num' | 'last' | 're' | 'step' | 'plus' | 'tilde';
  n: number;
  step: number;
  re: SedRegex | null;
}

interface SedRegex {
  re: RegExp | null; // null = "the last regex used"
  groups: number;
}

type ReplPiece = { lit: string } | { group: number } | { mode: 'U' | 'L' | 'E' | 'u' | 'l' };

interface Subst {
  re: SedRegex;
  repl: ReplPiece[];
  global: boolean;
  print: number;
  nth: number;
  evaluate: boolean;
  out: SedOut | null;
}

interface SedCmd {
  a1: Addr | null;
  a2: Addr | null;
  bang: boolean;
  cmd: string;
  text: string;
  label: string;
  jump: number;
  int: number;
  fname: string;
  out: SedOut | null;
  rfile: ReadFile | null;
  subst: Subst | null;
  ymap: Map<string, string> | null;
  range: 'inactive' | 'active' | 'closed';
  rangeEnd: number;
}

class SedOut {
  readonly stream: OutputStream;
  buf = '';
  missing = false;
  constructor(stream: OutputStream) {
    this.stream = stream;
  }
  fixMissing(): void {
    if (this.missing) {
      this.buf += '\n';
      this.missing = false;
    }
  }
  text(s: string): void {
    this.fixMissing();
    this.buf += s;
  }
  raw(s: string): void {
    this.fixMissing();
    this.buf += s;
  }
  line(s: string, chomped: boolean, delim: string): void {
    this.fixMissing();
    this.buf += s;
    if (chomped) this.buf += delim;
    else this.missing = true;
  }
  async flush(): Promise<void> {
    if (this.buf) {
      const b = this.buf;
      this.buf = '';
      await this.stream.write(b);
    }
  }
}

class ReadFile {
  lines: string[] | null = null;
  pos = 0;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

class SedCompileError extends Error {}
class SedPanic extends Error {}
/** A usage error found while running (exit status 1). */
class SedUsage extends Error {}

const SED_USAGE = `Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...

  -n, --quiet, --silent
                 suppress automatic printing of pattern space
      --debug
                 annotate program execution
  -e script, --expression=script
                 add the script to the commands to be executed
  -f script-file, --file=script-file
                 add the contents of script-file to the commands to be executed
  --follow-symlinks
                 follow symlinks when processing in place
  -i[SUFFIX], --in-place[=SUFFIX]
                 edit files in place (makes backup if SUFFIX supplied)
  -l N, --line-length=N
                 specify the desired line-wrap length for the \`l' command
  --posix
                 disable all GNU extensions.
  -E, -r, --regexp-extended
                 use extended regular expressions in the script
                 (for portability use POSIX -E).
  -s, --separate
                 consider files as separate rather than as a single,
                 continuous long stream.
      --sandbox
                 operate in sandbox mode (disable e/r/w commands).
  -u, --unbuffered
                 load minimal amounts of data from the input files and flush
                 the output buffers more often
  -z, --null-data
                 separate lines by NUL characters
      --help     display this help and exit
      --version  output version information and exit

If no -e, --expression, -f, or --file option is given, then the first
non-option argument is taken as the sed script to interpret.  All
remaining arguments are names of input files; if no input files are
specified, then the standard input is read.

GNU sed home page: <https://www.gnu.org/software/sed/>.
General help using GNU software: <https://www.gnu.org/gethelp/>.
`;

// ---------------------------------------------------------------------------
// sed: compiler

interface ScriptChunk {
  text: string;
  /** "-e expression #N" or "file NAME". */
  kind: 'e' | 'f';
  num: number;
  name: string;
}

interface CompileEnv {
  extended: boolean;
  sandbox: boolean;
  openWrite: (name: string) => SedOut;
  openRead: (name: string) => ReadFile;
}

class SedCompiler {
  readonly cmds: SedCmd[] = [];
  private readonly env: CompileEnv;
  private chunk: ScriptChunk = { text: '', kind: 'e', num: 0, name: '' };
  private pos = 0;
  private line = 1;
  private blocks: { index: number; chunk: ScriptChunk; line: number }[] = [];
  private pendingText: SedCmd | null = null;
  quietFromScript = false;
  private first = true;

  constructor(env: CompileEnv) {
    this.env = env;
  }

  private where(): string {
    if (this.chunk.kind === 'e') return `-e expression #${this.chunk.num}, char ${this.pos}`;
    return `file ${this.chunk.name} line ${this.line}`;
  }

  private bad(msg: string): never {
    throw new SedCompileError(`${this.where()}: ${msg}`);
  }

  private inchar(): string | null {
    if (this.pos >= this.chunk.text.length) return null;
    const c = this.chunk.text[this.pos++];
    if (c === '\n') this.line++;
    return c;
  }

  private savchar(c: string | null): void {
    if (c === null) return;
    this.pos--;
    if (c === '\n' && this.line > 1) this.line--;
  }

  private inNonblank(): string | null {
    let c: string | null;
    do c = this.inchar();
    while (c === ' ' || c === '\t');
    return c;
  }

  private inInteger(first: string): number {
    let s = first;
    for (;;) {
      const c = this.inchar();
      if (c !== null && c >= '0' && c <= '9') s += c;
      else {
        this.savchar(c);
        break;
      }
    }
    return parseInt(s, 10);
  }

  compile(chunk: ScriptChunk): void {
    this.chunk = chunk;
    this.pos = 0;
    this.line = 1;
    if (this.pendingText) this.readText(this.pendingText, '\n');
    if (this.first && chunk.text.startsWith('#n')) this.quietFromScript = true;
    this.first = false;
    for (;;) {
      let ch = this.inchar();
      while (ch === ';' || (ch !== null && /\s/.test(ch))) ch = this.inchar();
      if (ch === null) break;
      const cmd: SedCmd = {
        a1: null,
        a2: null,
        bang: false,
        cmd: '',
        text: '',
        label: '',
        jump: -1,
        int: -1,
        fname: '',
        out: null,
        rfile: null,
        subst: null,
        ymap: null,
        range: 'inactive',
        rangeEnd: 0,
      };
      const a = this.compileAddress(ch);
      if (a) {
        if (a.kind === 'plus' || a.kind === 'tilde') this.bad('invalid usage of +N or ~N as first address');
        cmd.a1 = a;
        ch = this.inNonblank();
        if (ch === ',') {
          const a2 = this.compileAddress(this.inNonblank());
          if (!a2) this.bad("unexpected `,'");
          cmd.a2 = a2;
          ch = this.inNonblank();
        }
        if (cmd.a1.kind === 'num' && cmd.a1.n === 0 && (!cmd.a2 || cmd.a2.kind !== 're')) this.bad('invalid usage of line address 0');
      }
      if (ch === '!') {
        cmd.bang = true;
        ch = this.inNonblank();
        while (ch === ' ' || ch === '\t') ch = this.inNonblank();
        if (ch === '!') this.bad("multiple `!'s");
      }
      if (ch === null) this.bad('missing command');
      cmd.cmd = ch;
      switch (ch) {
        case '#':
          if (cmd.a1) this.bad("comments don't accept any addresses");
          while (ch !== null && ch !== '\n') ch = this.inchar();
          continue;
        case 'v': {
          this.readLabel();
          continue;
        }
        case '{':
          this.blocks.push({ index: this.cmds.length, chunk: this.chunk, line: this.line });
          break;
        case '}': {
          const b = this.blocks.pop();
          if (!b) this.bad("unexpected `}'");
          if (cmd.a1) this.bad("} doesn't want any addresses");
          this.readEndOfCmd();
          this.cmds[b!.index].jump = this.cmds.length + 1;
          break;
        }
        case 'e':
          if (this.env.sandbox) this.bad('e/r/w commands disabled in sandbox mode');
          cmd.fname = this.readFilename();
          break;
        case 'a':
        case 'i':
        case 'c': {
          ch = this.inNonblank();
          if (ch === null) this.bad("expected \\ after `a', `c' or `i'");
          if (ch === '\\') ch = this.inchar();
          else {
            this.savchar(ch);
            ch = '\n';
          }
          this.readText(cmd, ch);
          break;
        }
        case ':': {
          if (cmd.a1) this.bad(": doesn't want any addresses");
          const label = this.readLabel();
          if (!label) this.bad('":" lacks a label');
          cmd.label = label;
          break;
        }
        case 'b':
        case 't':
        case 'T':
          cmd.label = this.readLabel();
          break;
        case 'q':
        case 'Q':
        case 'l':
        case 'L': {
          if ((ch === 'q' || ch === 'Q') && cmd.a2) this.bad('command only uses one address');
          let c2 = this.inNonblank();
          if (c2 !== null && c2 >= '0' && c2 <= '9') {
            cmd.int = this.inInteger(c2);
            c2 = this.inNonblank();
          } else cmd.int = -1;
          if (c2 === '}' || c2 === '#') this.savchar(c2);
          else if (c2 !== null && c2 !== '\n' && c2 !== ';') this.bad('extra characters after command');
          break;
        }
        case '=':
        case 'd':
        case 'D':
        case 'F':
        case 'g':
        case 'G':
        case 'h':
        case 'H':
        case 'n':
        case 'N':
        case 'p':
        case 'P':
        case 'z':
        case 'x':
          this.readEndOfCmd();
          break;
        case 'r': {
          if (this.env.sandbox) this.bad('e/r/w commands disabled in sandbox mode');
          const f = this.readFilename();
          if (f === '') this.bad('missing filename in r/R/w/W commands');
          cmd.fname = f;
          break;
        }
        case 'R': {
          if (this.env.sandbox) this.bad('e/r/w commands disabled in sandbox mode');
          const f = this.readFilename();
          if (f === '') this.bad('missing filename in r/R/w/W commands');
          cmd.rfile = this.env.openRead(f);
          break;
        }
        case 'w':
        case 'W': {
          if (this.env.sandbox) this.bad('e/r/w commands disabled in sandbox mode');
          const f = this.readFilename();
          if (f === '') this.bad('missing filename in r/R/w/W commands');
          cmd.out = this.env.openWrite(f);
          break;
        }
        case 's':
          cmd.subst = this.compileSubst();
          break;
        case 'y':
          cmd.ymap = this.compileY();
          break;
        default:
          this.bad(`unknown command: \`${ch}'`);
      }
      this.cmds.push(cmd);
    }
  }

  finish(): void {
    if (this.pendingText) this.pendingText = null;
    if (this.blocks.length) {
      const b = this.blocks[this.blocks.length - 1];
      const where = b.chunk.kind === 'e' ? `-e expression #${b.chunk.num}, char 0` : `file ${b.chunk.name} line ${b.line}`;
      throw new SedCompileError(`${where}: unmatched \`{'`);
    }
    const labels = new Map<string, number>();
    this.cmds.forEach((c, i) => {
      if (c.cmd === ':') {
        if (labels.has(c.label)) throw new SedCompileError(`-e expression #1, char 0: duplicate label \`${c.label}'`);
        labels.set(c.label, i);
      }
    });
    for (const c of this.cmds) {
      if (c.cmd === 'b' || c.cmd === 't' || c.cmd === 'T') {
        if (c.label === '') c.jump = this.cmds.length;
        else {
          const t = labels.get(c.label);
          if (t === undefined) throw new SedPanic(`can't find label for jump to \`${c.label}'`);
          c.jump = t;
        }
      }
    }
  }

  private readEndOfCmd(): void {
    const ch = this.inNonblank();
    if (ch === '}' || ch === '#') this.savchar(ch);
    else if (ch !== null && ch !== '\n' && ch !== ';') this.bad('extra characters after command');
  }

  private readLabel(): string {
    let ch = this.inNonblank();
    let s = '';
    while (ch !== null && ch !== '\n' && ch !== ' ' && ch !== '\t' && ch !== ';' && ch !== '}' && ch !== '#') {
      s += ch;
      ch = this.inchar();
    }
    this.savchar(ch);
    if (ch === ';') this.inchar();
    return s;
  }

  private readFilename(): string {
    let ch = this.inNonblank();
    let s = '';
    while (ch !== null && ch !== '\n') {
      s += ch;
      ch = this.inchar();
    }
    return s;
  }

  private readText(cmd: SedCmd, leadin: string | null): void {
    // continue text of a previous chunk, or start new text
    let raw = this.pendingText ? cmd.text : '';
    this.pendingText = null;
    if (leadin === null) {
      cmd.text = raw;
      this.pendingText = cmd;
      return;
    }
    if (leadin !== '\n') raw += leadin;
    let ch = this.inchar();
    while (ch !== null && ch !== '\n') {
      if (ch === '\\') {
        ch = this.inchar();
        if (ch !== null) raw += '\\';
      }
      if (ch === null) {
        cmd.text = raw + '\n';
        this.pendingText = cmd;
        return;
      }
      raw += ch;
      ch = this.inchar();
    }
    raw += '\n';
    cmd.text = normalizeText(raw, 'buffer');
  }

  /** Read up to an unescaped delimiter. Returns null when unterminated. */
  private matchSlash(slash: string, regex: boolean): string | null {
    let s = '';
    let ch: string | null;
    while ((ch = this.inchar()) !== null && ch !== '\n') {
      if (ch === slash) return s;
      if (ch === '[' && regex) {
        // the delimiter has no special meaning inside a bracket expression
        s += ch;
        let c2 = this.inchar();
        if (c2 === '^') {
          s += c2;
          c2 = this.inchar();
        }
        if (c2 === ']') {
          s += c2;
          c2 = this.inchar();
        }
        while (c2 !== null && c2 !== '\n' && c2 !== ']') {
          if (c2 === '[') {
            const k = this.inchar();
            s += c2;
            if (k === ':' || k === '.' || k === '=') {
              s += k;
              let c3 = this.inchar();
              while (c3 !== null && c3 !== '\n' && !(c3 === k && this.chunk.text[this.pos] === ']')) {
                s += c3;
                c3 = this.inchar();
              }
              if (c3 === null || c3 === '\n') {
                ch = c3;
                break;
              }
              s += c3 + this.inchar();
            } else if (k !== null) this.savchar(k);
            c2 = this.inchar();
            continue;
          }
          s += c2;
          c2 = this.inchar();
        }
        if (c2 === null || c2 === '\n') {
          ch = c2;
          break;
        }
        s += c2;
        continue;
      }
      if (ch === '\\') {
        ch = this.inchar();
        if (ch === null) break;
        if (ch === 'n' && regex) ch = '\n';
        else if (ch !== '\n' && (ch !== slash || (!regex && ch === '&'))) s += '\\';
      }
      s += ch;
    }
    if (ch === '\n') this.savchar(ch);
    return null;
  }

  private compileAddress(ch: string | null): Addr | null {
    if (ch === '/' || ch === '\\') {
      if (ch === '\\') ch = this.inchar();
      if (ch === null || ch === '\n' || ch === '\\') this.bad('unterminated address regex');
      const body = this.matchSlash(ch, true);
      if (body === null) this.bad('unterminated address regex');
      let flags = '';
      for (;;) {
        const f = this.inNonblank();
        if (f === 'I') flags += 'I';
        else if (f === 'M') flags += 'M';
        else {
          this.savchar(f);
          break;
        }
      }
      return { kind: 're', n: 0, step: 0, re: this.compileRegex(body!, flags) };
    }
    if (ch !== null && ch >= '0' && ch <= '9') {
      const n = this.inInteger(ch);
      const c2 = this.inNonblank();
      if (c2 !== '~') {
        this.savchar(c2);
        return { kind: 'num', n, step: 0, re: null };
      }
      const c3 = this.inNonblank();
      const step = c3 !== null && c3 >= '0' && c3 <= '9' ? this.inInteger(c3) : (this.savchar(c3), 0);
      if (step > 0) return { kind: 'step', n, step, re: null };
      return { kind: 'num', n, step: 0, re: null };
    }
    if (ch === '+' || ch === '~') {
      const c2 = this.inNonblank();
      const n = c2 !== null && c2 >= '0' && c2 <= '9' ? this.inInteger(c2) : (this.savchar(c2), 0);
      return { kind: ch === '+' ? 'plus' : 'tilde', n, step: 0, re: null };
    }
    if (ch === '$') return { kind: 'last', n: 0, step: 0, re: null };
    return null;
  }

  private compileRegex(body: string, flags: string): SedRegex {
    if (body === '') {
      if (flags) this.bad('cannot specify modifiers on empty regexp');
      return { re: null, groups: 0 };
    }
    const pre = preprocessSedRegex(body);
    let conv: ConvertedRegex;
    try {
      conv = convertPosixRegex(pre, { extended: this.env.extended, dialect: 'sed' });
    } catch (e) {
      this.bad(e instanceof Error ? e.message : String(e));
    }
    const multi = flags.includes('M');
    try {
      const re = new RegExp(conv!.source, 'g' + (flags.includes('I') ? 'i' : '') + (multi ? 'm' : 's'));
      return { re, groups: conv!.groups };
    } catch {
      this.bad('Invalid regular expression');
    }
  }

  private compileSubst(): Subst {
    const slash = this.inchar();
    if (slash === null || slash === '\n' || slash === '\\') this.bad("unterminated `s' command");
    const pat = this.matchSlash(slash!, true);
    if (pat === null) this.bad("unterminated `s' command");
    const rep = this.matchSlash(slash!, false);
    if (rep === null) this.bad("unterminated `s' command");
    const repl = parseReplacement(rep!);
    let flags = '';
    let global = false;
    let print = 0;
    let nth = 0;
    let evaluate = false;
    let out: SedOut | null = null;
    loop: for (;;) {
      const ch = this.inchar();
      switch (ch) {
        case 'i':
        case 'I':
          flags += 'I';
          break;
        case 'm':
        case 'M':
          flags += 'M';
          break;
        case 'e':
          evaluate = true;
          break;
        case 'p':
          if (print) this.bad("multiple `p' options to `s' command");
          print = 1;
          break;
        case 'g':
          if (global) this.bad("multiple `g' options to `s' command");
          global = true;
          break;
        case 'w': {
          const f = this.readFilename();
          if (f === '') this.bad('missing filename in r/R/w/W commands');
          out = this.env.openWrite(f);
          break loop;
        }
        case '0':
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9': {
          if (nth) this.bad("multiple number options to `s' command");
          nth = this.inInteger(ch);
          if (!nth) this.bad("number option to `s' command may not be zero");
          break;
        }
        case '}':
        case '#':
          this.savchar(ch);
          break loop;
        case '\n':
        case ';':
        case null:
          break loop;
        case ' ':
        case '\t':
          break;
        default:
          this.bad("unknown option to `s'");
      }
    }
    const re = this.compileRegex(pat!, flags);
    const maxRef = repl.reduce((m, p) => ('group' in p ? Math.max(m, p.group) : m), 0);
    if (re.re && maxRef > re.groups) this.bad(`invalid reference \\${maxRef} on \`s' command's RHS`);
    return { re, repl, global, print, nth: nth || 1, evaluate, out };
  }

  private compileY(): Map<string, string> {
    const slash = this.inchar();
    if (slash === null || slash === '\n' || slash === '\\') this.bad("unterminated `y' command");
    const src = this.matchSlash(slash!, false);
    if (src === null) this.bad("unterminated `y' command");
    const dst = this.matchSlash(slash!, false);
    if (dst === null) this.bad("unterminated `y' command");
    const unesc = (s: string): string[] => {
      const outc: string[] = [];
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[++i];
          if (n === '\\') outc.push('\\');
          else if (n in SIMPLE_ESCAPES) outc.push(SIMPLE_ESCAPES[n]);
          else if (n === slash) outc.push(n);
          else {
            outc.push('\\');
            outc.push(n);
          }
        } else outc.push(s[i]);
      }
      return outc;
    };
    const a = unesc(src!);
    const b = unesc(dst!);
    if (a.length !== b.length) this.bad("strings for `y' command are different lengths");
    const map = new Map<string, string>();
    a.forEach((c, i) => {
      if (!map.has(c)) map.set(c, b[i]);
    });
    this.readEndOfCmd();
    return map;
  }
}

/** GNU escapes that produce raw characters before the regex is compiled. */
function preprocessSedRegex(s: string): string {
  if (!/\\[cdox]/.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const n = s[i + 1];
    if (n === 'c' && i + 2 < s.length) {
      out += String.fromCharCode(s[i + 2].toUpperCase().charCodeAt(0) ^ 0x40);
      i += 2;
      continue;
    }
    const m = n === 'd' ? /^\d{1,3}/.exec(s.slice(i + 2)) : n === 'o' ? /^[0-7]{1,3}/.exec(s.slice(i + 2)) : n === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 2)) : null;
    if (m) {
      out += String.fromCharCode(parseInt(m[0], n === 'd' ? 10 : n === 'o' ? 8 : 16) & 255);
      i += 1 + m[0].length;
      continue;
    }
    out += c + n;
    i++;
  }
  return out;
}

/** normalize_text(): process escapes in a/i/c text (buffer) or replacements. */
function normalizeText(s: string, kind: 'buffer' | 'replacement'): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const n = s[i + 1];
    if (n in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[n];
      i++;
      continue;
    }
    if (n === '\n') {
      out += '\n';
      i++;
      continue;
    }
    if (n === 'c' && i + 2 < s.length) {
      out += String.fromCharCode(s[i + 2].toUpperCase().charCodeAt(0) ^ 0x40);
      i += 2;
      continue;
    }
    const m = n === 'd' ? /^\d{1,3}/.exec(s.slice(i + 2)) : n === 'o' ? /^[0-7]{1,3}/.exec(s.slice(i + 2)) : n === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 2)) : null;
    if (m) {
      const ch = String.fromCharCode(parseInt(m[0], n === 'd' ? 10 : n === 'o' ? 8 : 16) & 255);
      if (kind === 'replacement' && (ch === '&' || ch === '\\')) out += '\\';
      out += ch;
      i += 1 + m[0].length;
      continue;
    }
    if (kind === 'buffer') {
      out += n;
      i++;
      continue;
    }
    out += c + n;
    i++;
  }
  return out;
}

function parseReplacement(raw: string): ReplPiece[] {
  const s = normalizeText(raw, 'replacement');
  const pieces: ReplPiece[] = [];
  let lit = '';
  const flushLit = () => {
    if (lit) pieces.push({ lit });
    lit = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 >= s.length) {
        lit += '\\';
        continue;
      }
      const n = s[++i];
      if (n >= '0' && n <= '9') {
        flushLit();
        pieces.push({ group: n.charCodeAt(0) - 48 });
      } else if ('LUElu'.includes(n)) {
        flushLit();
        pieces.push({ mode: n as 'U' | 'L' | 'E' | 'u' | 'l' });
      } else lit += n;
      continue;
    }
    if (c === '&') {
      flushLit();
      pieces.push({ group: 0 });
      continue;
    }
    lit += c;
  }
  flushLit();
  return pieces;
}

function applyCase(text: string, persist: 'U' | 'L' | null, once: 'u' | 'l' | null): string {
  if (text === '') return text;
  let t = persist === 'U' ? text.toUpperCase() : persist === 'L' ? text.toLowerCase() : text;
  if (once === 'u') t = t[0].toUpperCase() + t.slice(1);
  else if (once === 'l') t = t[0].toLowerCase() + t.slice(1);
  return t;
}

function expandReplacement(pieces: ReplPiece[], m: RegExpExecArray): string {
  let out = '';
  let persist: 'U' | 'L' | null = null;
  let once: 'u' | 'l' | null = null;
  for (const p of pieces) {
    if ('mode' in p) {
      if (p.mode === 'U' || p.mode === 'L') persist = p.mode;
      else if (p.mode === 'E') {
        persist = null;
        once = null;
      } else once = p.mode;
      continue;
    }
    const text = 'lit' in p ? p.lit : m[p.group] ?? '';
    if (persist === null && once === null) {
      out += text;
      continue;
    }
    out += applyCase(text, persist, once);
    if (text !== '') once = null;
  }
  return out;
}

/** `l` command: show the pattern space unambiguously. */
function listLine(ps: string, width: number): string {
  const enc = new TextEncoder();
  let out = '';
  let col = 0;
  const emit = (piece: string) => {
    if (width > 1 && col + piece.length > width - 1) {
      out += '\\\n';
      col = 0;
    } else if (width === 1 && col + piece.length > 0) {
      out += '\\\n';
      col = 0;
    }
    out += piece;
    col += piece.length;
  };
  for (const ch of ps) {
    const code = ch.codePointAt(0)!;
    let piece: string;
    switch (ch) {
      case '\\':
        piece = '\\\\';
        break;
      case '\x07':
        piece = '\\a';
        break;
      case '\b':
        piece = '\\b';
        break;
      case '\f':
        piece = '\\f';
        break;
      case '\n':
        piece = '\\n';
        break;
      case '\r':
        piece = '\\r';
        break;
      case '\t':
        piece = '\\t';
        break;
      case '\v':
        piece = '\\v';
        break;
      default:
        if (code >= 0x20 && code < 0x7f) piece = ch;
        else if (code < 0x80) piece = '\\' + code.toString(8).padStart(3, '0');
        else {
          for (const b of enc.encode(ch)) emit('\\' + b.toString(8).padStart(3, '0'));
          continue;
        }
    }
    emit(piece);
  }
  return out + '$\n';
}

// ---------------------------------------------------------------------------
// sed: input

class SedInput {
  private readonly ctx: CommandContext;
  private readonly files: string[];
  private fileIdx = -1;
  private buf = '';
  private pos = 0;
  private srcEof = true;
  private stream: InputStream | null = null;
  readonly delim: string;
  readonly separate: boolean;
  currentName = '-';
  lineNo = 0;
  badFiles = 0;
  private readonly beforeBlock: () => Promise<void>;
  /** Called when a new file is opened (in-place editing). */
  onFile: ((name: string) => Promise<boolean>) | null = null;
  onFileDone: ((name: string) => Promise<void>) | null = null;
  private opened = false;

  constructor(ctx: CommandContext, files: string[], delim: string, separate: boolean, beforeBlock: () => Promise<void>) {
    this.ctx = ctx;
    this.files = files.length ? files : ['-'];
    this.delim = delim;
    this.separate = separate;
    this.beforeBlock = beforeBlock;
  }

  /** Make sure the current source has a complete line available (or is exhausted). */
  private async fillLine(): Promise<void> {
    while (!this.srcEof && this.buf.indexOf(this.delim, this.pos) === -1) {
      await this.beforeBlock();
      const chunk = await this.stream!.read();
      if (chunk === null) this.srcEof = true;
      else {
        this.buf = this.buf.slice(this.pos) + chunk;
        this.pos = 0;
      }
    }
  }

  private hasDataInCurrent(): boolean {
    return this.pos < this.buf.length;
  }

  /** Open the next file. Returns false when there are no more files. */
  private async openNext(): Promise<boolean> {
    if (this.opened && this.onFileDone) await this.onFileDone(this.currentName);
    this.opened = false;
    for (;;) {
      this.fileIdx++;
      if (this.fileIdx >= this.files.length) return false;
      const f = this.files[this.fileIdx];
      this.buf = '';
      this.pos = 0;
      this.stream = null;
      this.srcEof = true;
      if (this.separate) this.lineNo = 0;
      if (this.onFile && !(await this.onFile(f))) continue;
      if (f === '-') {
        this.stream = this.ctx.stdin;
        this.srcEof = false;
        this.currentName = '-';
        this.opened = true;
        return true;
      }
      try {
        const node = this.ctx.fs.stat(f);
        if (node.type === 'dir') {
          await this.beforeBlock();
          await this.ctx.error(`read error on ${f}: Is a directory`);
          throw new SedPanic('');
        }
        this.buf = this.ctx.fs.readFile(f);
        this.currentName = f;
        this.opened = true;
        return true;
      } catch (e) {
        if (e instanceof SedPanic) throw e;
        await this.beforeBlock();
        await this.ctx.error(`can't read ${f}: ${errText(e)}`);
        this.badFiles++;
      }
    }
  }

  /** Read the next line; null at end of input. */
  async next(): Promise<{ text: string; chomped: boolean } | null> {
    for (;;) {
      if (this.fileIdx >= 0 && this.fileIdx < this.files.length) {
        await this.fillLine();
        if (this.hasDataInCurrent()) {
          const idx = this.buf.indexOf(this.delim, this.pos);
          let text: string;
          let chomped: boolean;
          if (idx === -1) {
            text = this.buf.slice(this.pos);
            this.pos = this.buf.length;
            chomped = false;
          } else {
            text = this.buf.slice(this.pos, idx);
            this.pos = idx + 1;
            chomped = true;
          }
          if (this.pos > 65536 && this.stream) {
            this.buf = this.buf.slice(this.pos);
            this.pos = 0;
          }
          this.lineNo++;
          return { text, chomped };
        }
      }
      if (!(await this.openNext())) return null;
    }
  }

  /** True when the line just read is the last one ($). */
  async isLast(): Promise<boolean> {
    await this.fillLine();
    if (this.hasDataInCurrent()) return false;
    if (this.separate) return true;
    // look ahead into the following files for data
    for (let k = this.fileIdx + 1; k < this.files.length; k++) {
      const f = this.files[k];
      if (f === '-') {
        // can't cheaply peek; assume stdin has data unless it is the current source
        if (this.stream === this.ctx.stdin) continue;
        return false;
      }
      const node = this.ctx.fs.tryStat(f);
      if (node && node.type === 'file') {
        try {
          if (this.ctx.fs.readFile(f) !== '') return false;
        } catch {
          // unreadable: no data
        }
      } else if (node && node.type !== 'dir') return false;
    }
    return true;
  }

  async finish(): Promise<void> {
    if (this.opened && this.onFileDone) await this.onFileDone(this.currentName);
    this.opened = false;
  }
}

// ---------------------------------------------------------------------------
// sed: main

const SED_DOC: CommandDef['doc'] = {
  category: 'text',
  summary: 'stream editor for filtering and transforming text',
  synopsis: ['sed [OPTION]... {script-only-if-no-other-script} [input-file]...'],
  description:
    'sed is a stream editor. It reads its input (files, or standard input) one line at a time, applies the editing commands in the script to each line, and prints the result. By default the original file is not changed; use -i to edit a file in place.\n\n' +
    'The most used command is substitution: s/REGEX/REPLACEMENT/FLAGS. It replaces the first match of REGEX on each line; the g flag replaces every match, a number N replaces only the Nth match, I ignores case and p prints the line when a replacement was made. In the replacement, & stands for the whole match and \\1 to \\9 for the parts in \\( \\) (or ( ) with -E); \\U, \\L, \\u, \\l and \\E change letter case. Any character can replace the / delimiter, which helps with paths: s|/usr|/opt|.\n\n' +
    'A command can be limited to some lines with an address in front of it: a line number (3), the last line ($), a regex (/error/), a range (2,5 or /start/,/end/), every Nth line (first~step) or N lines after a match (/x/,+2). Put ! after an address to apply the command to the other lines.\n\n' +
    'Other commands: d (delete the line), p (print it), q (quit), a TEXT (append a line after), i TEXT (insert a line before), c TEXT (change the line), y/abc/xyz/ (transliterate), = (print the line number), n/N (read the next line), h/H/g/G/x (hold space), b/t/T (branch to a :label) and { } (group commands). Separate commands with ; or newlines.',
  options: [
    { flags: '-n, --quiet, --silent', desc: 'suppress automatic printing of pattern space (print only with p)' },
    { flags: '-e script, --expression=script', desc: 'add the script to the commands to be executed' },
    { flags: '-f script-file, --file=script-file', desc: 'add the contents of script-file to the commands to be executed' },
    { flags: '-i[SUFFIX], --in-place[=SUFFIX]', desc: 'edit files in place (makes backup if SUFFIX supplied)' },
    { flags: '-E, -r, --regexp-extended', desc: 'use extended regular expressions in the script (+, ?, |, ( ) and { } without backslashes)' },
    { flags: '-s, --separate', desc: 'consider files as separate rather than as a single, continuous long stream' },
    { flags: '-z, --null-data', desc: 'separate lines by NUL characters' },
    { flags: '-l N, --line-length=N', desc: "specify the desired line-wrap length for the `l' command" },
    { flags: '-u, --unbuffered', desc: 'flush the output buffers more often' },
    { flags: '--posix', desc: 'disable all GNU extensions' },
  ],
  examples: [
    { cmd: "sed 's/cat/dog/' pets.txt", desc: 'Replace the first "cat" on each line with "dog".' },
    { cmd: "sed 's/cat/dog/g' pets.txt", desc: 'Replace every "cat" on every line.' },
    { cmd: "sed -i 's/colour/color/g' notes.txt", desc: 'Edit the file itself instead of printing the result.' },
    { cmd: "sed -n '5,10p' file.txt", desc: 'Print only lines 5 to 10.' },
    { cmd: "sed '/^#/d' config.txt", desc: 'Delete comment lines (lines starting with #).' },
    { cmd: "sed '/^$/d' file.txt", desc: 'Delete empty lines.' },
    { cmd: "sed -E 's/([0-9]+)-([0-9]+)/\\2-\\1/' dates.txt", desc: 'Swap two numbers using groups.' },
    { cmd: "sed '1i Title' file.txt", desc: 'Insert a line at the top.' },
  ],
  seeAlso: ['awk', 'grep', 'tr'],
  tip: "Without -i, sed never changes your file: it prints the edited text. Try your command without -i first, and quote the script in single quotes so the shell leaves it alone.",
};

async function sedMain(ctx: CommandContext): Promise<number> {
  let opts;
  try {
    opts = parseOpts(ctx.args, {
      short: 'nrsuzEe:f:i::l:bV',
      long: {
        quiet: 'n',
        silent: 'n',
        'regexp-extended': 'E',
        separate: 's',
        unbuffered: 'u',
        'null-data': 'z',
        'zero-terminated': 'z',
        expression: { key: 'e', arg: 'required' },
        file: { key: 'f', arg: 'required' },
        'in-place': { key: 'i', arg: 'optional' },
        'line-length': { key: 'l', arg: 'required' },
        binary: 'b',
        posix: 'posix',
        debug: 'debug',
        sandbox: 'sandbox',
        'follow-symlinks': 'follow',
        help: 'help',
        version: 'version',
      },
    });
  } catch (e) {
    if (e instanceof OptError) {
      await ctx.error(e.message);
      await ctx.err(SED_USAGE);
      return 1;
    }
    throw e;
  }
  const extended = opts.has('E') || opts.has('r');
  let quiet = opts.has('n');
  const inPlace = opts.has('i');
  const suffix = opts.get('i') ?? '';
  const separate = opts.has('s') || inPlace;
  const delim = opts.has('z') ? '\0' : '\n';
  const unbuffered = opts.has('u');
  let lineLength = 70;
  if (opts.has('l')) {
    const v = opts.get('l')!;
    if (!/^\d+$/.test(v)) {
      await ctx.error(`invalid line length: ${v}`);
      return 1;
    }
    lineLength = parseInt(v, 10);
  }
  const chunks: ScriptChunk[] = [];
  let exprNum = 0;
  let operands = opts.operands;
  for (const { key, value } of opts.list) {
    if (key === 'e') chunks.push({ text: String(value), kind: 'e', num: ++exprNum, name: '' });
    if (key === 'f') {
      const name = String(value);
      try {
        let text: string;
        if (name === '-') text = await ctx.stdin.readAll();
        else {
          const node = ctx.fs.stat(name);
          if (node.type === 'dir') throw new FsError('EISDIR', name);
          text = ctx.fs.readFile(name);
        }
        if (text.endsWith('\n')) text = text.slice(0, -1);
        chunks.push({ text, kind: 'f', num: 0, name });
      } catch (e) {
        await ctx.error(`couldn't open file ${name}: ${errText(e)}`);
        return 4;
      }
    }
  }
  if (chunks.length === 0) {
    if (operands.length === 0) {
      await ctx.err(SED_USAGE);
      return 1;
    }
    chunks.push({ text: operands[0], kind: 'e', num: 1, name: '' });
    operands = operands.slice(1);
  }

  // outputs
  const stdout = new SedOut(ctx.stdout);
  const stderr = new SedOut(ctx.stderr);
  const writeFiles = new Map<string, SedOut>();
  const readFiles = new Map<string, ReadFile>();
  const env: CompileEnv = {
    extended,
    sandbox: opts.has('sandbox'),
    openWrite: (name) => {
      if (name === '/dev/stdout') return stdout;
      if (name === '/dev/stderr') return stderr;
      let o = writeFiles.get(name);
      if (!o) {
        try {
          o = new SedOut(openOutput(ctx, name, false));
        } catch (e) {
          throw new SedPanic(`couldn't open file ${name}: ${errText(e)}`);
        }
        writeFiles.set(name, o);
      }
      return o;
    },
    openRead: (name) => {
      let r = readFiles.get(name);
      if (!r) {
        r = new ReadFile(name);
        readFiles.set(name, r);
      }
      return r;
    },
  };
  const compiler = new SedCompiler(env);
  try {
    for (const ch of chunks) compiler.compile(ch);
    compiler.finish();
  } catch (e) {
    if (e instanceof SedCompileError) {
      await ctx.error(e.message);
      return 1;
    }
    if (e instanceof SedPanic) {
      await ctx.error(e.message);
      return 4;
    }
    throw e;
  }
  if (compiler.quietFromScript && chunks[0].kind === 'e') quiet = true;
  if (compiler.quietFromScript && chunks[0].kind === 'f') quiet = true;
  const cmds = compiler.cmds;

  if (inPlace && operands.length === 0) {
    await ctx.error('no input files');
    return 4;
  }

  // --- execution state
  let out = stdout;
  const flushAll = async () => {
    await stdout.flush();
    await stderr.flush();
    for (const o of writeFiles.values()) await o.flush();
  };
  const input = new SedInput(ctx, operands, delim, separate, flushAll);
  let inPlaceOut: SedOut | null = null;
  let inPlaceCapture: CaptureOutput | null = null;
  let status = 0;
  if (inPlace) {
    input.onFile = async (name) => {
      if (name === '-') {
        await flushAll();
        await ctx.error("couldn't edit -: not a regular file");
        status = 4;
        return false;
      }
      const node = ctx.fs.tryStat(name);
      if (!node) {
        await flushAll();
        let reason = 'No such file or directory';
        try {
          ctx.fs.stat(name);
        } catch (e) {
          reason = errText(e);
        }
        await ctx.error(`can't read ${name}: ${reason}`);
        status = 2;
        return false;
      }
      if (node.type !== 'file') {
        await flushAll();
        await ctx.error(`couldn't edit ${name}: not a regular file`);
        status = 4;
        return false;
      }
      inPlaceCapture = new CaptureOutput();
      inPlaceOut = new SedOut(inPlaceCapture);
      out = inPlaceOut;
      return true;
    };
    input.onFileDone = async (name) => {
      if (!inPlaceOut || !inPlaceCapture) return;
      await inPlaceOut.flush();
      const text = inPlaceCapture.text();
      try {
        if (suffix) {
          const base = basename(name);
          const backup = suffix.includes('*') ? (suffix.includes('/') ? suffix.replace(/\*/g, base) : dirname(name) + '/' + suffix.replace(/\*/g, base)) : name + suffix;
          ctx.fs.writeFile(backup, ctx.fs.readData(name));
        }
        ctx.fs.writeFile(name, text);
      } catch (e) {
        await ctx.error(`couldn't open temporary file ${dirname(name)}/sed${'XXXXXX'}: ${errText(e)}`);
        status = 4;
      }
      inPlaceOut = null;
      inPlaceCapture = null;
      out = stdout;
    };
  }

  let ps = '';
  let psChomped = true;
  let hold = '';
  let holdChomped = true;
  let replaced = false;
  let lastRe: RegExp | null = null;
  let appendQueue: ({ text: string } | { file: string } | { rline: ReadFile })[] = [];
  let quitStatus: number | null = null;
  let isLastCache: boolean | null = null;

  const isLast = async (): Promise<boolean> => {
    if (isLastCache === null) isLastCache = await input.isLast();
    return isLastCache;
  };
  const readLine = async (): Promise<boolean> => {
    const l = await input.next();
    isLastCache = null;
    if (!l) return false;
    ps = l.text;
    psChomped = l.chomped;
    return true;
  };
  const getRe = (r: SedRegex): RegExp => {
    if (r.re) {
      lastRe = r.re;
      return r.re;
    }
    if (!lastRe) throw new SedUsage(`-e expression #${Math.max(1, exprNum)}, char 0: no previous regular expression`);
    return lastRe;
  };
  const reTest = (r: SedRegex, s: string): boolean => {
    const re = getRe(r);
    re.lastIndex = 0;
    return re.test(s);
  };
  const dumpAppend = async () => {
    for (const a of appendQueue) {
      if ('text' in a) out.text(a.text);
      else if ('file' in a) {
        try {
          const node = ctx.fs.tryStat(a.file);
          if (node && node.type !== 'dir') out.raw(ctx.fs.readFile(a.file));
        } catch {
          // unreadable files are silently ignored
        }
      } else {
        const rf = a.rline;
        if (rf.lines === null) {
          try {
            const t = ctx.fs.readFile(rf.name);
            const parts = t.split('\n');
            rf.lines = parts.map((p, i) => (i < parts.length - 1 ? p + '\n' : p)).filter((p) => p !== '');
          } catch {
            rf.lines = [];
          }
        }
        if (rf.pos < rf.lines.length) out.raw(rf.lines[rf.pos++]);
      }
    }
    appendQueue = [];
  };

  const matchAddr = async (a: Addr): Promise<boolean> => {
    switch (a.kind) {
      case 'num':
        return input.lineNo === a.n;
      case 'step':
        return a.n === 0 ? input.lineNo % a.step === 0 : input.lineNo >= a.n && (input.lineNo - a.n) % a.step === 0;
      case 'last':
        return isLast();
      case 're':
        return reTest(a.re!, ps);
      default:
        return false;
    }
  };

  const matchCmd = async (c: SedCmd): Promise<boolean> => {
    if (!c.a1) return true;
    const l = input.lineNo;
    if (!c.a2) return matchAddr(c.a1);
    if (c.range === 'active') {
      const a2 = c.a2;
      if (a2.kind === 'num' || a2.kind === 'plus' || a2.kind === 'tilde') {
        if (l >= c.rangeEnd) c.range = 'inactive';
        return l <= c.rangeEnd;
      }
      if (await matchAddr(a2)) c.range = c.a1.kind === 'num' && c.a1.n === 0 ? 'closed' : 'inactive';
      return true;
    }
    if (c.a1.kind === 'num' && c.a1.n === 0) {
      // 0,/re/: the range is active from the start
      if (c.range === 'closed') return false;
      c.range = 'closed';
      if (await matchAddr(c.a2)) return true;
      c.range = 'active';
      return true;
    }
    if (!(await matchAddr(c.a1))) return false;
    const a2 = c.a2;
    switch (a2.kind) {
      case 'num':
        if (a2.n <= l) return true;
        c.rangeEnd = a2.n;
        break;
      case 'plus':
        if (a2.n === 0) return true;
        c.rangeEnd = l + a2.n;
        break;
      case 'tilde':
        if (a2.n === 0) return true;
        c.rangeEnd = l - (l % a2.n) + a2.n;
        break;
      case 'last':
        if (await isLast()) return true;
        break;
      default:
        break;
    }
    c.range = 'active';
    return true;
  };

  const runShell = async (command: string): Promise<string> => {
    await flushAll();
    const cap = new CaptureOutput();
    await ctx.exec(['sh', '-c', command], { stdout: cap });
    return cap.text();
  };

  const substitute = async (c: SedCmd): Promise<void> => {
    const sub = c.subst!;
    const re = getRe(sub.re);
    let pos = 0;
    let prevEnd = -1;
    let count = 0;
    let result = '';
    let last = 0;
    let did = false;
    const len = ps.length;
    while (pos <= len) {
      re.lastIndex = pos;
      const m = re.exec(ps);
      if (!m) break;
      const start = m.index;
      const end = start + m[0].length;
      if (start === end && start === prevEnd) {
        if (start >= len) break;
        pos = start + 1;
        continue;
      }
      count++;
      if (count >= sub.nth) {
        result += ps.slice(last, start) + expandReplacement(sub.repl, m);
        last = end;
        did = true;
        if (!sub.global) break;
      }
      prevEnd = end;
      pos = start === end ? end + 1 : end;
    }
    if (!did) return;
    ps = result + ps.slice(last);
    replaced = true;
    if (sub.evaluate) {
      let r = await runShell(ps);
      if (r.endsWith('\n')) r = r.slice(0, -1);
      ps = r;
    }
    if (sub.print) out.line(ps, psChomped, delim);
    if (sub.out) sub.out.line(ps, psChomped, delim);
  };

  /** Run the script over the current pattern space. Returns 'next' | 'restart' | 'quit'. */
  const runCycle = async (): Promise<'end' | 'delete' | 'restart' | 'quit'> => {
    let pc = 0;
    while (pc < cmds.length) {
      const c = cmds[pc];
      const hit = (await matchCmd(c)) !== c.bang;
      if (!hit) {
        pc = c.cmd === '{' ? c.jump : pc + 1;
        continue;
      }
      switch (c.cmd) {
        case '{':
        case '}':
        case ':':
          break;
        case '=':
          out.text(`${input.lineNo}\n`);
          break;
        case 'a':
          appendQueue.push({ text: c.text });
          break;
        case 'i':
          out.text(c.text);
          break;
        case 'c':
          if (c.range !== 'active') out.text(c.text);
          return 'delete';
        case 'b':
          pc = c.jump;
          continue;
        case 't':
          if (replaced) {
            replaced = false;
            pc = c.jump;
            continue;
          }
          break;
        case 'T':
          if (!replaced) {
            pc = c.jump;
            continue;
          }
          replaced = false;
          break;
        case 'd':
          return 'delete';
        case 'D': {
          const idx = ps.indexOf('\n');
          if (idx === -1) return 'delete';
          ps = ps.slice(idx + 1);
          return 'restart';
        }
        case 'e': {
          if (c.fname) {
            const r = await runShell(c.fname);
            out.text(r);
          } else {
            let r = await runShell(ps);
            if (r.endsWith('\n')) r = r.slice(0, -1);
            ps = r;
          }
          break;
        }
        case 'F':
          out.text(input.currentName + '\n');
          break;
        case 'g':
          ps = hold;
          psChomped = holdChomped;
          break;
        case 'G':
          ps += '\n' + hold;
          psChomped = holdChomped;
          break;
        case 'h':
          hold = ps;
          holdChomped = psChomped;
          break;
        case 'H':
          hold += '\n' + ps;
          holdChomped = psChomped;
          break;
        case 'x': {
          const t = ps;
          ps = hold;
          hold = t;
          const tc = psChomped;
          psChomped = holdChomped;
          holdChomped = tc;
          break;
        }
        case 'l':
          out.text(listLine(ps, c.int === -1 ? lineLength : c.int));
          break;
        case 'L':
          break;
        case 'n':
          if (await isLast()) {
            if (!quiet) out.line(ps, psChomped, delim);
            return 'quit';
          }
          if (!quiet) out.line(ps, psChomped, delim);
          await dumpAppend();
          if (!(await readLine())) return 'quit';
          break;
        case 'N': {
          if (await isLast()) {
            if (!quiet) out.line(ps, psChomped, delim);
            await dumpAppend();
            return 'quit';
          }
          await dumpAppend();
          const prev = ps;
          if (!(await readLine())) return 'quit';
          ps = prev + '\n' + ps;
          break;
        }
        case 'p':
          out.line(ps, psChomped, delim);
          break;
        case 'P': {
          const idx = ps.indexOf('\n');
          if (idx === -1) out.line(ps, psChomped, delim);
          else out.line(ps.slice(0, idx), true, '\n');
          break;
        }
        case 'q':
          if (!quiet) out.line(ps, psChomped, delim);
          await dumpAppend();
          quitStatus = c.int === -1 ? 0 : c.int;
          return 'quit';
        case 'Q':
          quitStatus = c.int === -1 ? 0 : c.int;
          appendQueue = [];
          return 'quit';
        case 'r':
          appendQueue.push({ file: c.fname });
          break;
        case 'R':
          appendQueue.push({ rline: c.rfile! });
          break;
        case 's':
          await substitute(c);
          break;
        case 'w':
          c.out!.line(ps, psChomped, delim);
          break;
        case 'W': {
          const idx = ps.indexOf('\n');
          c.out!.line(idx === -1 ? ps : ps.slice(0, idx), true, delim);
          break;
        }
        case 'y': {
          let r = '';
          for (const ch of ps) r += c.ymap!.get(ch) ?? ch;
          ps = r;
          break;
        }
        case 'z':
          ps = '';
          break;
        default:
          break;
      }
      pc++;
    }
    return 'end';
  };

  try {
    let cycles = 0;
    let restart = false;
    for (;;) {
      if (!restart) {
        if (!(await readLine())) break;
        replaced = false;
      }
      restart = false;
      if (++cycles % 256 === 0) {
        await ctx.checkpoint();
        if (stdout.buf.length > 65536) await stdout.flush();
      }
      const r = await runCycle();
      if (r === 'end') {
        if (!quiet) out.line(ps, psChomped, delim);
      } else if (r === 'restart') {
        await dumpAppend();
        restart = true;
        continue;
      } else if (r === 'quit') {
        await dumpAppend();
        break;
      }
      await dumpAppend();
      if (unbuffered || ctx.stdout.isTTY) await stdout.flush();
    }
    await input.finish();
  } catch (e) {
    await flushAll();
    if (e instanceof SedPanic) {
      if (e.message) await ctx.error(e.message);
      return 4;
    }
    if (e instanceof SedUsage) {
      await ctx.error(e.message);
      return 1;
    }
    throw e;
  }
  await flushAll();
  if (quitStatus !== null) return quitStatus;
  if (status) return status;
  return input.badFiles ? 2 : 0;
}

defineCommand({
  name: 'sed',
  pkg: 'sed',
  size: 113224,
  doc: SED_DOC,
  run: sedMain,
});
