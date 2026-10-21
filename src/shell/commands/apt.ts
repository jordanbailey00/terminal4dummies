// apt, apt-get, apt-cache and dpkg: package management on the simulated Ubuntu.

import { COMMANDS, defineCommand } from './util';
import { PACKAGES, humanBytes, packageByName, type PackageInfo } from '../packages';
import type { CommandContext } from '../types';
import { ROOT_CREDS, type OpContext } from '../vfs/fs';
import { strftime } from './sysinfo';

const ROOT: OpContext = { cwd: '/', creds: ROOT_CREDS, umask: 0o022 };

/** Packages that need extra (library) packages; installed alongside. */
const DEPENDS: Record<string, { name: string; version: string; size: number; installed: number }[]> = {
  cowsay: [{ name: 'libtext-charwidth-perl', version: '0.04-11build3', size: 9400, installed: 29 }],
  'fortune-mod': [
    { name: 'fortunes-min', version: '1:1.99.1-7.3build1', size: 44800, installed: 147 },
    { name: 'librecode0', version: '3.6-26build1', size: 620000, installed: 2083 },
  ],
  htop: [{ name: 'libnl-genl-3-200', version: '3.7.0-0.3build1.1', size: 12100, installed: 51 }],
  neofetch: [],
  figlet: [],
  tree: [],
  sl: [],
  ncal: [],
  zip: [],
  unzip: [],
};

/** Fake pending upgrades so `apt upgrade` has something to do. */
const UPGRADES = [
  { name: 'tzdata', from: '2024a-3ubuntu1.1', to: '2025b-0ubuntu0.24.04.1', size: 276000 },
  { name: 'openssl', from: '3.0.13-0ubuntu3.4', to: '3.0.13-0ubuntu3.5', size: 1002000 },
  { name: 'libssl3t64', from: '3.0.13-0ubuntu3.4', to: '3.0.13-0ubuntu3.5', size: 1940000 },
];

const ESSENTIAL = new Set(['coreutils', 'bash', 'dpkg', 'apt', 'grep', 'sed', 'findutils', 'tar', 'gzip', 'util-linux', 'debianutils', 'hostname', 'diffutils', 'mawk', 'procps', 'ncurses-bin']);

function isInstalled(ctx: CommandContext, pkg: string): boolean {
  return ctx.system.fs.exists(`/var/lib/dpkg/info/${pkg}.list`, ROOT);
}

function upgradesPending(ctx: CommandContext): typeof UPGRADES {
  return ctx.system.fs.exists('/var/lib/apt/upgraded', ROOT) ? [] : UPGRADES;
}

async function lockError(ctx: CommandContext): Promise<number> {
  await ctx.err('E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n');
  return 100;
}

async function pause(ctx: CommandContext, ms: number): Promise<void> {
  await ctx.sleep(ms);
}

async function readingLists(ctx: CommandContext): Promise<void> {
  await ctx.out('Reading package lists... ');
  await pause(ctx, 250);
  await ctx.out('Done\nBuilding dependency tree... ');
  await pause(ctx, 200);
  await ctx.out('Done\nReading state information... ');
  await pause(ctx, 120);
  await ctx.out('Done\n');
}

async function askContinue(ctx: CommandContext, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  await ctx.out('Do you want to continue? [Y/n] ');
  const line = await ctx.stdin.readLine();
  if (line === null) {
    await ctx.out('\n');
    return false;
  }
  const ans = line.trim().toLowerCase();
  if (ans === '' || ans === 'y' || ans === 'yes') return true;
  return false;
}

function fmtKb(bytes: number): string {
  if (bytes >= 1000 * 1000) return `${(bytes / 1000 / 1000).toFixed(1)} MB`;
  return `${(bytes / 1000).toFixed(1)} kB`;
}

function dbCount(ctx: CommandContext): number {
  let n = 74213;
  for (const p of PACKAGES) if (!p.preinstalled && isInstalled(ctx, p.name)) n += p.commands.length * 3 + 4;
  return n;
}

function log(ctx: CommandContext, file: string, text: string): void {
  try {
    ctx.system.fs.writeFile(file, text, ROOT, { append: true });
  } catch {
    // ignore
  }
}

