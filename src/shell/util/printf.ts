// printf(1)-style formatting and echo -e escape handling.

export interface PrintfResult {
  output: string;
  errors: string[];
  /** \c was seen: stop all further output. */
  stopped: boolean;
}

/** Process backslash escapes like `echo -e` / printf %b. */
export function processEscapes(s: string, mode: 'echo' | 'printf' | 'b'): { text: string; stopped: boolean } {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const n = s[++i];
    switch (n) {
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'c':
        if (mode !== 'printf') return { text: out, stopped: true };
        out += '\\c';
        break;
      case 'e':
      case 'E': out += '\x1b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case '"': out += mode === 'printf' ? '"' : '\\"'; break;
      case "'": out += mode === 'printf' ? "'" : "\\'"; break;
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
        if (m) {
          out += String.fromCharCode(parseInt(m[0], 16));
          i += m[0].length;
        } else out += '\\x';
        break;
      }
      case 'u':
      case 'U': {
        const m = (n === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(s.slice(i + 1));
        if (m) {
          out += String.fromCodePoint(parseInt(m[0], 16));
          i += m[0].length;
        } else out += '\\' + n;
        break;
      }
      case '0': {
        // echo: \0NNN ; printf: \NNN (with the leading 0 counting as a digit)
        const m = /^[0-7]{0,3}/.exec(s.slice(i + 1))!;
        out += String.fromCharCode(parseInt(m[0] || '0', 8) & 255);
        i += m[0].length;
        break;
      }
      default:
        if (mode !== 'echo' && /[1-7]/.test(n)) {
          const m = /^[0-7]{0,2}/.exec(s.slice(i + 1))!;
          out += String.fromCharCode(parseInt(n + m[0], 8) & 255);
          i += m[0].length;
        } else {
          out += '\\' + n;
        }
    }
  }
  return { text: out, stopped: false };
}

