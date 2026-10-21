// System information and process programs: whoami, id, groups, hostname,
// uname, date, cal, sleep, env, printenv, which, whereis, uptime, clear,
// reset, tty, who, w, users, nproc, arch, free, ps, kill, pgrep, pkill,
// pidof, logname, true, false, test, timeout, nohup, dircolors, lsb_release.

import { evalTestArgs } from '../builtins/test';
import type { Shell } from '../interpreter';
import { parseSignalName, signalListing } from '../builtins/jobs';
import type { SignalName } from '../streams';
import type { CommandContext } from '../types';
import { basename } from '../vfs/path';
import { DEFAULT_LS_COLORS } from './lscolors';
import { systemIp } from './net';
import { DAYS, MONTHS, defineCommand, errText, getopts, pad2, q, ql, tzAbbrev, tzOffset } from './util';

async function missing(ctx: CommandContext, msg = 'missing operand'): Promise<number> {
  await ctx.error(msg);
  await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// identity

defineCommand({
  name: 'whoami',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'system', summary: 'print effective user name', synopsis: ['whoami [OPTION]...'], description: 'Print the user name associated with the current effective user ID. Same as id -un.', examples: [{ cmd: 'whoami', desc: 'Which user am I?' }, { cmd: 'sudo whoami', desc: 'Prints root.' }], seeAlso: ['id', 'who'] },
  run: async (ctx) => {
    await ctx.out(ctx.system.userName(ctx.creds.uid) + '\n');
    return 0;
  },
});

defineCommand({
  name: 'logname',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'system', summary: "print user's login name", synopsis: ['logname [OPTION]'], description: 'Print the name of the current user.' },
  run: async (ctx) => {
    await ctx.out((ctx.env.get('LOGNAME') ?? ctx.system.userName(ctx.creds.uid)) + '\n');
    return 0;
  },
});

defineCommand({
  name: 'id',
  pkg: 'coreutils',
  size: 39432,
  doc: {
    category: 'permissions',
    summary: 'print real and effective user and group IDs',
    synopsis: ['id [OPTION]... [USER]...'],
    description: 'Print user and group information for each specified USER, or (when USER omitted) for the current process.',
    options: [
      { flags: '-g, --group', desc: 'print only the effective group ID' },
      { flags: '-G, --groups', desc: 'print all group IDs' },
      { flags: '-n, --name', desc: 'print a name instead of a number, for -ugG' },
      { flags: '-u, --user', desc: 'print only the effective user ID' },
    ],
    examples: [{ cmd: 'id', desc: 'Show your user id and the groups you belong to.' }],
    seeAlso: ['whoami', 'groups'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'agGnruzZ', long: { group: 'g', groups: 'G', name: 'n', real: 'r', user: 'u' } });
    if (!opts) return 1;
    const sys = ctx.system;
    let uid = ctx.creds.uid;
    let gid = ctx.creds.gid;
    let groups = ctx.creds.groups;
    if (opts.operands[0]) {
      const u = sys.userByName(opts.operands[0]) ?? (/^\d+$/.test(opts.operands[0]) ? sys.userByUid(+opts.operands[0]) : undefined);
      if (!u) {
        await ctx.error(`${q(opts.operands[0])}: no such user`);
        return 1;
      }
      uid = u.uid;
      gid = u.gid;
      groups = sys.groupIdsOf(u);
    }
    const name = opts.has('n');
    if (opts.has('u')) await ctx.out((name ? sys.userName(uid) : String(uid)) + '\n');
    else if (opts.has('g')) await ctx.out((name ? sys.groupName(gid) : String(gid)) + '\n');
    else if (opts.has('G')) await ctx.out(groups.map((g) => (name ? sys.groupName(g) : String(g))).join(' ') + '\n');
    else {
      await ctx.out(`uid=${uid}(${sys.userName(uid)}) gid=${gid}(${sys.groupName(gid)}) groups=${groups.map((g) => `${g}(${sys.groupName(g)})`).join(',')}\n`);
    }
    return 0;
  },
});

defineCommand({
  name: 'groups',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'permissions', summary: 'print the groups a user is in', synopsis: ['groups [OPTION]... [USERNAME]...'], description: 'Print group memberships for each USERNAME or, if no USERNAME is specified, for the current process.', seeAlso: ['id'] },
  run: async (ctx) => {
    const sys = ctx.system;
    if (ctx.args.length === 0) {
      await ctx.out(ctx.creds.groups.map((g) => sys.groupName(g)).join(' ') + '\n');
      return 0;
    }
    let status = 0;
    for (const n of ctx.args) {
      const u = sys.userByName(n);
      if (!u) {
        await ctx.error(`${q(n)}: no such user`);
        status = 1;
        continue;
      }
      await ctx.out(`${n} : ${sys.groupIdsOf(u).map((g) => sys.groupName(g)).join(' ')}\n`);
    }
    return status;
  },
});

defineCommand({
  name: 'hostname',
  pkg: 'hostname',
  size: 22760,
  doc: { category: 'network', summary: 'show or set the system\'s host name', synopsis: ['hostname [-a|-d|-f|-i|-I|-s]', 'hostname NAME'], description: 'Hostname is used to display the system\'s DNS name, and to display or set its hostname.', options: [{ flags: '-I, --all-ip-addresses', desc: 'all addresses for the host' }, { flags: '-i, --ip-address', desc: 'addresses for the host name' }], examples: [{ cmd: 'hostname', desc: "Print this computer's name." }, { cmd: 'hostname -I', desc: "Show this computer's IP address." }], seeAlso: ['uname'] },
  run: async (ctx) => {
    const a = ctx.args[0];
    if (a === '-I' || a === '--all-ip-addresses') {
      await ctx.out(`${systemIp(ctx.system)} \n`);
      return 0;
    }
    if (a === '-i' || a === '--ip-address') {
      await ctx.out('127.0.1.1\n');
      return 0;
    }
    if (a && !a.startsWith('-')) {
      if (ctx.creds.uid !== 0) {
        await ctx.out('hostname: you must be root to change the host name\n');
        return 1;
      }
      ctx.system.hostname = a;
      return 0;
    }
    await ctx.out(ctx.system.hostname + '\n');
    return 0;
  },
});

defineCommand({
  name: 'uname',
  pkg: 'coreutils',
  size: 35464,
  doc: {
    category: 'system',
    summary: 'print system information',
    synopsis: ['uname [OPTION]...'],
    description: 'Print certain system information. With no OPTION, same as -s.',
    options: [
      { flags: '-a, --all', desc: 'print all information' },
      { flags: '-s, --kernel-name', desc: 'print the kernel name' },
      { flags: '-n, --nodename', desc: 'print the network node hostname' },
      { flags: '-r, --kernel-release', desc: 'print the kernel release' },
      { flags: '-m, --machine', desc: 'print the machine hardware name' },
      { flags: '-o, --operating-system', desc: 'print the operating system' },
    ],
    examples: [{ cmd: 'uname -a', desc: 'Show the kernel version and machine type.' }],
    seeAlso: ['hostname', 'lsb_release'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'asnrvmpio', long: { all: 'a', 'kernel-name': 's', nodename: 'n', 'kernel-release': 'r', 'kernel-version': 'v', machine: 'm', processor: 'p', 'hardware-platform': 'i', 'operating-system': 'o' } });
    if (!opts) return 1;
    const v = {
      s: 'Linux',
      n: ctx.system.hostname,
      r: '6.8.0-45-generic',
      v: '#45-Ubuntu SMP PREEMPT_DYNAMIC Fri Aug 30 12:02:04 UTC 2024',
      m: 'x86_64',
      p: 'x86_64',
      i: 'x86_64',
      o: 'GNU/Linux',
    };
    const order = ['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o'] as const;
    const picked = opts.has('a') ? order : order.filter((k) => opts.has(k));
    await ctx.out((picked.length ? picked.map((k) => v[k]) : [v.s]).join(' ') + '\n');
    return 0;
  },
});

