// Per-viewer preferences kept in localStorage (best effort).

export interface Prefs {
  fontSize: number;
  screenReader: boolean;
  theme: 'system' | 'light' | 'dark';
}

const KEY = 't4d.prefs.v1';
const DEFAULTS: Prefs = { fontSize: 15, screenReader: false, theme: 'system' };

export function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePrefs(p: Partial<Prefs>): Prefs {
  const next = { ...readPrefs(), ...p };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable
  }
  return next;
}

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
