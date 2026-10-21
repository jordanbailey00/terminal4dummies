// Builds the default disk image: an Ubuntu-like directory tree, system
// files, installed programs and a home directory with sample files.

import { PACKAGES } from './packages';
import * as data from './sampledata';
import type { System } from './system';
import type { NativeCommand } from './types';
import { ROOT_CREDS, type BlobData, type FileData, type OpContext } from './vfs/fs';

const RELEASE = Date.UTC(2024, 3, 23, 12, 0, 0);
const INSTALL = Date.UTC(2025, 7, 14, 9, 30, 0);

export class ImageBuilder {
  readonly sys: System;
  private readonly root: OpContext = { cwd: '/', creds: ROOT_CREDS, umask: 0 };
  constructor(sys: System) {
    this.sys = sys;
  }

  dir(path: string, opts: { mode?: number; uid?: number; gid?: number; time?: number } = {}): void {
    const fs = this.sys.fs;
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      const existing = fs.tryStat(cur, this.root, false);
      if (existing) continue;
      fs.mkdir(cur, this.root, 0o755);
    }
    const node = fs.lstat(path, this.root);
    if (opts.mode !== undefined) node.mode = opts.mode;
    if (opts.uid !== undefined) node.uid = opts.uid;
    if (opts.gid !== undefined) node.gid = opts.gid;
    const t = opts.time ?? INSTALL;
    node.atime = node.mtime = node.ctime = t;
  }

  file(path: string, content: FileData, opts: { mode?: number; uid?: number; gid?: number; time?: number } = {}): void {
    const fs = this.sys.fs;
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    if (!fs.tryStat(parent, this.root)) this.dir(parent);
    const parentNode = fs.stat(parent, this.root);
    const pt = { a: parentNode.atime, m: parentNode.mtime, c: parentNode.ctime };
    const node = fs.writeFile(path, content, this.root, { mode: opts.mode ?? 0o644 });
    node.mode = opts.mode ?? 0o644;
    node.uid = opts.uid ?? 0;
    node.gid = opts.gid ?? 0;
    const t = opts.time ?? INSTALL;
    node.atime = node.mtime = node.ctime = t;
    parentNode.atime = pt.a;
    parentNode.mtime = Math.max(pt.m, t);
    parentNode.ctime = Math.max(pt.c, t);
  }

  link(target: string, path: string, time = RELEASE): void {
    const node = this.sys.fs.symlink(target, path, this.root);
    node.atime = node.mtime = node.ctime = time;
  }

  device(path: string, kind: 'null' | 'zero' | 'tty' | 'random' | 'stdin' | 'stdout' | 'stderr', mode = 0o666): void {
    const node = this.sys.fs.mknod(path, kind, this.root, mode);
    node.atime = node.mtime = node.ctime = this.sys.bootTime;
  }

  installBinary(cmd: NativeCommand, time = RELEASE): void {
    const dir = cmd.dir ?? '/usr/bin';
    const path = `${dir}/${cmd.name}`;
    if (this.sys.fs.tryStat(path, this.root, false)) return;
    this.file(path, { kind: 'native', command: cmd.name, size: cmd.size ?? 35000 + ((cmd.name.length * 7919) % 90000) }, { mode: 0o755, time });
  }

  blob(path: string, description: string, size: number, opts: { mode?: number; uid?: number; gid?: number; time?: number } = {}): void {
    const b: BlobData = { kind: 'blob', description, payload: null, size };
    this.file(path, b, opts);
  }
}