defineCommand({
  name: 'lsb_release',
  pkg: 'lsb-release',
  dir: '/usr/bin',
  size: 2200,
  doc: { category: 'system', summary: 'print distribution-specific information', synopsis: ['lsb_release [options]'], description: 'Print certain LSB (Linux Standard Base) and Distribution information.', options: [{ flags: '-a, --all', desc: 'Display all of the above information.' }, { flags: '-d, --description', desc: 'Display a description of the currently installed distribution.' }], examples: [{ cmd: 'lsb_release -a', desc: 'Which version of Ubuntu is this?' }] },
  run: async (ctx) => {
    const a = ctx.args.join(' ');
    const all = a.includes('-a') || a === '';
    let out = '';
    if (all || a.includes('-a')) out += 'No LSB modules are available.\n';
    if (all || a.includes('-i')) out += 'Distributor ID:\tUbuntu\n';
    if (all || a.includes('-d')) out += 'Description:\tUbuntu 24.04.1 LTS\n';
    if (all || a.includes('-r')) out += 'Release:\t24.04\n';
    if (all || a.includes('-c')) out += 'Codename:\tnoble\n';
    await ctx.out(out);
    return 0;
  },
});

// ---------------------------------------------------------------------------
// time

/** strftime() as used by date(1). */
export function strftime(fmt: string, t: number, utc = false): string {
  const d = new Date(t);
  const Y = utc ? d.getUTCFullYear() : d.getFullYear();
  const mo = utc ? d.getUTCMonth() : d.getMonth();
  const day = utc ? d.getUTCDate() : d.getDate();
  const H = utc ? d.getUTCHours() : d.getHours();
  const M = utc ? d.getUTCMinutes() : d.getMinutes();
  const S = utc ? d.getUTCSeconds() : d.getSeconds();
  const wd = utc ? d.getUTCDay() : d.getDay();
  const start = utc ? Date.UTC(Y, 0, 1) : new Date(Y, 0, 1).getTime();
  const yday = Math.floor((t - start) / 86400000) + 1;
  const tz = utc ? 'UTC' : tzAbbrev(d);
  const off = utc ? '+0000' : tzOffset(d);
  const longDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const longMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const h12 = H % 12 || 12;
  const isoWeek = () => {
    const date = new Date(Date.UTC(Y, mo, day));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  };
  return fmt.replace(/%([-_0^#]?)(:?)([a-zA-Z%+])/g, (_m, flag: string, colon: string, c: string) => {
    let v: string;
    let numeric = true;
    let width = 2;
    switch (c) {
      case 'a': v = DAYS[wd]; numeric = false; break;
      case 'A': v = longDays[wd]; numeric = false; break;
      case 'b':
      case 'h': v = MONTHS[mo]; numeric = false; break;
      case 'B': v = longMonths[mo]; numeric = false; break;
      case 'c': v = strftime('%a %b %e %r %Z %Y', t, utc); numeric = false; break;
      case 'C': v = String(Math.floor(Y / 100)); break;
      case 'd': v = String(day); break;
      case 'D': v = strftime('%m/%d/%y', t, utc); numeric = false; break;
      case 'e': v = String(day); if (!flag) flag = '_'; break;
      case 'F': v = strftime('%Y-%m-%d', t, utc); numeric = false; break;
      case 'g': v = String(Y % 100); break;
      case 'G': v = String(Y); width = 4; break;
      case 'H': v = String(H); break;
      case 'I': v = String(h12); break;
      case 'j': v = String(yday); width = 3; break;
      case 'k': v = String(H); if (!flag) flag = '_'; break;
      case 'l': v = String(h12); if (!flag) flag = '_'; break;
      case 'm': v = String(mo + 1); break;
      case 'M': v = String(M); break;
      case 'n': v = '\n'; numeric = false; break;
      case 'N': v = String((t % 1000) * 1000000).padStart(9, '0'); numeric = false; break;
      case 'p': v = H < 12 ? 'AM' : 'PM'; numeric = false; break;
      case 'P': v = H < 12 ? 'am' : 'pm'; numeric = false; break;
      case 'r': v = strftime('%I:%M:%S %p', t, utc); numeric = false; break;
      case 'R': v = strftime('%H:%M', t, utc); numeric = false; break;
      case 's': v = String(Math.floor(t / 1000)); numeric = false; break;
      case 'S': v = String(S); break;
      case 't': v = '\t'; numeric = false; break;
      case 'T': v = strftime('%H:%M:%S', t, utc); numeric = false; break;
      case 'u': v = String(wd || 7); width = 1; break;
      case 'V': v = String(isoWeek()); break;
      case 'w': v = String(wd); width = 1; break;
      case 'x': v = strftime('%m/%d/%Y', t, utc); numeric = false; break;
      case 'X': v = strftime('%r', t, utc); numeric = false; break;
      case 'y': v = String(Y % 100); break;
      case 'Y': v = String(Y); width = 1; break;
      case 'z': v = colon ? off.slice(0, 3) + ':' + off.slice(3) : off; numeric = false; break;
      case 'Z': v = tz; numeric = false; break;
      case '%': v = '%'; numeric = false; break;
      case '+': v = strftime('%a %b %e %H:%M:%S %Z %Y', t, utc); numeric = false; break;
      default: return '%' + flag + colon + c;
    }
    if (numeric) {
      if (flag === '-') return v;
      if (flag === '_') return v.padStart(width, ' ');
      return v.padStart(width, '0');
    }
    if (flag === '^') return v.toUpperCase();
    if (flag === '#') return v === v.toUpperCase() ? v.toLowerCase() : v.toUpperCase();
    return v;
  });
}

/** Parse the subset of GNU date strings people commonly use. */
export function parseDateString(s: string, now: number): number | null {
  const t = s.trim().toLowerCase();
  if (t === '' || t === 'now' || t === 'today') return now;
  if (t.startsWith('@') && /^@-?\d+$/.test(t)) return parseInt(t.slice(1), 10) * 1000;
  if (t === 'yesterday') return now - 86400000;
  if (t === 'tomorrow') return now + 86400000;
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  let m = /^(next|last|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)$/.exec(t);
  if (m) {
    const target = dayNames.findIndex((d) => d.startsWith(m![2]));
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    let diff = (target - d.getDay() + 7) % 7;
    if (m[1] === 'last') diff = diff === 0 ? -7 : diff - 7;
    else if (m[1] === 'next' && diff === 0) diff = 7;
    return d.getTime() + diff * 86400000;
  }
  m = /^([-+]?\d+)\s*(sec|second|min|minute|hour|day|week|fortnight|month|year)s?(\s+ago)?$/.exec(t);
  if (m) {
    let n = parseInt(m[1], 10);
    if (m[3]) n = -n;
    const unit = m[2];
    const d = new Date(now);
    if (unit === 'month') {
      d.setMonth(d.getMonth() + n);
      return d.getTime();
    }
    if (unit === 'year') {
      d.setFullYear(d.getFullYear() + n);
      return d.getTime();
    }
    const ms = { sec: 1e3, second: 1e3, min: 6e4, minute: 6e4, hour: 3.6e6, day: 8.64e7, week: 6.048e8, fortnight: 1.2096e9 }[unit]!;
    return now + n * ms;
  }
  m = /^(next|last)\s+(day|week|month|year)$/.exec(t);
  if (m) return parseDateString(`${m[1] === 'next' ? 1 : -1} ${m[2]}`, now);
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime();
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m) {
    const d = new Date(now);
    d.setHours(+m[1], +m[2], +(m[3] ?? 0), 0);
    return d.getTime();
  }
  const p = Date.parse(s);
  return Number.isNaN(p) ? null : p;
}