/** Put a package's programs and man pages on disk and mark it installed. */
function installFiles(ctx: CommandContext, pkg: PackageInfo): void {
  const fs = ctx.system.fs;
  const files: string[] = ['/.'];
  const now = ctx.system.now();
  for (const pc of pkg.commands) {
    const impl = COMMANDS.find((c) => c.name === pc.name);
    const path = `${pc.dir}/${pc.name}`;
    try {
      const node = fs.writeFile(path, { kind: 'native', command: pc.name, size: impl?.size ?? 30000 }, ROOT, { mode: 0o755 });
      node.mode = 0o755;
      node.mtime = node.atime = node.ctime = now;
      files.push(path);
      if (impl?.doc) {
        const sec = impl.doc.section ?? 1;
        const man = `/usr/share/man/man${sec}/${pc.name}.${sec}.gz`;
        fs.writeFile(man, { kind: 'blob', description: 'gzip compressed data, max compression, from Unix', payload: null, size: 1500 }, ROOT, { mode: 0o644 });
        files.push(man);
      }
    } catch {
      // ignore
    }
  }
  fs.writeFile(`/var/lib/dpkg/info/${pkg.name}.list`, files.join('\n') + '\n', ROOT, { mode: 0o644 });
}

function removeFiles(ctx: CommandContext, pkg: PackageInfo): void {
  const fs = ctx.system.fs;
  let list: string[] = [];
  try {
    list = fs.readFile(`/var/lib/dpkg/info/${pkg.name}.list`, ROOT).split('\n');
  } catch {
    // nothing recorded
  }
  for (const f of list) {
    if (!f || f === '/.') continue;
    try {
      const node = fs.tryStat(f, ROOT, false);
      if (node && node.type !== 'dir') fs.unlink(f, ROOT);
    } catch {
      // ignore
    }
  }
  try {
    fs.unlink(`/var/lib/dpkg/info/${pkg.name}.list`, ROOT);
  } catch {
    // ignore
  }
}

function debName(pkg: { name: string; version: string }, arch: string): string {
  return `${pkg.name}_${pkg.version.replace(/^\d+:/, '')}_${arch}.deb`;
}

function urlFor(pkg: PackageInfo): string {
  return `http://archive.ubuntu.com/ubuntu noble/${pkg.component}`;
}

async function notAvailableNote(ctx: CommandContext, name: string): Promise<void> {
  if (ctx.stdout.isTTY) await ctx.out(`\x1b[2m(terminal4dummies: ${name} isn't included in this practice computer. On a real Ubuntu system this command would install it.)\x1b[0m\n`);
  else await ctx.out(`(terminal4dummies: ${name} isn't included in this practice computer. On a real Ubuntu system this command would install it.)\n`);
}

