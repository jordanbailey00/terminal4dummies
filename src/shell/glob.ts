// Shell pattern matching (*, ?, [...]) and pathname expansion.

import { compareLocale } from './collate';
import type { OpContext, VirtualFS } from './vfs/fs';

const CLASSES: Record<string, string> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: 'A-Za-z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  word: 'A-Za-z0-9_',
  cntrl: '\\x00-\\x1f\\x7f',
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
};

function escapeRegexChar(c: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(c) ? '\\' + c : c;
}

/**
 * Parse a bracket expression starting at pattern[i] === '['.
 * Returns the regex fragment and the index after the closing ']', or null
 * if the bracket is not terminated (then '[' is literal).
 */
function parseBracket(p: string, i: number): { src: string; end: number } | null {
  let j = i + 1;
  let negate = false;
  if (p[j] === '!' || p[j] === '^') {
    negate = true;
    j++;
  }
  let body = '';
  let first = true;
  while (j < p.length) {
    const c = p[j];
    if (c === ']' && !first) {
      return { src: '[' + (negate ? '^' : '') + body + ']', end: j + 1 };
    }
    first = false;
    if (c === '[' && p[j + 1] === ':') {
      const close = p.indexOf(':]', j + 2);
      if (close !== -1) {
        const name = p.slice(j + 2, close);
        if (CLASSES[name]) {
          body += CLASSES[name];
          j = close + 2;
          continue;
        }
      }
    }
    if (c === '\\' && j + 1 < p.length) {
      body += escapeRegexChar(p[j + 1]);
      j += 2;
      continue;
    }
    if (c === '-' && body !== '' && p[j + 1] !== ']' && j + 1 < p.length) {
      body += '-';
      j++;
      continue;
    }
    body += c === ']' || c === '[' || c === '\\' || c === '^' || c === '-' ? '\\' + c : c;
    j++;
  }
  return null;
}

/**
 * Convert a shell pattern to a regular expression source.
 * In pathname mode, wildcards never match "/".
 */
export function patternToRegexSource(pattern: string, pathname = false): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      if (i + 1 < pattern.length) {
        out += escapeRegexChar(pattern[i + 1]);
        i++;
      } else {
        out += '\\\\';
      }
    } else if (c === '*') {
      while (pattern[i + 1] === '*') i++;
      out += pathname ? '[^/]*' : '[\\s\\S]*';
    } else if (c === '?') {
      out += pathname ? '[^/]' : '[\\s\\S]';
    } else if (c === '[') {
      const b = parseBracket(pattern, i);
      if (b) {
        out += b.src;
        i = b.end - 1;
      } else {
        out += '\\[';
      }
    } else {
      out += escapeRegexChar(c);
    }
  }
  return out;
}

const regexCache = new Map<string, RegExp>();

export function patternToRegExp(pattern: string, opts: { pathname?: boolean; nocase?: boolean; anchored?: boolean } = {}): RegExp {
  const key = `${opts.pathname ? 1 : 0}${opts.nocase ? 1 : 0}${opts.anchored === false ? 0 : 1}:${pattern}`;
  let re = regexCache.get(key);
  if (!re) {
    const src = patternToRegexSource(pattern, opts.pathname);
    re = new RegExp(opts.anchored === false ? src : '^' + src + '$', opts.nocase ? 'i' : '');
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(key, re);
  }
  return re;
}

export function matchPattern(pattern: string, text: string, opts: { pathname?: boolean; nocase?: boolean } = {}): boolean {
  return patternToRegExp(pattern, opts).test(text);
}

/** Does the pattern contain an unescaped wildcard? */
export function hasGlobChars(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '*' || c === '?') return true;
    if (c === '[' && parseBracket(pattern, i)) return true;
  }
  return false;
}

/** Remove pattern escaping ("a\*b" -> "a*b"). */
export function unescapePattern(pattern: string): string {
  return pattern.replace(/\\(.)/g, '$1');
}

/** Escape glob metacharacters so the text matches literally. */
export function escapePattern(text: string): string {
  return text.replace(/[\\*?[\]]/g, '\\$&');
}

export interface GlobOptions {
  dotglob?: boolean;
  nocaseglob?: boolean;
}

/**
 * Expand a pathname pattern against the filesystem. Returns matches sorted
 * the way bash sorts them, or an empty array when nothing matches.
 */
export function expandGlob(pattern: string, fs: VirtualFS, ctx: OpContext, opts: GlobOptions = {}): string[] {
  const absolute = pattern.startsWith('/');
  const trailingSlash = pattern.endsWith('/') && pattern.length > 1;
  const comps = pattern.split('/').filter((c) => c !== '');
  let results: string[] = [absolute ? '/' : ''];
  const joinPath = (base: string, name: string) => (base === '' ? name : base === '/' ? '/' + name : base + '/' + name);

  for (let i = 0; i < comps.length; i++) {
    const comp = comps[i];
    const isLast = i === comps.length - 1;
    const next: string[] = [];
    if (!hasGlobChars(comp)) {
      const lit = unescapePattern(comp);
      for (const r of results) {
        const p = joinPath(r, lit);
        const node = fs.tryStat(p, ctx, isLast && !trailingSlash ? false : true);
        if (!node) continue;
        if ((!isLast || trailingSlash) && node.type !== 'dir') continue;
        next.push(p);
      }
    } else {
      const re = patternToRegExp(comp, { pathname: true, nocase: opts.nocaseglob });
      const allowDot = comp.startsWith('.') || comp.startsWith('\\.') || opts.dotglob;
      for (const r of results) {
        let names: string[];
        try {
          names = fs.readdir(r === '' ? '.' : r, ctx);
        } catch {
          continue;
        }
        names.sort(compareLocale);
        for (const name of names) {
          if (name.startsWith('.') && !allowDot) continue;
          if (!re.test(name)) continue;
          const p = joinPath(r, name);
          if (!isLast || trailingSlash) {
            const node = fs.tryStat(p, ctx, true);
            if (!node || node.type !== 'dir') continue;
          }
          next.push(p);
        }
      }
    }
    results = next;
    if (results.length === 0) return [];
  }
  if (comps.length === 0) return [];
  let out = results;
  if (trailingSlash) out = out.map((r) => r + '/');
  return out.sort(compareLocale);
}