defineCommand({
  name: 'date',
  pkg: 'coreutils',
  size: 104960,
  doc: {
    category: 'system',
    summary: 'print or set the system date and time',
    synopsis: ['date [OPTION]... [+FORMAT]'],
    description: 'Display date and time in the given FORMAT. FORMAT controls the output; interpreted sequences include %Y (year), %m (month), %d (day), %H:%M:%S (time), %A (weekday name), %B (month name), %s (seconds since 1970).',
    options: [
      { flags: '-d, --date=STRING', desc: "display time described by STRING, not 'now' (e.g. 'yesterday', '2 days ago', 'next friday')" },
      { flags: '-I, --iso-8601', desc: 'output date/time in ISO 8601 format' },
      { flags: '-R, --rfc-email', desc: 'output date and time in RFC 5322 format' },
      { flags: '-r, --reference=FILE', desc: 'display the last modification time of FILE' },
      { flags: '-u, --utc', desc: 'print Coordinated Universal Time (UTC)' },
    ],
    examples: [
      { cmd: 'date', desc: 'Show the current date and time.' },
      { cmd: 'date +%Y-%m-%d', desc: 'Show just the date, like 2026-10-21.' },
      { cmd: "date -d 'next friday'", desc: 'When is next Friday?' },
    ],
    seeAlso: ['cal', 'uptime'],
  },
  run: async (ctx) => {
    const opts = await getopts(ctx, { short: 'd:f:I::r:Rs:u', long: { date: { key: 'd', arg: 'required' }, 'iso-8601': { key: 'I', arg: 'optional' }, reference: { key: 'r', arg: 'required' }, 'rfc-email': 'R', 'rfc-2822': 'R', set: { key: 's', arg: 'required' }, utc: 'u', universal: 'u' } });
    if (!opts) return 1;
    const now = ctx.system.now();
    let t = now;
    const utc = opts.has('u');
    if (opts.get('d') !== undefined) {
      const p = parseDateString(opts.get('d')!, now);
      if (p === null) {
        await ctx.error(`invalid date ${ql(opts.get('d')!)}`);
        return 1;
      }
      t = p;
    }
    if (opts.get('r') !== undefined) {
      try {
        t = ctx.fs.stat(opts.get('r')!).mtime;
      } catch (e) {
        await ctx.error(`${opts.get('r')}: ${errText(e)}`);
        return 1;
      }
    }
    if (opts.get('s') !== undefined) {
      if (ctx.creds.uid !== 0) {
        await ctx.error('cannot set date: Operation not permitted');
        const p = parseDateString(opts.get('s')!, now);
        if (p !== null) await ctx.out(strftime('%a %b %e %r %Z %Y', p, utc) + '\n');
        return 1;
      }
      await ctx.out(strftime('%a %b %e %r %Z %Y', parseDateString(opts.get('s')!, now) ?? now, utc) + '\n');
      return 0;
    }
    const fmtArg = opts.operands.find((o) => o.startsWith('+'));
    if (opts.operands.some((o) => !o.startsWith('+'))) {
      const bad = opts.operands.find((o) => !o.startsWith('+'))!;
      await ctx.error(`invalid date ${ql(bad)}`);
      return 1;
    }
    let out: string;
    if (fmtArg) out = strftime(fmtArg.slice(1), t, utc);
    else if (opts.has('I')) {
      const spec = opts.get('I') ?? 'date';
      out = spec === 'seconds' ? strftime('%Y-%m-%dT%H:%M:%S%:z', t, utc) : spec === 'minutes' ? strftime('%Y-%m-%dT%H:%M%:z', t, utc) : spec === 'hours' ? strftime('%Y-%m-%dT%H%:z', t, utc) : strftime('%Y-%m-%d', t, utc);
    } else if (opts.has('R')) out = strftime('%a, %d %b %Y %H:%M:%S %z', t, utc);
    else out = strftime('%a %b %e %r %Z %Y', t, utc);
    await ctx.out(out + '\n');
    return 0;
  },
});

function calMonth(year: number, month: number, today: Date | null, highlight: boolean): string[] {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const title = `${names[month]} ${year}`;
  const lines = [title.padStart(Math.floor((20 + title.length) / 2)).padEnd(20), 'Su Mo Tu We Th Fr Sa'];
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  let line = '   '.repeat(first);
  for (let d = 1; d <= days; d++) {
    let cell = String(d).padStart(2);
    if (highlight && today && today.getFullYear() === year && today.getMonth() === month && today.getDate() === d) cell = `\x1b[7m${cell}\x1b[27m`;
    line += cell;
    if ((first + d) % 7 === 0) {
      lines.push(line);
      line = '';
    } else if (d < days) line += ' ';
  }
  if (line) lines.push(line.padEnd(20));
  while (lines.length < 8) lines.push(' '.repeat(20));
  return lines;
}

defineCommand({
  name: 'cal',
  pkg: 'ncal',
  size: 34776,
  doc: { category: 'system', summary: 'displays a calendar', synopsis: ['cal [-3y] [[month] year]'], description: 'cal displays a simple calendar. If arguments are not specified, the current month is displayed.', options: [{ flags: '-3', desc: 'Display the previous, current and next month surrounding today.' }, { flags: '-y', desc: 'Display a calendar for the specified year.' }], examples: [{ cmd: 'cal', desc: 'This month.' }, { cmd: 'cal 12 2026', desc: 'December 2026.' }], seeAlso: ['date'] },
  run: async (ctx) => {
    const now = new Date(ctx.system.now());
    const nums = ctx.args.filter((a) => /^\d+$/.test(a)).map(Number);
    const three = ctx.args.includes('-3');
    const yearMode = ctx.args.includes('-y') || (nums.length === 1 && nums[0] > 12);
    const hl = ctx.stdout.isTTY;
    if (yearMode) {
      const year = nums[0] ?? now.getFullYear();
      let out = String(year).padStart(32) + '\n\n';
      for (let row = 0; row < 4; row++) {
        const months = [0, 1, 2].map((i) => calMonth(year, row * 3 + i, now, hl).map((l, li) => (li === 0 ? l.replace(/ \d{4}/, '').padStart(Math.floor((20 + l.replace(/ \d{4}/, '').trim().length) / 2)).padEnd(20) : l)));
        for (let li = 0; li < 8; li++) out += months.map((m) => m[li]).join('  ') + '\n';
      }
      await ctx.out(out);
      return 0;
    }
    const month = nums.length >= 2 ? nums[0] - 1 : now.getMonth();
    const year = nums.length >= 2 ? nums[1] : now.getFullYear();
    if (month < 0 || month > 11) {
      await ctx.out(`cal: ${nums[0]} is neither a month number (1..12) nor a name\n`);
      return 1;
    }
    if (three) {
      const blocks = [-1, 0, 1].map((o) => {
        const d = new Date(year, month + o, 1);
        return calMonth(d.getFullYear(), d.getMonth(), now, hl);
      });
      let out = '';
      for (let li = 0; li < 8; li++) out += blocks.map((b) => b[li]).join('  ') + '\n';
      await ctx.out(out);
      return 0;
    }
    await ctx.out(calMonth(year, month, now, hl).join('\n') + '\n');
    return 0;
  },
});

