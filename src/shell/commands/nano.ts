// GNU nano 7.2 — the beginner-friendly text editor.
//
// One deliberate difference from real nano: "Where Is" (search) is shown and
// bound as ^F, because browsers do not let pages intercept Ctrl+W (it closes
// the tab). ^W still works if the browser passes it through.

import type { CommandContext } from '../types';
import { FsError } from '../vfs/fs';
import { charWidth, stringWidth } from '../wcwidth';
import { Screen, keyName, type TuiKey } from './tui';
import { defineCommand, errText } from './util';

const VERSION = '7.2';
const TAB = 8;

interface Snapshot {
  lines: string[];
  cy: number;
  cx: number;
}

type Shortcut = [string, string];

const MAIN_BAR: Shortcut[][] = [
  [
    ['^G', 'Help'],
    ['^O', 'Write Out'],
    ['^F', 'Where Is'],
    ['^K', 'Cut'],
    ['M-U', 'Undo'],
    ['^C', 'Location'],
    ['M-A', 'Set Mark'],
    ['M-]', 'To Bracket'],
    ['M-Q', 'Previous'],
  ],
  [
    ['^X', 'Exit'],
    ['^R', 'Read File'],
    ['^\\', 'Replace'],
    ['^U', 'Paste'],
    ['M-E', 'Redo'],
    ['^/', 'Go To Line'],
    ['M-6', 'Copy'],
    ['^B', 'Back'],
    ['M-W', 'Next'],
  ],
];

const HELP_TEXT = `Main nano help text

The nano editor is designed to emulate the functionality and ease-of-use of
the UW Pico text editor.  There are four main sections of the editor.  The
top line shows the program version, the current filename being edited, and
whether or not the file has been modified.  Next is the main editor window
showing the file being edited.  The status line is the third line from the
bottom and shows important messages.  The bottom two lines show the most
commonly used shortcuts in the editor.

Shortcuts are written as follows: Control-key sequences are notated with a
'^' and can be entered either by using the Ctrl key or pressing the Esc key
twice.  Meta-key sequences are notated with 'M-' and can be entered using
either the Alt, Cmd, or Esc key, depending on your keyboard setup.

Note for this browser version: your browser reserves Ctrl+W (close tab), so
"Where Is" (search) is on ^F here instead of the usual ^W.

The following keystrokes are available in the main editor window.

^G      F1      Display this help text
^X      F2      Close the current buffer / Exit from nano
^O      F3      Write the current buffer (or the marked region) to disk
^S              Save file without prompting
^R      Ins     Insert another file into current one
^F      F6      Search forward for a string
M-W             Repeat the last search forward
^\\      M-R     Replace a string
^K      F9      Cut current line into cutbuffer
^U      F10     Paste the contents of cutbuffer at current cursor position
M-6             Copy current line into cutbuffer
^C      F11     Display the position of the cursor
^/      ^_      Go to line and column number
M-U             Undo the last operation
M-E             Redo the last undone operation

^B      Left    Go back one character
^F      Right   (arrow keys move the cursor)
^A      Home    Go to beginning of current line
^E      End     Go to end of current line
^Y      PgUp    Go one screenful up
^V      PgDn    Go one screenful down
M-\\     ^Home   Go to the first line of the file
M-/     ^End    Go to the last line of the file
^L              Refresh (redraw) the current screen

Press ^X to close this help.`;

class Nano {
  private readonly ctx: CommandContext;
  private readonly screen: Screen;
  lines: string[] = [''];
  cy = 0;
  cx = 0;
  private wantCol = 0;
  private top = 0;
  filename: string | null;
  modified = false;
  private viewOnly: boolean;
  private lineNumbers: boolean;
  private cutBuffer: string[] = [];
  private lastWasCut = false;
  private status: string | null = null;
  private statusKeep = 0;
  private undo: Snapshot[] = [];
  private redo: Snapshot[] = [];
  private lastSearch = '';
  private markStart: { cy: number; cx: number } | null = null;

  constructor(ctx: CommandContext, filename: string | null, opts: { viewOnly: boolean; lineNumbers: boolean }) {
    this.ctx = ctx;
    this.screen = new Screen(ctx.tty!);
    this.filename = filename;
    this.viewOnly = opts.viewOnly;
    this.lineNumbers = opts.lineNumbers;
  }

  // ---------------------------------------------------------------------------
  // file I/O

  load(): void {
    const name = this.filename;
    if (name === null) return;
    const fs = this.ctx.fs;
    const node = fs.tryStat(name);
    if (!node) {
      this.setStatus('New File');
      return;
    }
    if (node.type === 'dir') {
      this.setStatus(`"${name}" is a directory`);
      this.filename = null;
      return;
    }
    try {
      const text = fs.readFile(name);
      // like nano, the buffer ends with an empty line you can move onto
      const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
      if (lines[lines.length - 1] !== '') lines.push('');
      this.lines = lines;
      const n = lines.length - 1;
      this.setStatus(`Read ${n} line${n === 1 ? '' : 's'}`);
      if (!fs.canAccess(node, 2) && !this.viewOnly) this.setStatus(`File '${name}' is unwritable`);
    } catch (e) {
      this.setStatus(`Error reading ${name}: ${errText(e)}`);
    }
  }

