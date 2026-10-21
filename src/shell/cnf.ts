// Ubuntu's "command-not-found" helper: suggests packages and close spellings.

import { allKnownCommands, packagesProviding } from './packages';
import type { System } from './system';

/** Strings one edit away (delete, transpose, replace, insert). */
function isOneEditAway(a: string, b: string): boolean {
  if (a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    const diffs: number[] = [];
    for (let i = 0; i < la; i++) if (a[i] !== b[i]) diffs.push(i);
    if (diffs.length === 1) return true;
    if (diffs.length === 2 && diffs[1] === diffs[0] + 1 && a[diffs[0]] === b[diffs[1]] && a[diffs[1]] === b[diffs[0]]) return true;
    return false;
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
    } else {
      if (skipped) return false;
      skipped = true;
      j++;
    }
  }
  return true;
}

/** Is `name` a command the system has installed somewhere on the standard PATH? */
function installedPath(system: System, name: string): boolean {
  for (const dir of ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/games']) {
    if (system.fs.tryStat(`${dir}/${name}`, { cwd: '/', creds: { uid: 0, gid: 0, groups: [0] } })) return true;
  }
  return false;
}

export function commandNotFoundMessage(system: System, name: string): string {
  if (name.length > 1 && !/^[\w.+-]+$/.test(name)) return `${name}: command not found\n`;
  const providers = packagesProviding(name).filter((p) => !installedPath(system, name) || !p.preinstalled);
  if (providers.length === 1) {
    const p = providers[0];
    const dir = p.commands.find((c) => c.name === name)!.dir;
    if (installedPath(system, name)) {
      return `Command '${name}' is available in '${dir}/${name}'\nThe command could not be located because '${dir}' is not included in the PATH environment variable.\n${name}: command not found\n`;
    }
    return `Command '${name}' not found, but can be installed with:\nsudo apt install ${p.name}\n`;
  }
  if (providers.length > 1) {
    let out = `Command '${name}' not found, but can be installed with:\n`;
    for (const p of providers) out += `sudo apt install ${p.name.padEnd(12)} # version ${p.version}, or\n`;
    return out.replace(/, or\n$/, '\n');
  }
  if (name.length < 2) return `${name}: command not found\n`;
  const similar = allKnownCommands()
    .filter((c) => isOneEditAway(name, c.command))
    .sort((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
  // de-duplicate by command name
  const seen = new Set<string>();
  const unique = similar.filter((c) => (seen.has(c.command) ? false : (seen.add(c.command), true)));
  if (unique.length === 0) return `${name}: command not found\n`;
  if (unique.length > 12) return `Command '${name}' not found, but there are ${unique.length} similar ones.\n`;
  let out = `Command '${name}' not found, did you mean:\n`;
  for (const c of unique) out += `  command '${c.command}' from deb ${c.pkg.name} (${c.pkg.version})\n`;
  out += 'Try: sudo apt install <deb name>\n';
  return out;
}