/** Directory layout and system files. */
export function buildSystemImage(sys: System): void {
  const b = new ImageBuilder(sys);
  const now = sys.now();
  for (const d of ['boot', 'dev', 'etc', 'home', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'srv', 'sys', 'tmp', 'usr', 'var', 'snap']) {
    b.dir('/' + d, { time: RELEASE });
  }
  b.dir('/root', { mode: 0o700, time: INSTALL });
  b.dir('/tmp', { mode: 0o1777, time: now - 3600 * 1000 });
  b.dir('/proc', { mode: 0o555, time: sys.bootTime });
  b.dir('/sys', { mode: 0o555, time: sys.bootTime });
  for (const d of ['bin', 'games', 'include', 'lib', 'lib64', 'libexec', 'local', 'local/bin', 'local/games', 'local/include', 'local/lib', 'local/sbin', 'local/share', 'local/src', 'sbin', 'share', 'share/doc', 'share/man', 'share/man/man1', 'share/man/man5', 'share/man/man8', 'share/dict', 'src']) {
    b.dir('/usr/' + d, { time: RELEASE });
  }
  b.link('usr/bin', '/bin');
  b.link('usr/sbin', '/sbin');
  b.link('usr/lib', '/lib');
  b.link('usr/lib64', '/lib64');
  // /dev
  b.dir('/dev', { time: sys.bootTime });
  b.device('/dev/null', 'null');
  b.device('/dev/zero', 'zero');
  b.device('/dev/tty', 'tty');
  b.device('/dev/random', 'random');
  b.device('/dev/urandom', 'random');
  b.device('/dev/stdin', 'stdin');
  b.device('/dev/stdout', 'stdout');
  b.device('/dev/stderr', 'stderr');
  b.dir('/dev/shm', { mode: 0o1777, time: sys.bootTime });
  b.dir('/dev/pts', { time: sys.bootTime });
  // /boot
  b.blob('/boot/vmlinuz-6.8.0-45-generic', 'Linux kernel x86 boot executable bzImage, version 6.8.0-45-generic', 14919048, { mode: 0o600, time: INSTALL });
  b.blob('/boot/initrd.img-6.8.0-45-generic', 'Zstandard compressed data (v0.8+), Dictionary ID: None', 70214016, { mode: 0o644, time: INSTALL });
  b.link('vmlinuz-6.8.0-45-generic', '/boot/vmlinuz', INSTALL);
  b.link('initrd.img-6.8.0-45-generic', '/boot/initrd.img', INSTALL);

  // /etc
  const host = sys.hostname;
  b.file('/etc/hostname', host + '\n');
  b.file('/etc/hosts', data.HOSTS(host));
  b.file('/etc/os-release', data.OS_RELEASE, { time: RELEASE });
  b.file('/etc/lsb-release', 'DISTRIB_ID=Ubuntu\nDISTRIB_RELEASE=24.04\nDISTRIB_CODENAME=noble\nDISTRIB_DESCRIPTION="Ubuntu 24.04.1 LTS"\n', { time: RELEASE });
  b.file('/etc/issue', 'Ubuntu 24.04.1 LTS \\n \\l\n\n', { time: RELEASE });
  b.file('/etc/shells', data.SHELLS);
  b.file('/etc/timezone', 'Etc/UTC\n');
  b.file('/etc/fstab', data.FSTAB);
  b.file('/etc/crontab', data.CRONTAB);
  b.file('/etc/environment', 'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"\n');
  b.file('/etc/sudoers', data.SUDOERS, { mode: 0o440 });
  b.dir('/etc/sudoers.d', { mode: 0o750 });
  b.dir('/etc/apt/sources.list.d');
  b.file('/etc/apt/sources.list.d/ubuntu.sources', data.SOURCES);
  b.dir('/etc/skel');
  b.file('/etc/skel/.bashrc', data.BASHRC);
  b.file('/etc/skel/.profile', data.PROFILE);
  b.file('/etc/skel/.bash_logout', data.BASH_LOGOUT);
  b.file('/etc/bash.bashrc', '# System-wide .bashrc file for interactive bash(1) shells.\n\n# If not running interactively, don\'t do anything\n[ -z "$PS1" ] && return\n');
  b.file('/etc/profile', '# /etc/profile: system-wide .profile file for the Bourne shell (sh(1))\n# and Bourne compatible shells (bash(1), ksh(1), ash(1), ...).\n');
  b.file('/etc/motd', '');
  // users and groups
  const passwd = sys.users.map((u) => `${u.name}:x:${u.uid}:${u.gid}:${u.gecos}:${u.home}:${u.shell}`).join('\n') + '\n';
  b.file('/etc/passwd', passwd);
  const group = sys.groups.map((g) => `${g.name}:x:${g.gid}:${g.members.join(',')}`).join('\n') + '\n';
  b.file('/etc/group', group);
  const shadowGroup = sys.groupByName('shadow')?.gid ?? 42;
  b.file('/etc/shadow', sys.users.map((u) => `${u.name}:${u.uid === 1000 ? '$y$j9T$Xq1bS2d3Ee4fG5hH6iJ7kK$8lL9mM0nN1oO2pP3qQ4rR5sS6tT7uU8vV9wW0xX1yY2' : u.uid === 0 ? '*' : '*'}:19958:0:99999:7:::`).join('\n') + '\n', { mode: 0o640, gid: shadowGroup });

  // /proc (static snapshots)
  b.file('/proc/version', 'Linux version 6.8.0-45-generic (buildd@lcy02-amd64-115) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.2.0-23ubuntu4) 13.2.0, GNU ld (GNU Binutils for Ubuntu) 2.42) #45-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug 30 12:02:04 UTC 2024\n', { mode: 0o444, time: sys.bootTime });
  b.file('/proc/cpuinfo', cpuinfo(), { mode: 0o444, time: sys.bootTime });
  b.file('/proc/meminfo', 'MemTotal:        4022980 kB\nMemFree:         1825104 kB\nMemAvailable:    3011776 kB\nBuffers:           73468 kB\nCached:          1238016 kB\nSwapCached:            0 kB\nSwapTotal:       2097148 kB\nSwapFree:        2097148 kB\n', { mode: 0o444, time: sys.bootTime });
  b.file('/proc/loadavg', '0.08 0.03 0.01 1/187 4242\n', { mode: 0o444, time: sys.bootTime });

  // /var
  for (const d of ['backups', 'cache', 'cache/apt', 'cache/apt/archives', 'lib', 'lib/apt', 'lib/apt/lists', 'lib/dpkg', 'lib/dpkg/info', 'local', 'log', 'log/apt', 'mail', 'opt', 'spool', 'spool/cron', 'tmp', 'www', 'www/html']) {
    b.dir('/var/' + d);
  }
  b.dir('/var/tmp', { mode: 0o1777 });
  b.link('/run', '/var/run');
  b.link('/run/lock', '/var/lock');
  b.dir('/run/lock', { mode: 0o1777, time: sys.bootTime });
  b.dir('/run/user/1000', { mode: 0o700, uid: 1000, gid: 1000, time: sys.bootTime });
  const adm = sys.groupByName('adm')?.gid ?? 4;
  const syslogUid = sys.userByName('syslog')?.uid ?? 104;
  b.file('/var/log/syslog', data.makeSyslog(now, host), { mode: 0o640, uid: syslogUid, gid: adm, time: now - 60000 });
  b.file('/var/log/auth.log', data.makeAuthLog(now, host), { mode: 0o640, uid: syslogUid, gid: adm, time: now - 120000 });
  b.file('/var/log/dpkg.log', `${new Date(INSTALL).toISOString().slice(0, 19).replace('T', ' ')} startup archives unpack\n${new Date(INSTALL).toISOString().slice(0, 19).replace('T', ' ')} install nano:amd64 <none> 7.2-2ubuntu0.1\n`, { time: INSTALL });
  b.file('/var/log/apt/history.log', `\nStart-Date: ${new Date(INSTALL).toISOString().slice(0, 19).replace('T', '  ')}\nCommandline: apt-get install -y nano\nInstall: nano:amd64 (7.2-2ubuntu0.1)\nEnd-Date: ${new Date(INSTALL + 30000).toISOString().slice(0, 19).replace('T', '  ')}\n`, { time: INSTALL });
  b.file('/var/log/nginx-access.log', data.makeAccessLog(now), { mode: 0o644, uid: 33, gid: adm, time: now - 30000 });
  b.file('/var/www/html/index.html', data.INDEX_HTML);
  b.file('/var/mail/learner', '', { mode: 0o660, uid: 1000, gid: sys.groupByName('mail')?.gid ?? 8 });
}

