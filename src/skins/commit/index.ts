// The site's look, modeled on the Commit Mono website (commitmono.com), as a
// skin over the original styles. Loaded before the app starts, except in
// `--mode classic`, which keeps the original look (see vite.config.ts).

import type { ITheme } from '@xterm/xterm';
import { readPrefs, writePrefs } from '../../state/prefs';
import { TERMINAL_THEME_DARK, TERMINAL_THEME_LIGHT } from '../../terminal/theme';
import './skin.css';

const root = document.documentElement;
root.dataset.skin = 'commit';

// commitmono.com opens in its grey light mode whatever the OS uses
if (readPrefs().theme === 'system') {
  writePrefs({ theme: 'light' });
  root.setAttribute('data-theme', 'light');
}

// The terminal in the same colors. ANSI colors stay (lessons talk about blue
// folders) but are darkened or muted to sit on the grey.
const LIGHT: ITheme = {
  background: '#aaaaaa',
  foreground: '#111111',
  cursor: '#111111',
  cursorAccent: '#aaaaaa',
  selectionBackground: '#555555',
  selectionForeground: '#aaaaaa',
  selectionInactiveBackground: '#777777',
  black: '#111111',
  red: '#741818',
  green: '#184418',
  yellow: '#4f3900',
  blue: '#1c2f80',
  magenta: '#5a1d68',
  cyan: '#0b434a',
  white: '#2e2e2e',
  brightBlack: '#3d3d3d',
  brightRed: '#7c0e0e',
  brightGreen: '#0d4719',
  brightYellow: '#4a3600',
  brightBlue: '#0f2a9a',
  brightMagenta: '#5f1572',
  brightCyan: '#00434a',
  brightWhite: '#000000',
  scrollbarSliderBackground: 'rgba(17, 17, 17, 0.35)',
  scrollbarSliderHoverBackground: 'rgba(17, 17, 17, 0.5)',
  scrollbarSliderActiveBackground: 'rgba(17, 17, 17, 0.65)',
};

const DARK: ITheme = {
  background: '#111111',
  foreground: '#c8c8c8',
  cursor: '#c8c8c8',
  cursorAccent: '#111111',
  selectionBackground: '#555555',
  selectionForeground: '#ececec',
  selectionInactiveBackground: '#3a3a3a',
  black: '#4a4a4a',
  red: '#df8a8a',
  green: '#8ec58e',
  yellow: '#d2b870',
  blue: '#93aee6',
  magenta: '#c39ed8',
  cyan: '#80bec4',
  white: '#c8c8c8',
  brightBlack: '#8c8c8c',
  brightRed: '#efa8a8',
  brightGreen: '#aad8aa',
  brightYellow: '#e2ca8a',
  brightBlue: '#b0c6f2',
  brightMagenta: '#d6bae6',
  brightCyan: '#9fd2d8',
  brightWhite: '#ececec',
  scrollbarSliderBackground: 'rgba(200, 200, 200, 0.3)',
  scrollbarSliderHoverBackground: 'rgba(200, 200, 200, 0.45)',
  scrollbarSliderActiveBackground: 'rgba(200, 200, 200, 0.6)',
};

// the terminal reads these objects whenever it (re)applies its colors
Object.assign(TERMINAL_THEME_LIGHT, LIGHT);
Object.assign(TERMINAL_THEME_DARK, DARK);

// Keys for the terminal along the bottom of pages that have one, like the
// keyboard footer of commitmono.com (the skin's CSS shows and hides it).
const KEYS: [string[], string][] = [
  [['Tab'], 'Complete'],
  [['↑', '↓'], 'History'],
  [['Ctrl', 'R'], 'Search history'],
  [['Ctrl', 'C'], 'Stop'],
  [['Ctrl', 'L'], 'Clear'],
  [['Ctrl', 'A', 'E'], 'Line start/end'],
  [['Ctrl', 'U'], 'Delete to start'],
  [['Q'], 'Quit less/man'],
];

const footer = document.createElement('footer');
footer.className = 'skin-keys';
footer.setAttribute('aria-label', 'Terminal keys');
for (const [caps, label] of KEYS) {
  const group = document.createElement('div');
  group.className = 'skin-key-group';
  const row = document.createElement('div');
  row.className = 'skin-keycaps';
  for (const c of caps) {
    const key = document.createElement('kbd');
    key.className = 'skin-key';
    key.textContent = c;
    row.append(key);
  }
  const text = document.createElement('span');
  text.textContent = label;
  group.append(row, text);
  footer.append(group);
}
document.body.append(footer);
