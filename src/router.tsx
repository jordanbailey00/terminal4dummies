// A tiny client-side router (history API).

import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') window.addEventListener('popstate', notify);

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = new URL(to, window.location.href);
  const same = url.pathname === window.location.pathname && url.search === window.location.search;
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  notify();
  if (url.hash) {
    requestAnimationFrame(() => document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ block: 'start' }));
  } else if (!same) {
    window.scrollTo(0, 0);
  }
}

function snapshot(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

export function useLocation(): { pathname: string; hash: string; search: string } {
  const href = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    snapshot,
    () => '/',
  );
  const url = new URL(href, 'http://x');
  return { pathname: url.pathname, hash: url.hash, search: url.search };
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (/^https?:/.test(to)) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