async function aptInstall(ctx: CommandContext, names: string[], assumeYes: boolean, verb: 'apt' | 'apt-get'): Promise<number> {
  if (ctx.creds.uid !== 0) return lockError(ctx);
  if (names.length === 0) {
    await readingLists(ctx);
    await ctx.out(`0 upgraded, 0 newly installed, 0 to remove and ${upgradesPending(ctx).length} not upgraded.\n`);
    return 0;
  }
  await readingLists(ctx);
  const toInstall: PackageInfo[] = [];
  const already: PackageInfo[] = [];
  for (const n of names) {
    const pkg = packageByName(n);
    if (!pkg) {
      await ctx.err(`E: Unable to locate package ${n}\n`);
      return 100;
    }
    if (!pkg.available) {
      await ctx.out(`Package ${pkg.name} is not available, but is referred to by another package.\nThis may mean that the package is missing, has been obsoleted, or\nis only available from another source\n\n`);
      await ctx.err(`E: Package '${pkg.name}' has no installation candidate\n`);
      await notAvailableNote(ctx, pkg.name);
      return 100;
    }
    if (isInstalled(ctx, pkg.name)) already.push(pkg);
    else if (!toInstall.includes(pkg)) toInstall.push(pkg);
  }
  for (const p of already) await ctx.out(`${p.name} is already the newest version (${p.version}).\n`);
  const pending = upgradesPending(ctx).length;
  if (toInstall.length === 0) {
    await ctx.out(`0 upgraded, 0 newly installed, 0 to remove and ${pending} not upgraded.\n`);
    return 0;
  }
  const extras = toInstall.flatMap((p) => (DEPENDS[p.name] ?? []).filter((d) => !ctx.system.fs.exists(`/var/lib/dpkg/info/${d.name}.list`, ROOT)));
  if (extras.length) {
    await ctx.out(`The following additional packages will be installed:\n  ${extras.map((e) => e.name).join(' ')}\n`);
  }
  const all = [...extras.map((e) => e.name), ...toInstall.map((p) => p.name)].sort();
  await ctx.out(`The following NEW packages will be installed:\n  ${all.join(' ')}\n`);
  const download = toInstall.reduce((n, p) => n + p.downloadSize, 0) + extras.reduce((n, e) => n + e.size, 0);
  const disk = toInstall.reduce((n, p) => n + p.installedSize, 0) + extras.reduce((n, e) => n + e.installed, 0);
  await ctx.out(`0 upgraded, ${all.length} newly installed, 0 to remove and ${pending} not upgraded.\n`);
  await ctx.out(`Need to get ${fmtKb(download)} of archives.\n`);
  await ctx.out(`After this operation, ${fmtKb(disk * 1000)} of additional disk space will be used.\n`);
  if (extras.length > 0 && !(await askContinue(ctx, assumeYes))) {
    await ctx.out('Abort.\n');
    return 1;
  }
  let i = 1;
  for (const e of extras) {
    await pause(ctx, 120);
    await ctx.out(`Get:${i++} http://archive.ubuntu.com/ubuntu noble/main amd64 ${e.name} amd64 ${e.version} [${humanBytes(e.size)}]\n`);
  }
  for (const p of toInstall) {
    await pause(ctx, 160);
    await ctx.out(`Get:${i++} ${urlFor(p)} ${p.arch} ${p.name} ${p.arch} ${p.version} [${humanBytes(p.downloadSize)}]\n`);
  }
  await pause(ctx, 200);
  const speed = Math.round(download / 1000 / 0.4);
  await ctx.out(`Fetched ${fmtKb(download)} in 0s (${speed} kB/s)\n`);
  let db = dbCount(ctx);
  const now = ctx.system.now();
  const stamp = strftime('%Y-%m-%d %H:%M:%S', now);
  for (const e of extras) {
    await ctx.out(`Selecting previously unselected package ${e.name}.\n(Reading database ... ${db} files and directories currently installed.)\nPreparing to unpack .../${debName(e, 'amd64')} ...\nUnpacking ${e.name} (${e.version}) ...\n`);
    db += 6;
    ctx.system.fs.writeFile(`/var/lib/dpkg/info/${e.name}.list`, '/.\n', ROOT);
    await pause(ctx, 120);
  }
  for (const p of toInstall) {
    await ctx.out(`Selecting previously unselected package ${p.name}.\n(Reading database ... ${db} files and directories currently installed.)\nPreparing to unpack .../${debName(p, p.arch)} ...\nUnpacking ${p.name} (${p.version}) ...\n`);
    db += p.commands.length * 3 + 4;
    await pause(ctx, 180);
  }
  for (const e of extras) await ctx.out(`Setting up ${e.name} (${e.version}) ...\n`);
  for (const p of toInstall) {
    installFiles(ctx, p);
    await ctx.out(`Setting up ${p.name} (${p.version}) ...\n`);
    log(ctx, '/var/log/dpkg.log', `${stamp} install ${p.name}:${p.arch} <none> ${p.version}\n`);
    await pause(ctx, 100);
  }
  await ctx.out('Processing triggers for man-db (2.12.0-4build2) ...\n');
  log(ctx, '/var/log/apt/history.log', `\nStart-Date: ${strftime('%Y-%m-%d  %H:%M:%S', now)}\nCommandline: ${verb} install ${names.join(' ')}\nRequested-By: ${ctx.env.get('SUDO_USER') ?? 'root'} (${ctx.env.get('SUDO_UID') ?? '0'})\nInstall: ${toInstall.map((p) => `${p.name}:${p.arch} (${p.version})`).join(', ')}\nEnd-Date: ${strftime('%Y-%m-%d  %H:%M:%S', now + 3000)}\n`);
  return 0;
}