  private write(name: string): boolean {
    this.keepLastLineEmpty();
    const text = this.lines.join('\n');
    try {
      const node = this.ctx.fs.tryStat(name);
      if (node?.type === 'dir') throw new FsError('EISDIR', name);
      this.ctx.fs.writeFile(name, text);
      const n = this.lines.length - 1;
      this.setStatus(`Wrote ${n} line${n === 1 ? '' : 's'}`);
      this.filename = name;
      this.modified = false;
      return true;
    } catch (e) {
      this.setStatus(`Error writing ${name}: ${errText(e)}`);
      return false;
    }
  }

  private setStatus(msg: string): void {
    this.status = msg;
    this.statusKeep = 2;
  }

  // ---------------------------------------------------------------------------
  // geometry

  private get rows(): number {
    return this.screen.rows;
  }
  private get cols(): number {
    return this.screen.cols;
  }
  private get editRows(): number {
    return Math.max(1, this.rows - 4);
  }
  private get gutter(): number {
    return this.lineNumbers ? String(this.lines.length).length + 2 : 0;
  }
  private get textCols(): number {
    return Math.max(4, this.cols - this.gutter);
  }

  /** Display column of a character index (tabs expanded). */
  private displayCol(line: string, idx: number): number {
    let col = 0;
    for (let i = 0; i < idx && i < line.length; ) {
      const cp = line.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      col += ch === '\t' ? TAB - (col % TAB) : Math.max(1, charWidth(cp));
      i += ch.length;
    }
    return col;
  }

  /** Character index closest to a display column. */
  private indexForCol(line: string, target: number): number {
    let col = 0;
    let i = 0;
    while (i < line.length) {
      const cp = line.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const w = ch === '\t' ? TAB - (col % TAB) : Math.max(1, charWidth(cp));
      if (col + w > target) break;
      col += w;
      i += ch.length;
    }
    return i;
  }

  private expand(line: string): string {
    let out = '';
    let col = 0;
    for (const ch of line) {
      if (ch === '\t') {
        const n = TAB - (col % TAB);
        out += ' '.repeat(n);
        col += n;
      } else {
        const cp = ch.codePointAt(0)!;
        if (cp < 32 || cp === 127) {
          out += '^' + String.fromCharCode(cp === 127 ? 63 : cp + 64);
          col += 2;
        } else {
          out += ch;
          col += Math.max(1, charWidth(cp));
        }
      }
    }
    return out;
  }

  private sliceCols(s: string, start: number, width: number): string {
    let out = '';
    let col = 0;
    for (const ch of s) {
      const w = Math.max(1, charWidth(ch.codePointAt(0)!));
      if (col >= start && col + w <= start + width) out += ch;
      col += w;
      if (col >= start + width) break;
    }
    return out;
  }

  private scrollToCursor(): void {
    if (this.cy < this.top) this.top = this.cy;
    if (this.cy >= this.top + this.editRows) this.top = this.cy - this.editRows + 1;
    if (this.top < 0) this.top = 0;
  }

  // ---------------------------------------------------------------------------
  // drawing

  private titleBar(): string {
    const cols = this.cols;
    const left = `  GNU nano ${VERSION}`;
    const name = this.filename ?? 'New Buffer';
    const right = this.modified ? 'Modified  ' : this.viewOnly ? 'View  ' : '';
    let line = left.padEnd(cols);
    const nameStart = Math.max(left.length + 1, Math.floor((cols - name.length) / 2));
    line = line.slice(0, nameStart) + name + line.slice(nameStart + name.length);
    if (right) line = line.slice(0, cols - right.length) + right;
    return `\x1b[7m${line.slice(0, cols)}\x1b[27m`;
  }

  private shortcutBars(bars: Shortcut[][]): string[] {
    const cols = this.cols;
    const perRow = Math.max(2, Math.min(bars[0].length, Math.floor(cols / 13)));
    const width = Math.floor(cols / perRow);
    return bars.map((row) => {
      let out = '';
      row.slice(0, perRow).forEach(([key, label], i) => {
        const cell = `\x1b[7m${key}\x1b[27m ${label}`;
        const visible = key.length + 1 + label.length;
        const w = i === perRow - 1 ? cols - width * (perRow - 1) : width;
        out += visible >= w ? `\x1b[7m${key}\x1b[27m ${label.slice(0, Math.max(0, w - key.length - 1))}` : cell + ' '.repeat(w - visible);
      });
      return out;
    });
  }

