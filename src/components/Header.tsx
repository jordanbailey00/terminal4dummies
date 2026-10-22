import { useEffect, useState } from 'react';
import { Link, useLocation } from '../router';
import { readPrefs, writePrefs } from '../state/prefs';

export function applyTheme(theme: 'system' | 'light' | 'dark') {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

function effectiveDark(theme: 'system' | 'light' | 'dark'): boolean {
  if (theme === 'system') return !window.matchMedia?.('(prefers-color-scheme: light)').matches;
  return theme === 'dark';
}

const NAV = [
  { to: '/', label: 'emulator', match: ['/'] },
  { to: '/learn', label: 'lessons', match: ['/learn'] },
  { to: '/reference', label: 'commands', match: ['/reference'] },
];

export function Header() {
  const { pathname } = useLocation();
  const [theme, setTheme] = useState(() => readPrefs().theme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const dark = effectiveDark(theme);
  const toggleTheme = () => {
    const next = dark ? 'light' : 'dark';
    writePrefs({ theme: next });
    setTheme(next);
  };

  return (
    <header className="site-header">
      <Link to="/" className="brand" aria-label="terminal4dummies: emulator">
        <span className="brand-long">
          terminal<b>4</b>dummies
        </span>
        <span className="brand-short">
          t<b>4</b>d
        </span>
      </Link>
      <nav className="site-nav" aria-label="Main">
        {NAV.map((n) => {
          const active = n.match.some((m) => pathname === m || (m !== '/' && pathname.startsWith(m + '/')));
          return (
            <Link key={n.to} to={n.to} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>
              {n.label}
            </Link>
          );
        })}
      </nav>
      <button type="button" className="theme-btn" onClick={toggleTheme} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}>
        {dark ? 'light' : 'dark'}
      </button>
    </header>
  );
}