defineCommand({
  name: 'sleep',
  pkg: 'coreutils',
  size: 35464,
  doc: {
    category: 'processes',
    summary: 'delay for a specified amount of time',
    synopsis: ['sleep NUMBER[SUFFIX]...'],
    description: "Pause for NUMBER seconds. SUFFIX may be 's' for seconds (the default), 'm' for minutes, 'h' for hours or 'd' for days. NUMBER need not be an integer. Given two or more arguments, pause for the amount of time specified by the sum of their values.",
    examples: [
      { cmd: 'sleep 5', desc: 'Wait five seconds.' },
      { cmd: 'sleep 60 &', desc: 'Run a long sleep in the background.' },
    ],
    seeAlso: ['timeout'],
    tip: 'sleep is perfect for practising Ctrl+C, Ctrl+Z, jobs, fg and bg.',
  },
  run: async (ctx) => {
    if (ctx.args.length === 0) return missing(ctx);
    let total = 0;
    for (const a of ctx.args) {
      const m = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(a);
      if (!m) {
        if (a === 'inf' || a === 'infinity') {
          total = Infinity;
          continue;
        }
        await ctx.error(`invalid time interval ${ql(a)}`);
        await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
        return 1;
      }
      total += parseFloat(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] ?? 1);
    }
    await ctx.sleep(total === Infinity ? 1e12 : total * 1000);
    return 0;
  },
});

// ---------------------------------------------------------------------------
// environment

defineCommand({
  name: 'env',
  pkg: 'coreutils',
  size: 48536,
  doc: {
    category: 'shell',
    summary: 'run a program in a modified environment',
    synopsis: ['env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]'],
    description: 'Set each NAME to VALUE in the environment and run COMMAND. With no COMMAND, print the resulting environment.',
    options: [
      { flags: '-i, --ignore-environment', desc: 'start with an empty environment' },
      { flags: '-u, --unset=NAME', desc: 'remove variable from the environment' },
    ],
    examples: [
      { cmd: 'env', desc: 'Print all environment variables.' },
      { cmd: 'env LANG=C date', desc: 'Run a command with a changed variable.' },
    ],
    seeAlso: ['printenv', 'export'],
  },
  run: async (ctx) => {
    let args = ctx.args;
    let env = new Map(ctx.env);
    while (args.length) {
      const a = args[0];
      if (a === '-i' || a === '--ignore-environment' || a === '-') {
        env = new Map();
        args = args.slice(1);
      } else if (a === '-u' || a === '--unset') {
        env.delete(args[1] ?? '');
        args = args.slice(2);
      } else if (a.startsWith('--unset=')) {
        env.delete(a.slice(8));
        args = args.slice(1);
      } else if (a === '--') {
        args = args.slice(1);
        break;
      } else break;
    }
    while (args.length && /^[^=]+=/.test(args[0])) {
      const eq = args[0].indexOf('=');
      env.set(args[0].slice(0, eq), args[0].slice(eq + 1));
      args = args.slice(1);
    }
    if (args.length === 0) {
      let out = '';
      for (const [k, v] of env) out += `${k}=${v}\n`;
      await ctx.out(out);
      return 0;
    }
    const path = args[0].includes('/') ? args[0] : findWithEnv(ctx, args[0], env);
    if (!path || !ctx.fs.exists(path)) {
      await ctx.error(`${ql(args[0])}: No such file or directory`);
      return 127;
    }
    return ctx.exec([path === args[0] ? args[0] : args[0], ...args.slice(1)], { env });
  },
});

function findWithEnv(ctx: CommandContext, name: string, env: Map<string, string>): string | null {
  for (const dir of (env.get('PATH') ?? '').split(':')) {
    const p = (dir || '.') + '/' + name;
    const node = ctx.fs.tryStat(p);
    if (node && node.type === 'file') return p;
  }
  return null;
}

defineCommand({
  name: 'printenv',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'shell', summary: 'print all or part of environment', synopsis: ['printenv [OPTION]... [VARIABLE]...'], description: 'Print the values of the specified environment VARIABLE(s). If no VARIABLE is specified, print name and value pairs for them all.', examples: [{ cmd: 'printenv HOME', desc: 'Print one variable.' }], seeAlso: ['env', 'echo'] },
  run: async (ctx) => {
    if (ctx.args.length === 0) {
      let out = '';
      for (const [k, v] of ctx.env) out += `${k}=${v}\n`;
      await ctx.out(out);
      return 0;
    }
    let status = 0;
    for (const n of ctx.args) {
      const v = ctx.env.get(n);
      if (v === undefined) status = 1;
      else await ctx.out(v + '\n');
    }
    return status;
  },
});

defineCommand({
  name: 'which',
  pkg: 'debianutils',
  size: 1073,
  doc: {
    category: 'help',
    summary: 'locate a command',
    synopsis: ['which [-a] filename ...'],
    description: "which returns the pathnames of the files (or links) which would be executed in the current environment, had its arguments been given as commands. It does this by searching the PATH for executable files.\n\nwhich only knows about programs on disk. Shell builtins such as cd have no file, so which prints nothing for them; use 'type' instead.",
    options: [{ flags: '-a', desc: 'print all matching pathnames of each argument' }],
    examples: [{ cmd: 'which ls', desc: 'Where is the ls program?' }],
    seeAlso: ['type', 'whereis'],
  },
  run: async (ctx) => {
    let all = false;
    const names: string[] = [];
    for (const a of ctx.args) {
      if (a === '-a') all = true;
      else if (a.startsWith('-') && names.length === 0) {
        await ctx.err(`Usage: /usr/bin/which [-as] args\n`);
        return 2;
      } else names.push(a);
    }
    let status = 0;
    for (const n of names) {
      let found = false;
      if (n.includes('/')) {
        const node = ctx.fs.tryStat(n);
        if (node && node.type === 'file' && ctx.fs.canAccess(node, 1)) {
          await ctx.out(n + '\n');
          found = true;
        }
      } else {
        for (const dir of (ctx.env.get('PATH') ?? '').split(':')) {
          const p = (dir || '.') + '/' + n;
          const node = ctx.fs.tryStat(p);
          if (node && node.type === 'file' && ctx.fs.canAccess(node, 1)) {
            await ctx.out(p + '\n');
            found = true;
            if (!all) break;
          }
        }
      }
      if (!found) status = 1;
    }
    return status;
  },
});

defineCommand({
  name: 'whereis',
  pkg: 'util-linux',
  size: 31120,
  doc: { category: 'help', summary: 'locate the binary, source, and manual page files for a command', synopsis: ['whereis [options] name...'], description: 'whereis locates the binary, source and manual files for the specified command names.', examples: [{ cmd: 'whereis ls', desc: 'Find the ls program and its manual page.' }], seeAlso: ['which', 'type'] },
  run: async (ctx) => {
    let out = '';
    for (const n of ctx.args.filter((a) => !a.startsWith('-'))) {
      const found: string[] = [];
      for (const dir of ['/usr/bin', '/usr/sbin', '/usr/games', '/usr/local/bin', '/usr/lib', '/etc']) {
        if (ctx.fs.tryStat(`${dir}/${n}`)) found.push(`${dir}/${n}`);
      }
      for (const sec of [1, 5, 8]) if (ctx.fs.tryStat(`/usr/share/man/man${sec}/${n}.${sec}.gz`)) found.push(`/usr/share/man/man${sec}/${n}.${sec}.gz`);
      out += `${n}:${found.map((f) => ' ' + f).join('')}\n`;
    }
    await ctx.out(out);
    return 0;
  },
});

