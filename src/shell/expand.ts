// Word expansion, in bash's order: brace expansion; tilde, parameter,
// command and arithmetic expansion; word splitting; pathname expansion;
// quote removal.

import { expandGlob, hasGlobChars, matchPattern } from './glob';
import type { IO, Shell } from './interpreter';
import type { ArrayElement, Assignment, ParamExpansion, ParamOp, Word, WordPart } from './parser/ast';
import { parseInnerWord } from './parser/parser';

/** An expansion failed; bash prints "bash: <message>". */
export class ExpansionError extends Error {
  /** In a script, this error aborts the script (like `set -u` failures). */
  readonly fatal: boolean;
  constructor(message: string, fatal = false) {
    super(message);
    this.fatal = fatal;
  }
}

/** One field during expansion. mask: q = quoted, l = unquoted literal, e = unquoted expansion result. */
interface Field {
  text: string;
  mask: string;
  quoted: boolean;
}

class FieldBuilder {
  list: Field[] = [];
  cur: Field = { text: '', mask: '', quoted: false };
  add(text: string, kind: 'q' | 'l' | 'e'): void {
    if (text === '') return;
    this.cur.text += text;
    this.cur.mask += kind.repeat(text.length);
  }
  markQuoted(): void {
    this.cur.quoted = true;
  }
  split(): void {
    this.list.push(this.cur);
    this.cur = { text: '', mask: '', quoted: false };
  }
  done(): Field[] {
    this.list.push(this.cur);
    return this.list;
  }
}

// ---------------------------------------------------------------------------
// Brace expansion

type Tok = { c: string } | { part: WordPart };

function flatten(parts: WordPart[]): Tok[] {
  const out: Tok[] = [];
  for (const p of parts) {
    if (p.type === 'lit') for (const c of p.value) out.push({ c });
    else out.push({ part: p });
  }
  return out;
}

function regroup(toks: Tok[]): WordPart[] {
  const parts: WordPart[] = [];
  let lit = '';
  for (const t of toks) {
    if ('c' in t) lit += t.c;
    else {
      if (lit) parts.push({ type: 'lit', value: lit });
      lit = '';
      parts.push(t.part);
    }
  }
  if (lit) parts.push({ type: 'lit', value: lit });
  return parts;
}

function litTokens(s: string): Tok[] {
  return [...s].map((c) => ({ c }));
}

function sequence(inner: string): string[] | null {
  let m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    let step = m[3] ? Math.abs(parseInt(m[3], 10)) : 1;
    if (step === 0) step = 1;
    const width = /^-?0\d/.test(m[1]) || /^-?0\d/.test(m[2]) ? Math.max(m[1].length, m[2].length) : 0;
    const out: string[] = [];
    const dir = a <= b ? 1 : -1;
    for (let n = a; dir > 0 ? n <= b : n >= b; n += dir * step) {
      let s = String(Math.abs(n));
      if (width) s = s.padStart(width - (n < 0 ? 1 : 0), '0');
      out.push((n < 0 ? '-' : '') + s);
      if (out.length > 100000) break;
    }
    return out;
  }
  m = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(inner);
  if (m) {
    const a = m[1].charCodeAt(0);
    const b = m[2].charCodeAt(0);
    let step = m[3] ? Math.abs(parseInt(m[3], 10)) : 1;
    if (step === 0) step = 1;
    const out: string[] = [];
    const dir = a <= b ? 1 : -1;
    for (let n = a; dir > 0 ? n <= b : n >= b; n += dir * step) out.push(String.fromCharCode(n));
    return out;
  }
  return null;
}