function cpuinfo(): string {
  let out = '';
  for (let i = 0; i < 2; i++) {
    out += `processor\t: ${i}\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 154\nmodel name\t: 12th Gen Intel(R) Core(TM) i7-1260P\nstepping\t: 3\ncpu MHz\t\t: 2496.000\ncache size\t: 18432 KB\ncpu cores\t: 2\nflags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx rdtscp lm constant_tsc rep_good nopl xtopology nonstop_tsc cpuid tsc_known_freq pni pclmulqdq ssse3 cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt aes xsave avx rdrand hypervisor lahf_lm abm 3dnowprefetch fsgsbase bmi1 avx2 bmi2 invpcid rdseed clflushopt arat\n\n`;
  }
  return out;
}

/** Put every installed program on disk and register its package as installed. */
export function installPackages(sys: System, commands: NativeCommand[]): void {
  const b = new ImageBuilder(sys);
  const byName = new Map(commands.map((c) => [c.name, c]));
  for (const pkg of PACKAGES) {
    if (!pkg.preinstalled) continue;
    const files: string[] = [];
    for (const pc of pkg.commands) {
      const cmd = byName.get(pc.name);
      if (!cmd) continue;
      b.installBinary({ ...cmd, dir: pc.dir });
      files.push(`${pc.dir}/${pc.name}`);
      if (cmd.doc) {
        const man = `/usr/share/man/man${cmd.doc.section ?? 1}/${pc.name}.${cmd.doc.section ?? 1}.gz`;
        b.blob(man, 'gzip compressed data, max compression, from Unix', 1200 + pc.name.length * 97, { time: RELEASE });
        files.push(man);
      }
    }
    b.file(`/var/lib/dpkg/info/${pkg.name}.list`, ['/.', ...files].join('\n') + '\n', { time: INSTALL });
  }
}

