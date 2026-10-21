// Converting POSIX basic/extended regular expressions (grep, sed) to JavaScript.

const CLASS_MAP: Record<string, string> = {
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
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
};

export class RegexError extends Error {}

/** Copy a POSIX bracket expression starting at src[i] === '[' into JS syntax. */
function bracket(src: string, i: number): { out: string; end: number } {
  let j = i + 1;
  let out = '[';
  if (src[j] === '^') {
    out += '^';
    j++;
  }
  if (src[j] === ']') {
    out += '\\]';
    j++;
  }
  while (j < src.length && src[j] !== ']') {
    const c = src[j];
    if (c === '[' && src[j + 1] === ':') {
      const close = src.indexOf(':]', j + 2);
      if (close === -1) throw new RegexError('Unmatched [, [^, [:, [., or [=');
      const name = src.slice(j + 2, close);
      const cls = CLASS_MAP[name];
      if (!cls) throw new RegexError('Invalid character class name');
      out += cls;
      j = close + 2;
      continue;
    }
    if (c === '\\') {
      out += '\\\\';
      j++;
      continue;
    }
    if (c === '[') {
      out += '\\[';
      j++;
      continue;
    }
    out += c;
    j++;
  }
  if (j >= src.length) throw new RegexError('Unmatched [, [^, [:, [., or [=');
  return { out: out + ']', end: j + 1 };
}

/** Translate a POSIX regex (BRE when extended=false) into a JS RegExp source. */
export function posixToJs(src: string, extended: boolean): string {
  let out = '';
  let groupDepth = 0;
  let atStart = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const wasStart = atStart;
    atStart = false;
    if (c === '\\') {
      const n = src[i + 1];
      i++;
      if (n === undefined) throw new RegexError('Trailing backslash');
      if (!extended && '(){}|+?'.includes(n)) {
        if (n === '(') {
          groupDepth++;
          atStart = true;
        } else if (n === ')') {
          if (groupDepth === 0) throw new RegexError('Unmatched ) or \\)');
          groupDepth--;
        } else if (n === '|') atStart = true;
        out += n;
        continue;
      }
      if (n === '<') {
        out += '\\b(?=\\w)';
        continue;
      }
      if (n === '>') {
        out += '\\b(?<=\\w)';
        continue;
      }
      if ('bBwWsS'.includes(n) || /[1-9]/.test(n)) {
        out += '\\' + n;
        continue;
      }
      if (n === 'n') {
        out += '\\n';
        continue;
      }
      if (n === 't') {
        out += '\\t';
        continue;
      }
      out += /[\\^$.*+?()[\]{}|/-]/.test(n) ? '\\' + n : n;
      continue;
    }
    if (c === '[') {
      const b = bracket(src, i);
      out += b.out;
      i = b.end - 1;
      continue;
    }
    if (!extended && '(){}|+?'.includes(c)) {
      out += '\\' + c;
      continue;
    }
    if (extended) {
      if (c === '(') {
        groupDepth++;
        atStart = true;
        out += c;
        continue;
      }
      if (c === ')') {
        if (groupDepth === 0) {
          out += '\\)';
          continue;
        }
        groupDepth--;
        out += c;
        continue;
      }
      if (c === '|') {
        atStart = true;
        out += c;
        continue;
      }
      if (c === '{') {
        if (!/^\{\d*(,\d*)?\}/.test(src.slice(i))) {
          out += '\\{';
          continue;
        }
      }
    }
    if (c === '*' && wasStart) {
      out += '\\*';
      continue;
    }
    if (c === '^') {
      if (wasStart || extended) {
        out += '^';
        atStart = true;
      } else out += '\\^';
      continue;
    }
    if (c === '$') {
      const next = src[i + 1];
      const atEnd = next === undefined || (!extended && src.startsWith('\\)', i + 1)) || (!extended && src.startsWith('\\|', i + 1)) || (extended && (next === ')' || next === '|'));
      out += atEnd || extended ? '$' : '\\$';
      continue;
    }
    if (c === '/') {
      out += '\\/';
      continue;
    }
    out += c;
  }
  if (groupDepth > 0) throw new RegexError('Unmatched ( or \\(');
  return out;
}

export function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

export interface MatcherOptions {
  extended?: boolean;
  fixed?: boolean;
  perl?: boolean;
  ignoreCase?: boolean;
  word?: boolean;
  line?: boolean;
}

/** Build a global RegExp from one or more grep-style patterns. */
export function buildMatcher(patterns: string[], o: MatcherOptions): RegExp {
  const parts = patterns.map((p) => {
    let src = o.fixed ? escapeRegex(p) : o.perl ? p : posixToJs(p, !!o.extended);
    if (o.word) src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`;
    if (o.line) src = `^(?:${src})$`;
    return src;
  });
  const src = parts.length === 1 ? parts[0] : parts.map((p) => `(?:${p})`).join('|');
  try {
    return new RegExp(src, 'g' + (o.ignoreCase ? 'i' : ''));
  } catch (e) {
    throw new RegexError(e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : String(e));
  }
}