function expandBraceTokens(toks: Tok[], depth = 0): Tok[][] {
  if (depth > 64) return [toks];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!('c' in t) || t.c !== '{') continue;
    // find matching close brace and top-level commas
    let level = 0;
    const commas: number[] = [];
    let close = -1;
    for (let j = i + 1; j < toks.length; j++) {
      const u = toks[j];
      if (!('c' in u)) continue;
      if (u.c === '{') level++;
      else if (u.c === '}') {
        if (level === 0) {
          close = j;
          break;
        }
        level--;
      } else if (u.c === ',' && level === 0) commas.push(j);
    }
    if (close === -1) continue;
    const prefix = toks.slice(0, i);
    const suffix = toks.slice(close + 1);
    if (commas.length > 0) {
      const alts: Tok[][] = [];
      let start = i + 1;
      for (const c of [...commas, close]) {
        alts.push(toks.slice(start, c));
        start = c + 1;
      }
      const out: Tok[][] = [];
      for (const alt of alts) {
        for (const e of expandBraceTokens([...prefix, ...alt, ...suffix], depth + 1)) out.push(e);
      }
      return out;
    }
    const inner = toks.slice(i + 1, close);
    if (inner.every((x) => 'c' in x)) {
      const text = inner.map((x) => (x as { c: string }).c).join('');
      const seq = sequence(text);
      if (seq) {
        const out: Tok[][] = [];
        for (const s of seq) {
          for (const e of expandBraceTokens([...prefix, ...litTokens(s), ...suffix], depth + 1)) out.push(e);
        }
        return out;
      }
    }
  }
  return [toks];
}

export function braceExpand(word: Word): Word[] {
  if (!word.parts.some((p) => p.type === 'lit' && p.value.includes('{'))) return [word];
  const results = expandBraceTokens(flatten(word.parts));
  return results.map((toks) => ({ parts: regroup(toks), raw: word.raw }));
}

// ---------------------------------------------------------------------------
// Parameter expansion

function trimPattern(value: string, pattern: string, side: 'prefix' | 'suffix', greedy: boolean): string {
  const n = value.length;
  if (side === 'prefix') {
    if (greedy) {
      for (let i = n; i >= 0; i--) if (matchPattern(pattern, value.slice(0, i))) return value.slice(i);
    } else {
      for (let i = 0; i <= n; i++) if (matchPattern(pattern, value.slice(0, i))) return value.slice(i);
    }
  } else if (greedy) {
    for (let i = 0; i <= n; i++) if (matchPattern(pattern, value.slice(i))) return value.slice(0, i);
  } else {
    for (let i = n; i >= 0; i--) if (matchPattern(pattern, value.slice(i))) return value.slice(0, i);
  }
  return value;
}

function replacePattern(value: string, pattern: string, repl: string, all: boolean, anchor: '' | '#' | '%'): string {
  if (pattern === '') return value;
  const n = value.length;
  if (anchor === '#') {
    for (let j = n; j >= 0; j--) if (matchPattern(pattern, value.slice(0, j))) return repl + value.slice(j);
    return value;
  }
  if (anchor === '%') {
    for (let i = 0; i <= n; i++) if (matchPattern(pattern, value.slice(i))) return value.slice(0, i) + repl;
    return value;
  }
  let out = '';
  let i = 0;
  let replaced = false;
  while (i < n) {
    let matchEnd = -1;
    if (!replaced || all) {
      for (let j = n; j > i; j--) {
        if (matchPattern(pattern, value.slice(i, j))) {
          matchEnd = j;
          break;
        }
      }
    }
    if (matchEnd > i) {
      out += repl;
      i = matchEnd;
      replaced = true;
    } else {
      out += value[i];
      i++;
    }
  }
  return out;
}

/** $@, $*, ${a[@]}, ${a[*]} and ${!a[@]} expand to lists ("*": joined with IFS in quotes). */
interface ListValue {
  list: string[];
  star: boolean;
}

type ParamResult = string | ListValue;

function sq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Elements of an array as [key, value] (dynamic arrays like FUNCNAME included). */
function arrayEntries(sh: Shell, name: string): [string, string][] {
  return sh.state.entries(name);
}

