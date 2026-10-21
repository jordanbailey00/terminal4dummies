import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../shell/commands';
import { _internals } from '../shell/commands/fun';
import type { System } from '../shell/system';
import { HeadlessTerminal, makeShell, makeSystem, run, settle, startSession, waitFor } from './harness';

const ROOT = { cwd: '/', creds: { uid: 0, gid: 0, groups: [0] }, umask: 0o022 };

/** Installable programs are not on disk until `apt install`; put the binaries in place. */
function install(sys: System): void {
  for (const c of ['tree', 'htop', 'figlet', 'neofetch']) sys.fs.writeFile(`/usr/bin/${c}`, { kind: 'native', command: c, size: 1 }, ROOT, { mode: 0o755 });
  for (const c of ['cowsay', 'cowthink', 'fortune', 'sl']) sys.fs.writeFile(`/usr/games/${c}`, { kind: 'native', command: c, size: 1 }, ROOT, { mode: 0o755 });
}

function shell() {
  const sh = makeShell();
  install(sh.system);
  return sh;
}

async function session(opts: { cols?: number; rows?: number; sys?: System } = {}) {
  const s = await startSession(opts);
  install(s.sys);
  return s;
}

const promptBack = (term: HeadlessTerminal) => () => /learner@sandbox:~\$\s*$/.test(term.allText());

/** The cell attributes at the first place `text` appears on screen (plus `offset` columns). */
function cellAt(term: HeadlessTerminal, text: string, offset = 0) {
  const buf = term.term.buffer.active;
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y)!;
    const x = line.translateToString(false).indexOf(text);
    if (x >= 0) return line.getCell(x + offset)!;
  }
  throw new Error(`"${text}" not on screen:\n${term.screen().join('\n')}`);
}

// ---------------------------------------------------------------------------