function parseNumberArg(arg: string, errors: string[]): number {
  const t = arg.trim();
  if (t === '') return 0;
  if (/^['"]/.test(t)) return t.length > 1 ? t.codePointAt(1)! : 0;
  if (/^[-+]?0[xX][0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  if (/^[-+]?0[0-7]+$/.test(t)) return parseInt(t, 8);
  if (/^[-+]?\d+$/.test(t)) return parseInt(t, 10);
  const f = Number(t);
  if (!Number.isNaN(f) && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return f;
  errors.push(`${arg}: invalid number`);
  const m = /^[-+]?\d+/.exec(t);
  return m ? parseInt(m[0], 10) : 0;
}

function pad(s: string, width: number, left: boolean, zero: boolean): string {
  if (s.length >= width) return s;
  if (left) return s + ' '.repeat(width - s.length);
  if (zero) {
    const sign = /^[-+ ]/.test(s) ? s[0] : '';
    const body = sign ? s.slice(1) : s;
    return sign + '0'.repeat(width - s.length) + body;
  }
  return ' '.repeat(width - s.length) + s;
}

export function shellQuote(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  if (!/[\x00-\x1f\x7f]/.test(s)) return s.replace(/([^A-Za-z0-9_@%+=:,./-])/g, '\\$1');
  return "$'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\t/g, '\\t') + "'";
}

/** Format like printf(1). Reuses the format while arguments remain. */
export function formatPrintf(format: string, args: string[]): PrintfResult {
  const errors: string[] = [];
  let out = '';
  let argIndex = 0;
  const nextArg = (): string | undefined => args[argIndex++];
  let consumedAny = false;
  for (let pass = 0; pass < 10000; pass++) {
    const startIndex = argIndex;
    let i = 0;
    while (i < format.length) {
      const c = format[i];
      if (c === '\\') {
        // escape in the format string
        let j = i + 1;
        const n = format[j];
        if (n === undefined) {
          out += '\\';
          i++;
          continue;
        }
        let seq = '\\' + n;
        if (n === 'x') {
          const m = /^[0-9a-fA-F]{1,2}/.exec(format.slice(j + 1));
          if (m) seq += m[0];
        } else if (n === 'u' || n === 'U') {
          const m = (n === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(format.slice(j + 1));
          if (m) seq += m[0];
        } else if (/[0-7]/.test(n)) {
          const m = /^[0-7]{0,2}/.exec(format.slice(j + 1))!;
          seq += m[0];
        }
        j = i + seq.length;
        out += processEscapes(seq, 'printf').text;
        i = j;
        continue;
      }
      if (c !== '%') {
        out += c;
        i++;
        continue;
      }
      if (format[i + 1] === '%') {
        out += '%';
        i += 2;
        continue;
      }
      const m = /^%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d*))?([diouxXfFeEgGcsbq])/.exec(format.slice(i));
      if (!m) {
        const bad = format.slice(i, i + 2);
        errors.push(`${bad.slice(1) || '%'}: invalid format character`);
        return { output: out, errors, stopped: false };
      }
      i += m[0].length;
      const flags = m[1];
      let width = 0;
      if (m[2] === '*') width = parseNumberArg(nextArg() ?? '0', errors);
      else if (m[2]) width = parseInt(m[2], 10);
      let precision: number | null = null;
      if (m[3] !== undefined) precision = m[3] === '*' ? parseNumberArg(nextArg() ?? '0', errors) : m[3] === '' ? 0 : parseInt(m[3], 10);
      let left = flags.includes('-');
      if (width < 0) {
        left = true;
        width = -width;
      }
      const zero = flags.includes('0') && !left;
      const conv = m[4];
      const arg = nextArg();
      if (arg !== undefined) consumedAny = true;
      let s: string;
      switch (conv) {
        case 'd':
        case 'i': {
          let n = Math.trunc(parseNumberArg(arg ?? '0', errors));
          s = String(Math.abs(n));
          if (precision !== null) s = s.padStart(precision, '0');
          s = (n < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + s;
          out += pad(s, width, left, zero && precision === null);
          n = 0;
          break;
        }
        case 'u':
        case 'o':
        case 'x':
        case 'X': {
          let n = Math.trunc(parseNumberArg(arg ?? '0', errors));
          if (n < 0) n = n + 2 ** 64;
          s = conv === 'o' ? n.toString(8) : conv === 'u' ? String(n) : n.toString(16);
          if (conv === 'X') s = s.toUpperCase();
          if (precision !== null) s = s.padStart(precision, '0');
          if (flags.includes('#') && n !== 0) s = (conv === 'o' ? '0' : conv === 'x' ? '0x' : conv === 'X' ? '0X' : '') + s;
          out += pad(s, width, left, zero && precision === null);
          break;
        }
        case 'f':
        case 'F':
        case 'e':
        case 'E':
        case 'g':
        case 'G': {
          const n = parseNumberArg(arg ?? '0', errors);
          const p = precision ?? 6;
          if (conv === 'f' || conv === 'F') s = n.toFixed(p);
          else if (conv === 'e' || conv === 'E') s = n.toExponential(p).replace(/e([+-])(\d)$/, 'e$10$2');
          else {
            const g = Number(n.toPrecision(p === 0 ? 1 : p));
            s = String(g);
          }
          if (conv === 'E' || conv === 'G') s = s.toUpperCase();
          if (n >= 0 && flags.includes('+')) s = '+' + s;
          else if (n >= 0 && flags.includes(' ')) s = ' ' + s;
          out += pad(s, width, left, zero);
          break;
        }
        case 'c':
          s = (arg ?? '').slice(0, 1);
          out += pad(s, width, left, false);
          break;
        case 's':
          s = arg ?? '';
          if (precision !== null) s = s.slice(0, precision);
          out += pad(s, width, left, false);
          break;
        case 'b': {
          const r = processEscapes(arg ?? '', 'b');
          s = r.text;
          if (precision !== null) s = s.slice(0, precision);
          out += pad(s, width, left, false);
          if (r.stopped) return { output: out, errors, stopped: true };
          break;
        }
        case 'q':
          out += pad(shellQuote(arg ?? ''), width, left, false);
          break;
      }
    }
    // Reuse the format only if it consumed arguments and some remain.
    if (argIndex >= args.length || argIndex === startIndex || !consumedAny) break;
  }
  return { output: out, errors, stopped: false };
}
