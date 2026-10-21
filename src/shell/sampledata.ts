// Original sample content for the simulated computer (text files, logs, data).

export const WELCOME_TXT = `Welcome to your practice computer!

Everything here runs inside your web browser. Nothing you type can harm
your real computer, so experiment freely: create files, delete them, break
things, and start over whenever you like.

A few things to try:

  ls              list the files in the current folder
  cd Documents    move into the Documents folder
  cat welcome.txt show the contents of this file
  man ls          read the manual for the ls command (press q to quit)

Stuck? Press Ctrl+C to cancel whatever is running.
`;

export const NOTES_TXT = `Meeting notes - project kickoff
- Budget approved for the new website
- Sam will draft the homepage copy
- Priya is setting up the staging server
- Next check-in: Thursday at 10am
`;

export const TODO_TXT = `buy milk
call the dentist
water the plants
finish the terminal lessons
back up the laptop
`;

export const PANCAKES_TXT = `Fluffy Pancakes (serves 4)

Ingredients:
  2 cups flour
  2 tablespoons sugar
  1 tablespoon baking powder
  1 pinch salt
  2 eggs
  1 1/2 cups milk
  3 tablespoons melted butter

Steps:
  1. Whisk the dry ingredients together.
  2. In another bowl, beat the eggs with the milk and butter.
  3. Pour the wet mixture into the dry and stir until just combined.
  4. Cook on a hot buttered pan until bubbles form, then flip.
`;

export const GUACAMOLE_TXT = `Quick Guacamole

Ingredients:
  3 ripe avocados
  1 lime
  1 small onion
  1 tomato
  1 handful cilantro
  salt to taste

Mash the avocados, squeeze in the lime, chop and fold in everything else.
`;

export const STORY_TXT = `The Lighthouse Keeper's Cat

Chapter 1

Every evening at dusk, Marlo the cat climbed the one hundred and twelve
steps of the old lighthouse. Nobody had asked her to. Nobody had told her
that the lamp needed watching, or that ships still passed the rocky point
on foggy nights. She simply knew.

The keeper, a quiet man named Ferris, had stopped wondering about it years
ago. He would hear the soft thump of paws on the iron stairs, and a minute
later a gray shape would settle on the windowsill beside the great lens.

"Evening, Marlo," he would say.

Marlo would blink slowly, which Ferris understood to mean good evening,
and also, you are late with the oil.

Chapter 2

The storm arrived on a Tuesday. It came from the south, which storms rarely
did, and it brought a wind that rattled the windows in their frames. Ferris
lit the lamp early. Marlo was already at her post, ears flat, staring out
at the black water.

Somewhere out there a horn sounded, low and lost.

Chapter 3

By morning the sea was calm and gray, and a small fishing boat sat safely
in the harbor. Its captain walked up the hill to the lighthouse with a
basket of fresh fish.

"I would have hit the rocks," he said, "if your light had gone out."

Ferris looked at Marlo, who was washing one paw with great concentration.

"It never goes out," he said. "She makes sure of that."
`;

export const FRUIT_CSV = `date,fruit,quantity,price
2026-09-01,apple,12,0.50
2026-09-01,banana,30,0.25
2026-09-02,cherry,200,0.05
2026-09-02,apple,8,0.50
2026-09-03,mango,5,1.75
2026-09-03,banana,24,0.25
2026-09-04,apple,15,0.55
2026-09-04,grape,120,0.04
2026-09-05,mango,7,1.75
2026-09-05,banana,18,0.25
2026-09-06,cherry,150,0.06
2026-09-06,apple,10,0.55
`;

export const GRADES_CSV = `name,subject,score
Ava,math,91
Ben,math,78
Chloe,math,85
Ava,science,88
Ben,science,93
Chloe,science,79
Ava,history,72
Ben,history,81
Chloe,history,95
`;

export const CONFIG_JSON = `{
  "name": "my-website",
  "version": "1.2.0",
  "port": 8080,
  "debug": false,
  "features": ["search", "dark-mode", "newsletter"]
}
`;

export const HELLO_SH = `#!/bin/bash
# A tiny script: say hello to someone.
name=\${1:-world}
echo "Hello, $name!"
`;

export const BASHRC = `# ~/.bashrc: executed by bash(1) for non-login shells.

# If not running interactively, don't do anything
case $- in
    *i*) ;;
      *) return;;
esac

# don't put duplicate lines or lines starting with space in the history.
HISTCONTROL=ignoreboth

# for setting history length see HISTSIZE and HISTFILESIZE in bash(1)
HISTSIZE=1000
HISTFILESIZE=2000

# a colorful prompt: user@host:directory$
PS1='\\[\\e]0;\\u@\\h: \\w\\a\\]\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ '

# enable color support of ls and also add handy aliases
alias ls='ls --color=auto'
alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'

# some more ls aliases
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'

# Alias definitions.
# You may want to put all your additions into a separate file like
# ~/.bash_aliases, instead of adding them here directly.
if [ -f ~/.bash_aliases ]; then
    . ~/.bash_aliases
fi
`;

