// Command history (the `history` builtin, arrow keys, !! expansion).

export class History {
  entries: string[] = [];
  /** History number of entries[0]. */
  base = 1;
  maxSize = 1000;
  /** Listeners notified whenever history changes (used to save ~/.bash_history). */
  onChange: (() => void) | null = null;

  add(line: string, control = 'ignoreboth'): void {
    const ignoreSpace = control.includes('ignorespace') || control.includes('ignoreboth');
    const ignoreDups = control.includes('ignoredups') || control.includes('ignoreboth');
    if (line.trim() === '') return;
    if (ignoreSpace && /^[ \t]/.test(line)) return;
    if (ignoreDups && this.entries[this.entries.length - 1] === line) return;
    this.entries.push(line);
    while (this.entries.length > this.maxSize) {
      this.entries.shift();
      this.base++;
    }
    this.onChange?.();
  }

  get length(): number {
    return this.entries.length;
  }

  /** Last history number. */
  get last(): number {
    return this.base + this.entries.length - 1;
  }

  get(num: number): string | undefined {
    return this.entries[num - this.base];
  }

  clear(): void {
    this.base = this.base + this.entries.length;
    this.entries = [];
    this.onChange?.();
  }

  delete(num: number): boolean {
    const i = num - this.base;
    if (i < 0 || i >= this.entries.length) return false;
    this.entries.splice(i, 1);
    this.onChange?.();
    return true;
  }

  load(lines: string[]): void {
    this.entries = lines.filter((l) => l.trim() !== '').slice(-this.maxSize);
    this.base = 1;
  }
}

export class HistoryExpansionError extends Error {}

/**
 * Bash-style history expansion: !!, !n, !-n, !prefix, !?text?, !$, !^, !*, ^old^new.
 * Returns the expanded line (or the same line when nothing applied).
 */
export function expandHistory(line: string, history: History): { line: string; changed: boolean } {
  if (!line.includes('!') && !line.startsWith('^')) return { line, changed: false };
  const prevLine = (): string => {
    const p = history.get(history.last);
    if (p === undefined) throw new HistoryExpansionError('!!: event not found');
    return p;
  };
  if (line.startsWith('^')) {
    const m = /^\^([^^]*)\^([^^]*)\^?(.*)$/.exec(line);
    if (m) {
      const prev = prevLine();
      if (!prev.includes(m[1])) throw new HistoryExpansionError(':s^' + m[1] + '^' + m[2] + ': substitution failed');
      return { line: prev.replace(m[1], m[2]) + m[3], changed: true };
    }
  }
  let out = '';
  let changed = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && !inSingle && i + 1 < line.length) {
      out += c + line[i + 1];
      i++;
      continue;
    }
    if (c === "'" && !inDouble) inSingle = !inSingle;
    if (c === '"' && !inSingle) inDouble = !inDouble;
    if (c !== '!' || inSingle) {
      out += c;
      continue;
    }
    const rest = line.slice(i + 1);
    // "!" followed by blank, "=", "(" or end of line is literal; so is "!" before a closing quote
    if (rest === '' || /^[ \t\n=(]/.test(rest) || (inDouble && rest.startsWith('"'))) {
      out += c;
      continue;
    }
    let event: string | undefined;
    let consumed = 0;
    let m: RegExpExecArray | null;
    if (rest.startsWith('!')) {
      event = prevLine();
      consumed = 1;
    } else if ((m = /^-?\d+/.exec(rest))) {
      const n = parseInt(m[0], 10);
      const num = n < 0 ? history.last + 1 + n : n;
      event = history.get(num);
      if (event === undefined) throw new HistoryExpansionError(`!${m[0]}: event not found`);
      consumed = m[0].length;
    } else if (rest.startsWith('$') || rest.startsWith('^') || rest.startsWith('*')) {
      const words = splitHistoryWords(prevLine());
      const sel = rest[0];
      const val = sel === '$' ? words[words.length - 1] ?? '' : sel === '^' ? words[1] ?? '' : words.slice(1).join(' ');
      out += val;
      changed = true;
      i += 1;
      continue;
    } else if ((m = /^\?([^?\n]*)\??/.exec(rest))) {
      const needle = m[1];
      for (let k = history.entries.length - 1; k >= 0; k--) {
        if (history.entries[k].includes(needle)) {
          event = history.entries[k];
          break;
        }
      }
      if (event === undefined) throw new HistoryExpansionError(`!?${needle}: event not found`);
      consumed = m[0].length;
    } else if ((m = /^[^\s;&|()<>"'`!:]+/.exec(rest))) {
      const prefix = m[0];
      for (let k = history.entries.length - 1; k >= 0; k--) {
        if (history.entries[k].startsWith(prefix)) {
          event = history.entries[k];
          break;
        }
      }
      if (event === undefined) throw new HistoryExpansionError(`!${prefix}: event not found`);
      consumed = prefix.length;
    } else {
      out += c;
      continue;
    }
    // word designators like !!:1 or !!:$
    const after = rest.slice(consumed);
    const wm = /^:(\d+|\$|\^|\*)/.exec(after);
    if (wm && event !== undefined) {
      const words = splitHistoryWords(event);
      const d = wm[1];
      event = d === '$' ? words[words.length - 1] : d === '^' ? words[1] : d === '*' ? words.slice(1).join(' ') : words[parseInt(d, 10)];
      if (event === undefined) throw new HistoryExpansionError(`${wm[0]}: bad word specifier`);
      consumed += wm[0].length;
    }
    out += event;
    changed = true;
    i += consumed;
  }
  return { line: out, changed };
}

/** Split a command line into words roughly the way bash's history does. */
export function splitHistoryWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < line.length) {
      cur += c + line[++i];
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (cur) words.push(cur);
      cur = '';
      continue;
    }
    if ('|&;<>'.includes(c)) {
      if (cur) words.push(cur);
      cur = '';
      let op = c;
      if ((c === '|' || c === '&' || c === '>' || c === '<') && line[i + 1] === c) op += line[++i];
      words.push(op);
      continue;
    }
    cur += c;
  }
  if (cur) words.push(cur);
  return words;
}