defineCommand({
  name: 'dircolors',
  pkg: 'coreutils',
  size: 51272,
  doc: { category: 'shell', summary: 'color setup for ls', synopsis: ['dircolors [OPTION]... [FILE]'], description: 'Output commands to set the LS_COLORS environment variable.', options: [{ flags: '-b, --sh, --bourne-shell', desc: 'output Bourne shell code to set LS_COLORS' }] },
  run: async (ctx) => {
    await ctx.out(`LS_COLORS='${DEFAULT_LS_COLORS}';\nexport LS_COLORS\n`);
    return 0;
  },
});

// ---------------------------------------------------------------------------
// terminal

defineCommand({
  name: 'clear',
  pkg: 'ncurses-bin',
  size: 14488,
  doc: { category: 'shell', summary: 'clear the terminal screen', synopsis: ['clear [-x]'], description: 'clear clears your terminal\'s screen and its scrollback buffer. You can also press Ctrl+L, which clears the screen but keeps the scrollback.', options: [{ flags: '-x', desc: 'do not attempt to clear the terminal\'s scrollback buffer' }], examples: [{ cmd: 'clear', desc: 'Start with a clean screen.' }], seeAlso: ['reset'] },
  run: async (ctx) => {
    await ctx.out(ctx.args.includes('-x') ? '\x1b[H\x1b[2J' : '\x1b[H\x1b[2J\x1b[3J');
    return 0;
  },
});

defineCommand({
  name: 'reset',
  pkg: 'ncurses-bin',
  size: 26904,
  doc: { category: 'shell', summary: 'terminal initialization', synopsis: ['reset'], description: 'reset reinitializes the terminal. Use it when the terminal shows garbage after printing a binary file.' },
  run: async (ctx) => {
    ctx.tty?.setModes({ icanon: true, echo: true, isig: true, opost: true });
    await ctx.out('\x1bc\x1b[!p\x1b[?3;4l\x1b[4l\x1b>\x1b[H\x1b[2J\x1b[3J');
    return 0;
  },
});

defineCommand({
  name: 'tty',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'system', summary: 'print the file name of the terminal connected to standard input', synopsis: ['tty [OPTION]...'], description: 'Print the file name of the terminal connected to standard input.' },
  run: async (ctx) => {
    if (ctx.stdin.isTTY && ctx.tty) {
      if (!ctx.args.includes('-s')) await ctx.out(`/dev/${ctx.tty.name}\n`);
      return 0;
    }
    if (!ctx.args.includes('-s')) await ctx.out('not a tty\n');
    return 1;
  },
});

// ---------------------------------------------------------------------------
// users and load

function uptimeText(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  let s = '';
  if (days) s += `${days} day${days > 1 ? 's' : ''}, `;
  if (hours) s += `${String(hours).padStart(2)}:${pad2(m)}`;
  else s += `${m} min`;
  return s;
}

defineCommand({
  name: 'uptime',
  pkg: 'procps',
  size: 14568,
  doc: { category: 'system', summary: 'Tell how long the system has been running.', synopsis: ['uptime [options]'], description: 'uptime gives a one line display of the following information: the current time, how long the system has been running, how many users are currently logged on, and the system load averages for the past 1, 5, and 15 minutes.', options: [{ flags: '-p, --pretty', desc: 'show uptime in pretty format' }, { flags: '-s, --since', desc: 'system up since, in yyyy-mm-dd HH:MM:SS format' }], seeAlso: ['w', 'top'] },
  run: async (ctx) => {
    const now = ctx.system.now();
    const up = now - ctx.system.bootTime;
    if (ctx.args.includes('-p') || ctx.args.includes('--pretty')) {
      const mins = Math.floor(up / 60000);
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      await ctx.out(`up ${h ? `${h} hour${h > 1 ? 's' : ''}, ` : ''}${m} minute${m === 1 ? '' : 's'}\n`);
      return 0;
    }
    if (ctx.args.includes('-s') || ctx.args.includes('--since')) {
      await ctx.out(strftime('%Y-%m-%d %H:%M:%S', ctx.system.bootTime) + '\n');
      return 0;
    }
    await ctx.out(` ${strftime('%H:%M:%S', now)} up ${uptimeText(up)},  1 user,  load average: 0.08, 0.03, 0.01\n`);
    return 0;
  },
});

defineCommand({
  name: 'who',
  pkg: 'coreutils',
  size: 51272,
  doc: { category: 'system', summary: 'show who is logged on', synopsis: ['who [OPTION]... [ FILE | ARG1 ARG2 ]'], description: 'Print information about users who are currently logged in.', examples: [{ cmd: 'who', desc: 'Who is using this computer?' }, { cmd: 'who am i', desc: 'Just your own login.' }], seeAlso: ['w', 'whoami'] },
  run: async (ctx) => {
    const login = ctx.system.bootTime + 4 * 60000;
    await ctx.out(`learner  pts/0        ${strftime('%Y-%m-%d %H:%M', login)} (10.0.2.2)\n`);
    return 0;
  },
});

defineCommand({
  name: 'users',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'system', summary: 'print the user names of users currently logged in to the current host', synopsis: ['users [OPTION]... [FILE]'], description: 'Output who is currently logged in.' },
  run: async (ctx) => {
    await ctx.out('learner\n');
    return 0;
  },
});

defineCommand({
  name: 'w',
  pkg: 'procps',
  size: 22760,
  doc: { category: 'system', summary: 'Show who is logged on and what they are doing.', synopsis: ['w [options] [user]'], description: 'w displays information about the users currently on the machine, and their processes.', seeAlso: ['who', 'uptime'] },
  run: async (ctx) => {
    const now = ctx.system.now();
    const login = ctx.system.bootTime + 4 * 60000;
    await ctx.out(` ${strftime('%H:%M:%S', now)} up ${uptimeText(now - ctx.system.bootTime)},  1 user,  load average: 0.08, 0.03, 0.01\nUSER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU  WHAT\nlearner  pts/0    10.0.2.2         ${strftime('%H:%M', login)}    0.00s  0.04s  0.00s w\n`);
    return 0;
  },
});

defineCommand({
  name: 'nproc',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'system', summary: 'print the number of processing units available', synopsis: ['nproc [OPTION]...'], description: 'Print the number of processing units available to the current process.' },
  run: async (ctx) => {
    await ctx.out('2\n');
    return 0;
  },
});

defineCommand({
  name: 'arch',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'system', summary: 'print machine hardware name (same as uname -m)', synopsis: ['arch [OPTION]...'], description: 'Print machine architecture.' },
  run: async (ctx) => {
    await ctx.out('x86_64\n');
    return 0;
  },
});

