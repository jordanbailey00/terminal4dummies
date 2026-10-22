// The terminal window: xterm.js under a thin bar of controls.

import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MobileKeys } from './MobileKeys';
import { onThemeChange, primaryFamily, terminalFont, terminalTheme } from './theme';
import type { XtermBackend } from './xtermBackend';
import { readPrefs, writePrefs } from '../state/prefs';
import type { System } from '../shell/system';

export interface TerminalViewProps {
  backend: XtermBackend;
  /** The simulated computer (used to warn before leaving with unsaved editor changes). */
  system?: System;
  actions?: ReactNode;
  autoFocus?: boolean;
  /** Called with the xterm instance once it is ready (for focusing etc.). */
  onReady?: (term: Terminal) => void;
  className?: string;
}

function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
}

export function TerminalView({ backend, system, actions, autoFocus = true, onReady, className }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [touch] = useState(isTouchDevice);
  const [fontSize, setFontSize] = useState(() => readPrefs().fontSize);

  const changeFont = (delta: number) => {
    const next = Math.max(11, Math.min(24, fontSize + delta));
    setFontSize(next);
    writePrefs({ fontSize: next });
    const term = termRef.current;
    if (term) {
      term.options.fontSize = next;
      // the ResizeObserver will not fire for a font change, so refit by hand
      window.setTimeout(() => hostRef.current?.dispatchEvent(new Event('t4d-refit')), 0);
    }
  };

  // While a full-screen editor is open, Ctrl+W (which browsers reserve for
  // closing the tab) would lose work: ask before leaving the page.
  useEffect(() => {
    if (!system) return;
    let editing = false;
    const prev = system.hooks.onFullscreen;
    system.hooks.onFullscreen = (name) => {
      editing = name === 'nano';
      prev?.(name);
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!editing) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      system.hooks.onFullscreen = prev;
    };
  }, [system]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let term: Terminal | null = null;
    let ro: ResizeObserver | null = null;
    let raf = 0;
    const prefs = readPrefs();
    // switch colors along with the site's light/dark theme
    const offTheme = onThemeChange(() => {
      if (term) term.options.theme = terminalTheme();
    });

    const setup = () => {
      if (disposed) return;
      term = new Terminal({
        fontFamily: terminalFont(),
        fontSize: prefs.fontSize,
        lineHeight: 1.15,
        cursorBlink: true,
        cursorStyle: 'block',
        allowProposedApi: true,
        scrollback: 5000,
        theme: terminalTheme(),
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
      // Attach only after the renderer has measured the font and the
      // terminal has been fitted to its container.
      let tries = 0;
      const attachWhenSized = () => {
        if (disposed || !term) return;
        doFit();
        if (term.cols < 20 && tries++ < 20) {
          // timers (unlike animation frames) also run in background tabs
          window.setTimeout(attachWhenSized, 25);
          return;
        }
        backend.attach(term);
        if (import.meta.env.DEV) (window as unknown as { __t4d: unknown }).__t4d = { term, backend };
        ro = new ResizeObserver(() => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(doFit);
        });
        ro.observe(host);
        host.addEventListener('t4d-refit', doFit);
        if (autoFocus && !isTouchDevice()) term.focus();
        onReady?.(term);
      };
      window.setTimeout(attachWhenSized, 0);
    };

    // Wait for the web font so character cells are measured correctly.
    const fontReady = document.fonts?.load ? document.fonts.load(`${prefs.fontSize}px "${primaryFamily(terminalFont())}"`).catch(() => undefined) : Promise.resolve();
    void Promise.race([fontReady, new Promise((r) => setTimeout(r, 1500))]).then(setup);

    return () => {
      disposed = true;
      offTheme();
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
        <span className="term-actions" onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => changeFont(-1)} title="Smaller text" aria-label="Smaller text">
            A−
          </button>
          <button type="button" onClick={() => changeFont(1)} title="Bigger text" aria-label="Bigger text">
            A+
          </button>
          {actions}
        </span>
      </div>
      <div className="term-body" ref={hostRef} />
      {touch && <MobileKeys backend={backend} focus={() => termRef.current?.focus()} />}
    </div>
  );
}
