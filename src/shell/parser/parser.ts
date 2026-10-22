// A hand-written recursive-descent parser for a practical subset of bash.
//
// It works directly on the source text (no separate token stream) because
// bash's grammar is context sensitive: reserved words only count in command
// position, `=` makes assignments only before the command name, heredoc bodies
// start after the next newline, and aliases are expanded by re-reading text.

import type {
  ArrayElement,
  AndOr,
  Assignment,
  CaseClause,
  Command,
  CondExpr,
  ForClause,
  FunctionDef,
  IfClause,
  ListItem,
  ParamExpansion,
  ParamOp,
  Pipeline,
  RedirOp,
  Redirect,
  Script,
  SimpleCommand,
  WhileClause,
  Word,
  WordPart,
} from './ast';
import { decodeBytes } from '../util/bytes';

/** A genuine syntax error. `message` is what bash would print after "bash: ". */
export class ParseError extends Error {
  readonly line: number;
  readonly token: string | null;
  constructor(message: string, line: number, token: string | null = null) {
    super(message);
    this.line = line;
    this.token = token;
  }
}

/**
 * The input ended in the middle of a construct (open quote, trailing pipe,
 * unfinished `if`...). Interactive shells respond with the PS2 prompt.
 */
export class IncompleteInputError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export interface ParseOptions {
  /** Aliases to expand in command position (interactive shells only). */
  aliases?: Map<string, string>;
}

