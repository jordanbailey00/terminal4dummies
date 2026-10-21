// Terminal colors and font settings.

import type { ITheme } from '@xterm/xterm';

export const TERMINAL_FONT = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

export const TERMINAL_THEME: ITheme = {
  background: '#0e1116',
  foreground: '#e3e8ef',
  cursor: '#5eea8c',
  cursorAccent: '#0e1116',
  selectionBackground: 'rgba(110, 160, 255, 0.35)',
  selectionInactiveBackground: 'rgba(110, 160, 255, 0.2)',
  black: '#3b4252',
  red: '#ff6b6b',
  green: '#4cd97b',
  yellow: '#f2c55c',
  blue: '#5aa7ff',
  magenta: '#c792ea',
  cyan: '#4dd0e1',
  white: '#c7ced8',
  brightBlack: '#6b7686',
  brightRed: '#ff8f8f',
  brightGreen: '#6ff09a',
  brightYellow: '#ffd77a',
  brightBlue: '#82bcff',
  brightMagenta: '#dcb0f7',
  brightCyan: '#7fe3ef',
  brightWhite: '#ffffff',
  scrollbarSliderBackground: 'rgba(255,255,255,0.12)',
  scrollbarSliderHoverBackground: 'rgba(255,255,255,0.22)',
  scrollbarSliderActiveBackground: 'rgba(255,255,255,0.3)',
};