export const PROFILE = `# ~/.profile: executed by the command interpreter for login shells.
# This file is not read by bash(1), if ~/.bash_profile or ~/.bash_login
# exists.

# if running bash
if [ -n "$BASH_VERSION" ]; then
    # include .bashrc if it exists
    if [ -f "$HOME/.bashrc" ]; then
	. "$HOME/.bashrc"
    fi
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/bin" ] ; then
    PATH="$HOME/bin:$PATH"
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/.local/bin" ] ; then
    PATH="$HOME/.local/bin:$PATH"
fi
`;

export const BASH_LOGOUT = `# ~/.bash_logout: executed by bash(1) when login shell exits.

# when leaving the console clear the screen to increase privacy

if [ "$SHLVL" = 1 ]; then
    [ -x /usr/bin/clear_console ] && /usr/bin/clear_console -q
fi
`;

export const OS_RELEASE = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=noble
LOGO=ubuntu-logo
`;

export const HOSTS = (host: string) => `127.0.0.1 localhost
127.0.1.1 ${host}

# The following lines are desirable for IPv6 capable hosts
::1     ip6-localhost ip6-loopback
fe00::0 ip6-localnet
ff00::0 ip6-mcastprefix
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters
`;

export const SHELLS = `# /etc/shells: valid login shells
/bin/sh
/usr/bin/sh
/bin/bash
/usr/bin/bash
/bin/rbash
/usr/bin/rbash
/usr/bin/dash
`;

export const FSTAB = `# /etc/fstab: static file system information.
#
# <file system> <mount point>   <type>  <options>       <dump>  <pass>
/dev/sda1       /               ext4    errors=remount-ro 0       1
/dev/sda15      /boot/efi       vfat    umask=0077      0       1
/swap.img       none            swap    sw              0       0
`;

export const CRONTAB = `# /etc/crontab: system-wide crontab
# Unlike any other crontab you don't have to run the \`crontab'
# command to install the new version when you edit this file
# and files in /etc/cron.d. These files also have username fields,
# that none of the other crontabs do.

SHELL=/bin/sh
# You can also override PATH, but by default, newer versions inherit it from the environment
#PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

# Example of job definition:
# .---------------- minute (0 - 59)
# |  .------------- hour (0 - 23)
# |  |  .---------- day of month (1 - 31)
# |  |  |  .------- month (1 - 12) OR jan,feb,mar,apr ...
# |  |  |  |  .---- day of week (0 - 6) (Sunday=0 or 7) OR sun,mon,tue,wed,thu,fri,sat
# |  |  |  |  |
# *  *  *  *  * user-name command to be executed
17 *	* * *	root	cd / && run-parts --report /etc/cron.hourly
25 6	* * *	root	test -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.daily; }
47 6	* * 7	root	test -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.weekly; }
52 6	1 * *	root	test -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.monthly; }
`;

export const SOURCES = `Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;

export const SUDOERS = `#
# This file MUST be edited with the 'visudo' command as root.
#
Defaults	env_reset
Defaults	mail_badpass
Defaults	secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
Defaults	use_pty

# User privilege specification
root	ALL=(ALL:ALL) ALL

# Members of the admin group may gain root privileges
%admin ALL=(ALL) ALL

# Allow members of group sudo to execute any command
%sudo	ALL=(ALL:ALL) ALL
`;

export const INDEX_HTML = `<!DOCTYPE html>
<html>
  <head>
    <title>It works!</title>
  </head>
  <body>
    <h1>It works!</h1>
    <p>This is the default web page for this server.</p>
  </body>
</html>
`;

