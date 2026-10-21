// A readline-style line editor (emacs key bindings), drawing on the tty.

import type { History } from './history';
import { splitHistoryWords } from './history';
import type { TtyDriver } from './tty';
import { charWidth, stringWidth, stripAnsi } from './wcwidth';

export type ReadResult = { kind: 'line'; line: string } | { kind: 'eof' } | { kind: 'interrupt' };

export interface Completion {
  /** Index in the buffer where the word being completed starts. */
  start: number;
  /** Replacement strings (already quoted/escaped) for the word. */
  candidates: string[];
  /** Text shown when listing candidates (defaults to candidates). */
  display?: string[];
  /** Append this after a unique completion (" " or "/" or ""). */
  suffixes?: string[];
}

export type EditorEvent =
  | 'history-prev'
  | 'history-next'
  | 'reverse-search'
  | 'tab-complete'
  | 'tab-list'
  | 'clear-screen'
  | 'kill'
  | 'yank'
  | 'move-word'
  | 'line-start'
  | 'line-end'
  | 'interrupt';

export interface EditorHost {
  tty: TtyDriver;
  history: History;
  complete?(line: string, cursor: number): Promise<Completion | null>;
  onEvent?(e: EditorEvent): void;
}

type Key =
  | { t: 'text'; s: string }
  | { t: 'paste'; s: string }
  | { t: 'ctrl'; c: string }
  | { t: 'csi'; s: string }
  | { t: 'ss3'; s: string }
  | { t: 'meta'; c: string }
  | { t: 'esc' };

export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    if (data.startsWith('\x1b[200~', i)) {
      const end = data.indexOf('\x1b[201~', i + 6);
      const text = end === -1 ? data.slice(i + 6) : data.slice(i + 6, end);
      keys.push({ t: 'paste', s: text });
      i = end === -1 ? data.length : end + 6;
      continue;
    }
    const c = data[i];
    if (c === '\x1b') {
      const n = data[i + 1];
      if (n === '[') {
        const m = /^[0-9;?]*[ -/]*[@-~]/.exec(data.slice(i + 2));
        if (m) {
          keys.push({ t: 'csi', s: m[0] });
          i += 2 + m[0].length;
          continue;
        }
        keys.push({ t: 'esc' });
        i += 1;
        continue;
      }
      if (n === 'O' && i + 2 < data.length) {
        keys.push({ t: 'ss3', s: data[i + 2] });
        i += 3;
        continue;
      }
      if (n !== undefined) {
        keys.push({ t: 'meta', c: n });
        i += 2;
        continue;
      }
      keys.push({ t: 'esc' });
      i++;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      keys.push({ t: 'ctrl', c });
      i++;
      continue;
    }
    let j = i;
    while (j < data.length) {
      const cc = data.charCodeAt(j);
      if (cc < 0x20 || cc === 0x7f || cc === 0x1b) break;
      j++;
    }
    keys.push({ t: 'text', s: data.slice(i, j) });
    i = j;
  }
  return keys;
}

function isWordChar(c: string): boolean {
  return /[\p{L}\p{N}_]/u.test(c);
}

/** Position of the start of the previous character (handles surrogate pairs). */
function prevPos(s: string, pos: number): number {
  if (pos <= 0) return 0;
  const c = s.charCodeAt(pos - 1);
  if (c >= 0xdc00 && c <= 0xdfff && pos >= 2) return pos - 2;
  return pos - 1;
}

function nextPos(s: string, pos: number): number {
  if (pos >= s.length) return s.length;
  const c = s.charCodeAt(pos);
  if (c >= 0xd800 && c <= 0xdbff && pos + 1 < s.length) return pos + 2;
  return pos + 1;
}

export class LineEditor {
  private readonly host: EditorHost;
  private buf = '';
  private pos = 0;
  private prompt = '';
  private promptLast = '';
  private cursorRow = 0;
  private killRing: string[] = [];
  private undoStack: { buf: string; pos: number }[] = [];
  private histIndex = 0;
  private savedLine = '';
  private lastWasTab = false;
  private lastWasKill = false;
  private yankLastArgIndex = 0;
  private lastYankLen = 0;
  private lastKeyWasYankArg = false;
  // reverse search
  private searching = false;
  private searchQuery = '';
  private searchIndex = -1;
  private searchFailed = false;
  private searchOriginal = { buf: '', pos: 0 };