defineCommand({
  name: 'free',
  pkg: 'procps',
  size: 22760,
  doc: { category: 'system', summary: 'Display amount of free and used memory in the system', synopsis: ['free [options]'], description: 'free displays the total amount of free and used physical and swap memory in the system, as well as the buffers and caches used by the kernel.', options: [{ flags: '-h, --human', desc: 'Show all output fields automatically scaled to shortest three digit unit.' }, { flags: '-m, --mebi', desc: 'Display the amount of memory in mebibytes.' }], examples: [{ cmd: 'free -h', desc: 'How much memory is in use?' }], seeAlso: ['top', 'df'] },
  run: async (ctx) => {
    const kb = { total: 4022980, used: 1011204, free: 1825104, shared: 25308, cache: 1311484, avail: 3011776, stotal: 2097148, sused: 0, sfree: 2097148 };
    const human = ctx.args.some((a) => /^-[a-z]*h/.test(a) || a === '--human');
    const mega = ctx.args.includes('-m');
    const giga = ctx.args.includes('-g');
    const f = (n: number) => {
      if (human) {
        const units = ['Ki', 'Mi', 'Gi', 'Ti'];
        let v = n;
        let u = 0;
        while (v >= 1024 && u < units.length - 1) {
          v /= 1024;
          u++;
        }
        return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + units[u];
      }
      if (mega) return String(Math.floor(n / 1024));
      if (giga) return String(Math.floor(n / 1048576));
      return String(n);
    };
    const w = 12;
    let out = `${''.padStart(15)}${'total'.padStart(w)}${'used'.padStart(w)}${'free'.padStart(w)}${'shared'.padStart(w)}${'buff/cache'.padStart(w)}${'available'.padStart(w)}\n`;
    out += `Mem:${''.padStart(11)}${f(kb.total).padStart(w)}${f(kb.used).padStart(w)}${f(kb.free).padStart(w)}${f(kb.shared).padStart(w)}${f(kb.cache).padStart(w)}${f(kb.avail).padStart(w)}\n`;
    out += `Swap:${''.padStart(10)}${f(kb.stotal).padStart(w)}${f(kb.sused).padStart(w)}${f(kb.sfree).padStart(w)}\n`;
    await ctx.out(out);
    return 0;
  },
});

// ---------------------------------------------------------------------------
// processes

interface PsRow {
  pid: number;
  ppid: number;
  user: string;
  uid: number;
  tty: string;
  stat: string;
  start: number;
  cmd: string;
  comm: string;
  vsz: number;
  rss: number;
  cpu: number;
  time: string;
}

export function processRows(ctx: CommandContext, shellPid?: number): PsRow[] {
  const sys = ctx.system;
  const rows: PsRow[] = [];
  for (const sp of sys.processes.staticProcs) {
    rows.push({
      pid: sp.pid,
      ppid: sp.ppid,
      user: sp.user,
      uid: sys.userByName(sp.user)?.uid ?? 0,
      tty: sp.tty ?? '?',
      stat: sp.stat,
      start: sp.start,
      cmd: sp.command,
      comm: basename(sp.command.split(' ')[0].replace(/^\[|\]$/g, '')) || sp.command,
      vsz: sp.vsz,
      rss: sp.rss,
      cpu: 0,
      time: '00:00:00',
    });
  }
  if (shellPid !== undefined && !rows.some((r) => r.pid === shellPid)) {
    rows.push({ pid: shellPid, ppid: shellPid - 1, user: sys.userName(1000), uid: 1000, tty: 'pts/0', stat: 'Ss', start: sys.bootTime + 4 * 60000, cmd: '-bash', comm: 'bash', vsz: 11204, rss: 5248, cpu: 0, time: '00:00:00' });
  }
  for (const p of sys.processes.list()) {
    const name = basename(p.argv[0] ?? '?');
    rows.push({
      pid: p.pid,
      ppid: p.ppid,
      user: sys.userName(p.uid),
      uid: p.uid,
      tty: p.tty ?? '?',
      stat: p.pid === ctx.proc.pid ? 'R+' : p.state === 'T' ? 'T' : p.job.background ? 'S' : 'S+',
      start: p.startTime,
      cmd: p.argv.join(' '),
      comm: name,
      vsz: 5800 + ((name.length * 977) % 8000),
      rss: 1800 + ((name.length * 331) % 3000),
      cpu: 0,
      time: '00:00:00',
    });
  }
  return rows.sort((a, b) => a.pid - b.pid);
}

function psStart(t: number, now: number): string {
  if (now - t < 86400000) return strftime('%H:%M', t);
  return strftime('%b%d', t);
}

defineCommand({
  name: 'ps',
  pkg: 'procps',
  size: 137688,
  doc: {
    category: 'processes',
    summary: 'report a snapshot of the current processes',
    synopsis: ['ps [options]'],
    description: 'ps displays information about a selection of the active processes. By default it shows the processes started from your current terminal. ps aux and ps -ef show every process on the system.',
    options: [
      { flags: 'aux', desc: 'BSD style: every process, with user and resource usage' },
      { flags: '-e, -A', desc: 'Select all processes.' },
      { flags: '-f', desc: 'Do full-format listing (UID, PID, PPID, start time, command).' },
      { flags: '-u userlist', desc: 'Select by effective user ID or name.' },
      { flags: '-p pidlist', desc: 'Select by process ID.' },
      { flags: '-o format', desc: 'User-defined format, e.g. -o pid,user,cmd' },
    ],
    examples: [
      { cmd: 'ps', desc: 'Processes in this terminal.' },
      { cmd: 'ps aux', desc: 'Every process on the system.' },
      { cmd: 'ps aux | grep sleep', desc: 'Find a particular process.' },
    ],
    seeAlso: ['top', 'kill', 'pgrep'],
  },
  run: async (ctx) => {
    const args = ctx.args;
    const now = ctx.system.now();
    const shellPid = ctx.proc.ppid;
    const all = processRows(ctx, shellPid);
    let bsd = false;
    let showAll = false;
    let full = false;
    let users: string[] | null = null;
    let pids: number[] | null = null;
    let format: string[] | null = null;
    let xFlag = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!a.startsWith('-')) {
        bsd = true;
        if (a.includes('a')) showAll = true;
        if (a.includes('x')) xFlag = true;
        if (a.includes('u') && !a.includes('a') && !a.includes('x')) {
          /* "ps u" */
        }
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (c === 'e' || c === 'A') showAll = true;
        else if (c === 'f' || c === 'F') full = true;
        else if (c === 'u' || c === 'U') {
          users = (a.slice(j + 1) || args[++i] || '').split(',');
          break;
        } else if (c === 'p') {
          pids = (a.slice(j + 1) || args[++i] || '').split(',').map(Number);
          break;
        } else if (c === 'o') {
          format = (a.slice(j + 1) || args[++i] || '').split(',');
          break;
        } else if (c === 'l' || c === 'w' || c === 'H') {
          // accepted
        } else {
          await ctx.err(`error: unsupported option (BSD syntax)\n\nUsage:\n ps [options]\n\n Try 'ps --help <simple|list|output|threads|misc|all>'\n  or 'ps --help <s|l|o|t|m|a>'\n for additional help text.\n\nFor more details see ps(1).\n`);
          return 1;
        }
      }
    }
    let rows = all;
    if (pids) rows = rows.filter((r) => pids!.includes(r.pid));
    else if (users) rows = rows.filter((r) => users!.includes(r.user) || users!.includes(String(r.uid)));
    else if (!showAll && !(bsd && xFlag)) rows = rows.filter((r) => r.tty === 'pts/0');
    else if (bsd && xFlag && !showAll) rows = rows.filter((r) => r.uid === ctx.creds.uid);
    let out = '';
    if (format) {
      const cols = format.map((f) => f.trim()).filter(Boolean);
      const header: Record<string, string> = { pid: 'PID', ppid: 'PPID', user: 'USER', uid: 'UID', cmd: 'CMD', command: 'COMMAND', args: 'COMMAND', comm: 'COMMAND', '%cpu': '%CPU', '%mem': '%MEM', stat: 'STAT', tty: 'TT', time: 'TIME', etime: 'ELAPSED', rss: 'RSS', vsz: 'VSZ', start: 'STARTED' };
      const val = (r: PsRow, c: string): string => {
        switch (c) {
          case 'pid': return String(r.pid);
          case 'ppid': return String(r.ppid);
          case 'user': return r.user;
          case 'uid': return String(r.uid);
          case 'cmd':
          case 'command':
          case 'args': return r.cmd;
          case 'comm': return r.comm;
          case '%cpu': return r.cpu.toFixed(1);
          case '%mem': return ((r.rss / 4022980) * 100).toFixed(1);
          case 'stat': return r.stat;
          case 'tty': return r.tty;
          case 'time': return r.time;
          case 'etime': {
            const s = Math.floor((now - r.start) / 1000);
            return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
          }
          case 'rss': return String(r.rss);
          case 'vsz': return String(r.vsz);
          default: return '-';
        }
      };
      const table = [cols.map((c) => header[c.replace(/=.*/, '')] ?? c.toUpperCase()), ...rows.map((r) => cols.map((c) => val(r, c)))];
      const widths = cols.map((_, i) => Math.max(...table.map((row) => row[i].length)));
      for (const row of table) {
        out += row.map((cell, i) => (i === row.length - 1 ? cell : /^(pid|ppid|uid|rss|vsz|%cpu|%mem)$/.test(cols[i]) ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join(' ') + '\n';
      }
    } else if (bsd) {
      out += 'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n';
      for (const r of rows) {
        out += `${r.user.padEnd(8).slice(0, 8)} ${String(r.pid).padStart(7)} ${r.cpu.toFixed(1).padStart(4)} ${((r.rss / 4022980) * 100).toFixed(1).padStart(4)} ${String(r.vsz).padStart(6)} ${String(r.rss).padStart(5)} ${r.tty.padEnd(8)} ${r.stat.padEnd(4)} ${psStart(r.start, now).padEnd(5)}   0:00 ${r.cmd}\n`;
      }
    } else if (full) {
      out += 'UID          PID    PPID  C STIME TTY          TIME CMD\n';
      for (const r of rows) {
        out += `${r.user.padEnd(8).slice(0, 8)} ${String(r.pid).padStart(7)} ${String(r.ppid).padStart(7)}  0 ${psStart(r.start, now).padEnd(5)} ${r.tty.padEnd(8)} ${r.time} ${r.cmd}\n`;
      }
    } else {
      out += '    PID TTY          TIME CMD\n';
      for (const r of rows) out += `${String(r.pid).padStart(7)} ${r.tty.padEnd(8)} ${r.time} ${r.comm}\n`;
    }
    await ctx.out(out);
    return 0;
  },
});

