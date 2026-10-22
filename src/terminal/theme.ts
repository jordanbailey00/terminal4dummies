// Terminal colors and font settings. The terminal follows the site theme:
// the header's toggle sets data-theme on <html>; without it the OS setting wins.

import type { ITheme } from '@xterm/xterm';

export const TERMINAL_FONT = '"Commit Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** The site's monospace font (the --font-mono CSS variable), which the terminal uses too. */
export function terminalFont(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return v || TERMINAL_FONT;
}

/** The first family in a font stack, e.g. "IBM Plex Mono". */
export function primaryFamily(stack: string): string {
  return stack.split(',')[0].trim().replace(/^["']|["']$/g, '');
}

export const TERMINAL_THEME_DARK: ITheme = {
  background: '#0c0c0c',
  foreground: '#f5f5f5',
  cursor: '#5eea8c',
  cursorAccent: '#0c0c0c',
  selectionBackground: 'rgba(255, 255, 255, 0.22)',
  selectionInactiveBackground: 'rgba(255, 255, 255, 0.12)',
  black: '#3a3a3a',
  red: '#ff6b6b',
  green: '#4cd97b',
  yellow: '#f2c55c',
  blue: '#5aa7ff',
  magenta: '#c792ea',
  cyan: '#4dd0e1',
  white: '#dcdcdc',
  brightBlack: '#6e6e6e',
  brightRed: '#ff8f8f',
  brightGreen: '#6ff09a',
  brightYellow: '#ffd77a',
  brightBlue: '#82bcff',
  brightMagenta: '#dcb0f7',
  brightCyan: '#7fe3ef',
  brightWhite: '#ffffff',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.12)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.22)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.3)',
};

/** Colors chosen to stay readable on a light background ("white" is a mid gray). */
export const TERMINAL_THEME_LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1f1f1f',
  cursor: '#1a7f37',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(0, 0, 0, 0.15)',
  selectionInactiveBackground: 'rgba(0, 0, 0, 0.08)',
  black: '#1f1f1f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e6e6e',
  brightBlack: '#575757',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#7d4e00',
  brightBlue: '#0550ae',
  brightMagenta: '#6639ba',
  brightCyan: '#136061',
  brightWhite: '#8c8c8c',
  scrollbarSliderBackground: 'rgba(0, 0, 0, 0.15)',
  scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.25)',
  scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.35)',
};

/** Is the page currently using the dark theme? */
export function pageIsDark(): boolean {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return !window.matchMedia?.('(prefers-color-scheme: light)').matches;
}

export function terminalTheme(): ITheme {
  return pageIsDark() ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT;
}

/** Call `fn` whenever the page switches between light and dark. */
export function onThemeChange(fn: () => void): () => void {
  const observer = new MutationObserver(fn);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  media?.addEventListener('change', fn);
  return () => {
    observer.disconnect();
    media?.removeEventListener('change', fn);
  };
}
