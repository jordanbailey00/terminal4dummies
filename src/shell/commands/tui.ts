// Helpers for full-screen terminal programs (less, man, nano, top...).

import { parseKeys } from '../readline';
import type { TtyDriver, TtyModes } from '../tty';
import type { CommandContext } from '../types';
import { charWidth, stringWidth, stripAnsi } from '../wcwidth';

export type TuiKey =
  | { t: 'text'; s: string }
  | { t: 'paste'; s: string }
  | { t: 'ctrl'; c: string }
  | { t: 'csi'; s: string }
  | { t: 'ss3'; s: string }
  | { t: 'meta'; c: string }
  | { t: 'esc' };

/** Normalized key names for convenience: 'up', 'down', 'pgup', 'home', 'f6', 'C-x'... */
export function keyName(k: TuiKey): string {
  switch (k.t) {
    case 'text':
      return k.s;
    case 'paste':
      return 'paste';
    case 'esc':
      return 'escape';
    case 'meta':
      return 'M-' + k.c;
    case 'ctrl': {
      const code = k.c.charCodeAt(0);
      if (k.c === '\r' || k.c === '\n') return 'enter';
      if (k.c === '\t') return 'tab';
      if (code === 0x7f || code === 8) return 'backspace';
      if (code === 0x1f) return 'C-_';
      if (code === 0x1c) return 'C-\\';
      if (code === 0) return 'C-space';
      return 'C-' + String.fromCharCode(code + 96);
    }
    case 'csi':
    case 'ss3': {
      const map: Record<string, string> = {
        A: 'up',
        B: 'down',
        C: 'right',
        D: 'left',
        H: 'home',
        F: 'end',
        '1~': 'home',
        '7~': 'home',
        '4~': 'end',
        '8~': 'end',
        '2~': 'insert',
        '3~': 'delete',
        '5~': 'pgup',
        '6~': 'pgdn',
        P: 'f1',
        Q: 'f2',
        R: 'f3',
        S: 'f4',
        '15~': 'f5',
        '17~': 'f6',
        '18~': 'f7',
        '19~': 'f8',
        '20~': 'f9',
        '21~': 'f10',
        '23~': 'f11',
        '24~': 'f12',
        '1;5A': 'C-up',
        '1;5B': 'C-down',
        '1;5C': 'C-right',
        '1;5D': 'C-left',
        '1;5H': 'C-home',
        '1;5F': 'C-end',
        '1;2A': 'S-up',
        '1;2B': 'S-down',
        Z: 'S-tab',
      };
      return map[k.s] ?? 'unknown';
    }
  }
}

export class Screen {
  readonly tty: TtyDriver;
  private savedModes: TtyModes | null = null;
  private pending: string[] = [];
  private resizeOff: (() => void) | null = null;
  private resized = false;
  onResize: (() => void) | null = null;

  constructor(tty: TtyDriver) {
    this.tty = tty;
  }

  get cols(): number {
    return this.tty.cols;
  }

  get rows(): number {
    return this.tty.rows;
  }

  async enter(opts: { isig?: boolean } = {}): Promise<void> {
    this.savedModes = this.tty.getModes();
    this.tty.setModes({ icanon: false, echo: false, isig: opts.isig ?? false, opost: false });
    this.resizeOff = this.tty.onResize(() => {
      this.resized = true;
      this.onResize?.();
    });
    await this.tty.writeRaw('\x1b[?1049h\x1b[H\x1b[2J');
  }

  async leave(): Promise<void> {
    this.resizeOff?.();
    await this.tty.writeRaw('\x1b[0m\x1b[?25h\x1b[2J\x1b[?1049l');
    if (this.savedModes) this.tty.setModes(this.savedModes);
  }

  /** Keys typed since the last read (waits for at least one). */
  async readKeys(signal?: AbortSignal): Promise<TuiKey[]> {
    const data = await this.tty.readRaw(signal);
    return parseKeys(data) as TuiKey[];
  }