async function aptRemove(ctx: CommandContext, names: string[], assumeYes: boolean, purge: boolean): Promise<number> {
  if (ctx.creds.uid !== 0) return lockError(ctx);
  await readingLists(ctx);
  const targets: PackageInfo[] = [];
  for (const n of names) {
    const pkg = packageByName(n);
    if (!pkg) {
      await ctx.err(`E: Unable to locate package ${n}\n`);
      return 100;
    }
    if (!isInstalled(ctx, pkg.name)) {
      await ctx.out(`Package '${pkg.name}' is not installed, so not removed\n`);
      continue;
    }
    if (pkg.preinstalled && ESSENTIAL.has(pkg.name)) {
      await ctx.err('E: Removing essential system-critical packages is not permitted. This might break the system.\n');
      return 100;
    }
    targets.push(pkg);
  }
  const pending = upgradesPending(ctx).length;
  if (targets.length === 0) {
    await ctx.out(`0 upgraded, 0 newly installed, 0 to remove and ${pending} not upgraded.\n`);
    return 0;
  }
  await ctx.out(`The following packages will be REMOVED:\n  ${targets.map((t) => t.name + (purge ? '*' : '')).join(' ')}\n`);
  await ctx.out(`0 upgraded, 0 newly installed, ${targets.length} to remove and ${pending} not upgraded.\n`);
  const freed = targets.reduce((n, p) => n + p.installedSize, 0);
  await ctx.out(`After this operation, ${fmtKb(freed * 1000)} disk space will be freed.\n`);
  if (!(await askContinue(ctx, assumeYes))) {
    await ctx.out('Abort.\n');
    return 1;
  }
  await ctx.out(`(Reading database ... ${dbCount(ctx)} files and directories currently installed.)\n`);
  for (const p of targets) {
    await pause(ctx, 160);
    await ctx.out(`Removing ${p.name} (${p.version}) ...\n`);
    removeFiles(ctx, p);
    log(ctx, '/var/log/dpkg.log', `${strftime('%Y-%m-%d %H:%M:%S', ctx.system.now())} remove ${p.name}:${p.arch} ${p.version} <none>\n`);
  }
  await ctx.out('Processing triggers for man-db (2.12.0-4build2) ...\n');
  return 0;
}

async function aptUpdate(ctx: CommandContext): Promise<number> {
  if (ctx.creds.uid !== 0) {
    await ctx.err('Reading package lists... Done\nE: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)\nE: Unable to lock directory /var/lib/apt/lists/\nW: Problem unlinking the file /var/cache/apt/pkgcache.bin - RemoveCaches (13: Permission denied)\nW: Problem unlinking the file /var/cache/apt/srcpkgcache.bin - RemoveCaches (13: Permission denied)\n');
    return 100;
  }
  const lines = [
    ['Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease', 300],
    ['Get:2 http://archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]', 250],
    ['Get:3 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]', 300],
    ['Hit:4 http://archive.ubuntu.com/ubuntu noble-backports InRelease', 200],
    ['Get:5 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 Packages [612 kB]', 350],
    ['Get:6 http://archive.ubuntu.com/ubuntu noble-updates/universe amd64 Packages [879 kB]', 300],
    ['Get:7 http://security.ubuntu.com/ubuntu noble-security/main amd64 Packages [450 kB]', 250],
  ] as const;
  for (const [l, ms] of lines) {
    await pause(ctx, ms);
    await ctx.out(l + '\n');
  }
  await pause(ctx, 200);
  await ctx.out('Fetched 2,193 kB in 2s (1,128 kB/s)\n');
  await readingLists(ctx);
  ctx.system.fs.writeFile('/var/lib/apt/lists/archive.ubuntu.com_ubuntu_dists_noble_InRelease', 'Origin: Ubuntu\n', ROOT);
  const n = upgradesPending(ctx).length;
  if (n === 0) await ctx.out('All packages are up to date.\n');
  else await ctx.out(`${n} package${n > 1 ? 's' : ''} can be upgraded. Run 'apt list --upgradable' to see ${n > 1 ? 'them' : 'it'}.\n`);
  return 0;
}

async function aptUpgrade(ctx: CommandContext, assumeYes: boolean): Promise<number> {
  if (ctx.creds.uid !== 0) return lockError(ctx);
  await readingLists(ctx);
  await ctx.out('Calculating upgrade... ');
  await pause(ctx, 200);
  await ctx.out('Done\n');
  const ups = upgradesPending(ctx);
  if (ups.length === 0) {
    await ctx.out('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n');
    return 0;
  }
  await ctx.out(`The following packages will be upgraded:\n  ${ups.map((u) => u.name).sort().join(' ')}\n`);
  await ctx.out(`${ups.length} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n`);
  const total = ups.reduce((n, u) => n + u.size, 0);
  await ctx.out(`Need to get ${fmtKb(total)} of archives.\nAfter this operation, 12.3 kB of additional disk space will be used.\n`);
  if (!(await askContinue(ctx, assumeYes))) {
    await ctx.out('Abort.\n');
    return 1;
  }
  let i = 1;
  for (const u of ups) {
    await pause(ctx, 250);
    await ctx.out(`Get:${i++} http://archive.ubuntu.com/ubuntu noble-updates/main amd64 ${u.name} all ${u.to} [${humanBytes(u.size)}]\n`);
  }
  await ctx.out(`Fetched ${fmtKb(total)} in 1s (${Math.round(total / 1000)} kB/s)\n`);
  await ctx.out(`(Reading database ... ${dbCount(ctx)} files and directories currently installed.)\n`);
  for (const u of ups) {
    await pause(ctx, 200);
    await ctx.out(`Preparing to unpack .../${u.name}_${u.to}_all.deb ...\nUnpacking ${u.name} (${u.to}) over (${u.from}) ...\n`);
  }
  for (const u of ups) {
    await pause(ctx, 120);
    await ctx.out(`Setting up ${u.name} (${u.to}) ...\n`);
  }
  await ctx.out('Processing triggers for man-db (2.12.0-4build2) ...\nProcessing triggers for libc-bin (2.39-0ubuntu8.3) ...\n');
  ctx.system.fs.writeFile('/var/lib/apt/upgraded', '1\n', ROOT);
  return 0;
}

