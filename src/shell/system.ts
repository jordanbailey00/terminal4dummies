// The simulated computer: filesystem, users, processes, installed programs.

import { ProcessTable } from './process';
import type { NativeCommand } from './types';
import type { TtyDriver } from './tty';
import type { CommandEvent } from './repl';
import type { EditorEvent } from './readline';
import { VirtualFS, type Credentials } from './vfs/fs';

export interface UserEntry {
  name: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
}

export interface GroupEntry {
  name: string;
  gid: number;
  members: string[];
}

/** Reported after every simple command so lessons can watch what happens. */
export interface ExecEvent {
  argv: string[];
  /** How the command was resolved. */
  kind: 'builtin' | 'function' | 'external' | 'not-found' | 'assignment';
  status: number;
  /** Absolute path for external programs. */
  path?: string;
  /** Effective user id it ran as. */
  uid: number;
  cwd: string;
}

export interface SystemHooks {
  onCommand?: (ev: CommandEvent) => void;
  onEditorEvent?: (e: EditorEvent) => void;
  onTitle?: (title: string) => void;
  /** Called whenever a prompt is shown (true for PS1, false for PS2). */
  onPrompt?: (primary: boolean) => void;
  /** Called when a full-screen program starts or stops. */
  onFullscreen?: (name: string | null) => void;
}

