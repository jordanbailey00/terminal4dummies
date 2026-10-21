// A row of extra keys for phones and tablets (Tab, Ctrl, arrows, symbols).

import { useEffect, useRef, useState } from 'react';
import type { XtermBackend } from './xtermBackend';

const KEYS: { label: string; send?: string; ctrl?: boolean; title: string }[] = [
  { label: 'Esc', send: '\x1b', title: 'Escape' },
  { label: 'Tab', send: '\t', title: 'Tab (autocomplete)' },
  { label: 'Ctrl', ctrl: true, title: 'Hold Ctrl for the next key' },
  { label: '↑', send: '\x1b[A', title: 'Up (previous command)' },
  { label: '↓', send: '\x1b[B', title: 'Down' },
  { label: '←', send: '\x1b[D', title: 'Left' },
  { label: '→', send: '\x1b[C', title: 'Right' },
  { label: '|', send: '|', title: 'Pipe' },
  { label: '~', send: '~', title: 'Tilde (home)' },
  { label: '/', send: '/', title: 'Slash' },
  { label: '-', send: '-', title: 'Dash' },
  { label: '^C', send: '\x03', title: 'Ctrl+C (cancel)' },
];

export function MobileKeys({ backend, focus }: { backend: XtermBackend; focus: () => void }) {
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;

  useEffect(() => {
    backend.inputFilter = (d: string) => {
      if (!ctrlRef.current) return d;
      setCtrl(false);
      if (d.length === 1) {
        const c = d.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
        if (d === ' ') return '\x00';
      }
      return d;
    };
    return () => {
      backend.inputFilter = null;
    };
  }, [backend]);

  return (
    <div className="mobile-keys" role="toolbar" aria-label="Extra keys">
      {KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          title={k.title}
          className={k.ctrl && ctrl ? 'active' : undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (k.ctrl) setCtrl((v) => !v);
            else if (k.send) {
              let data = k.send;
              if (ctrl && data.length === 1 && /[a-z]/i.test(data)) data = String.fromCharCode(data.toLowerCase().charCodeAt(0) - 96);
              setCtrl(false);
              backend.type(data);
            }
            focus();
          }}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