async function aptList(ctx: CommandContext, args: string[]): Promise<number> {
  const installedOnly = args.includes('--installed');
  const upgradable = args.includes('--upgradable');
  const patterns = args.filter((a) => !a.startsWith('--'));
  await ctx.out('Listing... ');
  await pause(ctx, 150);
  await ctx.out('Done\n');
  const tty = ctx.stdout.isTTY;
  const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
  if (upgradable) {
    for (const u of upgradesPending(ctx)) await ctx.out(`${green(u.name)}/noble-updates ${u.to} all [upgradable from: ${u.from}]\n`);
    return 0;
  }
  const re = patterns.map((p) => new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'));
  let out = '';
  for (const p of [...PACKAGES].sort((a, b) => a.name.localeCompare(b.name))) {
    const inst = isInstalled(ctx, p.name);
    if (installedOnly && !inst) continue;
    if (re.length && !re.some((r) => r.test(p.name))) continue;
    const suite = p.preinstalled ? 'noble,now' : inst ? 'noble,now' : 'noble';
    out += `${green(p.name)}/${suite} ${p.version} ${p.arch}${inst ? ' [installed]' : ''}\n`;
  }
  await ctx.out(out);
  return 0;
}

async function aptSearch(ctx: CommandContext, terms: string[]): Promise<number> {
  if (terms.length === 0) {
    await ctx.err('E: You must give at least one search pattern\n');
    return 100;
  }
  await ctx.out('Sorting... ');
  await pause(ctx, 120);
  await ctx.out('Done\nFull Text Search... ');
  await pause(ctx, 200);
  await ctx.out('Done\n');
  const tty = ctx.stdout.isTTY;
  const res = terms.map((t) => new RegExp(t.replace(/[.+^${}()|\\]/g, '\\$&'), 'i'));
  let out = '';
  for (const p of [...PACKAGES].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!res.every((r) => r.test(p.name) || r.test(p.summary) || r.test(p.description))) continue;
    const inst = isInstalled(ctx, p.name);
    const name = tty ? `\x1b[32m${p.name}\x1b[0m` : p.name;
    out += `${name}/noble ${p.version} ${p.arch}${inst ? ' [installed]' : ''}\n  ${p.summary}\n\n`;
  }
  await ctx.out(out);
  return 0;
}

async function aptShow(ctx: CommandContext, names: string[]): Promise<number> {
  let status = 0;
  for (const n of names) {
    const p = packageByName(n);
    if (!p) {
      await ctx.err(`N: Unable to locate package ${n}\nE: No packages found\n`);
      status = 100;
      continue;
    }
    const inst = isInstalled(ctx, p.name);
    const deps = DEPENDS[p.name]?.map((d) => d.name) ?? [];
    await ctx.out(
      `Package: ${p.name}\nVersion: ${p.version}\nPriority: optional\nSection: ${p.component === 'main' ? '' : p.component + '/'}${p.section}\nOrigin: Ubuntu\nMaintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>\n` +
        `Installed-Size: ${p.installedSize} kB\n${deps.length ? `Depends: ${['libc6 (>= 2.38)', ...deps].join(', ')}\n` : 'Depends: libc6 (>= 2.38)\n'}Download-Size: ${humanBytes(p.downloadSize)}\n` +
        `APT-${inst ? 'Manual-Installed: yes\nAPT-' : ''}Sources: http://archive.ubuntu.com/ubuntu noble/${p.component} amd64 Packages\nDescription: ${p.summary}\n ${p.description.replace(/(.{1,78})(\s+|$)/g, '$1\n ').trimEnd()}\n\n`,
    );
  }
  return status;
}