  constructor(host: EditorHost) {
    this.host = host;
  }

  private get tty(): TtyDriver {
    return this.host.tty;
  }

  private get cols(): number {
    return this.tty.cols;
  }

  private emit(e: EditorEvent): void {
    this.host.onEvent?.(e);
  }

  /** Read one line. The prompt may contain escape sequences and newlines. */
  async readLine(prompt: string, initial = ''): Promise<ReadResult> {
    const tty = this.tty;
    const saved = tty.getModes();
    tty.setModes({ icanon: false, echo: false, isig: false, opost: true });
    this.prompt = prompt;
    const nl = prompt.lastIndexOf('\n');
    this.promptLast = nl === -1 ? prompt : prompt.slice(nl + 1);
    this.buf = initial;
    this.pos = initial.length;
    this.cursorRow = 0;
    this.undoStack = [];
    this.histIndex = this.host.history.length;
    this.savedLine = '';
    this.lastWasTab = false;
    this.searching = false;
    // bracketed paste on while editing
    await tty.writeRaw('\x1b[?2004h');
    await tty.writeRaw(this.prompt.replace(/\r?\n/g, '\r\n'));
    if (this.buf) await this.refresh();
    try {
      for (;;) {
        const data = await tty.readRaw();
        const keys = parseKeys(data);
        for (let k = 0; k < keys.length; k++) {
          const result = await this.handleKey(keys[k]);
          if (result) {
            // Unprocessed typeahead goes back to the tty for the next reader.
            const rest = keys.slice(k + 1);
            if (rest.length) tty.pushBack(rest.map(keyToString).join(''));
            return result;
          }
        }
      }
    } finally {
      await tty.writeRaw('\x1b[?2004l');
      tty.setModes(saved);
    }
  }

  // ---------------------------------------------------------------------------
  // drawing

  private layout(text: string): { row: number; col: number } {
    const cols = this.cols;
    let row = 0;
    let col = 0;
    for (const ch of text) {
      if (ch === '\n') {
        row++;
        col = 0;
        continue;
      }
      const w = charWidth(ch.codePointAt(0)!);
      if (w === 0) continue;
      if (col + w > cols) {
        row++;
        col = 0;
      }
      col += w;
      if (col >= cols) {
        row++;
        col = 0;
      }
    }
    return { row, col };
  }

  private currentPromptLast(): string {
    if (this.searching) {
      return `(${this.searchFailed ? 'failed ' : ''}reverse-i-search)\`${this.searchQuery}': `;
    }
    return this.promptLast;
  }

  private async refresh(): Promise<void> {
    const promptLast = this.currentPromptLast();
    const plain = stripAnsi(promptLast);
    let out = '';
    if (this.cursorRow > 0) out += `\x1b[${this.cursorRow}A`;
    out += '\r\x1b[J';
    out += promptLast + this.buf.replace(/\n/g, '\r\n');
    const end = this.layout(plain + this.buf);
    const full = plain + this.buf;
    if (end.col === 0 && end.row > 0 && full.length > 0 && !full.endsWith('\n')) out += '\r\n';
    const cur = this.layout(plain + this.buf.slice(0, this.pos));
    if (end.row > cur.row) out += `\x1b[${end.row - cur.row}A`;
    out += '\r';
    if (cur.col > 0) out += `\x1b[${cur.col}C`;
    this.cursorRow = cur.row;
    await this.tty.writeRaw(out);
  }

  /** Move the cursor below the input, ready for output. */
  private async finishLine(): Promise<void> {
    const plain = stripAnsi(this.currentPromptLast());
    const end = this.layout(plain + this.buf);
    const cur = this.cursorRow;
    let out = '';
    if (end.row > cur) out += `\x1b[${end.row - cur}B`;
    const full = plain + this.buf;
    if (!(end.col === 0 && end.row > 0 && full.length > 0 && !full.endsWith('\n'))) out += '\r\n';
    else out += '\r';
    this.cursorRow = 0;
    await this.tty.writeRaw(out);
  }

  // ---------------------------------------------------------------------------
  // editing primitives