  async draw(bottom?: { prompt?: string; input?: string; bars?: Shortcut[][] }): Promise<void> {
    const s = this.screen;
    const cols = this.cols;
    let out = '\x1b[?25l\x1b[H' + this.titleBar() + '\x1b[K';
    this.scrollToCursor();
    const tc = this.textCols;
    let cursorRow = 1;
    let cursorCol = 0;
    for (let r = 0; r < this.editRows; r++) {
      const li = this.top + r;
      out += s.moveTo(r + 1, 0);
      if (li < this.lines.length) {
        if (this.lineNumbers) out += `\x1b[2m${String(li + 1).padStart(this.gutter - 1)}\x1b[22m `;
        const disp = this.expand(this.lines[li]);
        const width = stringWidth(disp);
        let start = 0;
        if (li === this.cy) {
          const cc = this.displayCol(this.lines[li], this.cx);
          if (cc >= tc - 1) {
            const chunk = Math.max(1, tc - 8);
            start = Math.floor((cc - (tc - 8)) / chunk + 1) * chunk;
            if (start > cc) start = cc;
          }
          cursorRow = r + 1;
          cursorCol = this.gutter + cc - start;
        }
        let visible = this.sliceCols(disp, start, tc);
        if (start > 0) visible = '<' + this.sliceCols(disp, start + 1, tc - 1);
        if (width - start > tc) visible = this.sliceCols(visible, 0, tc - 1) + '>';
        out += this.highlightMark(li, visible, start);
      }
      out += '\x1b[K';
    }
    // status line
    out += s.moveTo(this.rows - 3, 0);
    if (bottom?.prompt !== undefined) {
      const text = bottom.prompt + (bottom.input ?? '');
      out += `\x1b[7m${text.padEnd(cols).slice(0, cols)}\x1b[27m`;
    } else if (this.status) {
      const msg = `[ ${this.status} ]`;
      const pad = Math.max(0, Math.floor((cols - msg.length) / 2));
      out += ' '.repeat(pad) + `\x1b[7m${msg.slice(0, cols)}\x1b[27m`;
    }
    out += '\x1b[K';
    const bars = this.shortcutBars(bottom?.bars ?? MAIN_BAR);
    out += s.moveTo(this.rows - 2, 0) + bars[0] + '\x1b[K';
    out += s.moveTo(this.rows - 1, 0) + (bars[1] ?? '') + '\x1b[K';
    if (bottom?.prompt !== undefined) {
      const text = bottom.prompt + (bottom.input ?? '');
      out += s.moveTo(this.rows - 3, Math.min(cols - 1, stringWidth(text)));
    } else {
      out += s.moveTo(cursorRow, Math.min(cols - 1, cursorCol));
    }
    out += '\x1b[?25h';
    await this.screen.tty.writeRaw(out);
  }

  private highlightMark(li: number, visible: string, start: number): string {
    if (!this.markStart) return visible;
    const a = this.markStart;
    const b = { cy: this.cy, cx: this.cx };
    const [from, to] = a.cy < b.cy || (a.cy === b.cy && a.cx <= b.cx) ? [a, b] : [b, a];
    if (li < from.cy || li > to.cy) return visible;
    const line = this.lines[li];
    const s0 = li === from.cy ? this.displayCol(line, from.cx) - start : 0;
    const s1 = li === to.cy ? this.displayCol(line, to.cx) - start : stringWidth(visible);
    const sa = Math.max(0, s0);
    const sb = Math.max(sa, Math.min(stringWidth(visible), s1));
    return this.sliceCols(visible, 0, sa) + '\x1b[7m' + this.sliceCols(visible, sa, sb - sa) + '\x1b[27m' + this.sliceCols(visible, sb, 10000);
  }

  // ---------------------------------------------------------------------------
  // editing primitives

  private snapshot(): void {
    this.undo.push({ lines: [...this.lines], cy: this.cy, cx: this.cx });
    if (this.undo.length > 300) this.undo.shift();
    this.redo = [];
  }

  private changed(): void {
    this.modified = true;
  }

  /** Typing on the empty last line gives it text, so a new empty line follows (saved files end in one newline). */
  private keepLastLineEmpty(): void {
    if (this.lines[this.lines.length - 1] !== '') this.lines.push('');
  }

  private guardView(): boolean {
    if (this.viewOnly) {
      this.setStatus('Key is invalid in view mode');
      return true;
    }
    return false;
  }

  insertText(text: string): void {
    if (this.guardView()) return;
    this.snapshot();
    const parts = text.replace(/\r\n?/g, '\n').split('\n');
    const line = this.lines[this.cy];
    const before = line.slice(0, this.cx);
    const after = line.slice(this.cx);
    if (parts.length === 1) {
      this.lines[this.cy] = before + parts[0] + after;
      this.cx += parts[0].length;
    } else {
      const newLines = [before + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + after];
      this.lines.splice(this.cy, 1, ...newLines);
      this.cy += parts.length - 1;
      this.cx = parts[parts.length - 1].length;
    }
    this.wantCol = this.displayCol(this.lines[this.cy], this.cx);
    this.changed();
  }