const META = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
const OPERATORS = [
  ';;&',
  '<<<',
  '<<-',
  '&>>',
  '&&',
  '||',
  ';;',
  ';&',
  '|&',
  '<<',
  '<>',
  '<&',
  '>>',
  '>&',
  '>|',
  '&>',
  '|',
  '&',
  ';',
  '<',
  '>',
  '(',
  ')',
  '\n',
];
const REDIR_OPS = new Set<string>(['<<<', '<<-', '&>>', '<<', '<>', '<&', '>>', '>&', '>|', '&>', '<', '>']);
const DECL_BUILTINS = new Set(['declare', 'typeset', 'local', 'export', 'readonly']);
const NOT_A_COMMAND = new Set(['then', 'else', 'elif', 'fi', 'do', 'done', 'esac', '}']);
const COND_UNARY = new Set([
  '-a', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-k', '-p', '-r', '-s', '-t', '-u', '-w', '-x',
  '-G', '-L', '-N', '-O', '-S', '-z', '-n', '-v', '-o',
]);
const COND_BINARY = new Set(['==', '=', '!=', '=~', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidName(s: string): boolean {
  return NAME_RE.test(s);
}

interface PendingHeredoc {
  redirect: Redirect;
  delimiter: string;
  stripTabs: boolean;
}

function tokenName(tok: string): string {
  return tok === '\n' ? 'newline' : tok;
}

export function parse(src: string, opts: ParseOptions = {}): Script {
  return new Parser(src, opts).parseProgram();
}

/** Parse `text` as the contents of a double-quoted string (used for heredocs and arithmetic). */
export function parseExpandableText(text: string, heredoc = true): Word {
  const p = new Parser(text, {});
  return p.parseLooseText(heredoc);
}

/** Parse text as a single word where blanks are literal (used by ${x:-...} etc). */
export function parseInnerWord(text: string): Word {
  const p = new Parser(text, {});
  return p.parseWholeWord();
}

class Parser {
  src: string;
  pos = 0;
  private readonly opts: ParseOptions;
  private heredocs: PendingHeredoc[] = [];
  private aliasRegions: { name: string; end: number }[] = [];
  private aliasNext = false;

  constructor(src: string, opts: ParseOptions) {
    this.src = src;
    this.opts = opts;
  }

  // ------------------------------------------------------------------
  // Low level helpers

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private lineAt(pos = this.pos): number {
    let n = 1;
    for (let i = 0; i < pos && i < this.src.length; i++) if (this.src.charCodeAt(i) === 10) n++;
    return n;
  }

  private error(tok: string): never {
    throw new ParseError(`syntax error near unexpected token \`${tokenName(tok)}'`, this.lineAt(), tokenName(tok));
  }

  private incomplete(reason: string): never {
    throw new IncompleteInputError(reason);
  }

  /** Report whatever token sits at the current position as unexpected. */
  private unexpectedHere(): never {
    if (this.eof()) this.incomplete('unexpected end of input');
    const op = this.peekOperator();
    if (op) this.error(op);
    const w = this.peekWordRaw();
    if (w) this.error(w);
    this.error(this.src[this.pos]);
  }

  private skipBlanks(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t') {
        this.pos++;
      } else if (c === '\\' && this.src[this.pos + 1] === '\n') {
        this.pos += 2;
      } else if (c === '\\' && this.pos + 1 === this.src.length) {
        this.incomplete('line continuation');
      } else if (c === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
      } else {
        break;
      }
    }
  }

  private consumeNewline(): void {
    this.pos++; // the '\n'
    while (this.heredocs.length > 0) {
      const h = this.heredocs.shift()!;
      this.readHeredocBody(h);
    }
  }

  private skipLinebreaks(): void {
    for (;;) {
      this.skipBlanks();
      if (this.src[this.pos] === '\n') this.consumeNewline();
      else break;
    }
  }

  private peekOperator(): string | null {
    const s = this.src;
    const p = this.pos;
    for (const op of OPERATORS) {
      if (s.startsWith(op, p)) {
        // `<(` and `>(` start a process substitution, which is a word
        if ((op === '<' || op === '>') && s[p + 1] === '(') return null;
        return op;
      }
    }
    return null;
  }

  /** The plain (unquoted, expansion-free) word at pos, or null. */
  private peekWordRaw(): string | null {
    let i = this.pos;
    const s = this.src;
    while (i < s.length && !META.has(s[i])) {
      const c = s[i];
      if (c === '"' || c === "'" || c === '\\' || c === '$' || c === '`') return null;
      i++;
    }
    if (i === this.pos) return null;
    return s.slice(this.pos, i);
  }

  private atReserved(word: string): boolean {
    return this.peekWordRaw() === word;
  }

  private expectReserved(word: string): void {
    this.skipBlanks();
    if (this.atReserved(word)) {
      this.pos += word.length;
      return;
    }
    this.unexpectedHere();
  }

  // ------------------------------------------------------------------
  // Grammar

  parseProgram(): Script {
    const script = this.parseList(null);
    this.skipBlanks();
    if (!this.eof()) this.unexpectedHere();
    if (this.heredocs.length > 0) this.incomplete('here-document');
    return script;
  }

  private atTerminator(terms: Set<string> | null): boolean {
    if (!terms) return false;
    const c = this.src[this.pos];
    if (c === ')' && terms.has(')')) return true;
    if (terms.has(';;')) {
      const op = this.peekOperator();
      if (op === ';;' || op === ';&' || op === ';;&') return true;
    }
    const w = this.peekWordRaw();
    return w !== null && terms.has(w);
  }

  private parseList(terms: Set<string> | null): Script {
    const items: ListItem[] = [];
    for (;;) {
      this.skipLinebreaks();
      if (this.eof()) {
        if (terms) this.incomplete('unterminated compound command');
        break;
      }
      if (this.atTerminator(terms)) break;
      const start = this.pos;
      const node = this.parseAndOr();
      const end = this.pos;
      this.skipBlanks();
      let background = false;
      const op = this.peekOperator();
      if (op === '&') {
        this.pos++;
        background = true;
      } else if (op === ';') {
        this.pos++;
      } else if (op === '\n' || this.eof() || this.atTerminator(terms)) {
        // fine: the loop or the caller handles it
      } else if (op === null) {
        this.unexpectedHere();
      } else {
        this.error(op);
      }
      const save = this.pos;
      this.skipBlanks();
      const endsLine = this.eof() || this.src[this.pos] === '\n';
      this.pos = save;
      items.push({ node, background, source: this.src.slice(start, end).trim(), endsLine });
    }
    return { type: 'script', items };
  }

  private parseAndOr(): AndOr {
    const first = this.parsePipeline();
    const rest: AndOr['rest'] = [];
    for (;;) {
      this.skipBlanks();
      const op = this.peekOperator();
      if (op === '&&' || op === '||') {
        this.pos += 2;
        this.skipLinebreaks();
        if (this.eof()) this.incomplete(`after ${op}`);
        rest.push({ op, pipeline: this.parsePipeline() });
      } else {
        break;
      }
    }
    return { type: 'andor', first, rest };
  }

  private parsePipeline(): Pipeline {
    this.skipBlanks();
    let timed = false;
    let negate = false;
    if (this.atReserved('time')) {
      this.pos += 4;
      timed = true;
      this.skipBlanks();
    }
    while (this.atReserved('!')) {
      this.pos += 1;
      negate = !negate;
      this.skipBlanks();
    }
    const commands: Command[] = [this.parseCommand()];
    const pipeStderr: boolean[] = [];
    for (;;) {
      this.skipBlanks();
      const op = this.peekOperator();
      if (op === '|' || op === '|&') {
        this.pos += op.length;
        pipeStderr.push(op === '|&');
        this.skipLinebreaks();
        if (this.eof()) this.incomplete('after |');
        commands.push(this.parseCommand());
      } else {
        break;
      }
    }
    return { type: 'pipeline', negate, commands, pipeStderr, timed };
  }

  private maybeExpandAlias(): void {
    const aliases = this.opts.aliases;
    if (!aliases || aliases.size === 0) return;
    for (let guard = 0; guard < 32; guard++) {
      const w = this.peekWordRaw();
      if (!w) return;
      this.aliasRegions = this.aliasRegions.filter((r) => r.end > this.pos);
      if (this.aliasRegions.some((r) => r.name === w)) return;
      const value = aliases.get(w);
      if (value === undefined) return;
      const end = this.pos + w.length;
      const delta = value.length - w.length;
      this.src = this.src.slice(0, this.pos) + value + this.src.slice(end);
      for (const r of this.aliasRegions) if (r.end >= end) r.end += delta;
      this.aliasRegions.push({ name: w, end: this.pos + value.length });
      this.aliasNext = /[ \t]$/.test(value);
    }
  }

  private parseCommand(): Command {
    this.skipBlanks();
    if (this.eof()) this.incomplete('expected a command');
    this.maybeExpandAlias();
    const op = this.peekOperator();
    if (op === '(') {
      if (this.src.startsWith('((', this.pos)) {
        const arith = this.tryParseArithCommand();
        if (arith) return arith;
      }
      this.pos++;
      const body = this.parseList(new Set([')']));
      if (this.src[this.pos] !== ')') this.unexpectedHere();
      this.pos++;
      if (body.items.length === 0) this.error(')');
      return { type: 'subshell', body, redirects: this.parseTrailingRedirects() };
    }
    if (op !== null && !REDIR_OPS.has(op)) this.error(op);

    const w = this.peekWordRaw();
    if (w !== null) {
      switch (w) {
        case '{': {
          this.pos++;
          const body = this.parseList(new Set(['}']));
          if (body.items.length === 0) this.unexpectedHere();
          this.expectReserved('}');
          return { type: 'group', body, redirects: this.parseTrailingRedirects() };
        }
        case 'if':
          return this.parseIf();
        case 'for':
          return this.parseFor();
        case 'while':
        case 'until':
          return this.parseWhile(w === 'until');
        case 'case':
          return this.parseCase();
        case 'function':
          return this.parseFunctionKeyword();
        case '[[':
          return this.parseCond();
        default:
          if (NOT_A_COMMAND.has(w)) this.error(w);
      }
      if (isValidName(w)) {
        const fn = this.tryParseFunctionDef(w);
        if (fn) return fn;
      }
    }
    return this.parseSimpleCommand();
  }

  private parseTrailingRedirects(): Redirect[] {
    const redirects: Redirect[] = [];
    for (;;) {
      this.skipBlanks();
      if (this.atRedirect()) redirects.push(this.parseRedirect());
      else break;
    }
    return redirects;
  }

  private parseRequiredList(terms: string[]): Script {
    const list = this.parseList(new Set(terms));
    if (list.items.length === 0) this.unexpectedHere();
    return list;
  }

  private parseIf(): IfClause {
    this.pos += 2;
    const clauses: IfClause['clauses'] = [];
    const cond = this.parseRequiredList(['then']);
    this.expectReserved('then');
    const body = this.parseRequiredList(['elif', 'else', 'fi']);
    clauses.push({ cond, body });
    let elseBody: Script | null = null;
    for (;;) {
      this.skipBlanks();
      if (this.atReserved('elif')) {
        this.pos += 4;
        const c = this.parseRequiredList(['then']);
        this.expectReserved('then');
        const b = this.parseRequiredList(['elif', 'else', 'fi']);
        clauses.push({ cond: c, body: b });
      } else if (this.atReserved('else')) {
        this.pos += 4;
        elseBody = this.parseRequiredList(['fi']);
        this.expectReserved('fi');
        break;
      } else if (this.atReserved('fi')) {
        this.pos += 2;
        break;
      } else {
        this.unexpectedHere();
      }
    }
    return { type: 'if', clauses, elseBody, redirects: this.parseTrailingRedirects() };
  }

  private parseFor(): Command {
    this.pos += 3;
    this.skipBlanks();
    if (this.src.startsWith('((', this.pos)) return this.parseArithFor();
    if (this.eof()) this.incomplete('for');
    const nameWord = this.readWord();
    if (!nameWord) this.unexpectedHere();
    const name = nameWord.raw;
    if (!isValidName(name)) throw new ParseError(`\`${name}': not a valid identifier`, this.lineAt());
    let words: Word[] | null = null;
    this.skipLinebreaks();
    if (this.eof()) this.incomplete('for');
    if (this.atReserved('in')) {
      this.pos += 2;
      words = [];
      for (;;) {
        this.skipBlanks();
        if (this.eof()) this.incomplete('for');
        const c = this.src[this.pos];
        if (c === ';' || c === '\n') break;
        if (this.peekOperator() && !this.atReserved('do')) this.unexpectedHere();
        const w = this.readWord();
        if (!w) this.unexpectedHere();
        words.push(w);
      }
      if (this.src[this.pos] === ';') this.pos++;
    } else if (this.src[this.pos] === ';') {
      this.pos++;
    }
    this.skipLinebreaks();
    if (this.eof()) this.incomplete('for');
    this.expectReserved('do');
    const body = this.parseRequiredList(['done']);
    this.expectReserved('done');
    const clause: ForClause = { type: 'for', name, words, body, redirects: [] };
    clause.redirects = this.parseTrailingRedirects();
    return clause;
  }

  private findArithClose(from: number): number {
    // returns index of the first char of the closing "))"
    let depth = 0;
    for (let i = from; i < this.src.length; i++) {
      const c = this.src[i];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) {
          if (this.src[i + 1] === ')') return i;
          return -2; // a lone ')' — not arithmetic
        }
        depth--;
      }
    }
    return -1;
  }

  private parseArithFor(): Command {
    const start = this.pos + 2;
    const close = this.findArithClose(start);
    if (close === -1) this.incomplete('((');
    if (close === -2) this.error(')');
    const inner = this.src.slice(start, close);
    const parts = inner.split(';');
    if (parts.length !== 3) throw new ParseError(`syntax error: arithmetic expression required`, this.lineAt());
    this.pos = close + 2;
    this.skipLinebreaks();
    if (this.src[this.pos] === ';') {
      this.pos++;
      this.skipLinebreaks();
    }
    if (this.eof()) this.incomplete('for');
    this.expectReserved('do');
    const body = this.parseRequiredList(['done']);
    this.expectReserved('done');
    return {
      type: 'arith-for',
      init: parts[0].trim(),
      cond: parts[1].trim(),
      step: parts[2].trim(),
      body,
      redirects: this.parseTrailingRedirects(),
    };
  }

  private tryParseArithCommand(): Command | null {
    const start = this.pos + 2;
    const close = this.findArithClose(start);
    if (close === -1) this.incomplete('((');
    if (close === -2) return null; // e.g. ((echo a); echo b) is a nested subshell
    const expr = this.src.slice(start, close);
    this.pos = close + 2;
    return { type: 'arith-cmd', expr: expr.trim(), redirects: this.parseTrailingRedirects() };
  }

  private parseWhile(until: boolean): WhileClause {
    this.pos += 5; // 'while' and 'until' are both five letters
    const cond = this.parseRequiredList(['do']);
    this.expectReserved('do');
    const body = this.parseRequiredList(['done']);
    this.expectReserved('done');
    return { type: 'while', until, cond, body, redirects: this.parseTrailingRedirects() };
  }

  private parseCase(): CaseClause {
    this.pos += 4;
    this.skipBlanks();
    if (this.eof()) this.incomplete('case');
    const word = this.readWord();
    if (!word) this.unexpectedHere();
    this.skipLinebreaks();
    if (this.eof()) this.incomplete('case');
    this.expectReserved('in');
    const items: CaseClause['items'] = [];
    for (;;) {
      this.skipLinebreaks();
      if (this.eof()) this.incomplete('case');
      if (this.atReserved('esac')) {
        this.pos += 4;
        break;
      }
      if (this.src[this.pos] === '(') {
        this.pos++;
        this.skipBlanks();
      }
      const patterns: Word[] = [];
      for (;;) {
        this.skipBlanks();
        if (this.eof()) this.incomplete('case');
        const w = this.readWord();
        if (!w) this.unexpectedHere();
        patterns.push(w);
        this.skipBlanks();
        const c = this.src[this.pos];
        if (c === '|') {
          this.pos++;
          continue;
        }
        if (c === ')') {
          this.pos++;
          break;
        }
        this.unexpectedHere();
      }
      const body = this.parseList(new Set([';;', 'esac']));
      this.skipBlanks();
      let terminator: ';;' | ';&' | ';;&' = ';;';
      const op = this.peekOperator();
      if (op === ';;' || op === ';&' || op === ';;&') {
        this.pos += op.length;
        terminator = op;
      } else if (!this.atReserved('esac')) {
        this.unexpectedHere();
      }
      items.push({ patterns, body, terminator });
    }
    return { type: 'case', word, items, redirects: this.parseTrailingRedirects() };
  }

  private tryParseFunctionDef(name: string): FunctionDef | null {
    const save = this.pos;
    const sourceStart = this.pos;
    this.pos += name.length;
    let i = this.pos;
    while (this.src[i] === ' ' || this.src[i] === '\t') i++;
    if (this.src[i] !== '(') {
      this.pos = save;
      return null;
    }
    i++;
    while (this.src[i] === ' ' || this.src[i] === '\t') i++;
    if (this.src[i] !== ')') {
      this.pos = save;
      return null;
    }
    this.pos = i + 1;
    this.skipLinebreaks();
    if (this.eof()) this.incomplete('function body');
    const body = this.parseCommand();
    if (body.type === 'simple') throw new ParseError(`syntax error near unexpected token \`${body.words[0]?.raw ?? 'newline'}'`, this.lineAt());
    return { type: 'function', name, body, source: this.src.slice(sourceStart, this.pos) };
  }

  private parseFunctionKeyword(): FunctionDef {
    const sourceStart = this.pos;
    this.pos += 8;
    this.skipBlanks();
    if (this.eof()) this.incomplete('function');
    const nameWord = this.readWord();
    if (!nameWord) this.unexpectedHere();
    const name = nameWord.raw;
    this.skipBlanks();
    if (this.src[this.pos] === '(') {
      let i = this.pos + 1;
      while (this.src[i] === ' ' || this.src[i] === '\t') i++;
      if (this.src[i] === ')') this.pos = i + 1;
    }
    this.skipLinebreaks();
    if (this.eof()) this.incomplete('function body');
    const body = this.parseCommand();
    return { type: 'function', name, body, source: this.src.slice(sourceStart, this.pos) };
  }

  // [[ expression ]]
  private parseCond(): Command {
    this.pos += 2;
    const tokens: { op?: string; word?: Word }[] = [];
    let prevOp: string | null = null;
    for (;;) {
      this.skipBlanks();
      while (this.src[this.pos] === '\n') {
        this.consumeNewline();
        this.skipBlanks();
      }
      if (this.eof()) this.incomplete('[[');
      if (this.src.startsWith(']]', this.pos) && (this.pos + 2 >= this.src.length || META.has(this.src[this.pos + 2]))) {
        this.pos += 2;
        break;
      }
      const s = this.src;
      if (s.startsWith('&&', this.pos) || s.startsWith('||', this.pos)) {
        tokens.push({ op: s.slice(this.pos, this.pos + 2) });
        this.pos += 2;
        prevOp = null;
        continue;
      }
      const c = s[this.pos];
      // after =~ the regex may start with an unquoted group: [[ $x =~ (a|b)+ ]]
      if ((c === '(' || c === ')') && prevOp !== '=~') {
        tokens.push({ op: c });
        this.pos++;
        continue;
      }
      if (c === '<' || c === '>') {
        tokens.push({ word: { parts: [{ type: 'lit', value: c }], raw: c } });
        this.pos++;
        prevOp = c;
        continue;
      }
      const w: Word | null = prevOp === '=~' ? this.readRegexWord() : this.readWord();
      if (!w) this.unexpectedHere();
      if (w.raw === '!') {
        tokens.push({ op: '!' });
      } else {
        tokens.push({ word: w });
      }
      prevOp = w.raw;
    }
    let i = 0;
    const peek = () => tokens[i];
    const fail = (): never => {
      const t = tokens[i];
      const tok = t ? (t.op ?? t.word!.raw) : ']]';
      throw new ParseError(`syntax error in conditional expression: unexpected token \`${tok}'`, this.lineAt(), tok);
    };
    const parseOr = (): CondExpr => {
      let left = parseAnd();
      while (peek()?.op === '||') {
        i++;
        left = { type: 'or', left, right: parseAnd() };
      }
      return left;
    };
    const parseAnd = (): CondExpr => {
      let left = parseNot();
      while (peek()?.op === '&&') {
        i++;
        left = { type: 'and', left, right: parseNot() };
      }
      return left;
    };
    const parseNot = (): CondExpr => {
      if (peek()?.op === '!') {
        i++;
        return { type: 'not', expr: parseNot() };
      }
      return parsePrimary();
    };
    const parsePrimary = (): CondExpr => {
      const t = peek();
      if (!t) fail();
      if (t.op === '(') {
        i++;
        const e = parseOr();
        if (peek()?.op !== ')') fail();
        i++;
        return e;
      }
      if (t.op) fail();
      const w = t.word!;
      const next = tokens[i + 1];
      if (COND_UNARY.has(w.raw) && next?.word && !(tokens[i + 2]?.word && COND_BINARY.has(tokens[i + 2].word!.raw))) {
        i += 2;
        return { type: 'unary', op: w.raw, arg: next.word };
      }
      if (next?.word && COND_BINARY.has(next.word.raw)) {
        const right = tokens[i + 2];
        if (!right?.word) {
          i += 2;
          fail();
        }
        i += 3;
        return { type: 'binary', op: next.word.raw, left: w, right: right.word! };
      }
      i++;
      return { type: 'word', word: w };
    };
    if (tokens.length === 0) fail();
    const expr = parseOr();
    if (i < tokens.length) fail();
    return { type: 'cond', expr, redirects: this.parseTrailingRedirects() };
  }

  private readRegexWord(): Word | null {
    // In `[[ x =~ re ]]` the regex may contain ( ) | without quoting.
    const start = this.pos;
    const parts: WordPart[] = [];
    let lit = '';
    const flush = () => {
      if (lit) parts.push({ type: 'lit', value: lit });
      lit = '';
    };
    let depth = 0;
    while (!this.eof()) {
      const c = this.src[this.pos];
      if ((c === ' ' || c === '\t' || c === '\n') && depth === 0) break;
      if (c === '(') depth++;
      if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      if (c === '\\' && this.pos + 1 < this.src.length) {
        flush();
        parts.push({ type: 'quoted', value: '\\' + this.src[this.pos + 1] });
        this.pos += 2;
        continue;
      }
      if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end === -1) this.incomplete("'");
        flush();
        parts.push({ type: 'quoted', value: this.src.slice(this.pos + 1, end) });
        this.pos = end + 1;
        continue;
      }
      if (c === '"') {
        flush();
        parts.push(this.parseDoubleQuoted());
        continue;
      }
      if (c === '$') {
        const part = this.parseDollar(false);
        if (part.type === 'lit') lit += part.value;
        else {
          flush();
          parts.push(part);
        }
        continue;
      }
      lit += c;
      this.pos++;
    }
    flush();
    if (this.pos === start) return null;
    return { parts, raw: this.src.slice(start, this.pos) };
  }

  private parseSimpleCommand(): SimpleCommand {
    const cmd: SimpleCommand = { type: 'simple', assignments: [], words: [], redirects: [], line: this.lineAt() };
    for (;;) {
      this.skipBlanks();
      if (this.eof()) break;
      if (this.atRedirect()) {
        cmd.redirects.push(this.parseRedirect());
        continue;
      }
      if (this.peekOperator() !== null) break;
      if (cmd.words.length === 0) {
        const assign = this.tryParseAssignment();
        if (assign) {
          cmd.assignments.push(assign);
          continue;
        }
        if (cmd.assignments.length > 0) this.maybeExpandAlias();
      } else if (this.aliasNext && cmd.words.length === 1) {
        this.aliasNext = false;
        this.maybeExpandAlias();
      }
      if (cmd.words.length > 0 && DECL_BUILTINS.has(cmd.words[0].raw)) {
        // declare x=$y and local a=(1 2) are assignments, not plain words
        const start = this.pos;
        const decl = this.tryParseAssignment();
        if (decl) {
          cmd.words.push({ parts: [], raw: this.src.slice(start, this.pos), decl });
          continue;
        }
      }
      const w = this.readWord();
      if (!w) break;
      cmd.words.push(w);
    }
    this.aliasNext = false;
    if (cmd.words.length === 0 && cmd.assignments.length === 0 && cmd.redirects.length === 0) {
      this.unexpectedHere();
    }
    return cmd;
  }

  private tryParseAssignment(): Assignment | null {
    const re = /[A-Za-z_][A-Za-z0-9_]*/y;
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    if (!m) return null;
    const s = this.src;
    let i = this.pos + m[0].length;
    let index: string | undefined;
    if (s[i] === '[') {
      const end = findSubscriptEnd(s, i + 1);
      if (end === -1) return null;
      index = s.slice(i + 1, end);
      i = end + 1;
    }
    let append = false;
    if (s[i] === '+' && s[i + 1] === '=') {
      append = true;
      i += 2;
    } else if (s[i] === '=') i++;
    else return null;
    this.pos = i;
    const name = m[0];
    if (index === undefined && s[this.pos] === '(') {
      this.pos++;
      const array: ArrayElement[] = [];
      for (;;) {
        this.skipLinebreaks();
        if (this.eof()) this.incomplete('array');
        if (s[this.pos] === ')') {
          this.pos++;
          break;
        }
        // [subscript]=value (or +=)
        if (s[this.pos] === '[') {
          const end = findSubscriptEnd(s, this.pos + 1);
          const plus = end !== -1 && s[end + 1] === '+' && s[end + 2] === '=';
          if (end !== -1 && (s[end + 1] === '=' || plus)) {
            const sub = s.slice(this.pos + 1, end);
            this.pos = end + (plus ? 3 : 2);
            const value = this.readWord({ assignment: true }) ?? { parts: [], raw: '' };
            array.push({ index: sub, value, append: plus });
            continue;
          }
        }
        const w = this.readWord();
        if (!w) this.unexpectedHere();
        array.push({ index: null, value: w });
      }
      return { name, value: null, append, array };
    }
    const value = this.readWord({ assignment: true });
    return { name, value, append, index };
  }

  private atRedirect(): boolean {
    const re = /[0-9]+(?=[<>](?!\())/y;
    re.lastIndex = this.pos;
    if (re.test(this.src)) return true;
    const op = this.peekOperator();
    return op !== null && REDIR_OPS.has(op);
  }

  private parseRedirect(): Redirect {
    let fd: number | null = null;
    const re = /[0-9]+(?=[<>](?!\())/y;
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    if (m) {
      fd = parseInt(m[0], 10);
      this.pos += m[0].length;
    }
    const op = this.peekOperator() as RedirOp;
    this.pos += op.length;
    this.skipBlanks();
    if (this.eof()) this.error('newline');
    const next = this.peekOperator();
    if (next !== null) this.error(next);
    const target = this.readWord();
    if (!target) this.unexpectedHere();
    const redirect: Redirect = { fd, op, target };
    if (op === '<<' || op === '<<-') {
      const expand = !target.parts.some((p) => p.type === 'quoted' || p.type === 'dq');
      const delimiter = target.parts
        .map((p) => (p.type === 'lit' || p.type === 'quoted' ? p.value : p.type === 'dq' ? literalOf(p.parts) : ''))
        .join('');
      redirect.heredoc = { body: '', expand };
      this.heredocs.push({ redirect, delimiter, stripTabs: op === '<<-' });
    }
    return redirect;
  }

  private readHeredocBody(h: PendingHeredoc): void {
    const lines: string[] = [];
    for (;;) {
      if (this.eof()) this.incomplete('here-document');
      const nl = this.src.indexOf('\n', this.pos);
      const lineEnd = nl === -1 ? this.src.length : nl;
      let text = this.src.slice(this.pos, lineEnd);
      if (h.stripTabs) text = text.replace(/^\t+/, '');
      if (text === h.delimiter) {
        this.pos = nl === -1 ? this.src.length : nl + 1;
        break;
      }
      if (nl === -1) this.incomplete('here-document');
      lines.push(text);
      this.pos = nl + 1;
    }
    const body = lines.map((l) => l + '\n').join('');
    h.redirect.heredoc!.body = body;
    if (h.redirect.heredoc!.expand) h.redirect.heredoc!.parsed = parseExpandableText(body, true);
  }

  // ------------------------------------------------------------------
  // Words

  private readWord(opts: { assignment?: boolean } = {}): Word | null {
    const start = this.pos;
    const parts: WordPart[] = [];
    let lit = '';
    const flush = () => {
      if (lit) parts.push({ type: 'lit', value: lit });
      lit = '';
    };
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if ((c === '<' || c === '>') && this.src[this.pos + 1] === '(') {
        flush();
        parts.push(this.parseProcSub());
        continue;
      }
      if (META.has(c)) break;
      if (c === '\\') {
        const n = this.src[this.pos + 1];
        if (n === undefined) this.incomplete('line continuation');
        if (n === '\n') {
          this.pos += 2;
          continue;
        }
        flush();
        parts.push({ type: 'quoted', value: n });
        this.pos += 2;
        continue;
      }
      if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end === -1) this.incomplete("'");
        flush();
        parts.push({ type: 'quoted', value: this.src.slice(this.pos + 1, end) });
        this.pos = end + 1;
        continue;
      }
      if (c === '"') {
        flush();
        parts.push(this.parseDoubleQuoted());
        continue;
      }
      if (c === '$') {
        const part = this.parseDollar(false);
        if (part.type === 'lit') lit += part.value;
        else {
          flush();
          parts.push(part);
        }
        continue;
      }
      if (c === '`') {
        flush();
        parts.push(this.parseBacktick());
        continue;
      }
      lit += c;
      this.pos++;
    }
    flush();
    if (this.pos === start) return null;
    const word: Word = { parts, raw: this.src.slice(start, this.pos) };
    applyTilde(word, !!opts.assignment);
    return word;
  }

  /** Read the whole remaining source as one word (blanks are literal). */
  parseWholeWord(): Word {
    const parts: WordPart[] = [];
    let lit = '';
    const flush = () => {
      if (lit) parts.push({ type: 'lit', value: lit });
      lit = '';
    };
    while (!this.eof()) {
      const c = this.src[this.pos];
      if (c === '\\' && this.pos + 1 < this.src.length) {
        flush();
        parts.push({ type: 'quoted', value: this.src[this.pos + 1] });
        this.pos += 2;
      } else if (c === "'") {
        const end = this.src.indexOf("'", this.pos + 1);
        if (end === -1) {
          lit += c;
          this.pos++;
          continue;
        }
        flush();
        parts.push({ type: 'quoted', value: this.src.slice(this.pos + 1, end) });
        this.pos = end + 1;
      } else if (c === '"') {
        flush();
        parts.push(this.parseDoubleQuoted());
      } else if (c === '$') {
        const part = this.parseDollar(false);
        if (part.type === 'lit') lit += part.value;
        else {
          flush();
          parts.push(part);
        }
      } else if (c === '`') {
        flush();
        parts.push(this.parseBacktick());
      } else {
        lit += c;
        this.pos++;
      }
    }
    flush();
    const word: Word = { parts, raw: this.src };
    applyTilde(word, false);
    return word;
  }

  /**
   * Heredoc / arithmetic text: like double quotes, but `"` is literal.
   * With heredoc=false (arithmetic), backslashes are kept literally.
   */
  parseLooseText(heredoc: boolean): Word {
    const parts: WordPart[] = [];
    let lit = '';
    const flush = () => {
      if (lit) parts.push({ type: 'quoted', value: lit });
      lit = '';
    };
    while (!this.eof()) {
      const c = this.src[this.pos];
      if (c === '\\' && heredoc) {
        const n = this.src[this.pos + 1];
        if (n === '$' || n === '`' || n === '\\') {
          lit += n;
          this.pos += 2;
        } else if (n === '\n') {
          this.pos += 2;
        } else {
          lit += c;
          this.pos++;
        }
      } else if (c === '$') {
        const part = this.parseDollar(true);
        if (part.type === 'lit') lit += part.value;
        else {
          flush();
          parts.push(part);
        }
      } else if (c === '`') {
        flush();
        parts.push(this.parseBacktick());
      } else {
        lit += c;
        this.pos++;
      }
    }
    flush();
    return { parts: [{ type: 'dq', parts }], raw: this.src };
  }

  private parseDoubleQuoted(): WordPart {
    this.pos++; // opening "
    const parts: WordPart[] = [];
    let lit = '';
    const flush = () => {
      if (lit) parts.push({ type: 'quoted', value: lit });
      lit = '';
    };
    for (;;) {
      if (this.eof()) this.incomplete('"');
      const c = this.src[this.pos];
      if (c === '"') {
        this.pos++;
        break;
      }
      if (c === '\\') {
        const n = this.src[this.pos + 1];
        if (n === undefined) this.incomplete('"');
        if (n === '$' || n === '`' || n === '"' || n === '\\') {
          lit += n;
          this.pos += 2;
        } else if (n === '\n') {
          this.pos += 2;
        } else {
          lit += '\\';
          this.pos++;
        }
        continue;
      }
      if (c === '$') {
        const part = this.parseDollar(true);
        if (part.type === 'lit') lit += part.value;
        else {
          flush();
          parts.push(part);
        }
        continue;
      }
      if (c === '`') {
        flush();
        parts.push(this.parseBacktick());
        continue;
      }
      lit += c;
      this.pos++;
    }
    flush();
    return { type: 'dq', parts };
  }

  private parseBacktick(): WordPart {
    this.pos++;
    let inner = '';
    for (;;) {
      if (this.eof()) this.incomplete('`');
      const c = this.src[this.pos];
      if (c === '`') {
        this.pos++;
        break;
      }
      if (c === '\\') {
        const n = this.src[this.pos + 1];
        if (n === '`' || n === '$' || n === '\\') {
          inner += n;
          this.pos += 2;
          continue;
        }
      }
      inner += c;
      this.pos++;
    }
    const body = new Parser(inner, this.opts).parseProgram();
    return { type: 'cmdsub', body, raw: inner };
  }

  private parseProcSub(): WordPart {
    const dir = this.src[this.pos] as '<' | '>';
    this.pos += 2;
    const bodyStart = this.pos;
    const body = this.parseList(new Set([')']));
    if (this.src[this.pos] !== ')') this.unexpectedHere();
    const raw = this.src.slice(bodyStart, this.pos);
    this.pos++;
    return { type: 'procsub', dir, body, raw };
  }

  private parseDollar(inDQ: boolean): WordPart {
    const n = this.src[this.pos + 1];
    if (n === '(') {
      if (this.src[this.pos + 2] === '(') {
        const close = this.findArithClose(this.pos + 3);
        if (close === -1) this.incomplete('$((');
        if (close >= 0) {
          const expr = this.src.slice(this.pos + 3, close);
          this.pos = close + 2;
          return { type: 'arith', expr };
        }
      }
      this.pos += 2;
      const bodyStart = this.pos;
      const body = this.parseList(new Set([')']));
      if (this.src[this.pos] !== ')') this.unexpectedHere();
      const raw = this.src.slice(bodyStart, this.pos);
      this.pos++;
      return { type: 'cmdsub', body, raw };
    }
    if (n === '{') {
      return this.parseBraceParam();
    }
    if (n === "'" && !inDQ) {
      const { value, end } = parseAnsiC(this.src, this.pos + 2);
      if (end === -1) this.incomplete("$'");
      this.pos = end;
      return { type: 'quoted', value };
    }
    if (n === '"' && !inDQ) {
      this.pos++;
      return this.parseDoubleQuoted();
    }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      const re = /[A-Za-z_][A-Za-z0-9_]*/y;
      re.lastIndex = this.pos + 1;
      const m = re.exec(this.src)!;
      this.pos += 1 + m[0].length;
      return { type: 'param', param: { name: m[0], op: { kind: 'plain' } } };
    }
    if (n !== undefined && /[0-9@*#?$!\-]/.test(n)) {
      this.pos += 2;
      return { type: 'param', param: { name: n, op: { kind: 'plain' } } };
    }
    this.pos++;
    return { type: 'lit', value: '$' };
  }

  private parseBraceParam(): WordPart {
    const start = this.pos + 2;
    let i = start;
    let depth = 0;
    const s = this.src;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === "'") {
        const e = s.indexOf("'", i + 1);
        if (e === -1) this.incomplete("'");
        i = e + 1;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      if (c === '$' && s[i + 1] === '{') {
        depth++;
        i += 2;
        continue;
      }
      if (c === '}') {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    if (i >= s.length) this.incomplete('${');
    const inner = s.slice(start, i);
    this.pos = i + 1;
    return { type: 'param', param: parseParamInner(inner, this.lineAt()) };
  }
}

