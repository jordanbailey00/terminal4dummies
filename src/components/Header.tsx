import { useEffect, useState } from 'react';
import { Link, useLocation } from '../router';
import { readPrefs, writePrefs } from '../state/prefs';
import { IconMenu, IconMoon, IconSun } from './Icons';

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
  { to: '/learn', label: 'Lessons' },
  { to: '/playground', label: 'Playground' },
  { to: '/reference', label: 'Commands' },
  { to: '/glossary', label: 'Glossary' },
];

export function Header() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(() => readPrefs().theme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => setOpen(false), [pathname]);

  const toggleTheme = () => {
    const next = effectiveDark(theme) ? 'light' : 'dark';
    writePrefs({ theme: next });
    setTheme(next);
  };

  return (
    <header className="site-header">
      <Link to="/" className="brand" aria-label="terminal4dummies home">
        <span className="brand-mark">&gt;_</span>
        <span>
          terminal<span className="brand-4">4</span>dummies
        </span>
      </Link>
      <nav className={`site-nav ${open ? 'open' : ''}`} aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className={pathname === n.to || pathname.startsWith(n.to + '/') ? 'active' : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <span className="header-spacer" />
      <button type="button" className="icon-btn" onClick={toggleTheme} aria-label={effectiveDark(theme) ? 'Switch to light theme' : 'Switch to dark theme'} title="Toggle light/dark">
        {effectiveDark(theme) ? <IconSun /> : <IconMoon />}
      </button>
      <button type="button" className="icon-btn menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Menu" aria-expanded={open}>
        <IconMenu />
      </button>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="inner">
        <span>terminal4dummies: learn the command line by using one. Everything runs in your browser.</span>
        <span className="row">
          <Link to="/learn">Lessons</Link>
          <Link to="/playground">Playground</Link>
          <Link to="/reference">Commands</Link>
          <a href="https://github.com/jordanbailey00/terminal4dummies" target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
        </span>
      </div>
    </footer>
  );
}