  private backspace(): void {
    if (this.guardView()) return;
    if (this.cx > 0) {
      this.snapshot();
      const line = this.lines[this.cy];
      let p = this.cx - 1;
      if (p > 0 && /[\udc00-\udfff]/.test(line[p])) p--;
      this.lines[this.cy] = line.slice(0, p) + line.slice(this.cx);
      this.cx = p;
      this.changed();
    } else if (this.cy > 0) {
      this.snapshot();
      const prev = this.lines[this.cy - 1];
      this.lines.splice(this.cy - 1, 2, prev + this.lines[this.cy]);
      this.cy--;
      this.cx = prev.length;
      this.changed();
    }
    this.wantCol = this.displayCol(this.lines[this.cy], this.cx);
  }

  private deleteChar(): void {
    if (this.guardView()) return;
    const line = this.lines[this.cy];
    if (this.cx < line.length) {
      this.snapshot();
      let n = 1;
      if (/[\ud800-\udbff]/.test(line[this.cx])) n = 2;
      this.lines[this.cy] = line.slice(0, this.cx) + line.slice(this.cx + n);
      this.changed();
    } else if (this.cy < this.lines.length - 1) {
      this.snapshot();
      this.lines.splice(this.cy, 2, line + this.lines[this.cy + 1]);
      this.changed();
    }
  }

  private cutLine(append: boolean): void {
    if (this.guardView()) return;
    this.snapshot();
    if (this.markStart) {
      const text = this.markedText();
      this.deleteMarked();
      this.cutBuffer = text.split('\n');
      this.markStart = null;
      this.changed();
      return;
    }
    const line = this.lines[this.cy];
    if (!append) this.cutBuffer = [];
    this.cutBuffer.push(line);
    if (this.lines.length === 1) this.lines = [''];
    else {
      this.lines.splice(this.cy, 1);
      if (this.cy >= this.lines.length) {
        this.lines.push('');
      }
    }
    this.cx = 0;
    this.changed();
  }

  private copyLine(): void {
    if (this.markStart) {
      this.cutBuffer = this.markedText().split('\n');
      this.markStart = null;
      this.setStatus('Copied');
      return;
    }
    this.cutBuffer = [this.lines[this.cy]];
    if (this.cy < this.lines.length - 1) {
      this.cy++;
      this.cx = 0;
    }
  }

  private markedText(): string {
    if (!this.markStart) return '';
    const a = this.markStart;
    const b = { cy: this.cy, cx: this.cx };
    const [from, to] = a.cy < b.cy || (a.cy === b.cy && a.cx <= b.cx) ? [a, b] : [b, a];
    if (from.cy === to.cy) return this.lines[from.cy].slice(from.cx, to.cx);
    const parts = [this.lines[from.cy].slice(from.cx), ...this.lines.slice(from.cy + 1, to.cy), this.lines[to.cy].slice(0, to.cx)];
    return parts.join('\n');
  }

  private deleteMarked(): void {
    if (!this.markStart) return;
    const a = this.markStart;
    const b = { cy: this.cy, cx: this.cx };
    const [from, to] = a.cy < b.cy || (a.cy === b.cy && a.cx <= b.cx) ? [a, b] : [b, a];
    const merged = this.lines[from.cy].slice(0, from.cx) + this.lines[to.cy].slice(to.cx);
    this.lines.splice(from.cy, to.cy - from.cy + 1, merged);
    this.cy = from.cy;
    this.cx = from.cx;
  }

  private paste(): void {
    if (this.guardView()) return;
    if (this.cutBuffer.length === 0) {
      this.setStatus('Cutbuffer is empty');
      return;
    }
    // whole cut lines are pasted as lines above the cursor line
    if (this.cx === 0 && this.cutBuffer.length >= 1) {
      this.snapshot();
      this.lines.splice(this.cy, 0, ...this.cutBuffer);
      this.cy += this.cutBuffer.length;
      this.changed();
      return;
    }
    this.insertText(this.cutBuffer.join('\n') + '\n');
  }

  private moveVert(delta: number): void {
    const ny = Math.max(0, Math.min(this.lines.length - 1, this.cy + delta));
    this.cy = ny;
    this.cx = this.indexForCol(this.lines[ny], this.wantCol);
  }