/** The key for name[index]: an arithmetic index, or for associative arrays a string. */
export async function subscriptKey(sh: Shell, name: string, index: string, io: IO): Promise<string | number> {
  if (sh.state.isAssoc(name)) return expandToString(sh, parseInnerWord(index), io);
  return sh.arithmetic(index, io);
}

async function elementValue(sh: Shell, name: string, index: string, io: IO): Promise<string | undefined> {
  const key = await subscriptKey(sh, name, index, io);
  const v = sh.state.getElement(name, key);
  if (v === null) {
    // bash complains but carries on with an empty value
    await sh.printError(io, `${name}: bad array subscript`);
    return undefined;
  }
  return v;
}

async function listOp(sh: Shell, name: string, isArray: boolean, star: boolean, op: ParamOp, io: IO): Promise<ParamResult> {
  const entries = isArray ? arrayEntries(sh, name) : null;
  const values = entries ? entries.map(([, v]) => v) : [...sh.state.positional];
  const label = isArray ? `${name}[${star ? '*' : '@'}]` : name;
  const list = (l: string[]): ListValue => ({ list: l, star });
  switch (op.kind) {
    case 'plain':
    case 'keys':
      return list(values);
    case 'bad':
      throw new ExpansionError(`\${${op.text}}: bad substitution`);
    case 'length':
      return String(values.length);
    case 'default':
    case 'assign':
    case 'alt':
    case 'error': {
      const present = op.colon ? values.join('') !== '' : values.length > 0;
      if (op.kind === 'alt') return present ? expandToString(sh, op.word, io) : list([]);
      if (present) return list(values);
      if (op.kind === 'default') return expandToString(sh, op.word, io);
      if (op.kind === 'assign') throw new ExpansionError(`${label}: cannot assign in this way`);
      const msg = await expandToString(sh, op.word, io);
      throw new ExpansionError(`${label}: ${msg || (op.colon ? 'parameter null or not set' : 'parameter not set')}`, true);
    }
    case 'trim': {
      const pat = await expandToPattern(sh, op.pattern, io);
      return list(values.map((v) => trimPattern(v, pat, op.side, op.greedy)));
    }
    case 'replace': {
      const pat = await expandToPattern(sh, op.pattern, io);
      const repl = op.replacement ? await expandToString(sh, op.replacement, io) : '';
      return list(values.map((v) => replacePattern(v, pat, repl, op.all, op.anchor)));
    }
    case 'case':
      return list(values.map((v) => changeCase(v, op.upper, op.all)));
    case 'substr': {
      const off = await sh.arithmetic(op.offset, io);
      const len = op.length === null ? null : await sh.arithmetic(op.length, io);
      if (len !== null && len < 0) throw new ExpansionError(`${op.length}: substring expression < 0`);
      let slice: string[];
      if (entries && !sh.state.isAssoc(name)) {
        // offsets of an indexed array are indices: elements from ${a[off]} on
        const max = entries.length ? Number(entries[entries.length - 1][0]) : -1;
        const start = off < 0 ? max + 1 + off : off;
        slice = start < 0 ? [] : entries.filter(([k]) => Number(k) >= start).map(([, v]) => v);
      } else {
        // positional parameters count from $0
        const all = entries ? values : [sh.state.arg0, ...values];
        const start = off < 0 ? all.length + off : off;
        slice = start < 0 ? [] : all.slice(start);
      }
      return list(len === null ? slice : slice.slice(0, len));
    }
  }
}

function changeCase(value: string, upper: boolean, all: boolean): string {
  if (all) return upper ? value.toUpperCase() : value.toLowerCase();
  if (value === '') return value;
  const first = [...value][0];
  return (upper ? first.toUpperCase() : first.toLowerCase()) + value.slice(first.length);
}