describe('tree', () => {
  const setup = async () => {
    const sh = shell();
    await run(sh, 'mkdir -p proj/src/lib proj/docs proj/empty && touch proj/README.md proj/src/main.c proj/src/lib/util.c proj/docs/guide.txt proj/.hidden && chmod +x proj/src/main.c && ln -s src proj/link');
    return sh;
  };

  it('draws the classic tree with a report', async () => {
    const sh = await setup();
    const r = await run(sh, 'tree proj');
    expect(r.stdout).toBe(
      'proj\n' +
        '├── docs\n' +
        '│   └── guide.txt\n' +
        '├── empty\n' +
        '├── link -> src\n' +
        '├── README.md\n' +
        '└── src\n' +
        '    ├── lib\n' +
        '    │   └── util.c\n' +
        '    └── main.c\n' +
        '\n' +
        '5 directories, 4 files\n',
    );
    expect(r.status).toBe(0);
  });

  it('uses singular words in the report', async () => {
    const sh = shell();
    await run(sh, 'mkdir -p one/d && touch one/f');
    expect((await run(sh, 'tree one')).stdout).toBe('one\n├── d\n└── f\n\n1 directory, 1 file\n');
    expect((await run(sh, 'tree -d one')).stdout).toBe('one\n└── d\n\n1 directory\n');
  });

  it('lists the current directory by default and sorts like ls', async () => {
    const sh = shell();
    const r = await run(sh, 'tree -L 1');
    expect(r.stdout.split('\n').slice(0, 4)).toEqual(['.', '├── Desktop', '├── Documents', '├── Downloads']);
    expect(r.stdout).toContain('└── welcome.txt\n\n8 directories, 1 file\n');
  });

  it('-a, -d, -L, -f, -i, -F, --dirsfirst, --noreport', async () => {
    const sh = await setup();
    expect((await run(sh, 'tree -a -L 1 proj')).stdout).toBe('proj\n├── docs\n├── empty\n├── .hidden\n├── link -> src\n├── README.md\n└── src\n\n4 directories, 2 files\n');
    expect((await run(sh, 'tree -d proj')).stdout).toBe('proj\n├── docs\n├── empty\n├── link -> src\n└── src\n    └── lib\n\n5 directories\n');
    expect((await run(sh, 'tree -fi --noreport proj/src')).stdout).toBe('proj/src\nproj/src/lib\nproj/src/lib/util.c\nproj/src/main.c\n');
    expect((await run(sh, 'tree -F -L 1 proj')).stdout).toBe('proj/\n├── docs/\n├── empty/\n├── link -> src/\n├── README.md\n└── src/\n\n4 directories, 1 file\n');
    expect((await run(sh, 'tree -F proj/src')).stdout).toContain('└── main.c*\n');
    expect((await run(sh, 'tree --dirsfirst -L 1 --noreport proj')).stdout).toBe('proj\n├── docs\n├── empty\n├── link -> src\n├── src\n└── README.md\n');
  });

  it('-I and -P patterns, --prune', async () => {
    const sh = await setup();
    expect((await run(sh, "tree -I 'lib|empty|link' proj")).stdout).toBe('proj\n├── docs\n│   └── guide.txt\n├── README.md\n└── src\n    └── main.c\n\n2 directories, 3 files\n');
    expect((await run(sh, "tree -P '*.c' --prune proj")).stdout).toBe('proj\n└── src\n    ├── lib\n    │   └── util.c\n    └── main.c\n\n2 directories, 2 files\n');
    expect((await run(sh, "tree -P '*.txt' --noreport proj/docs")).stdout).toBe('proj/docs\n└── guide.txt\n');
  });

  it('meta-data: -p -u -g -s -h -D', async () => {
    const sh = await setup();
    const r = await run(sh, 'tree -pugs proj/docs');
    expect(r.stdout).toBe('[drwxrwxr-x learner  learner         4096]  proj/docs\n└── [-rw-rw-r-- learner  learner            0]  guide.txt\n\n0 directories, 1 file\n');
    expect((await run(sh, 'tree -h --noreport proj/docs')).stdout).toBe('[4.0K]  proj/docs\n└── [   0]  guide.txt\n');
    expect((await run(sh, 'tree -D --noreport proj/docs')).stdout).toMatch(/^\[\w{3} [ \d]\d \d\d:\d\d\]  proj\/docs\n└── \[\w{3} [ \d]\d \d\d:\d\d\]  guide.txt\n$/);
  });

  it('JSON output (-J)', async () => {
    const sh = await setup();
    const r = await run(sh, 'tree -J proj/src');
    expect(r.stdout).toBe(
      '[\n' +
        '  {"type":"directory","name":"proj/src","contents":[\n' +
        '    {"type":"directory","name":"lib","contents":[\n' +
        '      {"type":"file","name":"util.c"}\n' +
        '    ]},\n' +
        '    {"type":"file","name":"main.c"}\n' +
        '  ]}\n' +
        ',\n' +
        '  {"type":"report","directories":1,"files":2}\n' +
        ']\n',
    );
    expect(() => JSON.parse(r.stdout.replace('\n,\n', ',\n'))).not.toThrow();
  });

  it('colors with -C, plain with -n, ASCII lines in the C locale', async () => {
    const sh = await setup();
    const c = await run(sh, 'tree -C -L 1 --noreport proj');
    expect(c.stdout).toContain('├── \x1b[01;34mdocs\x1b[00m\n');
    expect(c.stdout).toContain('├── \x1b[01;36mlink\x1b[00m -> \x1b[01;34msrc\x1b[00m\n');
    expect(c.stdout.startsWith('\x1b[01;34mproj\x1b[00m\n')).toBe(true);
    expect((await run(sh, 'tree -n -L 1 proj')).stdout).not.toContain('\x1b');
    // Not a terminal: no colors by default.
    expect((await run(sh, 'tree proj')).stdout).not.toContain('\x1b');
    expect((await run(sh, 'LANG=C tree proj/src')).stdout).toBe('proj/src\n|-- lib\n|   `-- util.c\n`-- main.c\n\n1 directory, 2 files\n');
  });

  it('reports errors like tree', async () => {
    const sh = await setup();
    const r = await run(sh, 'tree nodir');
    expect(r.stdout).toBe('nodir  [error opening dir]\n\n0 directories, 0 files\n');
    expect(r.status).toBe(2);
    await run(sh, 'mkdir proj/secret && chmod 000 proj/secret');
    const denied = await run(sh, 'tree proj');
    expect(denied.stdout).toContain('├── secret  [error opening dir]\n');
    expect(denied.stdout).toContain('\n6 directories, 4 files\n');
    const bad = await run(sh, 'tree -z');
    expect(bad.stderr.split('\n')[0]).toBe("tree: Invalid argument -`z'.");
    expect(bad.stderr).toContain('usage: tree');
    expect(bad.status).toBe(1);
    expect((await run(sh, 'tree -L')).stderr).toBe('tree: Missing argument to -L option.\n');
    expect((await run(sh, 'tree -L 0')).stderr).toBe('tree: Invalid level, must be greater than 0.\n');
    expect((await run(sh, 'tree --version')).stdout).toMatch(/^tree v2\.1\.1 /);
    expect((await run(sh, 'tree --help')).stdout).toContain('------- Listing options -------');
  });

  it('several directories share one report; -o writes a file', async () => {
    const sh = await setup();
    expect((await run(sh, 'tree proj/docs proj/src/lib')).stdout).toBe('proj/docs\n└── guide.txt\nproj/src/lib\n└── util.c\n\n0 directories, 2 files\n');
    await run(sh, 'tree -o out.txt proj/docs');
    expect((await run(sh, 'cat out.txt')).stdout).toBe('proj/docs\n└── guide.txt\n\n0 directories, 1 file\n');
  });

  it('--charset and -A choose the line drawing characters', async () => {
    const sh = await setup();
    expect((await run(sh, 'tree --charset=ascii --noreport proj/src')).stdout).toBe('proj/src\n|-- lib\n|   `-- util.c\n`-- main.c\n');
    expect((await run(sh, 'tree -A --noreport proj/src')).stdout).toBe('proj/src\n\x1b(0tqq \x1b(Blib\n\x1b(0x   mqq \x1b(Butil.c\n\x1b(0mqq \x1b(Bmain.c\n');
  });

  it('is colored like ls on the terminal', async () => {
    const { term, session: s } = await session();
    try {
      term.type('mkdir -p demo/sub && touch demo/file.txt && tree demo\r');
      await waitFor(() => term.allText().includes('1 directory, 1 file'));
      const cell = cellAt(term, '── sub', 3);
      expect(cell.isBold()).toBeTruthy();
      expect(cell.getFgColor()).toBe(4);
      expect(cellAt(term, '── file.txt', 3).getFgColor()).not.toBe(4);
    } finally {
      s.dispose();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------

describe('cowsay', () => {
  const COW = '        \\   ^__^\n         \\  (oo)\\_______\n            (__)\\       )\\/\\\n                ||----w |\n                ||     ||\n';

  it('says a one-line message', async () => {
    const r = await run(shell(), 'cowsay hello');
    expect(r.stdout).toBe(' _______ \n< hello >\n ------- \n' + COW);
  });

  it('wraps at 40 columns with / | \\ borders', async () => {
    const r = await run(shell(), 'cowsay The quick brown fox jumps over the lazy dog and keeps running far far away');
    expect(r.stdout).toBe(
      ' _________________________________________ \n' +
        '/ The quick brown fox jumps over the lazy \\\n' +
        '\\ dog and keeps running far far away      /\n' +
        ' ----------------------------------------- \n' +
        COW,
    );
    const three = await run(shell(), 'cowsay -W 12 one two three four five six');
    expect(three.stdout.split('\n').slice(0, 5)).toEqual([' ____________ ', '/ one two    \\', '| three four |', '\\ five six   /', ' ------------ ']);
  });

  it('cowthink uses round bubbles and o', async () => {
    const r = await run(shell(), 'cowthink -W 10 hmm let me think');
    expect(r.stdout.split('\n').slice(0, 7)).toEqual([' __________ ', '( hmm let  )', '( me think )', ' ---------- ', '        o   ^__^', '         o  (oo)\\_______', '            (__)\\       )\\/\\']);
  });

  it('reads standard input, keeps paragraphs, -n keeps the layout', async () => {
    const sh = shell();
    const r = await run(sh, 'cowsay', 'line one\nline two\n\nafter blank\n');
    expect(r.stdout.split('\n').slice(0, 5)).toEqual([' ___________________ ', '/ line one line two \\', '|                   |', '\\ after blank       /', ' ------------------- ']);
    const n = await run(sh, 'printf "a\\tb\\n  x\\n" | cowsay -n');
    expect(n.stdout.split('\n').slice(0, 4)).toEqual([' ___________ ', '/ a       b \\', '\\   x       /', ' ----------- ']);
    const empty = await run(sh, 'printf "" | cowsay');
    expect(empty.stdout.split('\n').slice(0, 3)).toEqual([' _ ', '<   >', ' - ']);
  });

  it('eyes, tongue and the modes', async () => {
    const sh = shell();
    const face = async (args: string) => (await run(sh, `cowsay ${args} x`)).stdout.split('\n');
    expect((await face('-e ^^ -T U'))[4]).toBe('         \\  (^^)\\_______');
    expect((await face('-e ^^ -T U'))[6]).toBe('             U ||----w |');
    expect((await face('-T "U "'))[6]).toBe('             U  ||----w |');
    const modes: Record<string, string> = { b: '==', d: 'xx', g: '$$', p: '@@', s: '**', t: '--', w: 'OO', y: '..' };
    for (const [m, eyes] of Object.entries(modes)) expect((await face(`-${m}`))[4]).toBe(`         \\  (${eyes})\\_______`);
    expect((await face('-d'))[6]).toBe('             U  ||----w |');
  });

  it('other cows, -l and errors', async () => {
    const sh = shell();
    expect((await run(sh, 'cowsay -l')).stdout).toBe('Cow files in /usr/share/cowsay/cows:\nbunny default dragon kitty owl sheep turtle tux\n');
    const tux = await run(sh, 'cowsay -f tux Hi');
    expect(tux.stdout).toContain('( \\/ )');
    expect((await run(sh, 'cowthink -f dragon rawr')).stdout).toContain('( oo  )');
    const bad = await run(sh, 'cowsay -f nope hi');
    expect(bad.stderr).toBe('cowsay: Could not find nope cowfile!\n');
    expect(bad.status).toBe(1);
    const unknown = await run(sh, 'cowsay -z hi');
    expect(unknown.stderr).toBe('Unknown option: z\n');
    expect(unknown.stdout).toContain('< hi >');
    expect((await run(sh, 'cowsay -h')).stderr).toContain('Usage: cowsay [-bdgpstwy] [-h] [-e eyes] [-f cowfile]');
  });

  it('looks for cows on the COWPATH', async () => {
    const sh = shell();
    await run(sh, "mkdir mycows && printf '%s\\n' '$the_cow = <<\"EOC\";' '  $thoughts  \\\\o/' 'EOC' > mycows/cheer.cow");
    expect((await run(sh, 'COWPATH=/usr/share/cowsay/cows:mycows cowsay -l')).stdout).toBe('Cow files in /usr/share/cowsay/cows:\nbunny default dragon kitty owl sheep turtle tux\nCow files in mycows:\ncheer\n');
    expect((await run(sh, 'COWPATH=mycows cowsay -f cheer yay')).stdout).toBe(' _____ \n< yay >\n ----- \n  \\  \\o/\n');
    expect((await run(sh, 'cowsay -f /usr/share/cowsay/cows/tux.cow hi')).stdout).toContain('( \\/ )');
  });

  it('loads a cowfile from the disk', async () => {
    const sh = shell();
    await run(sh, "printf '%s\\n' '$the_cow = <<EOC;' ' $thoughts' '  ($eyes) moo' 'EOC' > my.cow");
    expect((await run(sh, 'cowsay -f ./my.cow -e Oo hey')).stdout).toBe(' _____ \n< hey >\n ----- \n \\\n  (Oo) moo\n');
  });
});

// ---------------------------------------------------------------------------

describe('fortune', () => {
  it('has plenty of short, well formatted fortunes', () => {
    const all = Object.values(_internals.FORTUNES).flat();
    expect(all.length).toBeGreaterThanOrEqual(60);
    expect(_internals.FORTUNES.tips.length).toBeGreaterThanOrEqual(30);
    for (const f of all) for (const line of f.split('\n')) expect(line.replace(/\t/g, '        ').length).toBeLessThanOrEqual(80);
  });

  it('prints one fortune', async () => {
    const r = await run(shell(), 'fortune');
    expect(r.status).toBe(0);
    const all = Object.values(_internals.FORTUNES).flat();
    expect(all).toContain(r.stdout.replace(/\n$/, ''));
  });

  it('-s and -l pick short and long ones', async () => {
    const sh = shell();
    for (let i = 0; i < 5; i++) {
      expect((await run(sh, 'fortune -s')).stdout.length).toBeLessThanOrEqual(161);
      expect((await run(sh, 'fortune -l')).stdout.length).toBeGreaterThan(160);
    }
  });

  it('-m, -c, -f and file names', async () => {
    const sh = shell();
    const m = await run(sh, "fortune -m 'empty prompt'");
    expect(m.stderr).toBe('(tips)\n%\n');
    expect(m.stdout).toBe('Type exit, or press Ctrl+D at an empty prompt, to close the shell.\n%\n');
    expect((await run(sh, 'fortune -c proverbs')).stdout).toMatch(/^\(proverbs\)\n%\n/);
    expect((await run(sh, 'fortune -f')).stderr).toMatch(/^100\.00% \/usr\/share\/games\/fortunes\n {4}[ \d]{2}\d\.\d\d% tips\n/);
    const none = await run(sh, 'fortune nosuchfile');
    expect(none.stderr).toContain('No fortunes found');
    expect(none.status).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('figlet', () => {
  it('renders with its own standard font', async () => {
    const r = await run(shell(), 'figlet Hi');
    expect(r.stdout).toBe(' _   _ _ \n| | | (_)\n| |_| | |\n|  _  | |\n|_| |_|_|\n         \n');
  });

  it('has a glyph for every printable ASCII character', () => {
    const font = _internals.builtins().get('standard')!;
    for (let c = 32; c < 127; c++) {
      const g = font.glyphs.get(String.fromCharCode(c));
      expect(g, String.fromCharCode(c)).toBeDefined();
      expect(g!.length).toBe(6);
      expect(new Set(g!.map((l) => l.length)).size).toBe(1);
    }
  });

  it('smushes letters together by default; -k and -W space them out', async () => {
    const sh = shell();
    const width = async (args: string) => Math.max(...(await run(sh, `figlet ${args} HELLO`)).stdout.split('\n').map((l) => l.length));
    const smushed = await width('');
    const kerned = await width('-k');
    const full = await width('-W');
    expect(smushed).toBeLessThan(kerned);
    expect(kerned).toBeLessThan(full);
  });

  it('wraps at -w and justifies with -c and -r', async () => {
    const sh = shell();
    const r = await run(sh, 'figlet -w 40 Hello World');
    const lines = r.stdout.split('\n').filter((l) => l !== '');
    expect(r.stdout.split('\n').length - 1).toBe(12);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(40);
    const c = await run(sh, 'figlet -c -w 40 Hi');
    expect(c.stdout.split('\n')[0]).toBe(' '.repeat(15) + ' _   _ _ ');
    const right = await run(sh, 'figlet -r -w 40 Hi');
    expect(right.stdout.split('\n')[0]).toBe(' '.repeat(30) + ' _   _ _ ');
  });

  it('other fonts: block, banner, term', async () => {
    const sh = shell();
    expect((await run(sh, 'figlet -f block HI')).stdout).toBe(
      '██      ██  ██████  \n██      ██    ██    \n██████████    ██    \n██      ██    ██    \n██      ██  ██████  \n                    \n',
    );
    expect((await run(sh, 'figlet -f banner ok')).stdout.split('\n')[0]).toBe(' ###  #   # ');
    expect((await run(sh, 'figlet -f term hello there')).stdout).toBe('hello there\n');
    const bad = await run(sh, 'figlet -f nope x');
    expect(bad.stderr).toBe('figlet: nope: Unable to open font file\n');
    expect(bad.status).toBe(1);
  });

  it('reads FIGlet 2 font files from the disk', async () => {
    const sh = shell();
    let flf = 'flf2a$ 2 1 4 -1 1\nA tiny test font\n';
    for (let c = 32; c < 127; c++) {
      const ch = c === 32 ? '$' : String.fromCharCode(c);
      const end = ch === '@' ? '#' : '@';
      flf += `${ch}${ch}${end}\n${ch}${ch}${end}${end}\n`;
    }
    sh.system.fs.writeFile('/home/learner/tiny.flf', flf, { cwd: '/', creds: { uid: 1000, gid: 1000, groups: [1000] }, umask: 0o002 });
    expect((await run(sh, 'figlet -f ./tiny.flf A@B')).stdout).toBe('AA@@BB\nAA@@BB\n');
    expect((await run(sh, 'figlet -d . -f tiny "A B"')).stdout).toBe('AA  BB\nAA  BB\n');
    await run(sh, 'echo nonsense > bad.flf');
    expect((await run(sh, 'figlet -f ./bad.flf x')).stderr).toBe('figlet: ./bad.flf: Not a FIGlet 2 font file\n');
  });

  it('reads standard input line by line, and -I info', async () => {
    const sh = shell();
    expect((await run(sh, 'echo Hi | figlet')).stdout).toBe((await run(sh, 'figlet Hi')).stdout);
    expect((await run(sh, 'figlet -I2')).stdout).toBe('/usr/share/figlet\n');
    expect((await run(sh, 'figlet -f block -I3')).stdout).toBe('block\n');
    expect((await run(sh, 'figlet -z')).stderr).toContain("figlet: invalid option -- 'z'\nUsage: figlet");
  });
});

// ---------------------------------------------------------------------------

describe('neofetch', () => {
  it('shows information that agrees with the rest of the system', async () => {
    const sh = shell();
    const r = await run(sh, 'neofetch --stdout');
    const kernel = (await run(sh, 'uname -r')).stdout.trim();
    const free = (await run(sh, 'free -m')).stdout.split('\n')[1].split(/\s+/);
    expect(r.stdout).toContain('learner@sandbox\n---------------\n');
    expect(r.stdout).toContain('OS: Ubuntu 24.04.1 LTS x86_64\n');
    expect(r.stdout).toContain(`Kernel: ${kernel}\n`);
    expect(r.stdout).toContain(`Memory: ${free[2]}MiB / ${free[1]}MiB\n`);
    expect(r.stdout).toContain('Uptime: 3 hours, 17 mins\n');
    expect(r.stdout).toContain('Shell: bash 5.2.21\n');
    expect(r.stdout).toMatch(/Packages: \d+ \(dpkg\)\n/);
    expect(r.stdout).toContain('CPU: 12th Gen Intel i7-1260P (2) @ 2.496GHz\n');
    expect(r.stdout).not.toContain('\x1b');
    for (const k of ['Host', 'Resolution', 'Terminal']) expect(r.stdout).toContain(`${k}: `);
  });

  it('--off hides the logo, -L shows only the logo', async () => {
    const sh = shell();
    const off = (await run(sh, 'neofetch --off')).stdout;
    expect(off.startsWith('learner@sandbox\n')).toBe(true);
    expect(off).not.toContain('╭');
    const logo = (await run(sh, 'neofetch -L')).stdout;
    expect(logo).toContain('╭');
    expect(logo).not.toContain('Kernel');
  });

  it('draws the logo and color blocks on a terminal', async () => {
    const { term, session: s } = await session({ cols: 90 });
    try {
      term.type('neofetch\r');
      await waitFor(() => term.allText().includes('Memory:'));
      const text = term.allText();
      expect(text).toMatch(/╭─+╮ {3}learner@sandbox/);
      expect(text).toContain('Terminal: /dev/pts/0');
      expect(cellAt(term, 'OS').isBold()).toBeTruthy();
    } finally {
      s.dispose();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------

describe('top', () => {
  it('batch mode prints the procps layout once', async () => {
    const sh = shell();
    const r = await run(sh, 'top -b -n 1');
    const lines = r.stdout.split('\n');
    const up = (await run(sh, 'uptime')).stdout.trim();
    expect(lines[0]).toBe('top - ' + up);
    expect(lines[0]).toMatch(/^top - \d\d:\d\d:\d\d up  3:17,  1 user,  load average: 0\.08, 0\.03, 0\.01$/);
    expect(lines[1]).toMatch(/^Tasks: {3}2 total, {3}1 running, {3}1 sleeping, {3}0 stopped, {3}0 zombie$/);
    expect(lines[2]).toMatch(/^%Cpu\(s\):[ \d]{2}\d\.\d us,[ \d]{2}\d\.\d sy, {2}0\.0 ni,[ \d]{2}\d\.\d id, {2}0\.0 wa, {2}0\.0 hi,[ \d]{2}\d\.\d si, {2}0\.0 st $/);
    expect(lines[3]).toBe('MiB Mem :   3928.7 total,   1782.3 free,    987.5 used,   1280.7 buff/cache     ');
    expect(lines[4]).toBe('MiB Swap:   2048.0 total,   2048.0 free,      0.0 used.   2941.2 avail Mem ');
    expect(lines[5]).toBe('');
    expect(lines[6]).toBe('    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND');
    expect(lines[7]).toMatch(/^ {3}\d{4} learner   20   0 +\d+ +\d+ +\d+ R +\d\.\d +\d\.\d +0:00\.\d\d top$/);
    expect(lines[8]).toMatch(/^ {3}\d{4} learner   20   0   11204   5248 +\d+ S   0\.0   0\.1   0:00\.\d\d bash$/);
    expect(lines.length).toBe(10);
  });

  it('batch options: -n, -p, -o, -c and errors', async () => {
    const sh = shell();
    const two = await run(sh, 'top -b -n 2 -d 0.1');
    expect(two.stdout.split('\n\ntop - ').length).toBe(2);
    const pid = (await run(sh, 'top -b -n 1')).stdout.split('\n')[8].trim().split(/\s+/)[0];
    const only = (await run(sh, `top -b -n 1 -p ${pid}`)).stdout.split('\n');
    expect(only[1]).toMatch(/^Tasks: {3}1 total, {3}0 running, {3}1 sleeping/);
    expect(only.slice(7).filter(Boolean).length).toBe(1);
    expect((await run(sh, 'top -b -n 1 -o %MEM')).stdout.split('\n')[7]).toMatch(/ bash$/);
    expect((await run(sh, 'top -b -n 1 -c')).stdout).toMatch(/ -bash\n/);
    expect((await run(sh, 'top -x')).stderr).toBe("top: invalid option -- 'x'\n");
    expect((await run(sh, 'top -b -d abc')).stderr).toBe("top: bad delay interval 'abc'\n");
    expect((await run(sh, 'top -b -u nosuchuser')).stderr).toBe('top: Invalid user\n');
    expect((await run(sh, 'top -b -o FOO')).stderr).toBe("top: unrecognized field name 'FOO'\n");
    expect((await run(sh, 'top -V')).stdout).toBe('top from procps-ng 4.0.4\n');
    expect((await run(sh, 'top -h')).stdout).toContain(' -b, --batch-mode                run in non-interactive batch mode');
  });

  it('prints one snapshot when the output is not a terminal', async () => {
    const r = await run(shell(), 'top | head -3');
    expect(r.stdout.split('\n')[0]).toMatch(/^top - /);
    expect(r.status).toBe(0);
  });

  it('runs full screen and quits with q, leaving the last screen', async () => {
    const { term, session: s } = await session();
    try {
      term.type('top\r');
      await waitFor(() => term.screen()[0].startsWith('top - '));
      const screen = term.screen();
      expect(screen[1]).toMatch(/^Tasks:/);
      expect(screen[6]).toBe('    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND');
      expect(cellAt(term, 'PID USER').isInverse()).toBeTruthy();
      expect(screen.some((l) => / top$/.test(l))).toBe(true);
      term.type('q');
      await waitFor(promptBack(term));
      // top does not use the alternate screen: its last frame stays visible.
      expect(term.screen()[0]).toMatch(/^top - /);
      expect(term.screen()[23]).toBe('learner@sandbox:~$');
    } finally {
      s.dispose();
    }
  }, 15000);

  it('-n 1 draws one frame and exits by itself', async () => {
    const { term, session: s } = await session();
    try {
      term.type('top -n 1\r');
      await waitFor(() => term.screen()[0].startsWith('top - '));
      await waitFor(promptBack(term));
      expect(term.screen()[0]).toMatch(/^top - /);
      expect(term.screen()[23]).toBe('learner@sandbox:~$');
    } finally {
      s.dispose();
    }
  }, 15000);

  it('quits with Ctrl+C (exit status 0) and shows help with h', async () => {
    const { term, session: s } = await session();
    try {
      term.type('top\r');
      await waitFor(() => term.screen()[0].startsWith('top - '));
      term.type('h');
      await waitFor(() => term.screen()[0].startsWith('Help for Interactive Commands'));
      term.type(' ');
      await waitFor(() => term.screen()[0].startsWith('top - '));
      term.type('\x03');
      await waitFor(promptBack(term));
      term.type('echo status=$?\r');
      await waitFor(() => term.allText().includes('status=0'));
    } finally {
      s.dispose();
    }
  }, 15000);

  it('k sends a signal to the chosen process; M and P change the sort', async () => {
    const { term, session: s } = await session();
    try {
      term.type('sleep 500 &\r');
      await waitFor(() => /\[1\] \d+/.test(term.allText()));
      const pid = /\[1\] (\d+)/.exec(term.allText())![1];
      term.type('top\r');
      await waitFor(() => term.screen().some((l) => l.endsWith(' sleep')));
      term.type('M');
      await waitFor(() => / bash$/.test(term.screen()[7]));
      term.type('P');
      await waitFor(() => / top$/.test(term.screen()[7]));
      term.type('k');
      await waitFor(() => /^PID to signal\/kill \[default pid = \d+\]/.test(term.screen()[5]));
      term.type(pid + '\r');
      await waitFor(() => term.screen()[5].startsWith(`Send pid ${pid} signal [15/sigterm]`));
      term.type('\r');
      await waitFor(() => !term.screen().some((l) => l.endsWith(' sleep')));
      term.type('k');
      await waitFor(() => term.screen()[5].startsWith('PID to signal/kill'));
      term.type('99999\r\r');
      await waitFor(() => term.screen()[5].includes("Failed signal pid '99999' with '15': No such process"));
      term.type('q');
      await waitFor(() => term.allText().includes('Terminated'));
    } finally {
      s.dispose();
    }
  }, 15000);

  it('Ctrl+Z suspends it and fg brings it back', async () => {
    const { term, session: s } = await session();
    try {
      term.type('top\r');
      await waitFor(() => term.screen()[0].startsWith('top - '));
      term.type('\x1a');
      await waitFor(() => term.allText().includes('[1]+  Stopped                 top'));
      await waitFor(promptBack(term));
      term.type('fg\r');
      await waitFor(() => term.screen()[0].startsWith('top - '));
      term.type('q');
      await waitFor(promptBack(term));
    } finally {
      s.dispose();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------

describe('htop', () => {
  it('draws meters, the process table and the function bar; F10 quits', async () => {
    const { term, session: s } = await session();
    try {
      term.type('htop\r');
      await waitFor(() => term.screen()[23].startsWith('F1Help'));
      const screen = term.screen();
      expect(screen[23]).toBe('F1Help  F2Setup F3SearchF4FilterF5Tree  F6SortByF7Nice -F8Nice +F9Kill  F10Quit');
      expect(screen[1]).toMatch(/^ {4}0\[\|+ +\d+\.\d%\] Tasks: \d+, 0 thr, 0 kthr; 1 running$/);
      expect(screen[2]).toMatch(/^ {4}1\[\|* +\d+\.\d%\] Load average: 0\.08 0\.03 0\.01$/);
      expect(screen[3]).toMatch(/^ {2}Mem\[\|+ 988M\/3\.84G\] Uptime: 03:17:\d\d$/);
      expect(screen[4]).toMatch(/^ {2}Swp\[ +0K\/2\.00G\]$/);
      expect(screen[6]).toBe('    PID USER       PRI  NI  VIRT   RES   SHR S  CPU%▽MEM%   TIME+  Command');
      expect(cellAt(term, 'PID USER').getBgColor()).toBe(2);
      expect(cellAt(term, 'F1').isInverse()).toBeFalsy();
      expect(cellAt(term, 'Help').getBgColor()).toBe(6);
      expect(cellAt(term, 'Tasks:').getFgColor()).toBe(6);
      term.type('\x1b[21~');
      await waitFor(promptBack(term));
      expect(term.allText()).not.toContain('F1Help');
    } finally {
      s.dispose();
    }
  }, 15000);

  it('arrow keys move the selection; F9 kills the selected process', async () => {
    const { term, session: s } = await session();
    try {
      term.type('sleep 400 &\r');
      await waitFor(() => /\[1\] \d+/.test(term.allText()));
      term.type('htop\r');
      await waitFor(() => term.screen().some((l) => l.endsWith('sleep 400')));
      const row = () => term.screen().findIndex((l) => l.endsWith('sleep 400'));
      const sel = () => term.screen().findIndex((_, y) => y > 6 && term.term.buffer.active.getLine(term.term.buffer.active.viewportY + y)!.getCell(2)!.getBgColor() === 6);
      expect(sel()).toBe(7);
      while (sel() !== row()) {
        const before = sel();
        term.type('\x1b[B');
        await waitFor(() => sel() !== before);
      }
      term.type('\x1b[20~');
      await waitFor(() => term.screen()[6].startsWith('Send signal:'));
      expect(term.screen().some((l) => l.startsWith('15 SIGTERM'))).toBe(true);
      expect(term.screen()[23]).toBe('EnterSend   EscCancel');
      term.type('\r');
      await waitFor(() => !term.screen().some((l) => l.includes('sleep 400')));
      term.type('q');
      await waitFor(promptBack(term));
      await waitFor(() => term.allText().includes('Terminated'));
    } finally {
      s.dispose();
    }
  }, 15000);

  it('F6 picks the sort column', async () => {
    const { term, session: s } = await session();
    try {
      term.type('htop\r');
      await waitFor(() => term.screen()[23].startsWith('F1Help'));
      term.type('\x1b[17~');
      await waitFor(() => term.screen()[6].startsWith('Sort by'));
      expect(term.screen()[23]).toBe('EnterSort   EscCancel');
      term.type('\x1b[H\r');
      await waitFor(() => term.screen()[6].startsWith('    PID△USER'));
      expect(term.screen()[7]).toMatch(/ -bash$/);
      term.type('q');
      await waitFor(promptBack(term));
    } finally {
      s.dispose();
    }
  }, 15000);

  it('tree view, help and search', async () => {
    const { term, session: s } = await session();
    try {
      term.type('htop\r');
      await waitFor(() => term.screen()[23].startsWith('F1Help'));
      term.type('t');
      await waitFor(() => term.screen().some((l) => l.endsWith('└─ htop')));
      expect(term.screen()[23]).toContain('F5List');
      term.type('\x1bOP');
      await waitFor(() => term.screen()[0].startsWith('htop 3.3.0'));
      term.type('x');
      await waitFor(() => term.screen()[23].startsWith('F1Help'));
      term.type('/bash');
      await waitFor(() => term.screen()[23].includes('Search: bash'));
      term.type('\r');
      term.type('q');
      await waitFor(promptBack(term));
    } finally {
      s.dispose();
    }
  }, 15000);

  it('prints a snapshot when not on a terminal; --version, --help', async () => {
    const sh = shell();
    const r = await run(sh, 'htop | cat');
    expect(r.stdout).toMatch(/Mem\[\|+ +988M\/3\.84G\]/);
    expect(r.stdout).toContain('PID USER       PRI  NI  VIRT   RES   SHR S  CPU%▽MEM%   TIME+  Command');
    expect(r.stdout).not.toContain('\x1b');
    expect((await run(sh, 'htop --version')).stdout).toBe('htop 3.3.0\n');
    expect((await run(sh, 'htop --help')).stdout).toContain('-t --tree');
    expect((await run(sh, 'htop -s nope')).stderr).toBe('Error: invalid column "nope".\n');
  });
});

// ---------------------------------------------------------------------------

describe('watch', () => {
  it('shows the header and the command output, Ctrl+C stops it', async () => {
    const { term, session: s } = await session();
    try {
      term.type('watch -n 0.2 echo hello\r');
      await waitFor(() => term.screen()[0].startsWith('Every 0.2s: echo hello'));
      await waitFor(() => term.screen()[2] === 'hello');
      expect(term.screen()[0]).toMatch(/^Every 0\.2s: echo hello {2,}sandbox: \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
      expect(term.screen()[0].length).toBe(80);
      expect(term.screen()[1]).toBe('');
      term.type('\x03');
      await waitFor(promptBack(term));
      expect(term.allText()).not.toContain('Every 0.2s');
      term.type('echo status=$?\r');
      await waitFor(() => term.allText().includes('status=0'));
    } finally {
      s.dispose();
    }
  }, 15000);

  it('-t hides the header and -d highlights changes', async () => {
    const { term, session: s } = await session();
    try {
      term.type("watch -t -d -n 0.1 'date +%N'\r");
      await waitFor(() => /^\d{9}$/.test(term.screen()[0]));
      const first = term.screen()[0];
      await waitFor(() => term.screen()[0] !== first && /^\d{9}$/.test(term.screen()[0]));
      const buf = term.term.buffer.active;
      const line = buf.getLine(buf.viewportY)!;
      let inverse = 0;
      for (let x = 0; x < 9; x++) if (line.getCell(x)!.isInverse()) inverse++;
      expect(inverse).toBeGreaterThan(0);
      term.type('\x03');
      await waitFor(promptBack(term));
    } finally {
      s.dispose();
    }
  }, 15000);

  it('options and errors', async () => {
    const sh = shell();
    const none = await run(sh, 'watch');
    expect(none.stderr).toContain('Usage:\n watch [options] command');
    expect(none.status).toBe(1);
    expect((await run(sh, 'watch -n abc date')).stderr).toBe("watch: failed to parse argument: 'abc': Invalid argument\n");
    expect((await run(sh, 'watch -v')).stdout).toBe('watch from procps-ng 4.0.4\n');
    // Without a terminal each update is printed in turn; -e stops at the first failure.
    const e = await run(sh, 'watch -e -n 0.1 "echo oops; false"');
    expect(e.status).toBe(8);
    expect(e.stdout).toMatch(/^Every 0\.1s: echo oops; false .*\n\noops\n$/);
  });
});

// ---------------------------------------------------------------------------

describe('sl', () => {
  it('prints the train when not on a terminal', async () => {
    const r = await run(shell(), 'sl | head -2');
    expect(r.stdout).toBe('      _______\n      \\_____/                    ____________\n');
  });

  it('drives across the screen, ignores Ctrl+C and ends by itself', async () => {
    const sys = makeSystem();
    const { term, session: s } = await session({ sys });
    try {
      term.type('sl\r');
      await waitFor(() => term.screen().some((l) => l.includes('@@@@@@')), 5000);
      term.type('\x03');
      const pos = term.screen().find((l) => l.includes('@@@@'))!.indexOf('@');
      await waitFor(() => {
        const l = term.screen().find((x) => x.includes('@@@@'));
        return !l || l.indexOf('@') !== pos;
      }, 5000);
      await waitFor(promptBack(term), 10000);
      term.type('echo status=$?\r');
      await waitFor(() => term.allText().includes('status=0'));
    } finally {
      s.dispose();
    }
  }, 15000);

  it('-e lets Ctrl+C stop it', async () => {
    const { term, session: s } = await session();
    try {
      term.type('sl -e\r');
      await waitFor(() => term.screen().some((l) => l.trim() !== '' && !l.includes('learner@')), 5000);
      term.type('\x03');
      await waitFor(promptBack(term), 3000);
      term.type('echo status=$?\r');
      await waitFor(() => term.allText().includes('status=130'));
    } finally {
      s.dispose();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------

describe('documentation', () => {
  it('every program has a beginner friendly doc', () => {
    for (const name of ['tree', 'top', 'htop', 'watch', 'cowsay', 'cowthink', 'fortune', 'sl', 'figlet', 'neofetch']) {
      const cmd = COMMANDS.find((c) => c.name === name);
      expect(cmd, name).toBeDefined();
      const d = cmd!.doc!;
      expect(d.summary.length, name).toBeGreaterThan(10);
      expect(d.synopsis.length, name).toBeGreaterThan(0);
      expect(d.description.length, name).toBeGreaterThan(80);
      expect(d.examples?.length ?? 0, name).toBeGreaterThan(1);
      expect(d.seeAlso?.length ?? 0, name).toBeGreaterThan(0);
      expect(['navigation', 'processes', 'fun']).toContain(d.category);
    }
    expect(COMMANDS.find((c) => c.name === 'cowsay')!.dir).toBe('/usr/games');
    expect(COMMANDS.find((c) => c.name === 'htop')!.pkg).toBe('htop');
  });

  it('--help works for the fun programs', async () => {
    const sh = shell();
    for (const c of ['cowsay', 'fortune', 'figlet', 'neofetch']) {
      const r = await run(sh, `${c} --help`);
      expect(r.stdout, c).toMatch(/^Usage: /);
      expect(r.status).toBe(0);
    }
    await settle(0);
  });
});