  private location(): void {
    const totalLines = this.lines.length;
    const line = this.lines[this.cy];
    const col = this.displayCol(line, this.cx) + 1;
    const lineLen = this.displayCol(line, line.length) + 1;
    let charIndex = 0;
    for (let i = 0; i < this.cy; i++) charIndex += [...this.lines[i]].length + 1;
    charIndex += [...line.slice(0, this.cx)].length + 1;
    const totalChars = this.lines.reduce((n, l) => n + [...l].length + 1, 0);
    const pct = (a: number, b: number) => Math.floor((a / Math.max(1, b)) * 100);
    this.setStatus(`line ${this.cy + 1}/${totalLines} (${pct(this.cy + 1, totalLines)}%), col ${col}/${lineLen} (${pct(col, lineLen)}%), char ${charIndex}/${totalChars} (${pct(charIndex, totalChars)}%)`);
  }

  // ---------------------------------------------------------------------------
  // prompts

  private async promptLine(prompt: string, initial: string, bars: Shortcut[][]): Promise<string | null> {
    let input = initial;
    for (;;) {
      await this.draw({ prompt, input, bars });
      const k = await this.screen.readKey();
      const name = keyName(k);
      if (name === 'enter') return input;
      if (name === 'C-c') return null;
      if (name === 'backspace') input = [...input].slice(0, -1).join('');
      else if (name === 'C-u') input = '';
      else if (k.t === 'text') input += k.s;
      else if (k.t === 'paste') input += k.s.replace(/\n/g, ' ');
    }
  }

  private async promptYesNo(prompt: string, withAll = false): Promise<'y' | 'n' | 'a' | null> {
    const bars: Shortcut[][] = withAll
      ? [
          [[' Y', 'Yes'], [' A', 'All']],
          [[' N', 'No'], ['^C', 'Cancel']],
        ]
      : [[[' Y', 'Yes']], [[' N', 'No'], ['^C', 'Cancel']]];
    for (;;) {
      await this.draw({ prompt, input: '', bars });
      const k = await this.screen.readKey();
      const name = keyName(k);
      if (name === 'y' || name === 'Y') return 'y';
      if (name === 'n' || name === 'N') return 'n';
      if (withAll && (name === 'a' || name === 'A')) return 'a';
      if (name === 'C-c') return null;
    }
  }

  private writeBars(): Shortcut[][] {
    return [
      [['^G', 'Help'], ['M-D', 'DOS Format'], ['M-A', 'Append'], ['M-B', 'Backup File']],
      [['^C', 'Cancel'], ['M-M', 'Mac Format'], ['M-P', 'Prepend'], ['^T', 'Browse']],
    ];
  }

  private async writeOut(): Promise<boolean> {
    const name = await this.promptLine('File Name to Write: ', this.filename ?? '', this.writeBars());
    if (name === null || name === '') {
      this.setStatus('Cancelled');
      return false;
    }
    if (name !== this.filename && this.ctx.fs.exists(name)) {
      const ans = await this.promptYesNo(`File "${name}" exists; OVERWRITE? `);
      if (ans !== 'y') {
        this.setStatus('Cancelled');
        return false;
      }
    }
    return this.write(name);
  }

  private async search(repeat: boolean): Promise<void> {
    let needle = this.lastSearch;
    if (!repeat || !needle) {
      const prompt = this.lastSearch ? `Search [${this.lastSearch}]: ` : 'Search: ';
      const ans = await this.promptLine(prompt, '', [
        [['^G', 'Help'], ['^Y', 'First Line'], ['^R', 'Replace'], ['^W', 'Beg of Par']],
        [['^C', 'Cancel'], ['^V', 'Last Line'], ['^T', 'Go To Line'], ['^O', 'End of Par']],
      ]);
      if (ans === null) {
        this.setStatus('Cancelled');
        return;
      }
      if (ans !== '') needle = ans;
      if (!needle) {
        this.setStatus('Cancelled');
        return;
      }
    }
    this.lastSearch = needle;
    const lower = needle.toLowerCase();
    const n = this.lines.length;
    for (let step = 0; step <= n; step++) {
      const li = (this.cy + step) % n;
      const line = this.lines[li].toLowerCase();
      const from = step === 0 ? this.cx + 1 : 0;
      const idx = line.indexOf(lower, from);
      if (idx !== -1 && !(step === n && idx >= this.cx)) {
        const wrapped = this.cy + step >= n;
        this.cy = li;
        this.cx = idx;
        this.wantCol = this.displayCol(this.lines[li], idx);
        if (wrapped) this.setStatus('Search Wrapped');
        return;
      }
    }
    this.setStatus(`"${needle}" not found`);
  }

