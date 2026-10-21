// Abstract syntax tree for the subset of bash the simulator understands.

export type WordPart =
  /** Unquoted literal text (subject to brace, tilde and pathname expansion). */
  | { type: 'lit'; value: string }
  /** Text that is quoted or escaped: never globbed or split. */
  | { type: 'quoted'; value: string }
  /** "..." contents; parts inside are expanded but never split or globbed. */
  | { type: 'dq'; parts: WordPart[] }
  | { type: 'param'; param: ParamExpansion }
  | { type: 'cmdsub'; body: Script; raw: string }
  /** <(cmd) or >(cmd): replaced by a /dev/fd path connected to cmd. */
  | { type: 'procsub'; dir: '<' | '>'; body: Script; raw: string }
  | { type: 'arith'; expr: string }
  /** A leading ~ or ~user (only recognized in tilde-eligible positions). */
  | { type: 'tilde'; user: string };

export interface Word {
  parts: WordPart[];
  /** Original source text, used for error messages and history. */
  raw: string;
  /**
   * An argument of declare/local/export/readonly that looks like an
   * assignment: expanded like one (no word splitting; arrays allowed).
   */
  decl?: Assignment;
}

export type ParamOp =
  | { kind: 'plain' }
  | { kind: 'length' } // ${#x}
  | { kind: 'default'; colon: boolean; word: Word } // ${x:-w} ${x-w}
  | { kind: 'assign'; colon: boolean; word: Word } // ${x:=w}
  | { kind: 'alt'; colon: boolean; word: Word } // ${x:+w}
  | { kind: 'error'; colon: boolean; word: Word } // ${x:?w}
  | { kind: 'trim'; side: 'prefix' | 'suffix'; greedy: boolean; pattern: Word } // # ## % %%
  | { kind: 'replace'; all: boolean; anchor: '' | '#' | '%'; pattern: Word; replacement: Word | null }
  | { kind: 'substr'; offset: string; length: string | null }
  | { kind: 'case'; upper: boolean; all: boolean } // ^ ^^ , ,,
  | { kind: 'keys' } // ${!a[@]}
  /** Reported when expanded, like bash ("${x!}: bad substitution"). */
  | { kind: 'bad'; text: string };

export interface ParamExpansion {
  name: string; // variable name, digit, or special (@ * # ? $ ! - 0)
  op: ParamOp;
  /** ${!name} indirection */
  indirect?: boolean;
  /** Array subscript text: ${name[index]} (`@` and `*` mean all elements). */
  index?: string;
}

export type RedirOp =
  | '>'
  | '>>'
  | '>|'
  | '<'
  | '<>'
  | '>&'
  | '<&'
  | '&>'
  | '&>>'
  | '<<'
  | '<<-'
  | '<<<';

export interface Redirect {
  /** Explicit file descriptor (`2>`), or null for the operator's default. */
  fd: number | null;
  op: RedirOp;
  target: Word;
  /** For heredocs: the body text and whether expansions apply. */
  heredoc?: { body: string; expand: boolean; parsed?: Word };
}

export interface ArrayElement {
  /** [subscript]=value; null for a plain value */
  index: string | null;
  value: Word;
  /** [subscript]+=value */
  append?: boolean;
}

export interface Assignment {
  name: string;
  value: Word | null;
  append: boolean;
  /** name[index]=value */
  index?: string;
  /** name=(a b c) */
  array?: ArrayElement[];
}

export interface SimpleCommand {
  type: 'simple';
  assignments: Assignment[];
  words: Word[];
  redirects: Redirect[];
  line: number;
}

export interface Group {
  type: 'group';
  body: Script;
  redirects: Redirect[];
}

export interface Subshell {
  type: 'subshell';
  body: Script;
  redirects: Redirect[];
}

export interface IfClause {
  type: 'if';
  clauses: { cond: Script; body: Script }[];
  elseBody: Script | null;
  redirects: Redirect[];
}

export interface ForClause {
  type: 'for';
  name: string;
  /** null means `for x; do` which iterates over "$@" */
  words: Word[] | null;
  body: Script;
  redirects: Redirect[];
}

export interface ArithForClause {
  type: 'arith-for';
  init: string;
  cond: string;
  step: string;
  body: Script;
  redirects: Redirect[];
}

export interface WhileClause {
  type: 'while';
  until: boolean;
  cond: Script;
  body: Script;
  redirects: Redirect[];
}

export interface CaseClause {
  type: 'case';
  word: Word;
  items: { patterns: Word[]; body: Script; terminator: ';;' | ';&' | ';;&' }[];
  redirects: Redirect[];
}

export interface ArithCommand {
  type: 'arith-cmd';
  expr: string;
  redirects: Redirect[];
}

export type CondExpr =
  | { type: 'unary'; op: string; arg: Word }
  | { type: 'binary'; op: string; left: Word; right: Word }
  | { type: 'word'; word: Word }
  | { type: 'not'; expr: CondExpr }
  | { type: 'and'; left: CondExpr; right: CondExpr }
  | { type: 'or'; left: CondExpr; right: CondExpr };

export interface CondCommand {
  type: 'cond';
  expr: CondExpr;
  redirects: Redirect[];
}

export interface FunctionDef {
  type: 'function';
  name: string;
  body: Command;
  source: string;
}

export type Command =
  | SimpleCommand
  | Group
  | Subshell
  | IfClause
  | ForClause
  | ArithForClause
  | WhileClause
  | CaseClause
  | ArithCommand
  | CondCommand
  | FunctionDef;

export interface Pipeline {
  type: 'pipeline';
  negate: boolean;
  commands: Command[];
  /** `|&` between commands i and i+1 (pipe stderr too). */
  pipeStderr: boolean[];
  timed: boolean;
}

export interface AndOr {
  type: 'andor';
  first: Pipeline;
  rest: { op: '&&' | '||'; pipeline: Pipeline }[];
}

export interface ListItem {
  node: AndOr;
  background: boolean;
  /** Source text of this item (used for job names like "sleep 10 &"). */
  source: string;
  /** Nothing else follows on the same line (scripts abort line by line). */
  endsLine?: boolean;
}

export interface Script {
  type: 'script';
  items: ListItem[];
}

export const EMPTY_SCRIPT: Script = { type: 'script', items: [] };