function parseAptArgs(args: string[]): { sub: string; rest: string[]; yes: boolean } {
  let yes = false;
  const rest: string[] = [];
  let sub = '';
  for (const a of args) {
    if (a === '-y' || a === '--yes' || a === '--assume-yes' || a === '-qy' || a === '-yq') yes = true;
    else if (a === '-q' || a === '-qq' || a === '--quiet') continue;
    else if (!sub && !a.startsWith('-')) sub = a;
    else rest.push(a);
  }
  return { sub, rest, yes };
}

const APT_USAGE = `apt 2.7.14 (amd64)
Usage: apt [options] command

apt is a commandline package manager and provides commands for
searching and managing as well as querying information about packages.
It provides the same functionality as the specialized APT tools,
like apt-get and apt-cache, but enables options more suitable for
interactive use by default.

Most used commands:
  list - list packages based on package names
  search - search in package descriptions
  show - show package details
  install - install packages
  reinstall - reinstall packages
  remove - remove packages
  autoremove - automatically remove all unused packages
  update - update list of available packages
  upgrade - upgrade the system by installing/upgrading packages
  full-upgrade - upgrade the system by removing/installing/upgrading packages
  edit-sources - edit the source information file
  satisfy - satisfy dependency strings

See apt(8) for more information about the available commands.
Configuration options and syntax is detailed in apt.conf(5).
Information about how to configure sources can be found in sources.list(5).
Package and version choices can be expressed via apt_preferences(5).
Security details are available in apt-secure(8).
                                        This APT has Super Cow Powers.
`;

async function aptMain(ctx: CommandContext, flavor: 'apt' | 'apt-get'): Promise<number> {
  const { sub, rest, yes } = parseAptArgs(ctx.args);
  const names = rest.filter((r) => !r.startsWith('-'));
  if (ctx.args.includes('--help') || ctx.args.includes('-h') || sub === '') {
    await ctx.out(APT_USAGE);
    return sub === '' && !ctx.args.includes('--help') && !ctx.args.includes('-h') ? 1 : 0;
  }
  if (ctx.args.includes('--version') || ctx.args.includes('-v')) {
    await ctx.out('apt 2.7.14 (amd64)\n');
    return 0;
  }
  if (!ctx.stdout.isTTY && flavor === 'apt') await ctx.err('\nWARNING: apt does not have a stable CLI interface. Use with caution in scripts.\n\n');
  switch (sub) {
    case 'update':
      return aptUpdate(ctx);
    case 'upgrade':
    case 'full-upgrade':
    case 'dist-upgrade':
      return aptUpgrade(ctx, yes);
    case 'install':
    case 'reinstall':
      return aptInstall(ctx, names, yes, flavor);
    case 'remove':
      return aptRemove(ctx, names, yes, false);
    case 'purge':
      return aptRemove(ctx, names, yes, true);
    case 'autoremove':
    case 'autoclean':
    case 'clean':
      if (ctx.creds.uid !== 0) return lockError(ctx);
      if (sub === 'autoremove') {
        await readingLists(ctx);
        await ctx.out(`0 upgraded, 0 newly installed, 0 to remove and ${upgradesPending(ctx).length} not upgraded.\n`);
      }
      return 0;
    case 'list':
      if (flavor !== 'apt') break;
      return aptList(ctx, rest);
    case 'search':
      return aptSearch(ctx, names);
    case 'show':
      return aptShow(ctx, names);
    case 'moo':
      await ctx.out('                 (__) \n                 (oo) \n           /------\\/ \n          / |    ||   \n         *  /\\---/\\ \n            ~~   ~~   \n..."Have you mooed today?"...\n');
      return 0;
  }
  await ctx.err(`E: Invalid operation ${sub}\n`);
  return 100;
}