  private async replace(): Promise<void> {
    if (this.guardView()) return;
    const needle = await this.promptLine(this.lastSearch ? `Search (to replace) [${this.lastSearch}]: ` : 'Search (to replace): ', '', [[['^G', 'Help']], [['^C', 'Cancel']]]);
    if (needle === null) {
      this.setStatus('Cancelled');
      return;
    }
    const find = needle || this.lastSearch;
    if (!find) {
      this.setStatus('Cancelled');
      return;
    }
    this.lastSearch = find;
    const repl = await this.promptLine('Replace with: ', '', [[['^G', 'Help']], [['^C', 'Cancel']]]);
    if (repl === null) {
      this.setStatus('Cancelled');
      return;
    }
    this.snapshot();
    let count = 0;
    let all = false;
    const lower = find.toLowerCase();
    let li = this.cy;
    let from = this.cx;
    let visited = 0;
    while (visited <= this.lines.length) {
      const idx = this.lines[li].toLowerCase().indexOf(lower, from);
      if (idx === -1) {
        li = (li + 1) % this.lines.length;
        from = 0;
        visited++;
        continue;
      }
      this.cy = li;
      this.cx = idx;
      let ans: 'y' | 'n' | 'a' | null = 'y';
      if (!all) {
        this.markStart = { cy: li, cx: idx + find.length };
        ans = await this.promptYesNo('Replace this instance?', true);
        this.markStart = null;
      }
      if (ans === null) break;
      if (ans === 'a') all = true;
      if (ans === 'y' || ans === 'a') {
        const line = this.lines[li];
        this.lines[li] = line.slice(0, idx) + repl + line.slice(idx + find.length);
        count++;
        from = idx + repl.length;
        this.changed();
      } else from = idx + 1;
      if (count > 10000) break;
    }
    this.setStatus(`Replaced ${count} occurrence${count === 1 ? '' : 's'}`);
  }

  private async gotoLine(): Promise<void> {
    const ans = await this.promptLine('Enter line number, column number: ', '', [[['^G', 'Help'], ['^Y', 'First Line'], ['^T', 'Go To Text']], [['^C', 'Cancel'], ['^V', 'Last Line']]]);
    if (ans === null || ans.trim() === '') {
      this.setStatus('Cancelled');
      return;
    }
    const m = /^\s*(-?\d+)?\s*(?:[,.\s]\s*(\d+))?\s*$/.exec(ans);
    if (!m) {
      this.setStatus('Invalid line or column number');
      return;
    }
    let line = m[1] ? parseInt(m[1], 10) : this.cy + 1;
    if (line < 0) line = this.lines.length + line + 1;
    this.cy = Math.max(0, Math.min(this.lines.length - 1, line - 1));
    const col = m[2] ? parseInt(m[2], 10) - 1 : 0;
    this.cx = this.indexForCol(this.lines[this.cy], col);
  }

  private async readFile(): Promise<void> {
    if (this.guardView()) return;
    const ans = await this.promptLine('File to insert [from ./]: ', '', [[['^G', 'Help'], ['^T', 'Browse']], [['^C', 'Cancel'], ['M-F', 'New Buffer']]]);
    if (ans === null || ans === '') {
      this.setStatus('Cancelled');
      return;
    }
    try {
      const node = this.ctx.fs.stat(ans);
      if (node.type === 'dir') throw new FsError('EISDIR', ans);
      const text = this.ctx.fs.readFile(ans);
      const body = text.endsWith('\n') ? text.slice(0, -1) : text;
      this.insertText(body);
      const n = body === '' ? 0 : body.split('\n').length;
      this.setStatus(`Read ${n} line${n === 1 ? '' : 's'}`);
    } catch (e) {
      this.setStatus(e instanceof FsError && e.code === 'ENOENT' ? `File "${ans}" not found` : `Error reading ${ans}: ${errText(e)}`);
    }
  }

  private async help(): Promise<void> {
    const lines = HELP_TEXT.split('\n');
    let top = 0;
    const bars: Shortcut[][] = [
      [['^L', 'Refresh'], ['^Y', 'Prev Page'], ['M-\\', 'First Line']],
      [['^X', 'Close'], ['^V', 'Next Page'], ['M-/', 'Last Line']],
    ];
    for (;;) {
      const s = this.screen;
      let out = '\x1b[?25l\x1b[H' + this.titleBar() + '\x1b[K';
      for (let r = 0; r < this.editRows + 1; r++) out += s.moveTo(r + 1, 0) + (lines[top + r] ?? '').slice(0, this.cols) + '\x1b[K';
      const b = this.shortcutBars(bars);
      out += s.moveTo(this.rows - 2, 0) + b[0] + '\x1b[K' + s.moveTo(this.rows - 1, 0) + b[1] + '\x1b[K';
      await s.tty.writeRaw(out);
      const k = await s.readKey();
      const name = keyName(k);
      if (name === 'C-x' || name === 'C-g' || name === 'f1' || name === 'q' || name === 'C-c') return;
      if (name === 'down' || name === 'C-n') top = Math.min(Math.max(0, lines.length - this.editRows), top + 1);
      if (name === 'up' || name === 'C-p') top = Math.max(0, top - 1);
      if (name === 'pgdn' || name === 'C-v' || name === ' ') top = Math.min(Math.max(0, lines.length - this.editRows), top + this.editRows);
      if (name === 'pgup' || name === 'C-y') top = Math.max(0, top - this.editRows);
    }
  }