async function expandParam(sh: Shell, p: ParamExpansion, io: IO): Promise<ParamResult> {
  const op = p.op;
  if (op.kind === 'bad') throw new ExpansionError(`\${${op.text}}: bad substitution`);
  let name = p.name;
  let index = p.index;
  if (op.kind === 'keys') return { list: arrayEntries(sh, name).map(([k]) => k), star: index === '*' };
  if (p.indirect) {
    const target = index === undefined ? sh.getParam(name) : await elementValue(sh, name, index, io);
    if (target === undefined || target === '') throw new ExpansionError(`${name}: invalid indirect expansion`);
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/s.exec(target);
    if (m) {
      name = m[1];
      index = m[2];
    } else if (/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])$/.test(target)) {
      name = target;
      index = undefined;
    } else throw new ExpansionError(`${target}: invalid variable name`);
  }
  if (index === '@' || index === '*') return listOp(sh, name, true, index === '*', op, io);
  if (index === undefined && (name === '@' || name === '*')) return listOp(sh, name, false, name === '*', op, io);

  const raw = index === undefined ? sh.getParam(name) : await elementValue(sh, name, index, io);
  const label = index === undefined ? name : `${name}[${index}]`;
  const isSet = raw !== undefined;
  const value = raw ?? '';
  const unbound = () => {
    if (sh.state.options.nounset && !isSet) throw new ExpansionError(`${label}: unbound variable`, true);
  };
  switch (op.kind) {
    case 'plain':
      unbound();
      return value;
    case 'length':
      unbound();
      return String([...value].length);
    case 'default': {
      const use = op.colon ? !isSet || value === '' : !isSet;
      return use ? await expandToString(sh, op.word, io) : value;
    }
    case 'assign': {
      const use = op.colon ? !isSet || value === '' : !isSet;
      if (!use) return value;
      const v = await expandToString(sh, op.word, io);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ExpansionError(`$${name}: cannot assign in this way`);
      if (index === undefined) sh.setVar(name, v);
      else await sh.assignElement(name, index, v, false, io);
      return v;
    }
    case 'alt': {
      const use = op.colon ? isSet && value !== '' : isSet;
      return use ? await expandToString(sh, op.word, io) : '';
    }
    case 'error': {
      const bad = op.colon ? !isSet || value === '' : !isSet;
      if (!bad) return value;
      const msg = await expandToString(sh, op.word, io);
      throw new ExpansionError(`${label}: ${msg || (op.colon ? 'parameter null or not set' : 'parameter not set')}`, true);
    }
    case 'trim': {
      unbound();
      const pat = await expandToPattern(sh, op.pattern, io);
      return trimPattern(value, pat, op.side, op.greedy);
    }
    case 'replace': {
      unbound();
      const pat = await expandToPattern(sh, op.pattern, io);
      const repl = op.replacement ? await expandToString(sh, op.replacement, io) : '';
      return replacePattern(value, pat, repl, op.all, op.anchor);
    }
    case 'substr': {
      unbound();
      const chars = [...value];
      let off = await sh.arithmetic(op.offset, io);
      if (off < 0) off = Math.max(0, chars.length + off);
      if (op.length === null) return chars.slice(off).join('');
      const len = await sh.arithmetic(op.length, io);
      if (len < 0) {
        const end = chars.length + len;
        if (end < off) throw new ExpansionError(`${op.length}: substring expression < 0`);
        return chars.slice(off, end).join('');
      }
      return chars.slice(off, off + len).join('');
    }
    case 'case':
      unbound();
      return changeCase(value, op.upper, op.all);
  }
}

/** Add a parameter's value to the current field(s). */
function addParam(sh: Shell, f: FieldBuilder, r: ParamResult, inDQ: boolean): void {
  if (typeof r === 'string') {
    f.add(r, inDQ ? 'q' : 'e');
    return;
  }
  if (inDQ && r.star) {
    const ifs = sh.state.get('IFS');
    f.add(r.list.join(ifs === undefined ? ' ' : ifs.slice(0, 1)), 'q');
    return;
  }
  r.list.forEach((v, i) => {
    if (i > 0) f.split();
    f.add(v, inDQ ? 'q' : 'e');
    if (inDQ) f.markQuoted();
  });
}