export interface SystemOptions {
  fs?: VirtualFS;
  hostname?: string;
  now?: () => number;
  /** Override for timers (tests use instant delays). */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

function realDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class System {
  fs: VirtualFS;
  hostname: string;
  users: UserEntry[] = [
    { name: 'root', uid: 0, gid: 0, gecos: 'root', home: '/root', shell: '/bin/bash' },
    { name: 'daemon', uid: 1, gid: 1, gecos: 'daemon', home: '/usr/sbin', shell: '/usr/sbin/nologin' },
    { name: 'bin', uid: 2, gid: 2, gecos: 'bin', home: '/bin', shell: '/usr/sbin/nologin' },
    { name: 'sys', uid: 3, gid: 3, gecos: 'sys', home: '/dev', shell: '/usr/sbin/nologin' },
    { name: 'sync', uid: 4, gid: 65534, gecos: 'sync', home: '/bin', shell: '/bin/sync' },
    { name: 'games', uid: 5, gid: 60, gecos: 'games', home: '/usr/games', shell: '/usr/sbin/nologin' },
    { name: 'man', uid: 6, gid: 12, gecos: 'man', home: '/var/cache/man', shell: '/usr/sbin/nologin' },
    { name: 'lp', uid: 7, gid: 7, gecos: 'lp', home: '/var/spool/lpd', shell: '/usr/sbin/nologin' },
    { name: 'mail', uid: 8, gid: 8, gecos: 'mail', home: '/var/mail', shell: '/usr/sbin/nologin' },
    { name: 'news', uid: 9, gid: 9, gecos: 'news', home: '/var/spool/news', shell: '/usr/sbin/nologin' },
    { name: 'proxy', uid: 13, gid: 13, gecos: 'proxy', home: '/bin', shell: '/usr/sbin/nologin' },
    { name: 'www-data', uid: 33, gid: 33, gecos: 'www-data', home: '/var/www', shell: '/usr/sbin/nologin' },
    { name: 'backup', uid: 34, gid: 34, gecos: 'backup', home: '/var/backups', shell: '/usr/sbin/nologin' },
    { name: 'nobody', uid: 65534, gid: 65534, gecos: 'nobody', home: '/nonexistent', shell: '/usr/sbin/nologin' },
    { name: 'systemd-network', uid: 998, gid: 998, gecos: 'systemd Network Management', home: '/', shell: '/usr/sbin/nologin' },
    { name: 'systemd-timesync', uid: 996, gid: 996, gecos: 'systemd Time Synchronization', home: '/', shell: '/usr/sbin/nologin' },
    { name: 'messagebus', uid: 100, gid: 101, gecos: '', home: '/nonexistent', shell: '/usr/sbin/nologin' },
    { name: 'syslog', uid: 104, gid: 104, gecos: '', home: '/nonexistent', shell: '/usr/sbin/nologin' },
    { name: 'sshd', uid: 105, gid: 65534, gecos: '', home: '/run/sshd', shell: '/usr/sbin/nologin' },
    { name: 'learner', uid: 1000, gid: 1000, gecos: 'Learner', home: '/home/learner', shell: '/bin/bash' },
  ];
  groups: GroupEntry[] = [
    { name: 'root', gid: 0, members: [] },
    { name: 'daemon', gid: 1, members: [] },
    { name: 'bin', gid: 2, members: [] },
    { name: 'sys', gid: 3, members: [] },
    { name: 'adm', gid: 4, members: ['syslog', 'learner'] },
    { name: 'tty', gid: 5, members: [] },
    { name: 'disk', gid: 6, members: [] },
    { name: 'lp', gid: 7, members: [] },
    { name: 'mail', gid: 8, members: [] },
    { name: 'news', gid: 9, members: [] },
    { name: 'man', gid: 12, members: [] },
    { name: 'proxy', gid: 13, members: [] },
    { name: 'cdrom', gid: 24, members: ['learner'] },
    { name: 'sudo', gid: 27, members: ['learner'] },
    { name: 'dip', gid: 30, members: ['learner'] },
    { name: 'www-data', gid: 33, members: [] },
    { name: 'backup', gid: 34, members: [] },
    { name: 'shadow', gid: 42, members: [] },
    { name: 'utmp', gid: 43, members: [] },
    { name: 'video', gid: 44, members: [] },
    { name: 'plugdev', gid: 46, members: ['learner'] },
    { name: 'staff', gid: 50, members: [] },
    { name: 'games', gid: 60, members: [] },
    { name: 'users', gid: 100, members: ['learner'] },
    { name: 'messagebus', gid: 101, members: [] },
    { name: 'syslog', gid: 104, members: [] },
    { name: 'systemd-timesync', gid: 996, members: [] },
    { name: 'systemd-network', gid: 998, members: [] },
    { name: 'nogroup', gid: 65534, members: [] },
    { name: 'learner', gid: 1000, members: [] },
  ];
  readonly processes = new ProcessTable();
  readonly commands = new Map<string, NativeCommand>();
  readonly bootTime: number;
  readonly now: () => number;
  readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random: () => number;
  /** uid -> time of last successful sudo authentication. */
  readonly sudoTimestamps = new Map<number, number>();
  tty: TtyDriver | null = null;
  readonly execListeners: ((e: ExecEvent) => void)[] = [];
  /** Callbacks used by the web UI (lessons, window title). */
  hooks: SystemHooks = {};

  constructor(opts: SystemOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.fs = opts.fs ?? new VirtualFS({ now: this.now });
    this.hostname = opts.hostname ?? 'sandbox';
    this.delay = opts.delay ?? realDelay;
    this.random = opts.random ?? Math.random;
    this.bootTime = this.now() - 3 * 3600 * 1000 - 17 * 60 * 1000;
  }

  registerCommand(cmd: NativeCommand): void {
    this.commands.set(cmd.name, cmd);
  }

  userByName(name: string): UserEntry | undefined {
    return this.users.find((u) => u.name === name);
  }

  userByUid(uid: number): UserEntry | undefined {
    return this.users.find((u) => u.uid === uid);
  }

  groupByName(name: string): GroupEntry | undefined {
    return this.groups.find((g) => g.name === name);
  }

  groupByGid(gid: number): GroupEntry | undefined {
    return this.groups.find((g) => g.gid === gid);
  }

  userName(uid: number): string {
    return this.userByUid(uid)?.name ?? String(uid);
  }

  groupName(gid: number): string {
    return this.groupByGid(gid)?.name ?? String(gid);
  }

  /** All group ids a user belongs to (primary first). */
  groupIdsOf(user: UserEntry): number[] {
    const ids = [user.gid];
    for (const g of this.groups) if (g.members.includes(user.name) && !ids.includes(g.gid)) ids.push(g.gid);
    return ids;
  }

  credsFor(user: UserEntry): Credentials {
    return { uid: user.uid, gid: user.gid, groups: this.groupIdsOf(user) };
  }

  emitExec(e: ExecEvent): void {
    for (const l of this.execListeners) {
      try {
        l(e);
      } catch (err) {
        console.error(err);
      }
    }
  }
}