async function signalPids(ctx: CommandContext, pids: number[], sig: SignalName): Promise<number> {
  let status = 0;
  const sys = ctx.system;
  for (const pid of pids) {
    const proc = sys.processes.get(pid);
    if (proc) {
      if (ctx.creds.uid !== 0 && proc.uid !== ctx.creds.uid) {
        await ctx.error(`(${pid}) - Operation not permitted`);
        status = 1;
        continue;
      }
      if (proc.job.leaderPid === pid && proc.job.background) proc.job.kill(sig);
      else proc.kill(sig);
      continue;
    }
    const sp = sys.processes.staticProcs.find((p) => p.pid === pid);
    if (sp) {
      if (ctx.creds.uid !== 0) {
        await ctx.error(`(${pid}) - Operation not permitted`);
        status = 1;
      }
      continue;
    }
    if (pid === ctx.proc.ppid) continue;
    await ctx.error(`(${pid}) - No such process`);
    status = 1;
  }
  return status;
}

defineCommand({
  name: 'kill',
  pkg: 'procps',
  size: 22760,
  doc: {
    category: 'processes',
    summary: 'send a signal to a process',
    synopsis: ['kill [options] <pid> [...]'],
    description: 'The default signal for kill is TERM, which politely asks a program to exit. Use -l or -L to list available signals. KILL (signal 9) cannot be ignored, so use it only when a program will not quit.\n\nNOTE: bash has a builtin kill, which also understands job numbers like %1.',
    options: [
      { flags: '-<signal>, -s <signal>', desc: 'Specify the signal to be sent, by name or number (e.g. -9, -KILL, -s TERM).' },
      { flags: '-l, --list [signal]', desc: 'List signal names.' },
    ],
    examples: [
      { cmd: 'kill 1234', desc: 'Ask process 1234 to exit.' },
      { cmd: 'kill -9 1234', desc: 'Force process 1234 to stop immediately.' },
      { cmd: 'kill %1', desc: 'Kill background job number 1 (bash builtin).' },
    ],
    seeAlso: ['ps', 'pkill', 'jobs'],
  },
  run: async (ctx) => {
    let args = ctx.args;
    if (args[0] === '-l' || args[0] === '-L' || args[0] === '--list') {
      await ctx.out(signalListing());
      return 0;
    }
    let sig: SignalName = 'SIGTERM';
    if (args[0] === '-s') {
      const s = parseSignalName(args[1] ?? '');
      if (!s) {
        await ctx.error(`unknown signal name ${q(args[1] ?? '')}`);
        return 1;
      }
      sig = s;
      args = args.slice(2);
    } else if (args[0]?.startsWith('-') && args[0] !== '--') {
      const s = parseSignalName(args[0].slice(1));
      if (!s) {
        await ctx.error(`unknown signal name ${q(args[0].slice(1))}`);
        return 1;
      }
      sig = s;
      args = args.slice(1);
    }
    if (args.length === 0) {
      await ctx.err('\nUsage:\n kill [options] <pid> [...]\n');
      return 1;
    }
    const pids: number[] = [];
    for (const a of args) {
      if (!/^-?\d+$/.test(a)) {
        await ctx.error(`failed to parse argument: ${q(a)}`);
        return 1;
      }
      pids.push(parseInt(a, 10));
    }
    return signalPids(ctx, pids, sig);
  },
});

async function pgrepLike(ctx: CommandContext, kill: boolean): Promise<number> {
  let sig: SignalName = 'SIGTERM';
  let full = false;
  let list = false;
  let user: string | null = null;
  let exact = false;
  let count = false;
  let pattern: string | null = null;
  const args = ctx.args;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '--full') full = true;
    else if (a === '-l' || a === '--list-name') list = true;
    else if (a === '-a' || a === '--list-full') list = full = true;
    else if (a === '-x' || a === '--exact') exact = true;
    else if (a === '-c' || a === '--count') count = true;
    else if (a === '-u') user = args[++i] ?? null;
    else if (kill && a.startsWith('-') && parseSignalName(a.slice(1))) sig = parseSignalName(a.slice(1))!;
    else if (a.startsWith('-')) {
      await ctx.error(`invalid option -- '${a.slice(1)}'`);
      return 2;
    } else pattern = a;
  }
  if (pattern === null) {
    await ctx.error('no matching criteria specified');
    await ctx.err(`Try \`${ctx.name} --help' for more information.\n`);
    return 2;
  }
  let re: RegExp;
  try {
    re = new RegExp(exact ? `^(?:${pattern})$` : pattern);
  } catch {
    await ctx.error(`invalid regular expression`);
    return 2;
  }
  const rows = processRows(ctx, ctx.proc.ppid).filter((r) => r.pid !== ctx.proc.pid && (!user || r.user === user) && re.test(full ? r.cmd : r.comm));
  if (rows.length === 0) return 1;
  if (kill) {
    const mine = rows.filter((r) => ctx.creds.uid === 0 || r.uid === ctx.creds.uid);
    if (mine.length < rows.length && mine.length === 0) {
      await ctx.error(`killing pid ${rows[0].pid} failed: Operation not permitted`);
      return 1;
    }
    await signalPids(ctx, mine.map((r) => r.pid), sig);
    return 0;
  }
  if (count) {
    await ctx.out(rows.length + '\n');
    return 0;
  }
  await ctx.out(rows.map((r) => (list ? `${r.pid} ${full ? r.cmd : r.comm}` : String(r.pid))).join('\n') + '\n');
  return 0;
}