function literalOf(parts: WordPart[]): string {
  return parts.map((p) => (p.type === 'lit' || p.type === 'quoted' ? p.value : '')).join('');
}

function applyTilde(word: Word, assignment: boolean): void {
  const first = word.parts[0];
  const v = first?.type === 'lit' ? first.value : '';
  if (v.startsWith('~')) {
    const slash = v.indexOf('/');
    const colon = assignment ? v.indexOf(':') : -1;
    let end = slash;
    if (colon !== -1 && (end === -1 || colon < end)) end = colon;
    if (end === -1) {
      if (word.parts.length === 1) {
        word.parts.splice(0, 1, { type: 'tilde', user: v.slice(1) });
      }
    } else {
      const user = v.slice(1, end);
      word.parts.splice(0, 1, { type: 'tilde', user }, { type: 'lit', value: v.slice(end) });
    }
  }
  if (assignment) {
    // tilde after ':' in assignments (PATH=~/bin:~/.local/bin)
    for (let idx = 0; idx < word.parts.length; idx++) {
      const p = word.parts[idx];
      if (p.type !== 'lit') continue;
      const m = /:~([^/:]*)(?=$|[/:])/.exec(p.value);
      if (!m) continue;
      const before = p.value.slice(0, m.index + 1);
      const after = p.value.slice(m.index + m[0].length);
      const repl: WordPart[] = [{ type: 'lit', value: before }, { type: 'tilde', user: m[1] }];
      if (after) repl.push({ type: 'lit', value: after });
      word.parts.splice(idx, 1, ...repl);
      idx += repl.length - 2;
    }
  }
}