/** A deterministic pseudo-random generator so generated logs are stable. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
  };
}

function iso(t: number, us: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(us, 6)}+00:00`;
}

export function makeSyslog(now: number, host: string): string {
  const r = rng(42);
  const start = now - 26 * 3600 * 1000;
  const lines: string[] = [];
  const events: ((t: number, pid: number) => string)[] = [
    (_t, pid) => `CRON[${pid}]: (root) CMD (cd / && run-parts --report /etc/cron.hourly)`,
    (_t, pid) => `systemd[1]: Started session-${pid % 90}.scope - Session ${pid % 90} of User learner.`,
    () => `systemd[1]: Starting apt-daily.service - Daily apt download activities...`,
    () => `systemd[1]: apt-daily.service: Deactivated successfully.`,
    () => `systemd[1]: Finished apt-daily.service - Daily apt download activities.`,
    (_t, pid) => `systemd-resolved[${pid}]: Clock change detected. Flushing caches.`,
    () => `kernel: [UFW BLOCK] IN=eth0 OUT= SRC=198.51.100.23 DST=10.0.2.15 PROTO=TCP SPT=44321 DPT=23`,
    (_t, pid) => `rsyslogd[${pid}]: [origin software="rsyslogd"] rsyslogd was HUPed`,
    () => `systemd[1]: Starting logrotate.service - Rotate log files...`,
    () => `systemd[1]: logrotate.service: Deactivated successfully.`,
    (_t, pid) => `snapd[${pid}]: storehelpers.go:769: cannot refresh: snap has no updates available`,
    () => `kernel: e1000: eth0 NIC Link is Up 1000 Mbps Full Duplex, Flow Control: RX`,
    () => `systemd[1]: Starting systemd-tmpfiles-clean.service - Cleanup of Temporary Directories...`,
    () => `systemd[1]: systemd-tmpfiles-clean.service: Deactivated successfully.`,
    (_t, pid) => `NetworkManager[${pid}]: <info>  [${Math.floor(now / 1000)}.1234] dhcp4 (eth0): state changed new lease, address=10.0.2.15`,
    () => `kernel: Out of memory: Killed process 4242 (chrome) total-vm:4520112kB, anon-rss:1203300kB`,
    (_t, pid) => `cupsd[${pid}]: REQUEST localhost - - "POST / HTTP/1.1" 200 183 Renew-Subscription successful-ok`,
  ];
  let t = start;
  while (t < now - 60000) {
    t += Math.floor(r() * 9 * 60 * 1000) + 30000;
    const pid = 300 + Math.floor(r() * 4000);
    const ev = events[Math.floor(r() * events.length)];
    lines.push(`${iso(t, Math.floor(r() * 999999))} ${host} ${ev(t, pid)}`);
  }
  return lines.join('\n') + '\n';
}

export function makeAuthLog(now: number, host: string): string {
  const r = rng(7);
  const start = now - 30 * 3600 * 1000;
  const lines: string[] = [];
  const badUsers = ['admin', 'test', 'oracle', 'ubuntu', 'guest', 'postgres', 'pi'];
  const ips = ['203.0.113.45', '198.51.100.7', '192.0.2.88', '203.0.113.12'];
  let t = start;
  while (t < now - 60000) {
    t += Math.floor(r() * 20 * 60 * 1000) + 20000;
    const roll = r();
    const pid = 1000 + Math.floor(r() * 3000);
    let msg: string;
    if (roll < 0.45) {
      const u = badUsers[Math.floor(r() * badUsers.length)];
      const ip = ips[Math.floor(r() * ips.length)];
      msg = `sshd[${pid}]: Failed password for invalid user ${u} from ${ip} port ${40000 + Math.floor(r() * 20000)} ssh2`;
    } else if (roll < 0.55) {
      const ip = ips[Math.floor(r() * ips.length)];
      msg = `sshd[${pid}]: Failed password for root from ${ip} port ${40000 + Math.floor(r() * 20000)} ssh2`;
    } else if (roll < 0.7) {
      msg = `sshd[${pid}]: Accepted publickey for learner from 10.0.2.2 port ${50000 + Math.floor(r() * 9000)} ssh2: ED25519 SHA256:k3yF1ng3rPr1ntExampleOnly`;
    } else if (roll < 0.85) {
      const cmds = ['/usr/bin/apt update', '/usr/bin/apt upgrade', '/usr/bin/systemctl restart nginx', '/usr/bin/cat /var/log/syslog'];
      msg = `sudo:  learner : TTY=pts/0 ; PWD=/home/learner ; USER=root ; COMMAND=${cmds[Math.floor(r() * cmds.length)]}`;
    } else {
      msg = `systemd-logind[${pid % 900}]: New session ${Math.floor(r() * 90)} of user learner.`;
    }
    lines.push(`${iso(t, Math.floor(r() * 999999))} ${host} ${msg}`);
  }
  return lines.join('\n') + '\n';
}

export function makeAccessLog(now: number): string {
  const r = rng(99);
  const paths = ['/', '/index.html', '/about', '/contact', '/blog', '/blog/terminal-tips', '/images/logo.png', '/css/site.css', '/js/app.js', '/admin', '/wp-login.php', '/favicon.ico'];
  const agents = ['Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Safari/605.1.15', 'curl/8.5.0', 'Googlebot/2.1 (+http://www.google.com/bot.html)'];
  const ips = ['192.0.2.10', '192.0.2.44', '198.51.100.23', '203.0.113.9', '203.0.113.77', '198.51.100.150'];
  const lines: string[] = [];
  let t = now - 6 * 3600 * 1000;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let i = 0; i < 160; i++) {
    t += Math.floor(r() * 120 * 1000) + 1000;
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, '0');
    const ts = `${p(d.getUTCDate())}/${months[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
    const path = paths[Math.floor(r() * paths.length)];
    let status = 200;
    if (path === '/admin' || path === '/wp-login.php') status = r() < 0.7 ? 404 : 403;
    else if (r() < 0.06) status = 500;
    else if (r() < 0.1) status = 404;
    else if (r() < 0.15) status = 304;
    const size = status === 304 ? 0 : 200 + Math.floor(r() * 9000);
    const ip = ips[Math.floor(r() * ips.length)];
    const agent = agents[Math.floor(r() * agents.length)];
    lines.push(`${ip} - - [${ts}] "GET ${path} HTTP/1.1" ${status} ${size} "-" "${agent}"`);
  }
  return lines.join('\n') + '\n';
}