const APT_DOC = {
  category: 'packages' as const,
  summary: 'command-line interface',
  synopsis: ['apt [-h] [-o=config_string] [-c=config_file] [-t=target_release] [-a=architecture] {list | search | show | update | install pkg... | remove pkg... | upgrade | full-upgrade | edit-sources | {-v | --version}}'],
  description:
    'apt provides a high-level commandline interface for the package management system. It is the usual way to install, update and remove software on Ubuntu and Debian.\n\n' +
    'Changing the system (install, remove, update, upgrade) needs administrator rights, so those commands are run with sudo. Looking things up (search, show, list) does not.',
  options: [
    { flags: 'update', desc: 'Download package information from all configured sources, so apt knows about the newest versions.' },
    { flags: 'upgrade', desc: 'Install available upgrades of all packages currently installed.' },
    { flags: 'install pkg...', desc: 'Install one or more packages (and anything they depend on).' },
    { flags: 'remove pkg...', desc: 'Remove packages. purge also removes their configuration files.' },
    { flags: 'search term', desc: 'Search package names and descriptions.' },
    { flags: 'show pkg', desc: 'Show information about a package.' },
    { flags: 'list --installed', desc: 'List installed packages (or --upgradable for pending upgrades).' },
    { flags: '-y, --yes', desc: 'Automatic yes to prompts.' },
  ],
  examples: [
    { cmd: 'sudo apt update', desc: 'Refresh the list of available software.' },
    { cmd: 'apt search cow', desc: 'Find packages about cows.' },
    { cmd: 'sudo apt install cowsay', desc: 'Install a program.' },
    { cmd: 'sudo apt remove cowsay', desc: 'Uninstall it again.' },
  ],
  seeAlso: ['apt-get', 'dpkg', 'sudo'],
  tip: 'On macOS the equivalent is Homebrew (brew install ...); on Windows, winget install ...',
};

defineCommand({ name: 'apt', pkg: 'apt', size: 18760, doc: { ...APT_DOC, section: 8 }, gnu: false, run: (ctx) => aptMain(ctx, 'apt') });
defineCommand({
  name: 'apt-get',
  pkg: 'apt',
  size: 51480,
  doc: { ...APT_DOC, summary: 'APT package handling utility -- command-line interface', section: 8, description: 'apt-get is the older, script-friendly command-line tool for handling packages. Most people use apt interactively; apt-get behaves the same for install, remove, update and upgrade.' },
  gnu: false,
  run: (ctx) => aptMain(ctx, 'apt-get'),
});
defineCommand({
  name: 'apt-cache',
  pkg: 'apt',
  size: 76152,
  doc: { category: 'packages', section: 8, summary: 'query the APT cache', synopsis: ['apt-cache [-agipns] [-o=config_string] [-c=config_file] {search regex... | show pkg... | policy [pkg...]}'], description: 'apt-cache performs a variety of operations on APT\'s package cache. It never changes the state of the system.', seeAlso: ['apt'] },
  gnu: false,
  run: async (ctx) => {
    const [sub, ...rest] = ctx.args;
    if (sub === 'search') {
      const terms = rest.map((t) => new RegExp(t, 'i'));
      let out = '';
      for (const p of [...PACKAGES].sort((a, b) => a.name.localeCompare(b.name))) if (terms.every((r) => r.test(p.name) || r.test(p.summary))) out += `${p.name} - ${p.summary}\n`;
      await ctx.out(out);
      return 0;
    }
    if (sub === 'show') return aptShow(ctx, rest);
    if (sub === 'policy') {
      for (const n of rest) {
        const p = packageByName(n);
        if (!p) continue;
        const inst = isInstalled(ctx, p.name);
        await ctx.out(`${p.name}:\n  Installed: ${inst ? p.version : '(none)'}\n  Candidate: ${p.version}\n  Version table:\n ${inst ? '***' : '   '} ${p.version} 500\n        500 http://archive.ubuntu.com/ubuntu noble/${p.component} amd64 Packages\n${inst ? '        100 /var/lib/dpkg/status\n' : ''}`);
      }
      return 0;
    }
    await ctx.err(`E: Invalid operation ${sub ?? ''}\n`);
    return 100;
  },
});