export interface ArrayItem {
  /** Subscript text ([key]=value), or null for the next index. */
  key: string | null;
  value: string;
  append?: boolean;
}

/** Expand the elements of an array literal: (a "b c" *.txt [5]=x). */
export async function expandArrayElements(sh: Shell, elems: ArrayElement[], io: IO): Promise<ArrayItem[]> {
  const out: ArrayItem[] = [];
  for (const el of elems) {
    if (el.index !== null) out.push({ key: el.index, value: await expandToString(sh, el.value, io), append: el.append });
    else for (const v of await expandWords(sh, [el.value], io)) out.push({ key: null, value: v });
  }
  return out;
}

/**
 * An assignment argument of declare/local/export/readonly, as one string.
 * Array elements are expanded now and quoted so the builtin can read them back.
 */
async function expandDeclWord(sh: Shell, a: Assignment, io: IO): Promise<string> {
  const head = a.name + (a.index !== undefined ? `[${a.index}]` : '') + (a.append ? '+=' : '=');
  if (a.array) {
    const items = await expandArrayElements(sh, a.array, io);
    return head + '(' + items.map((it) => (it.key !== null ? `[${it.key}]${it.append ? '+' : ''}=` : '') + sq(it.value)).join(' ') + ')';
  }
  return head + (a.value ? await expandToString(sh, a.value, io) : '');
}

// ---------------------------------------------------------------------------
// Main expansion

async function expandParts(sh: Shell, parts: WordPart[], f: FieldBuilder, inDQ: boolean, io: IO): Promise<void> {
  for (const part of parts) {
    switch (part.type) {
      case 'lit':
        f.add(part.value, inDQ ? 'q' : 'l');
        break;
      case 'quoted':
        f.add(part.value, 'q');
        f.markQuoted();
        break;
      case 'dq': {
        const only = part.parts.length === 1 ? part.parts[0] : null;
        if (only && only.type === 'param') {
          // "$@" and "${a[@]}" with no elements produce no word at all
          const r = await expandParam(sh, only.param, io);
          if (typeof r !== 'string' && !r.star) {
            addParam(sh, f, r, true);
            break;
          }
          f.markQuoted();
          addParam(sh, f, r, true);
          break;
        }
        f.markQuoted();
        await expandParts(sh, part.parts, f, true, io);
        break;
      }
      case 'tilde': {
        const home = sh.expandTilde(part.user);
        if (home === null) f.add('~' + part.user, inDQ ? 'q' : 'l');
        else f.add(home, 'q');
        break;
      }
      case 'param':
        addParam(sh, f, await expandParam(sh, part.param, io), inDQ);
        break;
      case 'cmdsub': {
        const out = await sh.commandSubstitution(part.body, io);
        f.add(out, inDQ ? 'q' : 'e');
        break;
      }
      case 'procsub':
        f.add(await sh.processSubstitution(part.dir, part.body, io), 'q');
        break;
      case 'arith': {
        const v = await sh.arithmetic(part.expr, io);
        f.add(String(v), inDQ ? 'q' : 'e');
        break;
      }
    }
  }
}

function splitFields(fields: Field[], ifs: string): Field[] {
  if (ifs === '') return fields;
  const isWs = (c: string) => (c === ' ' || c === '\t' || c === '\n') && ifs.includes(c);
  const out: Field[] = [];
  for (const field of fields) {
    if (!field.mask.includes('e')) {
      out.push(field);
      continue;
    }
    let cur: Field = { text: '', mask: '', quoted: false };
    let first = true;
    let afterWs = false;
    const push = () => {
      if (first && field.quoted) cur.quoted = true;
      out.push(cur);
      cur = { text: '', mask: '', quoted: false };
      first = false;
    };
    const { text, mask } = field;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const m = mask[i];
      if (m === 'e' && ifs.includes(c)) {
        if (isWs(c)) {
          if (cur.text.length > 0 || cur.quoted) push();
          afterWs = true;
        } else {
          if (cur.text.length > 0 || cur.quoted || !afterWs) push();
          afterWs = false;
          while (i + 1 < text.length && mask[i + 1] === 'e' && isWs(text[i + 1])) i++;
        }
        continue;
      }
      afterWs = false;
      cur.text += c;
      cur.mask += m;
      if (m === 'q') cur.quoted = true;
    }
    if (cur.text.length > 0 || cur.quoted) {
      if (first && field.quoted) cur.quoted = true;
      out.push(cur);
    }
  }
  return out;
}