/** Parse $'...' ANSI-C quoting. `from` points just after the opening quote. */
export function parseAnsiC(s: string, from: number): { value: string; end: number } {
  let out = '';
  let bytes: number[] = [];
  const add = (t: string) => {
    if (bytes.length) {
      out += decodeBytes(bytes);
      bytes = [];
    }
    out += t;
  };
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      add('');
      return { value: out, end: i + 1 };
    }
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      i += 2;
      switch (n) {
        case 'n': add('\n'); break;
        case 't': add('\t'); break;
        case 'r': add('\r'); break;
        case 'a': add('\x07'); break;
        case 'b': add('\b'); break;
        case 'e':
        case 'E': add('\x1b'); break;
        case 'f': add('\f'); break;
        case 'v': add('\v'); break;
        case '\\': add('\\'); break;
        case "'": add("'"); break;
        case '"': add('"'); break;
        case '?': add('?'); break;
        case 'x': {
          const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i));
          if (m) {
            bytes.push(parseInt(m[0], 16));
            i += m[0].length;
          } else add('\\x');
          break;
        }
        case 'u':
        case 'U': {
          const m = (n === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(s.slice(i));
          if (m) {
            add(String.fromCodePoint(parseInt(m[0], 16)));
            i += m[0].length;
          } else add('\\' + n);
          break;
        }
        default:
          if (/[0-7]/.test(n)) {
            const m = /^[0-7]{0,2}/.exec(s.slice(i))!;
            bytes.push(parseInt(n + m[0], 8) & 255);
            i += m[0].length;
          } else {
            add('\\' + n);
          }
      }
      continue;
    }
    add(c);
    i++;
  }
  add('');
  return { value: out, end: -1 };
}

