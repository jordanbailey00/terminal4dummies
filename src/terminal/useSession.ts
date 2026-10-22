// Creates a terminal session for a page and disposes it on unmount.

import { useEffect, useState } from 'react';
import { createSystem } from '../shell';
import { Session } from '../shell/session';
import type { System } from '../shell/system';
import { XtermBackend } from './xtermBackend';

export interface LiveSession {
  session: Session;
  backend: XtermBackend;
  system: System;
}

export interface SessionFactoryOptions {
  makeSystem?: () => System;
  banner?: string;
  history?: string[];
  startDir?: string;
  adminHint?: boolean;
}

export function createLiveSession(opts: SessionFactoryOptions = {}): LiveSession {
  const system = opts.makeSystem ? opts.makeSystem() : createSystem();
  const backend = new XtermBackend();
  const session = new Session({ system, backend, banner: opts.banner, history: opts.history, startDir: opts.startDir, adminHint: opts.adminHint });
  return { session, backend, system };
}

/** One session per `key`; recreated when the key changes. */
export function useLiveSession(key: string, factory: () => LiveSession): LiveSession | null {
  const [live, setLive] = useState<LiveSession | null>(null);
  useEffect(() => {
    const s = factory();
    let disposed = false;
    setLive(s);
    // Start the shell once the terminal is on screen and knows its size.
    void s.backend.whenAttached().then(() => {
      if (!disposed) void s.session.start();
    });
    return () => {
      disposed = true;
      s.session.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return live;
}