  // ---------------------------------------------------------------------------
  // main loop

  /** Returns when the user exits. */
  async run(startLine?: number): Promise<void> {
    if (startLine !== undefined) {
      this.cy = Math.max(0, Math.min(this.lines.length - 1, startLine - 1));
    }
    await this.screen.enter();
    this.screen.onResize = () => void this.draw();
    try {
      await this.draw();
      for (;;) {
        const k = await this.screen.readKey();
        const done = await this.handle(k);
        if (done) return;
        this.keepLastLineEmpty();
        if (this.statusKeep > 0) this.statusKeep--;
        else this.status = null;
        await this.draw();
      }
    } finally {
      await this.screen.leave();
    }
  }

  private async handle(k: TuiKey): Promise<boolean> {
    const name = keyName(k);
    const wasCut = this.lastWasCut;
    this.lastWasCut = false;
    if (k.t === 'text') {
      this.insertText(k.s);
      return false;
    }
    if (k.t === 'paste') {
      this.insertText(k.s);
      return false;
    }
    switch (name) {
      case 'enter':
        this.insertText('\n');
        break;
      case 'tab':
        this.insertText('\t');
        break;
      case 'backspace':
      case 'C-h':
        this.backspace();
        break;
      case 'delete':
      case 'C-d':
        this.deleteChar();
        break;
      case 'left':
      case 'C-b':
        if (this.cx > 0) {
          this.cx--;
          if (this.cx > 0 && /[\udc00-\udfff]/.test(this.lines[this.cy][this.cx])) this.cx--;
        } else if (this.cy > 0) {
          this.cy--;
          this.cx = this.lines[this.cy].length;
        }
        this.wantCol = this.displayCol(this.lines[this.cy], this.cx);
        break;
      case 'right':
        if (this.cx < this.lines[this.cy].length) {
          this.cx++;
          if (/[\udc00-\udfff]/.test(this.lines[this.cy][this.cx] ?? '')) this.cx++;
        } else if (this.cy < this.lines.length - 1) {
          this.cy++;
          this.cx = 0;
        }
        this.wantCol = this.displayCol(this.lines[this.cy], this.cx);
        break;
      case 'up':
      case 'C-p':
        this.moveVert(-1);
        break;
      case 'down':
      case 'C-n':
        this.moveVert(1);
        break;
      case 'home':
      case 'C-a':
        this.cx = 0;
        this.wantCol = 0;
        break;
      case 'end':
      case 'C-e':
        this.cx = this.lines[this.cy].length;
        this.wantCol = this.displayCol(this.lines[this.cy], this.cx);
        break;
      case 'pgup':
      case 'C-y':
        this.top = Math.max(0, this.top - this.editRows);
        this.moveVert(-this.editRows);
        break;
      case 'pgdn':
      case 'C-v':
        this.top = Math.min(Math.max(0, this.lines.length - 1), this.top + this.editRows);
        this.moveVert(this.editRows);
        break;
      case 'C-home':
      case 'M-\\':
        this.cy = 0;
        this.cx = 0;
        break;
      case 'C-end':
      case 'M-/':
        this.cy = this.lines.length - 1;
        this.cx = this.lines[this.cy].length;
        break;
      case 'C-k':
      case 'f9':
        this.cutLine(wasCut);
        this.lastWasCut = true;
        break;
      case 'C-u':
      case 'f10':
        this.paste();
        break;
      case 'M-6':
      case 'M-^':
        this.copyLine();
        break;
      case 'M-a':
      case 'C-^':
        if (this.markStart) {
          this.markStart = null;
          this.setStatus('Mark Unset');
        } else {
          this.markStart = { cy: this.cy, cx: this.cx };
          this.setStatus('Mark Set');
        }
        break;
      case 'M-u': {
        const u = this.undo.pop();
        if (u) {
          this.redo.push({ lines: [...this.lines], cy: this.cy, cx: this.cx });
          this.lines = u.lines;
          this.cy = u.cy;
          this.cx = u.cx;
          this.modified = true;
          this.setStatus('Undid action');
        } else this.setStatus('Nothing to undo');
        break;
      }
      case 'M-e': {
        const r = this.redo.pop();
        if (r) {
          this.undo.push({ lines: [...this.lines], cy: this.cy, cx: this.cx });
          this.lines = r.lines;
          this.cy = r.cy;
          this.cx = r.cx;
          this.modified = true;
          this.setStatus('Redid action');
        } else this.setStatus('Nothing to redo');
        break;
      }
      case 'C-c':
      case 'f11':
        this.location();
        break;
      case 'C-g':
      case 'f1':
        await this.help();
        break;
      case 'C-o':
      case 'f3':
        if (this.viewOnly) this.setStatus('Key is invalid in view mode');
        else await this.writeOut();
        break;
      case 'C-s':
        if (this.viewOnly) break;
        if (this.filename) this.write(this.filename);
        else await this.writeOut();
        break;
      case 'C-f':
      case 'C-w':
      case 'f6':
        await this.search(false);
        break;
      case 'M-w':
        await this.search(true);
        break;
      case 'C-\\':
      case 'M-r':
        await this.replace();
        break;
      case 'C-_':
      case 'M-g':
        await this.gotoLine();
        break;
      case 'C-r':
      case 'insert':
        await this.readFile();
        break;
      case 'C-l':
        break;
      case 'C-x':
      case 'f2': {
        if (!this.modified || this.viewOnly) return true;
        const ans = await this.promptYesNo('Save modified buffer? ');
        if (ans === null) {
          this.setStatus('Cancelled');
          break;
        }
        if (ans === 'n') return true;
        const name = await this.promptLine('File Name to Write: ', this.filename ?? '', this.writeBars());
        if (name === null || name === '') {
          this.setStatus('Cancelled');
          break;
        }
        if (this.write(name)) return true;
        break;
      }
      case 'C-t':
        this.setStatus('Executing commands is not available in this practice terminal');
        break;
      case 'C-j':
        this.setStatus('Justify is not available in this practice terminal');
        break;
      case 'C-z':
        this.setStatus('Suspension is not enabled');
        break;
      default:
        break;
    }
    return false;
  }
}