  private saveUndo(): void {
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && last.buf === this.buf) return;
    this.undoStack.push({ buf: this.buf, pos: this.pos });
    if (this.undoStack.length > 200) this.undoStack.shift();
  }

  private insert(s: string): void {
    this.saveUndo();
    this.buf = this.buf.slice(0, this.pos) + s + this.buf.slice(this.pos);
    this.pos += s.length;
  }

  private kill(from: number, to: number, prepend: boolean): void {
    if (from >= to) return;
    this.saveUndo();
    const text = this.buf.slice(from, to);
    if (this.lastWasKill && this.killRing.length) {
      this.killRing[this.killRing.length - 1] = prepend ? text + this.killRing[this.killRing.length - 1] : this.killRing[this.killRing.length - 1] + text;
    } else {
      this.killRing.push(text);
      if (this.killRing.length > 20) this.killRing.shift();
    }
    this.buf = this.buf.slice(0, from) + this.buf.slice(to);
    this.pos = from;
    this.emit('kill');
  }

  private wordLeft(pos: number, isWord: (c: string) => boolean = isWordChar): number {
    let p = pos;
    while (p > 0 && !isWord(this.buf[p - 1])) p--;
    while (p > 0 && isWord(this.buf[p - 1])) p--;
    return p;
  }

  private wordRight(pos: number): number {
    let p = pos;
    while (p < this.buf.length && !isWordChar(this.buf[p])) p++;
    while (p < this.buf.length && isWordChar(this.buf[p])) p++;
    return p;
  }

  private setFromHistory(index: number): void {
    const h = this.host.history;
    if (this.histIndex === h.length) this.savedLine = this.buf;
    this.histIndex = index;
    this.buf = index === h.length ? this.savedLine : h.entries[index];
    this.pos = this.buf.length;
  }

  // ---------------------------------------------------------------------------
  // keys

  private async handleKey(key: Key): Promise<ReadResult | null> {
    if (this.searching) {
      const handled = await this.handleSearchKey(key);
      if (handled !== 'continue') return handled;
    }
    const wasTab = this.lastWasTab;
    const wasKill = this.lastWasKill;
    const wasYankArg = this.lastKeyWasYankArg;
    this.lastWasTab = false;
    this.lastWasKill = false;
    this.lastKeyWasYankArg = false;

    switch (key.t) {
      case 'text':
        this.insert(key.s);
        await this.refresh();
        return null;
      case 'paste': {
        const text = key.s.replace(/\r\n?/g, '\n');
        this.insert(text);
        await this.refresh();
        return null;
      }
      case 'esc':
        return null;
      case 'meta':
        return this.handleMeta(key.c, wasKill, wasYankArg);
      case 'csi':
        return this.handleCsi(key.s);
      case 'ss3':
        return this.handleCsi(key.s);
      case 'ctrl':
        return this.handleCtrl(key.c, wasTab, wasKill);
    }
  }

  private async handleCtrl(c: string, wasTab: boolean, wasKill: boolean): Promise<ReadResult | null> {
    switch (c) {
      case '\r':
      case '\n': {
        await this.finishLine();
        return { kind: 'line', line: this.buf };
      }
      case '\x7f':
      case '\b':
        if (this.pos > 0) {
          this.saveUndo();
          const p = prevPos(this.buf, this.pos);
          this.buf = this.buf.slice(0, p) + this.buf.slice(this.pos);
          this.pos = p;
          await this.refresh();
        } else this.bell();
        return null;
      case '\x04':
        if (this.buf === '') {
          await this.finishLineEof();
          return { kind: 'eof' };
        }
        if (this.pos < this.buf.length) {
          this.saveUndo();
          this.buf = this.buf.slice(0, this.pos) + this.buf.slice(nextPos(this.buf, this.pos));
          await this.refresh();
        }
        return null;
      case '\x01':
        this.pos = 0;
        this.emit('line-start');
        await this.refresh();
        return null;
      case '\x05':
        this.pos = this.buf.length;
        this.emit('line-end');
        await this.refresh();
        return null;
      case '\x02':
        this.pos = prevPos(this.buf, this.pos);
        await this.refresh();
        return null;
      case '\x06':
        this.pos = nextPos(this.buf, this.pos);
        await this.refresh();
        return null;
      case '\x0b':
        this.lastWasKill = wasKill;
        this.kill(this.pos, this.buf.length, false);
        this.lastWasKill = true;
        await this.refresh();
        return null;
      case '\x15':
        this.kill(0, this.pos, true);
        this.lastWasKill = true;
        await this.refresh();
        return null;
      case '\x17': {
        let p = this.pos;
        while (p > 0 && /\s/.test(this.buf[p - 1])) p--;
        while (p > 0 && !/\s/.test(this.buf[p - 1])) p--;
        this.kill(p, this.pos, true);
        this.lastWasKill = true;
        await this.refresh();
        return null;
      }
      case '\x19': {
        const text = this.killRing[this.killRing.length - 1];
        if (text) {
          this.insert(text);
          this.emit('yank');
          await this.refresh();
        }
        return null;
      }
      case '\x14': {
        if (this.pos === 0 || this.buf.length < 2) return null;
        this.saveUndo();
        let p = this.pos;
        if (p === this.buf.length) p = prevPos(this.buf, p);
        const a = prevPos(this.buf, p);
        const ch1 = this.buf.slice(a, p);
        const ch2 = this.buf.slice(p, nextPos(this.buf, p));
        this.buf = this.buf.slice(0, a) + ch2 + ch1 + this.buf.slice(p + ch2.length);
        this.pos = a + ch2.length + ch1.length;
        await this.refresh();
        return null;
      }
      case '\x0c': {
        this.emit('clear-screen');
        await this.tty.writeRaw('\x1b[H\x1b[2J');
        this.cursorRow = 0;
        await this.tty.writeRaw(this.prompt.slice(0, this.prompt.length - this.promptLast.length).replace(/\r?\n/g, '\r\n'));
        await this.refresh();
        return null;
      }
      case '\x03': {
        // ^C: abandon the line
        this.pos = this.buf.length;
        await this.refresh();
        await this.tty.writeRaw('^C');
        await this.finishLineAfter();
        this.emit('interrupt');
        this.searching = false;
        return { kind: 'interrupt' };
      }
      case '\x10':
        return this.historyPrev();
      case '\x0e':
        return this.historyNext();
      case '\x12':
        this.startSearch();
        await this.refresh();
        return null;
      case '\t':
        await this.complete(wasTab);
        return null;
      case '\x1f': {
        const u = this.undoStack.pop();
        if (u) {
          this.buf = u.buf;
          this.pos = u.pos;
          await this.refresh();
        } else this.bell();
        return null;
      }
      case '\x07':
        this.bell();
        return null;
      default:
        return null;
    }
  }

  private async finishLineEof(): Promise<void> {
    await this.finishLine();
  }

  private async finishLineAfter(): Promise<void> {
    // cursor is at end of buffer (after "^C")
    await this.tty.writeRaw('\r\n');
    this.cursorRow = 0;
  }

  private async handleMeta(c: string, wasKill: boolean, wasYankArg: boolean): Promise<ReadResult | null> {
    switch (c) {
      case 'b':
      case 'B':
        this.pos = this.wordLeft(this.pos);
        this.emit('move-word');
        await this.refresh();
        return null;
      case 'f':
      case 'F':
        this.pos = this.wordRight(this.pos);
        this.emit('move-word');
        await this.refresh();
        return null;
      case 'd':
      case 'D':
        this.lastWasKill = wasKill;
        this.kill(this.pos, this.wordRight(this.pos), false);
        this.lastWasKill = true;
        await this.refresh();
        return null;
      case '\x7f':
      case '\b':
        this.kill(this.wordLeft(this.pos), this.pos, true);
        this.lastWasKill = true;
        await this.refresh();
        return null;
      case '.':
      case '_': {
        const h = this.host.history;
        if (!wasYankArg) {
          this.yankLastArgIndex = h.length - 1;
          this.lastYankLen = 0;
        } else {
          this.yankLastArgIndex--;
          // remove previously inserted arg
          this.buf = this.buf.slice(0, this.pos - this.lastYankLen) + this.buf.slice(this.pos);
          this.pos -= this.lastYankLen;
        }
        const entry = h.entries[this.yankLastArgIndex];
        if (entry !== undefined) {
          const words = splitHistoryWords(entry);
          const last = words[words.length - 1] ?? '';
          this.insert(last);
          this.lastYankLen = last.length;
        } else this.lastYankLen = 0;
        this.lastKeyWasYankArg = true;
        await this.refresh();
        return null;
      }
      case 'u':
      case 'l':
      case 'c': {
        const end = this.wordRight(this.pos);
        let start = this.pos;
        while (start < end && !isWordChar(this.buf[start])) start++;
        const word = this.buf.slice(start, end);
        const repl = c === 'u' ? word.toUpperCase() : c === 'l' ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        this.saveUndo();
        this.buf = this.buf.slice(0, start) + repl + this.buf.slice(end);
        this.pos = end;
        await this.refresh();
        return null;
      }
      case '\r':
        // Alt+Enter inserts a newline
        this.insert('\n');
        await this.refresh();
        return null;
      default:
        return null;
    }
  }

  private async handleCsi(s: string): Promise<ReadResult | null> {
    switch (s) {
      case 'A':
        return this.historyPrev();
      case 'B':
        return this.historyNext();
      case 'C':
        this.pos = nextPos(this.buf, this.pos);
        await this.refresh();
        return null;
      case 'D':
        this.pos = prevPos(this.buf, this.pos);
        await this.refresh();
        return null;
      case 'H':
      case '1~':
      case '7~':
        this.pos = 0;
        this.emit('line-start');
        await this.refresh();
        return null;
      case 'F':
      case '4~':
      case '8~':
        this.pos = this.buf.length;
        this.emit('line-end');
        await this.refresh();
        return null;
      case '3~':
        if (this.pos < this.buf.length) {
          this.saveUndo();
          this.buf = this.buf.slice(0, this.pos) + this.buf.slice(nextPos(this.buf, this.pos));
          await this.refresh();
        }
        return null;
      case '1;5D':
      case '1;3D':
        this.pos = this.wordLeft(this.pos);
        this.emit('move-word');
        await this.refresh();
        return null;
      case '1;5C':
      case '1;3C':
        this.pos = this.wordRight(this.pos);
        this.emit('move-word');
        await this.refresh();
        return null;
      case '3;5~':
        this.kill(this.pos, this.wordRight(this.pos), false);
        await this.refresh();
        return null;
      default:
        return null;
    }
  }

  private async historyPrev(): Promise<null> {
    if (this.histIndex > 0) {
      this.setFromHistory(this.histIndex - 1);
      this.emit('history-prev');
      await this.refresh();
    } else this.bell();
    return null;
  }

  private async historyNext(): Promise<null> {
    const h = this.host.history;
    if (this.histIndex < h.length) {
      this.setFromHistory(this.histIndex + 1);
      this.emit('history-next');
      await this.refresh();
    } else this.bell();
    return null;
  }

  private bell(): void {
    void this.tty.writeRaw('\x07');
  }

  // ---------------------------------------------------------------------------
  // reverse-i-search

  private startSearch(): void {
    this.emit('reverse-search');
    this.searching = true;
    this.searchQuery = '';
    this.searchFailed = false;
    this.searchIndex = this.host.history.length;
    this.searchOriginal = { buf: this.buf, pos: this.pos };
  }

  private searchFrom(start: number): boolean {
    const entries = this.host.history.entries;
    if (this.searchQuery === '') return true;
    for (let i = Math.min(start, entries.length - 1); i >= 0; i--) {
      const idx = entries[i].lastIndexOf(this.searchQuery);
      if (idx !== -1) {
        this.searchIndex = i;
        this.buf = entries[i];
        this.pos = idx;
        this.searchFailed = false;
        return true;
      }
    }
    this.searchFailed = true;
    return false;
  }

  private async handleSearchKey(key: Key): Promise<ReadResult | null | 'continue'> {
    if (key.t === 'text') {
      this.searchQuery += key.s;
      this.searchFrom(this.searchIndex === this.host.history.length ? this.searchIndex - 1 : this.searchIndex);
      await this.refresh();
      return null;
    }
    if (key.t === 'ctrl') {
      switch (key.c) {
        case '\x12':
          if (this.searchQuery === '') {
            // repeat the last search
            return null;
          }
          this.searchFrom(this.searchIndex - 1);
          await this.refresh();
          return null;
        case '\x7f':
        case '\b':
          this.searchQuery = this.searchQuery.slice(0, -1);
          this.searchIndex = this.host.history.length;
          if (this.searchQuery === '') {
            this.buf = this.searchOriginal.buf;
            this.pos = this.searchOriginal.pos;
            this.searchFailed = false;
          } else this.searchFrom(this.searchIndex - 1);
          await this.refresh();
          return null;
        case '\x07':
          this.searching = false;
          this.buf = this.searchOriginal.buf;
          this.pos = this.searchOriginal.pos;
          await this.refresh();
          return null;
        case '\r':
        case '\n':
          this.searching = false;
          await this.refresh();
          await this.finishLine();
          return { kind: 'line', line: this.buf };
        case '\x03':
          this.searching = false;
          return 'continue';
        default:
          this.searching = false;
          await this.refresh();
          return 'continue';
      }
    }
    if (key.t === 'esc') {
      this.searching = false;
      await this.refresh();
      return null;
    }
    this.searching = false;
    await this.refresh();
    return 'continue';
  }

  // ---------------------------------------------------------------------------
  // completion

  private async complete(wasTab: boolean): Promise<void> {
    if (!this.host.complete) {
      this.insert('\t');
      await this.refresh();
      return;
    }
    const c = await this.host.complete(this.buf, this.pos);
    if (!c || c.candidates.length === 0) {
      this.bell();
      return;
    }
    const word = this.buf.slice(c.start, this.pos);
    if (c.candidates.length === 1) {
      const suffix = c.suffixes?.[0] ?? ' ';
      let replacement = c.candidates[0];
      // keep what follows the cursor; avoid doubling a space
      const after = this.buf.slice(this.pos);
      let suf = suffix;
      if ((suf === ' ' && after.startsWith(' ')) || (suf === '/' && after.startsWith('/'))) suf = '';
      replacement += suf;
      this.saveUndo();
      this.buf = this.buf.slice(0, c.start) + replacement + after;
      this.pos = c.start + replacement.length;
      this.emit('tab-complete');
      await this.refresh();
      return;
    }
    const common = commonPrefix(c.candidates);
    if (common.length > word.length) {
      this.saveUndo();
      this.buf = this.buf.slice(0, c.start) + common + this.buf.slice(this.pos);
      this.pos = c.start + common.length;
      this.emit('tab-complete');
      await this.refresh();
      this.lastWasTab = true;
      return;
    }
    if (!wasTab) {
      this.bell();
      this.lastWasTab = true;
      return;
    }
    this.lastWasTab = true;
    this.emit('tab-list');
    await this.listCandidates(c.display ?? c.candidates);
  }

  private async listCandidates(items: string[]): Promise<void> {
    await this.finishLine();
    const tty = this.tty;
    if (items.length > 100) {
      await tty.writeRaw(`Display all ${items.length} possibilities? (y or n)`);
      const ans = await tty.readRaw();
      await tty.writeRaw('\r\n');
      if (!/^[yY ]/.test(ans)) {
        await tty.writeRaw(this.prompt.replace(/\r?\n/g, '\r\n'));
        await this.refresh();
        return;
      }
    }
    const width = Math.max(...items.map((s) => stringWidth(s))) + 2;
    const cols = Math.max(1, Math.floor(this.cols / width));
    const rows = Math.ceil(items.length / cols);
    let out = '';
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let col = 0; col < cols; col++) {
        const idx = col * rows + r;
        if (idx >= items.length) break;
        const s = items[idx];
        line += idx + rows < items.length ? s + ' '.repeat(width - stringWidth(s)) : s;
      }
      out += line + '\r\n';
    }
    await tty.writeRaw(out);
    await tty.writeRaw(this.prompt.replace(/\r?\n/g, '\r\n'));
    this.cursorRow = 0;
    await this.refresh();
  }
}

function commonPrefix(items: string[]): string {
  if (items.length === 0) return '';
  let p = items[0];
  for (const s of items.slice(1)) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
  }
  return p;
}

function keyToString(k: Key): string {
  switch (k.t) {
    case 'text':
      return k.s;
    case 'paste':
      return `\x1b[200~${k.s}\x1b[201~`;
    case 'ctrl':
      return k.c;
    case 'csi':
      return '\x1b[' + k.s;
    case 'ss3':
      return '\x1bO' + k.s;
    case 'meta':
      return '\x1b' + k.c;
    case 'esc':
      return '\x1b';
  }
}