/** Create a user's home directory with the usual dotfiles and folders. */
export function buildHome(sys: System, username = 'learner', opts: { samples?: boolean } = {}): void {
  const user = sys.userByName(username);
  if (!user) return;
  const b = new ImageBuilder(sys);
  const now = sys.now();
  const day = 86400 * 1000;
  const own = { uid: user.uid, gid: user.gid };
  const home = user.home;
  b.dir(home, { mode: 0o750, ...own, time: now - 20 * day });
  b.file(`${home}/.bashrc`, data.BASHRC, { ...own, time: now - 20 * day });
  b.file(`${home}/.profile`, data.PROFILE, { ...own, time: now - 20 * day });
  b.file(`${home}/.bash_logout`, data.BASH_LOGOUT, { ...own, time: now - 20 * day });
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Public', 'Templates', 'Videos']) {
    b.dir(`${home}/${d}`, { mode: 0o755, ...own, time: now - 20 * day });
  }
  b.dir(`${home}/.cache`, { mode: 0o700, ...own, time: now - 19 * day });
  b.dir(`${home}/.config`, { mode: 0o755, ...own, time: now - 19 * day });
  b.dir(`${home}/.local/share`, { mode: 0o755, ...own, time: now - 19 * day });
  for (const d of [`${home}/.local`]) {
    const node = sys.fs.lstat(d, { cwd: '/', creds: ROOT_CREDS });
    node.uid = user.uid;
    node.gid = user.gid;
    node.mode = 0o755;
  }
  if (opts.samples === false) return;
  b.file(`${home}/welcome.txt`, data.WELCOME_TXT, { ...own, mode: 0o664, time: now - 2 * day });
  b.file(`${home}/Documents/notes.txt`, data.NOTES_TXT, { ...own, mode: 0o664, time: now - 5 * day });
  b.file(`${home}/Documents/todo.txt`, data.TODO_TXT, { ...own, mode: 0o664, time: now - 1 * day });
  b.dir(`${home}/Documents/recipes`, { mode: 0o775, ...own, time: now - 9 * day });
  b.file(`${home}/Documents/recipes/pancakes.txt`, data.PANCAKES_TXT, { ...own, mode: 0o664, time: now - 9 * day });
  b.file(`${home}/Documents/recipes/guacamole.txt`, data.GUACAMOLE_TXT, { ...own, mode: 0o664, time: now - 8 * day });
  b.file(`${home}/Documents/story.txt`, data.STORY_TXT, { ...own, mode: 0o664, time: now - 12 * day });
  b.file(`${home}/Documents/fruit-sales.csv`, data.FRUIT_CSV, { ...own, mode: 0o664, time: now - 3 * day });
  b.blob(`${home}/Downloads/report.pdf`, 'PDF document, version 1.7, 3 page(s)', 48213, { ...own, mode: 0o664, time: now - 4 * day });
  b.blob(`${home}/Downloads/holiday.jpg`, 'JPEG image data, JFIF standard 1.01, resolution (DPI), density 72x72, segment length 16, baseline, precision 8, 1920x1080, components 3', 284511, { ...own, mode: 0o664, time: now - 6 * day });
  b.blob(`${home}/Pictures/cat.png`, 'PNG image data, 640 x 480, 8-bit/color RGBA, non-interlaced', 152304, { ...own, mode: 0o664, time: now - 15 * day });
  b.blob(`${home}/Music/lullaby.mp3`, 'Audio file with ID3 version 2.4.0, contains: MPEG ADTS, layer III, v1, 192 kbps, 44.1 kHz, JntStereo', 3412992, { ...own, mode: 0o664, time: now - 11 * day });
}
