// Saving and restoring a simulated disk (and shell history) in localStorage.

import type { SerializedFS } from '../shell/vfs/fs';
import type { System } from '../shell/system';
import { safeGet, safeRemove, safeSet } from './prefs';

export interface SavedMachine {
  v: 1;
  fs: SerializedFS;
  history: string[];
  hostname: string;
  savedAt: number;
  /** Working directory of the shell when saved. */
  cwd?: string;
}

export function loadMachine(key: string): SavedMachine | null {
  const raw = safeGet(key);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as SavedMachine;
    if (m.v !== 1 || !m.fs) return null;
    return m;
  } catch {
    return null;
  }
}

export function saveMachine(key: string, system: System, history: string[], cwd?: string): boolean {
  const m: SavedMachine = { v: 1, fs: system.fs.serialize(), history: history.slice(-500), hostname: system.hostname, savedAt: Date.now(), cwd };
  return safeSet(key, JSON.stringify(m));
}

export function clearMachine(key: string): void {
  safeRemove(key);
}
