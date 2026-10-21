// POSIX-style path helpers. All paths in the virtual filesystem use "/".

export function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

/** Split a path into its non-empty components ("a//b/" -> ["a", "b"]). */
export function splitPath(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0);
}

/**
 * Lexically normalize a path: collapse "//", resolve "." and "..".
 * Does not touch the filesystem, so symlinks are not followed (this matches
 * how bash maintains $PWD for `cd` in its default "logical" mode).
 */
export function normalize(p: string): string {
  const abs = isAbsolute(p);
  const out: string[] = [];
  for (const part of splitPath(p)) {
    if (part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  if (abs) return '/' + joined;
  return joined === '' ? '.' : joined;
}

export function join(...parts: string[]): string {
  const filtered = parts.filter((p) => p.length > 0);
  if (filtered.length === 0) return '.';
  return normalize(filtered.join('/'));
}

/** Resolve `p` against `cwd` and normalize the result. */
export function resolvePath(cwd: string, p: string): string {
  if (isAbsolute(p)) return normalize(p);
  return normalize(cwd + '/' + p);
}

/** Like the `dirname` command. */
export function dirname(p: string): string {
  if (p === '') return '.';
  let s = p.replace(/\/+$/, '');
  if (s === '') return '/';
  const idx = s.lastIndexOf('/');
  if (idx === -1) return '.';
  s = s.slice(0, idx).replace(/\/+$/, '');
  return s === '' ? '/' : s;
}

/** Like the `basename` command (without suffix removal). */
export function basename(p: string): string {
  const s = p.replace(/\/+$/, '');
  if (s === '') return p.startsWith('/') ? '/' : '';
  const idx = s.lastIndexOf('/');
  return idx === -1 ? s : s.slice(idx + 1);
}

/** Replace a leading home directory with "~" (for prompts and window titles). */
export function tildify(p: string, home: string): string {
  if (home && home !== '/' && (p === home || p.startsWith(home + '/'))) {
    return '~' + p.slice(home.length);
  }
  return p;
}