function globField(sh: Shell, field: Field): string[] {
  const opts = sh.state.options;
  if (opts.noglob) return [field.text];
  let active = false;
  let pattern = '';
  for (let i = 0; i < field.text.length; i++) {
    const c = field.text[i];
    if (field.mask[i] === 'q') {
      pattern += /[\\*?[\]]/.test(c) ? '\\' + c : c;
    } else {
      if (c === '*' || c === '?' || c === '[') active = true;
      pattern += c;
    }
  }
  if (!active || !hasGlobChars(pattern)) return [field.text];
  const matches = expandGlob(pattern, sh.system.fs, sh.opCtx(), { dotglob: opts.dotglob, nocaseglob: opts.nocaseglob });
  if (matches.length > 0) return matches;
  if (opts.nullglob) return [];
  if (opts.failglob) throw new ExpansionError(`no match: ${field.text}`);
  return [field.text];
}

/** Expand command words into argv: all expansions, splitting and globbing. */
export async function expandWords(sh: Shell, words: Word[], io: IO): Promise<string[]> {
  const argv: string[] = [];
  const ifs = sh.state.get('IFS') ?? ' \t\n';
  for (const word of words) {
    if (word.decl) {
      argv.push(await expandDeclWord(sh, word.decl, io));
      continue;
    }
    for (const w of braceExpand(word)) {
      const f = new FieldBuilder();
      await expandParts(sh, w.parts, f, false, io);
      for (const field of splitFields(f.done(), ifs)) {
        if (field.text === '' && !field.quoted) continue;
        if (field.text === '') {
          argv.push('');
          continue;
        }
        for (const g of globField(sh, field)) argv.push(g);
      }
    }
  }
  return argv;
}

/** Expand without splitting or globbing (assignments, case words, [[ ]] operands, heredocs). */
export async function expandToString(sh: Shell, word: Word, io: IO): Promise<string> {
  const f = new FieldBuilder();
  await expandParts(sh, word.parts, f, false, io);
  return f
    .done()
    .map((x) => x.text)
    .join(' ');
}

/** Expand into a shell pattern: quoted characters are escaped so they match literally. */
export async function expandToPattern(sh: Shell, word: Word, io: IO): Promise<string> {
  const f = new FieldBuilder();
  await expandParts(sh, word.parts, f, false, io);
  return f
    .done()
    .map((field) => {
      let out = '';
      for (let i = 0; i < field.text.length; i++) {
        const c = field.text[i];
        out += field.mask[i] === 'q' && /[\\*?[\]]/.test(c) ? '\\' + c : c;
      }
      return out;
    })
    .join(' ');
}

/** Expand a redirection target; it must produce exactly one word. */
export async function expandRedirectTarget(sh: Shell, word: Word, io: IO): Promise<string> {
  const f = new FieldBuilder();
  await expandParts(sh, word.parts, f, false, io);
  const ifs = sh.state.get('IFS') ?? ' \t\n';
  const fields = splitFields(f.done(), ifs).filter((x) => x.text !== '' || x.quoted);
  const out: string[] = [];
  for (const field of fields) out.push(...(field.text === '' ? [''] : globField(sh, field)));
  if (out.length !== 1) throw new ExpansionError(`${word.raw}: ambiguous redirect`);
  return out[0];
}