defineCommand({
  name: 'pgrep',
  pkg: 'procps',
  size: 30960,
  doc: { category: 'processes', summary: 'look up processes based on name and other attributes', synopsis: ['pgrep [options] pattern'], description: 'pgrep looks through the currently running processes and lists the process IDs which match the selection criteria to stdout.', options: [{ flags: '-l, --list-name', desc: 'List the process name as well as the process ID.' }, { flags: '-f, --full', desc: 'The pattern is normally only matched against the process name. When -f is set, the full command line is used.' }, { flags: '-u euid,...', desc: 'Only match processes whose effective user ID is listed.' }], examples: [{ cmd: 'pgrep -l sleep', desc: 'Find running sleep commands.' }], seeAlso: ['ps', 'pkill'] },
  run: (ctx) => pgrepLike(ctx, false),
});

defineCommand({
  name: 'pkill',
  pkg: 'procps',
  size: 30960,
  doc: { category: 'processes', summary: 'signal processes based on name and other attributes', synopsis: ['pkill [options] pattern'], description: 'pkill sends a signal (TERM by default) to each process whose name matches the pattern.', options: [{ flags: '-<signal>', desc: 'Defines the signal to send to each matched process.' }, { flags: '-f, --full', desc: 'Match against the full command line.' }], examples: [{ cmd: 'pkill sleep', desc: 'Stop every sleep command.' }], seeAlso: ['kill', 'pgrep'] },
  run: (ctx) => pgrepLike(ctx, true),
});

defineCommand({
  name: 'pidof',
  pkg: 'procps',
  size: 14568,
  doc: { category: 'processes', summary: 'find the process ID of a running program', synopsis: ['pidof [options] program [...]'], description: 'Pidof finds the process id\'s (pids) of the named programs. It prints those id\'s on the standard output.' },
  run: async (ctx) => {
    const names = ctx.args.filter((a) => !a.startsWith('-'));
    const rows = processRows(ctx, ctx.proc.ppid).filter((r) => names.includes(r.comm));
    if (rows.length === 0) return 1;
    await ctx.out(rows.map((r) => r.pid).sort((a, b) => b - a).join(' ') + '\n');
    return 0;
  },
});

// ---------------------------------------------------------------------------
// shell-ish utilities

defineCommand({
  name: 'true',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'shell', summary: 'do nothing, successfully', synopsis: ['true [ignored command line arguments]'], description: 'Exit with a status code indicating success.' },
  gnu: false,
  run: async () => 0,
});

defineCommand({
  name: 'false',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'shell', summary: 'do nothing, unsuccessfully', synopsis: ['false [ignored command line arguments]'], description: 'Exit with a status code indicating failure.' },
  gnu: false,
  run: async () => 1,
});

async function externalTest(ctx: CommandContext, bracket: boolean): Promise<number> {
  let args = ctx.args;
  if (bracket) {
    if (args[args.length - 1] !== ']') {
      await ctx.error("missing ']'");
      return 2;
    }
    args = args.slice(0, -1);
  }
  const shim = { system: ctx.system, state: { isSet: (n: string) => ctx.env.has(n) }, opCtx: () => ({ cwd: ctx.cwd, creds: ctx.creds, umask: ctx.umask }) } as unknown as Shell;
  try {
    return evalTestArgs(shim, args) ? 0 : 1;
  } catch (e) {
    await ctx.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
}

defineCommand({
  name: 'test',
  pkg: 'coreutils',
  size: 43656,
  doc: { category: 'shell', summary: 'check file types and compare values', synopsis: ['test EXPRESSION', '[ EXPRESSION ]'], description: 'Exit with the status determined by EXPRESSION. For example -f FILE is true if FILE exists and is a regular file, and STRING1 = STRING2 is true if the strings are equal.\n\nNOTE: bash has builtin versions of test and [ which are normally used instead.', seeAlso: ['expr'] },
  gnu: false,
  run: (ctx) => externalTest(ctx, false),
});

defineCommand({
  name: '[',
  pkg: 'coreutils',
  size: 51368,
  gnu: false,
  run: (ctx) => externalTest(ctx, true),
});

defineCommand({
  name: 'timeout',
  pkg: 'coreutils',
  size: 39432,
  doc: { category: 'processes', summary: 'run a command with a time limit', synopsis: ['timeout [OPTION] DURATION COMMAND [ARG]...'], description: 'Start COMMAND, and kill it if still running after DURATION. If the command times out, the exit status is 124.', options: [{ flags: '-s, --signal=SIGNAL', desc: "specify the signal to be sent on timeout; SIGNAL may be a name like 'HUP' or a number" }], examples: [{ cmd: 'timeout 3 yes', desc: 'Run yes for 3 seconds.' }], seeAlso: ['sleep', 'kill'] },
  run: async (ctx) => {
    let args = ctx.args;
    let sig: SignalName = 'SIGTERM';
    while (args[0]?.startsWith('-')) {
      if (args[0] === '-s' || args[0] === '--signal') {
        sig = parseSignalName(args[1] ?? '') ?? 'SIGTERM';
        args = args.slice(2);
      } else if (args[0].startsWith('--signal=')) {
        sig = parseSignalName(args[0].slice(9)) ?? 'SIGTERM';
        args = args.slice(1);
      } else args = args.slice(1);
    }
    if (args.length < 2) return missing(ctx);
    const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(args[0]);
    if (!m) {
      await ctx.error(`invalid time interval ${ql(args[0])}`);
      return 125;
    }
    const ms = parseFloat(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] ?? 1) * 1000;
    const sys = ctx.system;
    let timedOut = false;
    const before = new Set(sys.processes.list().map((p) => p.pid));
    const timer = setTimeout(() => {
      timedOut = true;
      for (const p of sys.processes.list()) if (!before.has(p.pid) && p.job === ctx.proc.job && p !== ctx.proc) p.kill(sig);
    }, ms);
    try {
      const status = await ctx.exec(args.slice(1));
      if (status === 127) await ctx.error(`failed to run command ${q(args[1])}: No such file or directory`);
      return timedOut ? 124 : status;
    } finally {
      clearTimeout(timer);
    }
  },
});

defineCommand({
  name: 'nohup',
  pkg: 'coreutils',
  size: 35464,
  doc: { category: 'processes', summary: 'run a command immune to hangups, with output to a non-tty', synopsis: ['nohup COMMAND [ARG]...'], description: "Run COMMAND, ignoring hangup signals, so it keeps running after you log out. If standard output is a terminal, output goes to 'nohup.out'.", examples: [{ cmd: 'nohup ./long-job.sh &', desc: 'Keep a job running after you close the terminal.' }], seeAlso: ['jobs', 'disown'] },
  run: async (ctx) => {
    if (ctx.args.length === 0) return missing(ctx);
    let stdout = undefined;
    if (ctx.stdout.isTTY) {
      await ctx.error("ignoring input and appending output to 'nohup.out'");
      const { FileOutput } = await import('../streams');
      const node = ctx.fs.vfs.openForWrite('nohup.out', ctx.fs.ctx, { append: true });
      if (node.type === 'file') stdout = new FileOutput(ctx.fs.vfs, node, ctx.fs.abs('nohup.out'));
    }
    ctx.onSignal('SIGHUP', () => {});
    const status = await ctx.exec(ctx.args, { stdout, stderr: stdout });
    if (status === 127) await ctx.error(`failed to run command ${q(ctx.args[0])}: No such file or directory`);
    return status;
  },
});