defineCommand({
  name: 'dpkg',
  pkg: 'dpkg',
  size: 318440,
  doc: {
    category: 'packages',
    section: 1,
    summary: 'package manager for Debian',
    synopsis: ['dpkg [option...] action'],
    description: 'dpkg is the low-level tool that installs, builds, removes and manages Debian packages. Day to day you use apt, which calls dpkg for you; dpkg is still handy for questions like "which files did this package install?".',
    options: [
      { flags: '-l, --list [pattern]', desc: 'List packages matching the pattern.' },
      { flags: '-L, --listfiles package', desc: 'List files installed to your system from package.' },
      { flags: '-s, --status package', desc: 'Report status of the specified package.' },
      { flags: '-S, --search filename', desc: 'Search for a filename from installed packages.' },
    ],
    examples: [
      { cmd: 'dpkg -l | grep nano', desc: 'Is nano installed?' },
      { cmd: 'dpkg -L cowsay', desc: 'Which files did cowsay install?' },
      { cmd: 'dpkg -S /usr/bin/ls', desc: 'Which package provides ls?' },
    ],
    seeAlso: ['apt'],
  },
  gnu: false,
  run: async (ctx) => {
    const [op, ...rest] = ctx.args;
    if (op === '-l' || op === '--list') {
      const re = rest.length ? new RegExp('^' + rest[0].replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null;
      const pkgs = PACKAGES.filter((p) => isInstalled(ctx, p.name) && (!re || re.test(p.name))).sort((a, b) => a.name.localeCompare(b.name));
      if (re && pkgs.length === 0) {
        await ctx.err(`dpkg-query: no packages found matching ${rest[0]}\n`);
        return 1;
      }
      let out = 'Desired=Unknown/Install/Remove/Purge/Hold\n| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend\n|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)\n';
      const nw = Math.max(14, ...pkgs.map((p) => p.name.length));
      const vw = Math.max(14, ...pkgs.map((p) => p.version.length));
      out += `||/ ${'Name'.padEnd(nw)} ${'Version'.padEnd(vw)} Architecture Description\n`;
      out += `+++-${'='.repeat(nw)}-${'='.repeat(vw)}-============-${'='.repeat(40)}\n`;
      for (const p of pkgs) out += `ii  ${p.name.padEnd(nw)} ${p.version.padEnd(vw)} ${p.arch.padEnd(12)} ${p.summary}\n`;
      await ctx.out(out);
      return 0;
    }
    if (op === '-L' || op === '--listfiles') {
      let status = 0;
      for (const n of rest) {
        try {
          await ctx.out(ctx.system.fs.readFile(`/var/lib/dpkg/info/${n}.list`, ROOT));
        } catch {
          await ctx.err(`dpkg-query: package '${n}' is not installed\nUse dpkg --contents (= dpkg-deb --contents) to list archive files contents.\n`);
          status = 1;
        }
      }
      return status;
    }
    if (op === '-s' || op === '--status') {
      let status = 0;
      for (const n of rest) {
        const p = packageByName(n);
        if (!p || !isInstalled(ctx, n)) {
          await ctx.err(`dpkg-query: package '${n}' is not installed and no information is available\nUse dpkg --info (= dpkg-deb --info) to examine archive files.\n`);
          status = 1;
          continue;
        }
        await ctx.out(`Package: ${p.name}\nStatus: install ok installed\nPriority: optional\nSection: ${p.section}\nInstalled-Size: ${p.installedSize}\nMaintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>\nArchitecture: ${p.arch}\nVersion: ${p.version}\nDescription: ${p.summary}\n`);
      }
      return status;
    }
    if (op === '-S' || op === '--search') {
      const target = rest[0] ?? '';
      let found = false;
      for (const p of PACKAGES) {
        if (!isInstalled(ctx, p.name)) continue;
        for (const c of p.commands) {
          const path = `${c.dir}/${c.name}`;
          if (path === target || path.endsWith('/' + target) || c.name === target || path.replace('/usr', '') === target) {
            await ctx.out(`${p.name}: ${path}\n`);
            found = true;
          }
        }
      }
      if (!found) {
        await ctx.err(`dpkg-query: no path found matching pattern *${target}*\n`);
        return 1;
      }
      return 0;
    }
    if (op === '-i' || op === '--install' || op === '-r' || op === '--remove' || op === '-P' || op === '--purge') {
      if (ctx.creds.uid !== 0) {
        await ctx.err(`dpkg: error: requested operation requires superuser privilege\n`);
        return 2;
      }
      await ctx.err(`dpkg: error: use apt to ${op.includes('i') ? 'install' : 'remove'} packages in this practice computer\n`);
      return 2;
    }
    if (op === '--version') {
      await ctx.out("Debian 'dpkg' package management program version 1.22.6 (amd64).\n");
      return 0;
    }
    await ctx.err(`dpkg: error: need an action option\n\nType dpkg --help for help about installing and deinstalling packages [*];\nUse 'apt' or 'aptitude' for user-friendly package management;\nType dpkg -Dhelp for a list of dpkg debug flag values;\nType dpkg --force-help for a list of forcing options;\nType dpkg-deb --help for help about manipulating *.deb files;\n\nOptions marked [*] produce a lot of output - pipe it through 'less' or 'more' !\n`);
    return 2;
  },
});
