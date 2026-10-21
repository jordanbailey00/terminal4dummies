// The terminal window: xterm.js inside a desktop-style window frame.

import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MobileKeys } from './MobileKeys';
import { TERMINAL_FONT, TERMINAL_THEME } from './theme';
import type { XtermBackend } from './xtermBackend';
import { readPrefs } from '../state/prefs';

export interface TerminalViewProps {
  backend: XtermBackend;
  /** Title shown until the shell sets one. */
  initialTitle?: string;
  actions?: ReactNode;
  autoFocus?: boolean;
  /** Called with the xterm instance once it is ready (for focusing etc.). */
  onReady?: (term: Terminal) => void;
  className?: string;
}

function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
}

export function TerminalView({ backend, initialTitle = 'Terminal', actions, autoFocus = true, onReady, className }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [title, setTitle] = useState(initialTitle);
  const [touch] = useState(isTouchDevice);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let term: Terminal | null = null;
    let ro: ResizeObserver | null = null;
    let raf = 0;
    const prefs = readPrefs();

    const setup = () => {
      if (disposed) return;
      term = new Terminal({
        fontFamily: TERMINAL_FONT,
        fontSize: prefs.fontSize,
        lineHeight: 1.15,
        cursorBlink: true,
        cursorStyle: 'block',
        allowProposedApi: true,
        scrollback: 5000,
        theme: TERMINAL_THEME,
        macOptionIsMeta: true,
        rightClickSelectsWord: true,
        screenReaderMode: prefs.screenReader,
        drawBoldTextInBrightColors: true,
        minimumContrastRatio: 1,
        smoothScrollDuration: 0,
      });
      termRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
      const unicode = new Unicode11Addon();
      term.loadAddon(unicode);
      term.unicode.activeVersion = '11';
      term.open(host);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // WebGL unavailable: the DOM renderer is used instead
      }
      const doFit = () => {
        try {
          fit.fit();
        } catch {
          // container hidden
        }
      };
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;
        const t = term!;
        const mod = ev.ctrlKey || ev.metaKey;
        const key = ev.key.toLowerCase();
        // Copy: Ctrl+Shift+C, Cmd+C, or Ctrl+C while text is selected
        if ((mod && ev.shiftKey && key === 'c') || (ev.metaKey && key === 'c') || (ev.ctrlKey && !ev.shiftKey && key === 'c' && t.hasSelection())) {
          const text = t.getSelection();
          if (text) {
            void navigator.clipboard?.writeText(text).catch(() => {});
            t.clearSelection();
          }
          ev.preventDefault();
          return false;
        }
        // Paste: let the browser deliver a paste event to xterm
        if ((mod && key === 'v') || (ev.shiftKey && key === 'insert')) return false;
        // Keep browser zoom / devtools shortcuts working
        if (mod && (key === '=' || key === '-' || key === '0' || key === '+')) return false;
        if (ev.key === 'F12' || ev.key === 'F5' || (ev.ctrlKey && ev.shiftKey && (key === 'i' || key === 'j' || key === 'r'))) return false;
        if (ev.metaKey && !ev.ctrlKey) return false;
        return true;
      });
      term.onTitleChange((t) => setTitle(t || initialTitle));
      // Attach only after the renderer has measured the font and the
      // terminal has been fitted to its container.
      let tries = 0;
      const attachWhenSized = () => {
        if (disposed || !term) return;
        doFit();
        if (term.cols < 20 && tries++ < 20) {
          raf = requestAnimationFrame(attachWhenSized);
          return;
        }
        backend.attach(term);
        ro = new ResizeObserver(() => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(doFit);
        });
        ro.observe(host);
        if (autoFocus && !isTouchDevice()) term.focus();
        onReady?.(term);
      };
      raf = requestAnimationFrame(attachWhenSized);
    };

    // Wait for the web font so character cells are measured correctly.
    const fontReady = document.fonts?.load ? document.fonts.load(`${prefs.fontSize}px "JetBrains Mono Variable"`).catch(() => undefined) : Promise.resolve();
    void Promise.race([fontReady, new Promise((r) => setTimeout(r, 1500))]).then(setup);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      backend.detach();
      term?.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  return (
    <div className={`term-window ${className ?? ''}`} onMouseDown={() => setTimeout(() => termRef.current?.focus(), 0)}>
      <div className="term-titlebar">
        <span className="term-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="term-title" title={title}>
          {title}
        </span>
        <span className="term-actions" onMouseDown={(e) => e.stopPropagation()}>
          {actions}
        </span>
      </div>
      <div className="term-body" ref={hostRef} />
      {touch && <MobileKeys backend={backend} focus={() => termRef.current?.focus()} />}
    </div>
  );
}