defineCommand({
  name: 'nano',
  pkg: 'nano',
  size: 288896,
  doc: {
    category: 'files',
    summary: 'Nano\'s ANOther editor, inspired by Pico',
    synopsis: ['nano [options] [[+line[,column]] file]...'],
    description:
      'nano is a small and friendly editor. It copies the look and feel of Pico, but is free software, and implements several features that Pico lacks.\n\n' +
      'Type to insert text. The two lines at the bottom show the most useful shortcuts: ^ means the Ctrl key and M- means the Alt key. For example ^O (Ctrl+O) writes the file, ^X (Ctrl+X) exits, ^K cuts a line and ^U pastes it.\n\n' +
      'In this browser version search is on ^F, because browsers reserve Ctrl+W for closing tabs.',
    options: [
      { flags: '+LINE', desc: 'Place the cursor on line LINE.' },
      { flags: '-l, --linenumbers', desc: 'Display line numbers to the left of the text area.' },
      { flags: '-v, --view', desc: 'Just view the file and disallow editing: read-only mode.' },
    ],
    examples: [
      { cmd: 'nano notes.txt', desc: 'Edit (or create) notes.txt. Save with Ctrl+O, exit with Ctrl+X.' },
      { cmd: 'sudo nano /etc/hosts', desc: 'Edit a system file that only root may change.' },
      { cmd: 'nano +10 script.sh', desc: 'Open a file at line 10.' },
    ],
    seeAlso: ['less', 'cat'],
    tip: 'Ctrl+O then Enter saves. Ctrl+X quits. If you forget, the shortcuts are always listed at the bottom of the screen.',
  },
  gnu: false,
  run: async (ctx) => {
    let file: string | null = null;
    let startLine: number | undefined;
    let viewOnly = false;
    let lineNumbers = false;
    for (const a of ctx.args) {
      if (a === '--version' || a === '-V') {
        await ctx.out(` GNU nano, version ${VERSION}\n (C) 2023 the Free Software Foundation and various contributors\n Compiled options: --disable-libmagic --enable-utf8\n`);
        return 0;
      }
      if (a === '--help' || a === '-h') {
        await ctx.out(`Usage: nano [OPTIONS] [[+LINE[,COLUMN]] FILE]...\n\nTo place the cursor on a specific line of a file, put the line number with\na '+' before the filename.  The column number can be added after a comma.\n\n -l, --linenumbers          Show line numbers in front of the text\n -v, --view                 View mode (read-only)\n -h, --help                 Show this help text and exit\n -V, --version              Print version information and exit\n`);
        return 0;
      }
      if (/^\+\d+/.test(a)) startLine = parseInt(a.slice(1), 10);
      else if (a === '-l' || a === '--linenumbers') lineNumbers = true;
      else if (a === '-v' || a === '--view') viewOnly = true;
      else if (a.startsWith('-') && a !== '-') continue;
      else if (file === null) file = a;
    }
    if (!ctx.tty || !ctx.stdout.isTTY) {
      await ctx.err('Too many errors from stdin\n');
      return 1;
    }
    const editor = new Nano(ctx, file, { viewOnly, lineNumbers });
    editor.load();
    ctx.system.hooks.onFullscreen?.('nano');
    try {
      await editor.run(startLine);
    } finally {
      ctx.system.hooks.onFullscreen?.(null);
    }
    return 0;
  },
});