  /** Was the terminal resized since the last call? */
  takeResized(): boolean {
    const r = this.resized;
    this.resized = false;
    return r;
  }

  buffer(s: string): void {
    this.pending.push(s);
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const s = this.pending.join('');
    this.pending = [];
    await this.tty.writeRaw(s);
  }

  moveTo(row: number, col: number): string {
    return `\x1b[${row + 1};${col + 1}H`;
  }
}

/** Truncate a string (which may contain SGR escapes) to a display width. */
export function truncateAnsi(s: string, width: number): string {
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > width) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out;
}

/** Split a line (with SGR escapes) into chunks of at most `width` columns. */
export function wrapAnsi(s: string, width: number): string[] {
  if (width <= 0) return [s];
  const expanded = expandTabs(s);
  if (stringWidth(expanded) <= width) return [expanded];
  const chunks: string[] = [];
  let cur = '';
  let w = 0;
  let sgr = '';
  let i = 0;
  while (i < expanded.length) {
    if (expanded[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(expanded.slice(i));
      if (m) {
        cur += m[0];
        if (m[0].endsWith('m')) sgr = m[0] === '\x1b[0m' || m[0] === '\x1b[m' ? '' : sgr + m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = expanded.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > width) {
      chunks.push(cur + (sgr ? '\x1b[0m' : ''));
      cur = sgr;
      w = 0;
    }
    cur += ch;
    w += cw;
    i += ch.length;
  }
  chunks.push(cur);
  return chunks;
}

export function expandTabs(s: string): string {
  if (!s.includes('\t')) return s;
  let out = '';
  let col = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (c === '\t') {
      const n = 8 - (col % 8);
      out += ' '.repeat(n);
      col += n;
      i++;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out += ch;
    col += charWidth(cp);
    i += ch.length;
  }
  return out;
}

/** Make control characters visible the way less does (^A, ESC kept for SGR). */
export function visibleControls(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, (c) => `\x1b[7m^${c === '\x7f' ? '?' : String.fromCharCode(c.charCodeAt(0) + 64)}\x1b[27m`);
}

// ---------------------------------------------------------------------------
// Pager (less / more / man)

export interface PagerOptions {
  /** Name shown in the first prompt (file name) or null for standard input. */
  name: string | null;
  /** Use man's prompt: " Manual page ls(1) line 1 (press h for help or q to quit)". */
  manTitle?: string;
  /** Behave like `more` (quit at end of file, --More-- prompt). */
  more?: boolean;
  /** Show line numbers (-N). */
  lineNumbers?: boolean;
  /** Chop long lines instead of wrapping (-S). */
  chop?: boolean;
  /** Start position: line number or search. */
  startLine?: number;
}

const LESS_HELP = `
                   SUMMARY OF LESS COMMANDS

      Commands marked with * may be preceded by a number, N.
      A key preceded by a caret means the Ctrl key; thus ^F is Ctrl+F.

  h  H                 Display this help.
  q  :q  Q  :Q  ZZ     Exit.
 ---------------------------------------------------------------------------

                           MOVING

  e  ^E  j  ^N  CR  *  Forward  one line   (or N lines).
  y  ^Y  k  ^K  ^P  *  Backward one line   (or N lines).
  f  ^F  ^V  SPACE  *  Forward  one window (or N lines).
  b  ^B  ESC-v      *  Backward one window (or N lines).
  d  ^D             *  Forward  one half-window.
  u  ^U             *  Backward one half-window.
  RightArrow / LeftArrow   Scroll horizontally (with -S).
  r  ^R  ^L            Repaint screen.
 ---------------------------------------------------------------------------

                          SEARCHING

  /pattern          *  Search forward for (N-th) matching line.
  ?pattern          *  Search backward for (N-th) matching line.
  n                 *  Repeat previous search (for N-th occurrence).
  N                 *  Repeat previous search in reverse direction.
 ---------------------------------------------------------------------------

                           JUMPING

  g  <  ESC-<       *  Go to first line in file (or line N).
  G  >  ESC->       *  Go to last line in file (or line N).
  p  %              *  Go to beginning of file (or N percent into file).
 ---------------------------------------------------------------------------

                        MISCELLANEOUS

  -N                   Toggle line numbers.
  -S                   Toggle chopping of long lines.
  =  ^G                Print current file name and position.

 Press q to leave this help.
`;

export async function runPager(ctx: CommandContext, text: string, o: PagerOptions): Promise<number> {
  const tty = ctx.tty!;
  const screen = new Screen(tty);
  const logical = text.replace(/\r\n/g, '\n').split('\n');
  if (logical.length > 1 && logical[logical.length - 1] === '') logical.pop();
  let lineNumbers = !!o.lineNumbers;
  let chop = !!o.chop;
  let display: { text: string; line: number; first: boolean }[] = [];
  let top = 0;
  let hscroll = 0;
  let lastSearch: { re: RegExp; forward: boolean } | null = null;
  let message: string | null = null;
  let firstPrompt = true;
  let pendingNumber = '';
  let showHelp = false;
  let helpTop = 0;
  const body = () => screen.rows - 1;

  const rebuild = () => {
    const width = screen.cols - (lineNumbers ? 8 : 0);
    display = [];
    logical.forEach((l, i) => {
      const vis = visibleControls(l);
      if (chop) display.push({ text: expandTabs(vis), line: i, first: true });
      else wrapAnsi(vis, width).forEach((chunk, k) => display.push({ text: chunk, line: i, first: k === 0 }));
    });
  };
  rebuild();
  if (o.startLine) top = Math.max(0, display.findIndex((d) => d.line >= o.startLine! - 1));
  const maxTop = () => Math.max(0, display.length - body());
  const atEnd = () => top >= maxTop();

  const highlight = (s: string): string => {
    if (!lastSearch) return s;
    const plain = stripAnsi(s);
    const re = new RegExp(lastSearch.re.source, lastSearch.re.flags.includes('g') ? lastSearch.re.flags : lastSearch.re.flags + 'g');
    if (!re.test(plain)) return s;
    re.lastIndex = 0;
    return plain.replace(re, (m) => (m ? `\x1b[7m${m}\x1b[27m` : m));
  };

  const prompt = (): string => {
    if (message) return `\x1b[7m${message}\x1b[27m`;
    if (o.more) {
      if (atEnd()) return `\x1b[7m--More--(END)\x1b[27m`;
      const pct = Math.floor(((top + body()) / Math.max(1, display.length)) * 100);
      return `\x1b[7m--More--(${pct}%)\x1b[27m`;
    }
    const lineNo = (display[top]?.line ?? 0) + 1;
    if (o.manTitle) {
      const total = logical.length;
      const end = atEnd() ? ` (END)` : '';
      return `\x1b[7m ${o.manTitle} line ${lineNo}${atEnd() ? `/${total}` : ''}${end} (press h for help or q to quit)\x1b[27m`;
    }
    if (atEnd()) return `\x1b[7m(END)\x1b[27m`;
    if (firstPrompt && o.name) return `\x1b[7m${o.name}\x1b[27m`;
    return ':';
  };

  const render = async () => {
    let out = '\x1b[H';
    const rows = body();
    if (showHelp) {
      const lines = LESS_HELP.split('\n');
      for (let r = 0; r < rows; r++) out += screen.moveTo(r, 0) + truncateAnsi(lines[helpTop + r] ?? '', screen.cols) + '\x1b[K';
      out += screen.moveTo(rows, 0) + `\x1b[7mHELP -- ${helpTop + rows >= lines.length ? 'END -- Press g to see it again' : 'Press RETURN for more'}, or q when done\x1b[27m\x1b[K`;
      await tty.writeRaw(out);
      return;
    }
    for (let r = 0; r < rows; r++) {
      const d = display[top + r];
      let line: string;
      if (!d) line = o.more ? '' : '\x1b[1m~\x1b[0m';
      else {
        let t = highlight(d.text);
        if (chop && hscroll > 0) t = sliceAnsi(t, hscroll);
        const prefix = lineNumbers ? (d.first ? `\x1b[1m${String(d.line + 1).padStart(7)}\x1b[0m ` : '        ') : '';
        line = prefix + truncateAnsi(t, screen.cols - (lineNumbers ? 8 : 0)) + '\x1b[0m';
      }
      out += screen.moveTo(r, 0) + line + '\x1b[K';
    }
    out += screen.moveTo(rows, 0) + prompt() + '\x1b[K';
    await tty.writeRaw(out);
  };

  const search = (re: RegExp, forward: boolean, fromLine: number): boolean => {
    const startLogical = display[fromLine]?.line ?? 0;
    const step = forward ? 1 : -1;
    for (let i = startLogical + step; i >= 0 && i < logical.length; i += step) {
      if (re.test(stripAnsi(logical[i]))) {
        top = Math.min(maxTop(), Math.max(0, display.findIndex((d) => d.line === i)));
        return true;
      }
    }
    return false;
  };

  const readLineAtBottom = async (label: string): Promise<string | null> => {
    let buf = '';
    for (;;) {
      await tty.writeRaw(screen.moveTo(body(), 0) + label + buf + '\x1b[K');
      const keys = await screen.readKeys();
      for (const k of keys) {
        const name = keyName(k);
        if (name === 'enter') return buf;
        if (name === 'C-c' || name === 'escape' || name === 'C-g') return null;
        if (name === 'backspace') {
          if (buf === '') return null;
          buf = [...buf].slice(0, -1).join('');
        } else if (k.t === 'text') buf += k.s;
        else if (k.t === 'paste') buf += k.s.replace(/\n/g, ' ');
      }
    }
  };

  await screen.enter();
  screen.onResize = () => {
    rebuild();
    if (top > maxTop()) top = maxTop();
  };
  try {
    if (o.more && display.length <= body()) {
      // more: short files just print and exit
      await screen.leave();
      await ctx.out(text);
      return 0;
    }
    await render();
    for (;;) {
      const keys = await screen.readKeys();
      for (const k of keys) {
        const name = keyName(k);
        if (showHelp) {
          const lines = LESS_HELP.split('\n');
          if (name === 'q' || name === 'Q' || name === 'escape') showHelp = false;
          else if (name === 'enter' || name === 'down' || name === 'j') helpTop = Math.min(Math.max(0, lines.length - body()), helpTop + 1);
          else if (name === ' ' || name === 'f' || name === 'pgdn') helpTop = Math.min(Math.max(0, lines.length - body()), helpTop + body());
          else if (name === 'b' || name === 'pgup') helpTop = Math.max(0, helpTop - body());
          else if (name === 'k' || name === 'up') helpTop = Math.max(0, helpTop - 1);
          else if (name === 'g') helpTop = 0;
          continue;
        }
        const hadMessage = message !== null;
        message = null;
        if (/^\d$/.test(name)) {
          pendingNumber += name;
          continue;
        }
        const n = pendingNumber ? parseInt(pendingNumber, 10) : null;
        pendingNumber = '';
        firstPrompt = false;
        switch (name) {
          case 'q':
          case 'Q':
          case 'Z':
            return 0;
          case ':': {
            const cmd = await readLineAtBottom(':');
            if (cmd === 'q' || cmd === 'Q') return 0;
            break;
          }
          case ' ':
          case 'f':
          case 'C-f':
          case 'C-v':
          case 'pgdn':
          case 'z':
            if (o.more && atEnd()) return 0;
            top = Math.min(maxTop(), top + (n ?? body()));
            break;
          case 'b':
          case 'C-b':
          case 'pgup':
          case 'w':
          case 'M-v':
            top = Math.max(0, top - (n ?? body()));
            break;
          case 'enter':
          case 'j':
          case 'e':
          case 'C-n':
          case 'C-e':
          case 'down':
            if (o.more && atEnd()) return 0;
            top = Math.min(maxTop(), top + (n ?? 1));
            break;
          case 'k':
          case 'y':
          case 'C-y':
          case 'C-p':
          case 'C-k':
          case 'up':
            top = Math.max(0, top - (n ?? 1));
            break;
          case 'd':
          case 'C-d':
            top = Math.min(maxTop(), top + (n ?? Math.floor(body() / 2)));
            break;
          case 'u':
          case 'C-u':
            top = Math.max(0, top - (n ?? Math.floor(body() / 2)));
            break;
          case 'g':
          case '<':
          case 'home':
          case 'M-<':
            top = n ? Math.max(0, Math.min(maxTop(), display.findIndex((d) => d.line >= n - 1))) : 0;
            break;
          case 'G':
          case '>':
          case 'end':
          case 'M->':
            top = n ? Math.max(0, Math.min(maxTop(), display.findIndex((d) => d.line >= n - 1))) : maxTop();
            break;
          case 'p':
          case '%':
            top = Math.min(maxTop(), Math.floor(((n ?? 0) / 100) * display.length));
            break;
          case 'right':
            if (chop) hscroll += Math.floor(screen.cols / 2);
            break;
          case 'left':
            if (chop) hscroll = Math.max(0, hscroll - Math.floor(screen.cols / 2));
            break;
          case 'r':
          case 'C-r':
          case 'C-l':
            break;
          case 'h':
          case 'H':
            showHelp = true;
            helpTop = 0;
            break;
          case '=':
          case 'C-g': {
            const lineNo = (display[top]?.line ?? 0) + 1;
            const lastLine = (display[Math.min(display.length - 1, top + body() - 1)]?.line ?? 0) + 1;
            const pct = Math.floor((lastLine / Math.max(1, logical.length)) * 100);
            message = `${o.name ?? 'Standard input'} lines ${lineNo}-${lastLine}/${logical.length} ${pct}%`;
            break;
          }
          case '-': {
            const opt = await readLineAtBottom('Set option: -');
            if (opt === 'N') {
              lineNumbers = !lineNumbers;
              rebuild();
              message = lineNumbers ? 'Constantly display line numbers' : "Don't use line numbers";
            } else if (opt === 'S') {
              chop = !chop;
              hscroll = 0;
              rebuild();
              message = chop ? 'Chop long lines' : 'Fold long lines';
            }
            break;
          }
          case '/':
          case '?': {
            const pat = await readLineAtBottom(name);
            if (pat === null || pat === '') {
              if (pat === '' && lastSearch) {
                if (!search(lastSearch.re, name === '/', top)) message = 'Pattern not found  (press RETURN)';
              }
              break;
            }
            let re: RegExp;
            try {
              re = new RegExp(pat, /[A-Z]/.test(pat) ? '' : 'i');
            } catch {
              re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            }
            lastSearch = { re, forward: name === '/' };
            let found = false;
            for (let c = 0; c < (n ?? 1); c++) found = search(re, name === '/', top) || found;
            if (!found) message = 'Pattern not found  (press RETURN)';
            break;
          }
          case 'n':
          case 'N':
            if (!lastSearch) {
              message = 'No previous regular expression  (press RETURN)';
              break;
            }
            if (!search(lastSearch.re, name === 'n' ? lastSearch.forward : !lastSearch.forward, top)) message = 'Pattern not found  (press RETURN)';
            break;
          default:
            if (!hadMessage && name !== 'C-c' && name !== 'escape') {
              // unknown keys just beep in less
              await tty.writeRaw('\x07');
            }
        }
      }
      await render();
    }
  } finally {
    await screen.leave();
  }
}

function sliceAnsi(s: string, skip: number): string {
  let w = 0;
  let i = 0;
  let prefix = '';
  while (i < s.length && w < skip) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(s.slice(i));
      if (m) {
        prefix += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    w += charWidth(cp);
    i += String.fromCodePoint(cp).length;
  }
  return prefix + s.slice(i);
}