class BadSubstitution extends Error {}

function badSubstitution(_inner: string, _line: number): never {
  throw new BadSubstitution();
}

/** Index of the `]` that closes a subscript starting at `from`, or -1. */
export function findSubscriptEnd(s: string, from: number): number {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
    } else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e === -1) return -1;
      i = e;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') i++;
        i++;
      }
      if (i >= s.length) return -1;
    } else if (c === '\n') {
      return -1;
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** Split `pattern/replacement` at the first unquoted, unescaped slash. */
function splitReplace(s: string): [string, string | null] {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      i = e === -1 ? s.length : e + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '/') return [s.slice(0, i), s.slice(i + 1)];
    i++;
  }
  return [s, null];
}

/** Bad substitutions are reported when the word is expanded, as in bash. */
function parseParamInner(inner: string, line: number): ParamExpansion {
  try {
    return parseParamStrict(inner, line);
  } catch (e) {
    if (e instanceof BadSubstitution) return { name: '', op: { kind: 'bad', text: inner } };
    throw e;
  }
}

function parseParamStrict(inner: string, line: number): ParamExpansion {
  if (inner === '') badSubstitution(inner, line);
  let indirect = false;
  let body = inner;
  if (body.startsWith('#') && body.length > 1) {
    const rest = body.slice(1);
    if (/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!\-])$/.test(rest)) {
      return { name: rest, op: { kind: 'length' } };
    }
    const am = /^[A-Za-z_][A-Za-z0-9_]*\[/.exec(rest);
    if (am) {
      const end = findSubscriptEnd(rest, am[0].length);
      if (end === rest.length - 1) return { name: am[0].slice(0, -1), index: rest.slice(am[0].length, end), op: { kind: 'length' } };
    }
  }
  if (body.startsWith('!') && body.length > 1) {
    indirect = true;
    body = body.slice(1);
  }
  const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!\-])/.exec(body);
  if (!m) badSubstitution(inner, line);
  const name = m[1];
  let rest = body.slice(name.length);
  let index: string | undefined;
  if (rest.startsWith('[') && /^[A-Za-z_]/.test(name)) {
    const end = findSubscriptEnd(rest, 1);
    if (end === -1) badSubstitution(inner, line);
    index = rest.slice(1, end);
    rest = rest.slice(end + 1);
    if (indirect && (index === '@' || index === '*') && rest === '') return { name, index, op: { kind: 'keys' } };
  }
  let op: ParamOp;
  if (rest === '') {
    op = { kind: 'plain' };
  } else if (/^:[-=+?]/.test(rest)) {
    const word = parseInnerWord(rest.slice(2));
    const kindMap = { '-': 'default', '=': 'assign', '+': 'alt', '?': 'error' } as const;
    op = { kind: kindMap[rest[1] as '-' | '=' | '+' | '?'], colon: true, word };
  } else if (/^[-=+?]/.test(rest)) {
    const word = parseInnerWord(rest.slice(1));
    const kindMap = { '-': 'default', '=': 'assign', '+': 'alt', '?': 'error' } as const;
    op = { kind: kindMap[rest[0] as '-' | '=' | '+' | '?'], colon: false, word };
  } else if (rest.startsWith('##') || rest.startsWith('#')) {
    const greedy = rest.startsWith('##');
    op = { kind: 'trim', side: 'prefix', greedy, pattern: parseInnerWord(rest.slice(greedy ? 2 : 1)) };
  } else if (rest.startsWith('%%') || rest.startsWith('%')) {
    const greedy = rest.startsWith('%%');
    op = { kind: 'trim', side: 'suffix', greedy, pattern: parseInnerWord(rest.slice(greedy ? 2 : 1)) };
  } else if (rest.startsWith('/')) {
    let r = rest.slice(1);
    let all = false;
    let anchor: '' | '#' | '%' = '';
    if (r.startsWith('/')) {
      all = true;
      r = r.slice(1);
    } else if (r.startsWith('#')) {
      anchor = '#';
      r = r.slice(1);
    } else if (r.startsWith('%')) {
      anchor = '%';
      r = r.slice(1);
    }
    const [pat, repl] = splitReplace(r);
    op = {
      kind: 'replace',
      all,
      anchor,
      pattern: parseInnerWord(pat),
      replacement: repl === null ? null : parseInnerWord(repl),
    };
  } else if (rest.startsWith(':')) {
    const spec = rest.slice(1);
    const idx = spec.indexOf(':');
    op = idx === -1 ? { kind: 'substr', offset: spec, length: null } : { kind: 'substr', offset: spec.slice(0, idx), length: spec.slice(idx + 1) };
  } else if (rest === '^^' || rest === '^') {
    op = { kind: 'case', upper: true, all: rest === '^^' };
  } else if (rest === ',,' || rest === ',') {
    op = { kind: 'case', upper: false, all: rest === ',,' };
  } else {
    badSubstitution(inner, line);
  }
  return index === undefined ? { name, op, indirect } : { name, op, indirect, index };
}
