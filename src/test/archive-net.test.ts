import { describe, expect, it } from 'vitest';
import { makeShell, makeSystem, run, startSession, waitFor } from './harness';
import type { System } from '../shell/system';
import { createLoginShell } from '../shell/session';
import { ROOT_CREDS } from '../shell/vfs/fs';
import { decodeBinaryStream, deflateSize, encodeBinaryStream, makeCompressedBlob } from '../shell/commands/archive';
import { SIMULATED_HOSTS, remoteSystem, resolveName } from '../shell/commands/net';

const ROOT = { cwd: '/', creds: ROOT_CREDS, umask: 0o022 };
const STAMP = String.raw`\d{4}-\d\d-\d\d \d\d:\d\d`;

function install(sys: System, name: string): void {
  sys.fs.writeFile(`/usr/bin/${name}`, { kind: 'native', command: name, size: 1 }, ROOT, { mode: 0o755 });
}

/** A fresh computer with zip/unzip installed and a small project directory. */
async function setup() {
  const sys = makeSystem();
  install(sys, 'zip');
  install(sys, 'unzip');
  const sh = makeShell(sys);
  await run(sh, 'mkdir -p proj/sub && echo "hello world" > proj/a.txt && seq 1 500 > proj/sub/nums.txt && touch proj/empty');
  return { sys, sh };
}

/** unzip's "%-22s" file name column. */
function unzipLine(verb: 'inflating' | 'extracting', name: string): string {
  return `${verb === 'inflating' ? '  inflating' : ' extracting'}: ${name.padEnd(22)}  \n`;
}

describe('compression size model', () => {
  it('estimates DEFLATE sizes close to real gzip', () => {
    const enc = new TextEncoder();
    let seq = '';
    for (let i = 1; i <= 2000; i++) seq += i + '\n';
    // real gzip -6 produces a 4200-byte deflate stream for `seq 1 2000`
    expect(Math.abs(deflateSize(enc.encode(seq)) - 4200)).toBeLessThan(4200 * 0.03);
    expect(deflateSize(enc.encode(''))).toBe(2);
    expect(deflateSize(enc.encode('hi\n'))).toBe(5);
    expect(deflateSize(enc.encode('y\n'.repeat(1000)))).toBeLessThan(30);
  });

  it('binary data survives a trip through a text stream', () => {
    const blob = makeCompressedBlob('gzip', 'some text\n', { name: 'x.txt', mtime: Date.UTC(2026, 0, 1) });
    const text = encodeBinaryStream(blob);
    expect(text).not.toContain('some text');
    expect(text).not.toContain('\n');
    expect(decodeBinaryStream(text)).toEqual(blob);
    expect(decodeBinaryStream('plain text')).toBeNull();
  });
});

describe('tar', () => {
  it('creates, lists and extracts archives', async () => {
    const { sh } = await setup();
    expect(await run(sh, 'tar -cvf proj.tar proj')).toEqual({ stdout: 'proj/\nproj/a.txt\nproj/empty\nproj/sub/\nproj/sub/nums.txt\n', stderr: '', status: 0 });
    expect((await run(sh, 'tar -tf proj.tar')).stdout).toBe('proj/\nproj/a.txt\nproj/empty\nproj/sub/\nproj/sub/nums.txt\n');
    const lines = (await run(sh, 'tar -tvf proj.tar')).stdout.split('\n');
    expect(lines[0]).toMatch(new RegExp(`^drwxrwxr-x learner/learner   0 ${STAMP} proj/$`));
    expect(lines[1]).toMatch(new RegExp(`^-rw-rw-r-- learner/learner  12 ${STAMP} proj/a\\.txt$`));
    // GNU tar widens the size column as it goes ("stairstepping")
    expect(lines[4]).toMatch(new RegExp(`^-rw-rw-r-- learner/learner 1892 ${STAMP} proj/sub/nums\\.txt$`));
    expect((await run(sh, 'stat -c %s proj.tar')).stdout).toBe('10240\n');
    expect((await run(sh, 'file proj.tar')).stdout).toBe('proj.tar: POSIX tar archive (GNU)\n');
    await run(sh, 'mkdir out');
    expect(await run(sh, 'tar -xvf proj.tar -C out')).toEqual({ stdout: 'proj/\nproj/a.txt\nproj/empty\nproj/sub/\nproj/sub/nums.txt\n', stderr: '', status: 0 });
    expect((await run(sh, 'cat out/proj/a.txt; wc -l < out/proj/sub/nums.txt; stat -c %a out/proj/sub')).stdout).toBe('hello world\n500\n775\n');
    expect((await run(sh, 'tar xf proj.tar -C out && echo old-style ok')).stdout).toBe('old-style ok\n');
  });

  it('compresses with -z/-j/-J and detects compression when reading a file', async () => {
    const { sh } = await setup();
    expect((await run(sh, 'tar -czf proj.tar.gz proj')).status).toBe(0);
    expect((await run(sh, 'file proj.tar.gz')).stdout).toBe('proj.tar.gz: gzip compressed data, from Unix, original size modulo 2^32 10240\n');
    // real GNU tar + gzip make 1161 bytes from this tree
    const size = Number((await run(sh, 'stat -c %s proj.tar.gz')).stdout);
    expect(size).toBeGreaterThan(1100);
    expect(size).toBeLessThan(1220);
    expect((await run(sh, 'tar -tf proj.tar.gz')).stdout).toContain('proj/sub/nums.txt\n');
    await run(sh, 'rm -r proj');
    expect((await run(sh, 'tar -xzf proj.tar.gz && cat proj/a.txt')).stdout).toBe('hello world\n');
    expect((await run(sh, 'tar -cjf p.tar.bz2 proj && file p.tar.bz2')).stdout).toBe('p.tar.bz2: bzip2 compressed data, block size = 900k\n');
    expect((await run(sh, 'tar -caf p.tar.xz proj && file p.tar.xz')).stdout).toBe('p.tar.xz: XZ compressed data, checksum CRC64\n');
    expect((await run(sh, 'tar -tJf p.tar.xz | head -1')).stdout).toBe('proj/\n');
  });

  it('works through pipes', async () => {
    const { sh } = await setup();
    expect((await run(sh, 'tar -czf - proj | tar -tzf -')).stdout).toBe('proj/\nproj/a.txt\nproj/empty\nproj/sub/\nproj/sub/nums.txt\n');
    // with the archive on stdout, -v goes to stderr
    expect((await run(sh, 'tar -cvf - proj | cat > /dev/null')).stderr).toBe('proj/\nproj/a.txt\nproj/empty\nproj/sub/\nproj/sub/nums.txt\n');
    expect((await run(sh, 'tar -cf - proj | gzip > p.tgz && file p.tgz && tar -tzf p.tgz | wc -l')).stdout).toBe('p.tgz: gzip compressed data, from Unix, original size modulo 2^32 10240\n5\n');
    expect(await run(sh, 'tar -czf - proj | tar -t')).toEqual({ stdout: '', stderr: 'tar: Archive is compressed. Use -z option\ntar: Error is not recoverable: exiting now\n', status: 2 });
    expect((await run(sh, 'tar -xOf p.tgz proj/a.txt')).stdout).toBe('hello world\n');
  });

  it('prints GNU tar error messages', async () => {
    const { sh } = await setup();
    const tryLine = "Try 'tar --help' or 'tar --usage' for more information.\n";
    expect(await run(sh, 'tar')).toEqual({ stdout: '', stderr: "tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\n" + tryLine, status: 2 });
    expect((await run(sh, 'tar -x -c')).stderr).toBe("tar: You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option\n" + tryLine);
    expect((await run(sh, 'tar -cf x.tar')).stderr).toBe('tar: Cowardly refusing to create an empty archive\n' + tryLine);
    expect(await run(sh, 'tar -cf x.tar nonexist')).toEqual({ stdout: '', stderr: 'tar: nonexist: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\n', status: 2 });
    expect((await run(sh, 'tar -xf nothere.tar')).stderr).toBe('tar: nothere.tar: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n');
    expect((await run(sh, 'tar -tf proj/a.txt')).stderr).toBe('tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors\n');
    await run(sh, 'tar -cf proj.tar proj');
    expect(await run(sh, 'tar -tzf proj.tar')).toEqual({ stdout: '', stderr: '\ngzip: stdin: not in gzip format\ntar: Child returned status 1\ntar: Error is not recoverable: exiting now\n', status: 2 });
    expect(await run(sh, 'tar -tf proj.tar nosuch')).toEqual({ stdout: '', stderr: 'tar: nosuch: Not found in archive\ntar: Exiting with failure status due to previous errors\n', status: 2 });
    expect((await run(sh, 'tar -tf proj.tar "proj/s*"')).stderr).toBe('tar: Pattern matching characters used in file names\ntar: Use --wildcards to enable pattern matching, or --no-wildcards to suppress this warning\ntar: proj/s*: Not found in archive\ntar: Exiting with failure status due to previous errors\n');
    expect((await run(sh, 'tar -tf proj.tar --wildcards "proj/s*"')).stdout).toBe('proj/sub/\nproj/sub/nums.txt\n');
    expect((await run(sh, 'tar -tf proj.tar proj/sub')).stdout).toBe('proj/sub/\nproj/sub/nums.txt\n');
    expect((await run(sh, 'tar xvf')).stderr).toBe("tar: Old option 'f' requires an argument.\n" + tryLine);
    expect((await run(sh, 'tar -q')).stderr).toBe("tar: invalid option -- 'q'\n" + tryLine);
    expect((await run(sh, 'tar --foo')).stderr).toBe("tar: unrecognized option '--foo'\n" + tryLine);
    expect((await run(sh, 'tar -cf')).stderr).toBe("tar: option requires an argument -- 'f'\n" + tryLine);
    expect((await run(sh, 'tar -xf proj.tar -C nodir')).stderr).toBe('tar: nodir: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n');
    expect((await run(sh, 'tar -cfv v.tar proj')).stderr).toBe('tar: v.tar: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\n');
  });

  it('strips leading slashes, refuses to archive itself and warns about misplaced options', async () => {
    const { sh } = await setup();
    const r = await run(sh, 'tar -cf abs.tar /etc/hostname && tar -tf abs.tar');
    expect(r.stderr).toBe("tar: Removing leading `/' from member names\n");
    expect(r.stdout).toBe('etc/hostname\n');
    const self = await run(sh, '(cd proj && tar -cvf self.tar .)');
    expect(self.stderr).toBe('tar: ./self.tar: archive cannot contain itself; not dumped\n');
    expect(self.stdout).toBe('./\n./a.txt\n./empty\n./sub/\n./sub/nums.txt\n');
    const pos = await run(sh, 'tar -cf y.tar proj -C /tmp');
    expect(pos.stderr).toBe('tar: The following options were used after non-option arguments.  These options are positional and affect only arguments that follow them.  Please, rearrange them properly.\ntar: -C ‘/tmp’ has no effect\ntar: Exiting with failure status due to previous errors\n');
    expect(pos.status).toBe(2);
    expect((await run(sh, 'tar -cf h.tar -C proj sub && tar -tf h.tar')).stdout).toBe('sub/\nsub/nums.txt\n');
  });

  it('supports --exclude, --strip-components, -k and -r', async () => {
    const { sh } = await setup();
    expect((await run(sh, 'tar -cf x.tar --exclude="*.txt" proj && tar -tf x.tar')).stdout).toBe('proj/\nproj/empty\nproj/sub/\n');
    await run(sh, 'tar -cf p.tar proj && mkdir s && tar -xf p.tar -C s --strip-components=1');
    expect((await run(sh, 'ls s')).stdout).toBe('a.txt\nempty\nsub\n');
    const k = await run(sh, 'tar -xkf p.tar');
    expect(k.stderr).toContain('tar: proj/a.txt: Cannot open: File exists\n');
    expect(k.status).toBe(2);
    await run(sh, 'echo extra > extra.txt && tar -rf p.tar extra.txt');
    expect((await run(sh, 'tar -tf p.tar | tail -1')).stdout).toBe('extra.txt\n');
    expect((await run(sh, 'tar -rzf p.tar extra.txt')).stderr).toBe("tar: Cannot update compressed archives\nTry 'tar --help' or 'tar --usage' for more information.\n");
  });

  it('keeps symlinks, hard links and programs', async () => {
    const { sh } = await setup();
    await run(sh, 'ln -s a.txt proj/link && ln proj/a.txt proj/hard && cp /usr/bin/ls proj/myls');
    const l = (await run(sh, 'tar -cf l.tar proj && tar -tvf l.tar')).stdout;
    expect(l).toMatch(new RegExp(`hrw-rw-r-- learner/learner +0 ${STAMP} proj/hard link to proj/a\\.txt\n`));
    expect(l).toMatch(new RegExp(`lrwxrwxrwx learner/learner +0 ${STAMP} proj/link -> a\\.txt\n`));
    await run(sh, 'mkdir x && tar -xf l.tar -C x');
    expect((await run(sh, 'readlink x/proj/link; stat -c %h x/proj/a.txt; x/proj/myls x/proj/sub')).stdout).toBe('a.txt\n2\nnums.txt\n');
  });
});

describe('binary data through the shell', () => {
  it('survives cat, < redirection and > files', async () => {
    const { sh } = await setup();
    await run(sh, 'tar czf p.tgz proj');
    let r = await run(sh, 'cat p.tgz | tar tz');
    expect(r.stdout).toContain('proj/sub/nums.txt');
    r = await run(sh, 'cat p.tgz > copy.tgz; tar tzf copy.tgz; file copy.tgz');
    expect(r.stdout).toContain('proj/a.txt');
    expect(r.stdout).toContain('copy.tgz: gzip compressed data');
    await run(sh, 'gzip -k proj/a.txt');
    r = await run(sh, 'gunzip < proj/a.txt.gz; gunzip -c < proj/a.txt.gz | wc -c');
    expect(r.stdout).toBe('hello world\n12\n');
    r = await run(sh, 'tar czf - proj | tar tz | sort | head -2');
    expect(r.stdout).toBe('proj/\nproj/a.txt\n');
  });
});

describe('gzip, gunzip, zcat', () => {
  it('compresses in place and reports the ratio', async () => {
    const { sh } = await setup();
    await run(sh, 'cp proj/sub/nums.txt n.txt');
    expect((await run(sh, 'gzip -v n.txt')).stderr).toMatch(/^n\.txt:\t 5\d\.\d% -- replaced with n\.txt\.gz\n$/);
    expect((await run(sh, 'ls n.txt*')).stdout).toBe('n.txt.gz\n');
    expect((await run(sh, 'file n.txt.gz')).stdout).toMatch(/^n\.txt\.gz: gzip compressed data, was "n\.txt", last modified: \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}, from Unix, original size modulo 2\^32 1892\n$/);
    const l = (await run(sh, 'gzip -l n.txt.gz')).stdout.split('\n');
    expect(l[0]).toBe('         compressed        uncompressed  ratio uncompressed_name');
    expect(l[1]).toMatch(/^ {16}\d{3} {16}1892  5\d\.\d% n\.txt$/);
    expect((await run(sh, 'gzip -lv n.txt.gz')).stdout).toMatch(/^method  crc     date  time {11}compressed {8}uncompressed  ratio uncompressed_name\ndefla e9aabf73 \w{3} [ \d]\d \d\d:\d\d +\d+ +1892 +5\d\.\d% n\.txt\n$/);
    expect((await run(sh, 'gunzip -v n.txt.gz')).stderr).toMatch(/^n\.txt\.gz:\t 5\d\.\d% -- replaced with n\.txt\n$/);
    expect((await run(sh, 'wc -l < n.txt')).stdout).toBe('500\n');
  });

  it('keeps files with -k, refuses to overwrite and explains problems', async () => {
    const { sh } = await setup();
    expect((await run(sh, '(cd proj && gzip -k a.txt && ls)')).stdout).toBe('a.txt\na.txt.gz\nempty\nsub\n');
    expect(await run(sh, '(cd proj && gzip -k a.txt)')).toEqual({ stdout: '', stderr: 'gzip: a.txt.gz already exists;\tnot overwritten\n', status: 2 });
    expect((await run(sh, '(cd proj && gzip -fk a.txt)')).status).toBe(0);
    expect(await run(sh, 'gzip proj/a.txt.gz')).toEqual({ stdout: '', stderr: 'gzip: proj/a.txt.gz already has .gz suffix -- unchanged\n', status: 2 });
    expect(await run(sh, 'gzip nosuch')).toEqual({ stdout: '', stderr: 'gzip: nosuch: No such file or directory\n', status: 1 });
    expect(await run(sh, 'gzip -d proj/a.txt')).toEqual({ stdout: '', stderr: 'gzip: proj/a.txt: unknown suffix -- ignored\n', status: 2 });
    expect((await run(sh, 'gzip -d nosuch')).stderr).toBe('gzip: nosuch.gz: No such file or directory\n');
    expect(await run(sh, 'gzip proj')).toEqual({ stdout: '', stderr: 'gzip: proj is a directory -- ignored\n', status: 2 });
    expect(await run(sh, 'zcat proj/a.txt')).toEqual({ stdout: '', stderr: '\ngzip: proj/a.txt: not in gzip format\n', status: 1 });
    expect((await run(sh, 'gzip -x')).stderr).toBe("gzip: invalid option -- 'x'\nTry `gzip --help' for more information.\n");
    expect((await run(sh, 'gunzip proj/a.txt')).stderr).toBe('gzip: proj/a.txt: unknown suffix -- ignored\n');
  });

  it('works with -c, zcat, standard input and -r', async () => {
    const { sh } = await setup();
    const c = await run(sh, 'gzip -c proj/a.txt > a.gz && file a.gz && ls proj/a.txt');
    expect(c.stdout).toMatch(/^a\.gz: gzip compressed data, was "a\.txt", last modified: .*, from Unix, original size modulo 2\^32 12\nproj\/a\.txt\n$/);
    expect((await run(sh, 'zcat a.gz')).stdout).toBe('hello world\n');
    expect((await run(sh, 'gunzip -c a.gz')).stdout).toBe('hello world\n');
    expect((await run(sh, 'echo abc | gzip | gzip -d')).stdout).toBe('abc\n');
    expect((await run(sh, 'echo abc | gzip | gzip -l')).stdout).toBe('         compressed        uncompressed  ratio uncompressed_name\n                 24                   4 -50.0% stdout\n');
    expect((await run(sh, 'gzip -r proj && ls proj proj/sub')).stdout).toBe('proj:\na.txt.gz\nempty.gz\nsub\n\nproj/sub:\nnums.txt.gz\n');
    expect((await run(sh, 'gunzip -r proj && ls proj proj/sub')).stdout).toBe('proj:\na.txt\nempty\nsub\n\nproj/sub:\nnums.txt\n');
    expect((await run(sh, 'gzip -tv a.gz')).stderr).toBe('a.gz:\t OK\n');
  });
});

describe('zip and unzip', () => {
  it('zips directories recursively', async () => {
    const { sh } = await setup();
    expect(await run(sh, 'zip -r proj.zip proj')).toEqual({
      stdout: '  adding: proj/ (stored 0%)\n  adding: proj/a.txt (stored 0%)\n  adding: proj/empty (stored 0%)\n  adding: proj/sub/ (stored 0%)\n  adding: proj/sub/nums.txt (deflated 53%)\n',
      stderr: '',
      status: 0,
    });
    // real zip 3.0 makes a 1663-byte archive here
    expect(Math.abs(Number((await run(sh, 'stat -c %s proj.zip')).stdout) - 1663)).toBeLessThan(20);
    expect((await run(sh, 'file proj.zip')).stdout).toBe('proj.zip: Zip archive data, at least v1.0 to extract, compression method=store\n');
    expect((await run(sh, 'zip -r proj.zip proj')).stdout.split('\n')[0]).toBe('updating: proj/ (stored 0%)');
    // the classic mistake: no -r stores just the directory entry
    expect((await run(sh, 'zip only proj && ls only.zip')).stdout).toBe('  adding: proj/ (stored 0%)\nonly.zip\n');
    expect(await run(sh, 'zip x.zip nosuch')).toEqual({ stdout: '\tzip warning: name not matched: nosuch\n\nzip error: Nothing to do! (x.zip)\n', stderr: '', status: 12 });
    expect((await run(sh, 'zip -d proj.zip proj/empty')).stdout).toBe('deleting: proj/empty\n');
    expect((await run(sh, "zip -r t.zip proj -x '*.txt'")).stdout).toBe('  adding: proj/ (stored 0%)\n  adding: proj/empty (stored 0%)\n  adding: proj/sub/ (stored 0%)\n');
  });

  it('lists archives like unzip -l and -v', async () => {
    const { sh } = await setup();
    await run(sh, 'zip -qr proj.zip proj');
    const l = (await run(sh, 'unzip -l proj.zip')).stdout;
    expect(l).toMatch(new RegExp(String.raw`^Archive:  proj\.zip\n  Length      Date    Time    Name\n---------  ---------- -----   ----\n        0  ${STAMP}   proj/\n       12  ${STAMP}   proj/a\.txt\n`));
    expect(l).toMatch(/---------                     -------\n     1904                     5 files\n$/);
    const v = (await run(sh, 'unzip -v proj.zip')).stdout;
    expect(v).toContain(' Length   Method    Size  Cmpr    Date    Time   CRC-32   Name\n--------  ------  ------- ---- ---------- ----- --------  ----\n');
    expect(v).toMatch(new RegExp(String.raw`      12  Stored       12   0% ${STAMP} af083b2d  proj/a\.txt\n`));
    expect(v).toMatch(new RegExp(String.raw`    1892  Defl:N +\d+  5\d% ${STAMP} e9aabf73  proj/sub/nums\.txt\n`));
    expect((await run(sh, 'unzip -Z1 proj.zip')).stdout).toBe('proj/\nproj/a.txt\nproj/empty\nproj/sub/\nproj/sub/nums.txt\n');
    expect((await run(sh, 'unzip -t proj.zip')).stdout).toBe(`Archive:  proj.zip\n    testing: ${'proj/'.padEnd(22)}   OK\n    testing: ${'proj/a.txt'.padEnd(22)}   OK\n    testing: ${'proj/empty'.padEnd(22)}   OK\n    testing: ${'proj/sub/'.padEnd(22)}   OK\n    testing: ${'proj/sub/nums.txt'.padEnd(22)}   OK\nNo errors detected in compressed data of proj.zip.\n`);
  });

  it('extracts, asks before replacing and reports errors', async () => {
    const { sh } = await setup();
    await run(sh, 'zip -qr proj.zip proj');
    expect(await run(sh, 'unzip proj.zip -d out')).toEqual({
      stdout: 'Archive:  proj.zip\n   creating: out/proj/\n' + unzipLine('extracting', 'out/proj/a.txt') + unzipLine('extracting', 'out/proj/empty') + '   creating: out/proj/sub/\n' + unzipLine('inflating', 'out/proj/sub/nums.txt'),
      stderr: '',
      status: 0,
    });
    expect((await run(sh, 'cat out/proj/a.txt')).stdout).toBe('hello world\n');
    const prompt = (n: string) => `replace ${n}? [y]es, [n]o, [A]ll, [N]one, [r]ename: `;
    expect((await run(sh, 'unzip proj.zip', 'n\nA\n')).stdout).toBe('Archive:  proj.zip\n' + prompt('proj/a.txt') + prompt('proj/empty') + unzipLine('extracting', 'proj/empty') + unzipLine('inflating', 'proj/sub/nums.txt'));
    expect(await run(sh, 'unzip proj.zip')).toEqual({ stdout: 'Archive:  proj.zip\n' + prompt('proj/a.txt') + ' NULL\n(EOF or read error, treating as "[N]one" ...)\n', stderr: '', status: 1 });
    expect((await run(sh, 'unzip -o -q proj.zip && echo ok')).stdout).toBe('ok\n');
    expect((await run(sh, 'unzip -p proj.zip proj/a.txt')).stdout).toBe('hello world\n');
    expect(await run(sh, 'unzip nosuch.zip')).toEqual({ stdout: '', stderr: 'unzip:  cannot find or open nosuch.zip, nosuch.zip.zip or nosuch.zip.ZIP.\n', status: 9 });
    const bad = await run(sh, 'unzip -l proj/a.txt');
    expect(bad.stdout).toBe('Archive:  proj/a.txt\n');
    expect(bad.stderr).toContain('  End-of-central-directory signature not found.  Either this file is not\n');
    expect(bad.status).toBe(9);
    expect(await run(sh, 'unzip -o proj.zip nosuch')).toEqual({ stdout: 'Archive:  proj.zip\n', stderr: 'caution: filename not matched:  nosuch\n', status: 11 });
  });

  it('unzips an archive downloaded from the simulated internet', async () => {
    const { sh } = await setup();
    expect((await run(sh, 'curl -sO https://files.example.com/notes.zip && unzip -q notes.zip && cat notes/todo.txt')).stdout).toBe('water the plants\nreply to Sam\nlearn tar and zip\n');
  });
});

describe('the simulated internet', () => {
  it('uses documentation addresses and resolves through /etc/hosts first', async () => {
    const sys = makeSystem();
    for (const name of ['example.com', 'www.example.com', 'example.org', 'example.net', 'api.example.com', 'files.example.com', 'webserver', 'webserver.example.com']) {
      const host = SIMULATED_HOSTS.find((h) => h.names.includes(name));
      expect(host?.ip).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
    }
    expect(resolveName(sys, 'webserver')).toBe('192.0.2.10');
    expect(resolveName(sys, 'WebServer.Example.com')).toBe('192.0.2.10');
    expect(resolveName(sys, 'localhost')).toBe('127.0.0.1');
    expect(resolveName(sys, 'sandbox')).toBe('127.0.1.1');
    expect(resolveName(sys, 'nosuch.invalid')).toBeNull();
    sys.fs.writeFile('/etc/hosts', '192.0.2.10 myserver\n', ROOT, { append: true });
    expect(resolveName(sys, 'myserver')).toBe('192.0.2.10');
    expect((await run(makeShell(sys), 'ping -c 1 myserver')).stdout.split('\n')[0]).toBe('PING myserver (192.0.2.10) 56(84) bytes of data.');
  });
});

describe('curl', () => {
  it('prints pages and shows the progress meter when piped', async () => {
    const sh = makeShell();
    const r = await run(sh, 'curl https://example.com | grep h1');
    expect(r.stdout).toBe('    <h1>Example Domain</h1>\n');
    expect(r.stderr).toMatch(/^  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n {33}Dload  Upload   Total   Spent    Left  Speed\n\r  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\r100   \d{3}  100   \d{3}    0     0 +\d+      0 --:--:-- --:--:-- --:--:-- +\d+\n$/);
    expect((await run(sh, 'curl -s http://example.com')).stdout).toContain('<title>Example Domain</title>');
    expect((await run(sh, 'curl -s example.org | grep -c "Example Domain"')).stdout).toBe('2\n');
  });

  it('talks to the JSON API', async () => {
    const sh = makeShell();
    expect(JSON.parse((await run(sh, 'curl -s https://api.example.com/users/1')).stdout)).toEqual({ id: 1, name: 'Alice Moreno', username: 'alice', email: 'alice@example.com', city: 'Lisbon' });
    expect(JSON.parse((await run(sh, 'curl -s https://api.example.com/users')).stdout)).toHaveLength(5);
    const post = await run(sh, `curl -s -X POST -H "Content-Type: application/json" -d '{"name":"Sam"}' https://api.example.com/users`);
    expect(JSON.parse(post.stdout)).toEqual({ id: 6, name: 'Sam' });
    expect(JSON.parse((await run(sh, 'curl -s "https://api.example.com/weather?city=London"')).stdout)).toMatchObject({ city: 'London', temperature_c: 14 });
    expect(JSON.parse((await run(sh, 'curl -s -H "X-Demo: 1" https://api.example.com/headers')).stdout).headers).toMatchObject({ Host: 'api.example.com', 'User-Agent': 'curl/8.5.0', 'X-Demo': '1' });
    expect(JSON.parse((await run(sh, `curl -s --json '{"a":1}' https://api.example.com/echo`)).stdout)).toMatchObject({ method: 'POST', json: { a: 1 } });
    expect((await run(sh, 'curl -s -o /dev/null -w "%{http_code}\\n" https://api.example.com/users/99')).stdout).toBe('404\n');
  });

  it('shows headers with -I, -i and -v', async () => {
    const sh = makeShell();
    const h2 = (await run(sh, 'curl -sI https://example.com')).stdout;
    expect(h2.startsWith('HTTP/2 200 \r\ncontent-type: text/html; charset=UTF-8\r\n')).toBe(true);
    expect(h2.endsWith('\r\n\r\n')).toBe(true);
    const h1 = (await run(sh, 'curl -si http://api.example.com/users/9')).stdout;
    expect(h1).toMatch(/^HTTP\/1\.1 404 Not Found\r\nDate: .* GMT\r\nContent-Type: application\/json; charset=utf-8\r\n/);
    expect(h1).toContain('\r\n\r\n{\n  "error": "User 9 not found"\n}\n');
    const v = (await run(sh, 'curl -sv http://example.com -o /dev/null')).stderr;
    expect(v).toContain('* Host example.com:80 was resolved.\n* IPv6: (none)\n* IPv4: 203.0.113.80\n*   Trying 203.0.113.80:80...\n* Connected to example.com (203.0.113.80) port 80\n> GET / HTTP/1.1\r\n> Host: example.com\r\n> User-Agent: curl/8.5.0\r\n> Accept: */*\r\n> \r\n< HTTP/1.1 200 OK\r\n');
    expect(v).toMatch(/< \r\n\{ \[\d+ bytes data\]\n\* Connection #0 to host example\.com left intact\n$/);
  });

  it('saves files with -o and -O', async () => {
    const sh = makeShell();
    const o = await run(sh, 'curl -o page.html https://example.com && head -1 page.html');
    expect(o.stdout).toBe('<!doctype html>\n');
    expect(o.stderr).toContain('  % Total    % Received');
    expect((await run(sh, 'curl -sO https://files.example.com/hello.txt && head -1 hello.txt')).stdout).toBe('Hello from files.example.com!\n');
    expect((await run(sh, 'curl -sO https://files.example.com/project.tar.gz && file project.tar.gz && tar -tzf project.tar.gz | head -2')).stdout).toBe('project.tar.gz: gzip compressed data, from Unix, original size modulo 2^32 10240\nproject/\nproject/README.md\n');
    expect(await run(sh, 'curl -sO https://example.com/')).toEqual({ stdout: '', stderr: '', status: 23 });
    expect(await run(sh, 'curl -sS -o /nonexistent/x https://example.com')).toEqual({ stdout: '', stderr: 'Warning: Failed to open the file /nonexistent/x: No such file or directory\ncurl: (23) Failure writing output to destination\n', status: 23 });
  });

  it('follows redirects with -L and pipes binary data', async () => {
    const sh = makeShell();
    expect((await run(sh, 'curl -s https://files.example.com/latest')).stdout).toContain('<head><title>302 Found</title></head>');
    expect((await run(sh, 'curl -sL https://files.example.com/latest | tar -xzv')).stdout).toContain('project/install.sh\n');
    expect((await run(sh, 'tail -1 project/src/hello.sh')).stdout).toBe('echo "Hello, $USER!"\n');
    expect((await run(sh, 'curl -s https://files.example.com/data.csv | grep -c London')).stdout).toBe('3\n');
  });

  it("serves this computer's web root on localhost", async () => {
    const sys = makeSystem();
    const sh = makeShell(sys);
    expect((await run(sh, 'curl -s localhost')).stdout).toContain('<title>It works!</title>');
    sys.fs.writeFile('/var/www/html/hi.txt', 'hi there\n', ROOT);
    expect((await run(sh, 'curl -s http://127.0.0.1/hi.txt')).stdout).toBe('hi there\n');
    expect((await run(sh, 'curl -s -o /dev/null -w "%{http_code}" http://localhost/missing')).stdout).toBe('404');
    expect((await run(sh, 'curl -s http://localhost/missing')).stdout).toContain('<hr><center>nginx/1.24.0 (Ubuntu)</center>');
  });

  it('reports errors with curl exit codes', async () => {
    const sh = makeShell();
    const tryLine = "curl: try 'curl --help' or 'curl --manual' for more information\n";
    expect(await run(sh, 'curl -s https://nosuch.invalid')).toEqual({ stdout: '', stderr: '', status: 6 });
    expect((await run(sh, 'curl -sS https://nosuch.invalid')).stderr).toBe('curl: (6) Could not resolve host: nosuch.invalid\n');
    expect(await run(sh, 'curl -sSf https://api.example.com/nope')).toEqual({ stdout: '', stderr: 'curl: (22) The requested URL returned error: 404\n', status: 22 });
    expect(await run(sh, 'curl -sS http://localhost:8080')).toEqual({ stdout: '', stderr: "curl: (7) Failed to connect to localhost port 8080 after 0 ms: Couldn't connect to server\n", status: 7 });
    expect((await run(sh, 'curl -sS htp://example.com')).stderr).toBe('curl: (1) Protocol "htp" not supported or disabled in libcurl\n');
    expect((await run(sh, 'curl -sS http://')).stderr).toBe('curl: (3) URL rejected: No host part in the URL\n');
    expect(await run(sh, 'curl')).toEqual({ stdout: '', stderr: tryLine, status: 2 });
    expect(await run(sh, 'curl --foo')).toEqual({ stdout: '', stderr: 'curl: option --foo: is unknown\n' + tryLine, status: 2 });
    expect((await run(sh, 'curl -o')).stderr).toBe('curl: option -o: requires parameter\n' + tryLine);
  });
});

describe('wget', () => {
  it('downloads files and prints the full log', async () => {
    const sh = makeShell();
    const r = await run(sh, 'wget https://files.example.com/data.csv');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(
      new RegExp(
        String.raw`^--\d{4}-\d\d-\d\d \d\d:\d\d:\d\d--  https://files\.example\.com/data\.csv\n` +
          String.raw`Resolving files\.example\.com \(files\.example\.com\)\.\.\. 203\.0\.113\.30\n` +
          String.raw`Connecting to files\.example\.com \(files\.example\.com\)\|203\.0\.113\.30\|:443\.\.\. connected\.\n` +
          String.raw`HTTP request sent, awaiting response\.\.\. 200 OK\n` +
          String.raw`Length: 252 \[text/csv\]\n` +
          String.raw`Saving to: ‘data\.csv’\n\n` +
          String.raw` {5}0K {55}100% +[\d.]+M=0s\n\n` +
          String.raw`\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \([\d.]+ MB/s\) - ‘data\.csv’ saved \[252/252\]\n\n$`,
      ),
    );
    expect((await run(sh, 'head -2 data.csv')).stdout).toBe('date,city,temperature_c,rain_mm\n2026-10-12,London,13,2.4\n');
    expect((await run(sh, 'wget -q https://files.example.com/data.csv && ls data.csv*')).stdout).toBe('data.csv\ndata.csv.1\n');
    expect((await run(sh, 'wget -q -O - https://api.example.com/time')).stdout).toContain('"timezone": "UTC"');
    expect((await run(sh, 'wget -nv https://files.example.com/latest')).stderr).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d URL:https:\/\/files\.example\.com\/project\.tar\.gz \[\d+\/\d+\] -> "project\.tar\.gz" \[1\]\n$/);
    expect((await run(sh, 'wget https://files.example.com/latest -O p.tgz')).stderr).toContain('HTTP request sent, awaiting response... 302 Found\nLocation: https://files.example.com/project.tar.gz [following]\n');
    expect((await run(sh, 'tar -tzf p.tgz | head -1')).stdout).toBe('project/\n');
    expect((await run(sh, 'wget -P dl -q https://example.com && ls dl')).stdout).toBe('index.html\n');
  });

  it('reports wget errors and exit codes', async () => {
    const sh = makeShell();
    const res = await run(sh, 'wget https://nosuch.invalid');
    expect(res.status).toBe(4);
    expect(res.stderr).toMatch(/Resolving nosuch\.invalid \(nosuch\.invalid\)\.\.\. failed: Name or service not known\.\nwget: unable to resolve host address ‘nosuch\.invalid’\n$/);
    const nf = await run(sh, 'wget http://example.com/missing');
    expect(nf.status).toBe(8);
    expect(nf.stderr).toMatch(/HTTP request sent, awaiting response\.\.\. 404 Not Found\n\d{4}-\d\d-\d\d \d\d:\d\d:\d\d ERROR 404: Not Found\.\n\n$/);
    expect(await run(sh, 'wget')).toEqual({ stdout: '', stderr: "wget: missing URL\nUsage: wget [OPTION]... [URL]...\n\nTry `wget --help' for more options.\n", status: 1 });
    const refused = await run(sh, 'wget http://localhost:8080/');
    expect(refused.stderr).toContain('Connecting to localhost (localhost)|127.0.0.1|:8080... failed: Connection refused.\n');
    expect(refused.status).toBe(4);
  });
});

describe('ping', () => {
  it('pings a host a fixed number of times', async () => {
    const sh = makeShell();
    const r = await run(sh, 'ping -c 3 example.com');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^PING example\.com \(203\.0\.113\.80\) 56\(84\) bytes of data\.\n64 bytes from 203\.0\.113\.80: icmp_seq=1 ttl=56 time=1\d\.\d ms\n64 bytes from 203\.0\.113\.80: icmp_seq=2 ttl=56 time=1\d\.\d ms\n64 bytes from 203\.0\.113\.80: icmp_seq=3 ttl=56 time=1\d\.\d ms\n\n--- example\.com ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss, time 200\dms\nrtt min\/avg\/max\/mdev = \d+\.\d{3}\/\d+\.\d{3}\/\d+\.\d{3}\/\d+\.\d{3} ms\n$/);
    expect((await run(sh, 'ping -c 1 localhost')).stdout).toMatch(/^PING localhost \(127\.0\.0\.1\) 56\(84\) bytes of data\.\n64 bytes from localhost \(127\.0\.0\.1\): icmp_seq=1 ttl=64 time=0\.0\d\d ms\n/);
    expect((await run(sh, 'ping -c 1 8.8.8.8')).stdout).toMatch(/\n64 bytes from 8\.8\.8\.8: icmp_seq=1 ttl=117 time=\d+\.\d+ ms\n/);
    expect((await run(sh, 'ping -c 1 webserver')).stdout).toContain('64 bytes from webserver.example.com (192.0.2.10): icmp_seq=1 ttl=63');
    expect((await run(sh, 'ping -qc 2 localhost')).stdout).toMatch(/^PING localhost \(127\.0\.0\.1\) 56\(84\) bytes of data\.\n\n--- localhost ping statistics ---\n2 packets transmitted, 2 received, 0% packet loss/);
    expect((await run(sh, 'ping -c 1 -s 100 localhost')).stdout).toMatch(/^PING localhost \(127\.0\.0\.1\) 100\(128\) bytes of data\.\n108 bytes from/);
  });

  it('reports unreachable and unknown hosts', async () => {
    const sh = makeShell();
    expect(await run(sh, 'ping nosuch.invalid')).toEqual({ stdout: '', stderr: 'ping: nosuch.invalid: Name or service not known\n', status: 2 });
    expect(await run(sh, 'ping')).toEqual({ stdout: '', stderr: 'ping: usage error: Destination address required\n', status: 1 });
    expect(await run(sh, 'ping -c 1 -W 1 203.0.113.99')).toEqual({
      stdout: 'PING 203.0.113.99 (203.0.113.99) 56(84) bytes of data.\n\n--- 203.0.113.99 ping statistics ---\n1 packets transmitted, 0 received, 100% packet loss, time 0ms\n\n',
      stderr: '',
      status: 1,
    });
    expect((await run(sh, 'ping -c 5 10.0.2.99')).stdout).toMatch(/From 10\.0\.2\.15 icmp_seq=1 Destination Host Unreachable\n[\s\S]*5 packets transmitted, 0 received, \+2 errors, 100% packet loss/);
    expect((await run(sh, 'ping -c abc localhost')).stderr).toBe("ping: invalid argument: 'abc'\n");
    const x = await run(sh, 'ping -x localhost');
    expect(x.stderr.startsWith("ping: invalid option -- 'x'\n\nUsage\n  ping [options] <destination>\n")).toBe(true);
    expect(x.status).toBe(2);
  });
});

describe('ip and ss', () => {
  it('prints interfaces, routes and links', async () => {
    const sh = makeShell();
    expect((await run(sh, 'ip a')).stdout).toMatch(
      /^1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\n    link\/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n    inet 127\.0\.0\.1\/8 scope host lo\n       valid_lft forever preferred_lft forever\n    inet6 ::1\/128 scope host noprefixroute \n       valid_lft forever preferred_lft forever\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000\n    link\/ether 08:00:27:3a:5c:7e brd ff:ff:ff:ff:ff:ff\n    inet 10\.0\.2\.15\/24 metric 100 brd 10\.0\.2\.255 scope global dynamic eth0\n       valid_lft \d+sec preferred_lft \d+sec\n    inet6 fe80::a00:27ff:fe3a:5c7e\/64 scope link \n       valid_lft forever preferred_lft forever\n$/,
    );
    expect((await run(sh, 'ip -br a')).stdout).toBe('lo               UNKNOWN        127.0.0.1/8 ::1/128 \neth0             UP             10.0.2.15/24 fe80::a00:27ff:fe3a:5c7e/64 \n');
    expect((await run(sh, 'ip route')).stdout).toBe('default via 10.0.2.2 dev eth0 proto dhcp src 10.0.2.15 metric 100 \n10.0.2.0/24 dev eth0 proto kernel scope link src 10.0.2.15 metric 100 \n10.0.2.2 dev eth0 proto dhcp scope link src 10.0.2.15 metric 100 \n10.0.2.3 dev eth0 proto dhcp scope link src 10.0.2.15 metric 100 \n');
    expect((await run(sh, 'ip link show eth0')).stdout).toBe('2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default qlen 1000\n    link/ether 08:00:27:3a:5c:7e brd ff:ff:ff:ff:ff:ff\n');
    expect((await run(sh, 'ip -4 addr show lo')).stdout).toBe('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\n    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n');
    expect(await run(sh, 'ip foo')).toEqual({ stdout: '', stderr: 'Object "foo" is unknown, try "ip help".\n', status: 1 });
    expect(await run(sh, 'ip a show nosuch')).toEqual({ stdout: '', stderr: 'Device "nosuch" does not exist.\n', status: 1 });
    expect(await run(sh, 'ip addr add 1.2.3.4/24 dev eth0')).toEqual({ stdout: '', stderr: 'RTNETLINK answers: Operation not permitted\n', status: 2 });
    expect((await run(sh, 'ip addr foo')).stderr).toBe('Command "foo" is unknown, try "ip address help".\n');
    expect((await run(sh, 'ip')).status).toBe(255);
  });

  it('lists sockets', async () => {
    const sys = makeSystem();
    const sh = makeShell(sys);
    expect((await run(sh, 'ss -tuln')).stdout).toBe(
      'Netid State  Recv-Q Send-Q  Local Address:Port Peer Address:PortProcess\n' +
        'udp   UNCONN 0      0          127.0.0.54:53        0.0.0.0:*          \n' +
        'udp   UNCONN 0      0       127.0.0.53%lo:53        0.0.0.0:*          \n' +
        'udp   UNCONN 0      0      10.0.2.15%eth0:68        0.0.0.0:*          \n' +
        'tcp   LISTEN 0      4096    127.0.0.53%lo:53        0.0.0.0:*          \n' +
        'tcp   LISTEN 0      4096       127.0.0.54:53        0.0.0.0:*          \n' +
        'tcp   LISTEN 0      511           0.0.0.0:80        0.0.0.0:*          \n' +
        'tcp   LISTEN 0      4096          0.0.0.0:22        0.0.0.0:*          \n' +
        'tcp   LISTEN 0      511              [::]:80           [::]:*          \n' +
        'tcp   LISTEN 0      4096             [::]:22           [::]:*          \n',
    );
    expect((await run(sh, 'ss -tl')).stdout).toContain('     0.0.0.0:ssh ');
    expect((await run(sh, 'ss -t')).stdout).toMatch(/ESTAB 0      36 +10\.0\.2\.15:ssh +10\.0\.2\.2:52144/);
    const rootSh = createLoginShell(sys, 'root', { interactive: false });
    expect((await run(rootSh, 'ss -tlnp')).stdout).toContain('users:(("sshd",pid=812,fd=3),("systemd",pid=1,fd=93))');
  });
});

describe('ssh without a terminal', () => {
  it('fails the way OpenSSH does', async () => {
    const sh = makeShell();
    expect(await run(sh, 'ssh nosuch')).toEqual({ stdout: '', stderr: 'ssh: Could not resolve hostname nosuch: Name or service not known\n', status: 255 });
    expect((await run(sh, 'ssh NoSuch')).stderr).toBe('ssh: Could not resolve hostname nosuch: Name or service not known\n');
    expect(await run(sh, 'ssh webserver hostname')).toEqual({ stdout: '', stderr: 'Host key verification failed.\n', status: 255 });
    expect(await run(sh, 'ssh -o StrictHostKeyChecking=accept-new webserver hostname')).toEqual({
      stdout: '',
      stderr: "Warning: Permanently added 'webserver' (ED25519) to the list of known hosts.\nlearner@webserver: Permission denied (publickey,password).\n",
      status: 255,
    });
    const usage = await run(sh, 'ssh');
    expect(usage.stderr.startsWith('usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]\n')).toBe(true);
    expect(usage.status).toBe(255);
    expect((await run(sh, 'ssh -Z x')).stderr.startsWith('unknown option -- Z\nusage: ssh')).toBe(true);
    expect(await run(sh, 'ssh -p 2222 localhost')).toEqual({ stdout: '', stderr: 'ssh: connect to host localhost port 2222: Connection refused\n', status: 255 });
  });

  it('logs in with a public key, runs commands and copies files with scp', async () => {
    const sys = makeSystem();
    const sh = makeShell(sys);
    const remote = (await remoteSystem(sys, 'webserver'))!;
    expect(remote.hostname).toBe('webserver');
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyForTestsOnlyExampleKeyForTests learner@sandbox';
    await run(sh, `mkdir -p ~/.ssh && echo '${key}' > ~/.ssh/id_ed25519.pub`);
    remote.fs.mkdir('/home/learner/.ssh', ROOT, 0o700);
    remote.fs.writeFile('/home/learner/.ssh/authorized_keys', key + '\n', ROOT);
    const r = await run(sh, 'ssh -o StrictHostKeyChecking=no webserver "hostname; ls /var/www/html"');
    expect(r).toEqual({ stdout: 'webserver\nabout.html\ncss\nimages\nindex.html\nmenu.html\n', stderr: "Warning: Permanently added 'webserver' (ED25519) to the list of known hosts.\n", status: 0 });
    // the remote computer has its own files
    expect((await run(sh, 'ssh webserver cat README.txt | head -1')).stdout).toBe('Welcome to webserver!\n');
    expect((await run(sh, 'ls README.txt')).status).toBe(2);
    expect((await run(sh, 'ssh webserver "exit 3"')).status).toBe(3);
    expect((await run(sh, 'echo hello | ssh webserver "cat > from-sandbox.txt" && ssh webserver cat from-sandbox.txt')).stdout).toBe('hello\n');
    // and serves its website over HTTP
    expect((await run(sh, 'curl -s http://webserver/ | grep "<h1>"')).stdout).toBe('  <h1>Sunrise Bakery</h1>\n');
    remote.fs.writeFile('/var/www/html/index.html', '<h1>Changed</h1>\n', ROOT);
    expect((await run(sh, 'curl -s http://webserver.example.com/')).stdout).toBe('<h1>Changed</h1>\n');
    // scp in both directions
    expect((await run(sh, 'echo payload > up.txt && scp -q up.txt webserver: && ssh webserver cat up.txt')).stdout).toBe('payload\n');
    expect((await run(sh, 'scp -q webserver:/var/log/nginx/error.log . && wc -l < error.log')).stdout).toBe('1\n');
    expect((await run(sh, 'ssh webserver "tar -czf - -C /var/www html" > site.tgz && tar -tzf site.tgz | head -1')).stdout).toBe('html/\n');
  });
});

describe('interactive sessions', () => {
  async function terminal(cols = 100) {
    const sys = makeSystem();
    const s = await startSession({ sys, cols, rows: 40 });
    let mark = 0;
    const since = () => s.term.allText().slice(mark);
    const send = async (input: string, until: RegExp, timeout = 5000) => {
      mark = s.term.allText().length;
      s.term.type(input);
      await waitFor(() => until.test(since()), timeout, () => s.term.allText());
      return since();
    };
    return { ...s, send };
  }

  it('ssh asks about the host key and the password, then opens a remote shell', async () => {
    const { send, session, sys } = await terminal();
    let out = await send('ssh webserver\r', /continue connecting \(yes\/no\/\[fingerprint\]\)\?$/);
    expect(out).toContain("The authenticity of host 'webserver (192.0.2.10)' can't be established.\n");
    expect(out).toMatch(/ED25519 key fingerprint is SHA256:[A-Za-z0-9+/]{43}\.\nThis key is not known by any other names\.\n/);
    await send('maybe\r', /Please type 'yes', 'no' or the fingerprint:$/);
    out = await send('yes\r', /learner@webserver's password:$/);
    expect(out).toContain("Warning: Permanently added 'webserver' (ED25519) to the list of known hosts.\n");
    expect(sys.fs.readFile('/home/learner/.ssh/known_hosts', ROOT)).toMatch(/^\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+ ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI\S+\n$/);
    await send('\r', /Permission denied, please try again\.\nlearner@webserver's password:$/);
    out = await send('hunter2\r', /learner@webserver:~\$$/);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)');
    expect(out).toMatch(/Last login: .* from 198\.51\.100\.23\n/);
    out = await send('hostname; ls /var/www/html\r', /learner@webserver:~\$$/);
    expect(out).toContain('webserver\nabout.html  css  images  index.html  menu.html\n');
    out = await send('echo $SSH_CONNECTION\r', /learner@webserver:~\$$/);
    expect(out).toMatch(/10\.0\.2\.15 \d+ 192\.0\.2\.10 22\n/);
    out = await send('exit\r', /learner@sandbox:~\$$/);
    expect(out).toMatch(/exit\nlogout\nConnection to webserver closed\.\nlearner@sandbox:~\$$/);
    // the second time the host key is already known
    out = await send('ssh webserver\r', /password:$/);
    expect(out).not.toContain('authenticity');
    out = await send('pw\r', /learner@webserver:~\$$/);
    expect(out).toMatch(/Last login: .* from 10\.0\.2\.15\n/);
    out = await send('\x04', /learner@sandbox:~\$$/);
    expect(out).toContain('logout\nConnection to webserver closed.\n');
    out = await send('hostname\r', /learner@sandbox:~\$$/);
    expect(out).toContain('sandbox\n');
    session.dispose();
  }, 20000);

  it('ssh runs a single remote command without a terminal', async () => {
    const { send, session } = await terminal();
    await send('ssh -o StrictHostKeyChecking=accept-new webserver ls /var/www/html\r', /password:$/);
    expect(await send('pw\r', /learner@sandbox:~\$$/)).toContain('about.html\ncss\nimages\nindex.html\nmenu.html\n');
    session.dispose();
  }, 20000);

  it('ping prints statistics when interrupted with Ctrl+C', async () => {
    const { send, session, term } = await terminal();
    await send('ping 8.8.8.8\r', /icmp_seq=3 /);
    term.type('\x03');
    await waitFor(() => /\^C\n--- 8\.8\.8\.8 ping statistics ---\n\d+ packets transmitted, \d+ received, 0% packet loss, time \d+ms\nrtt min\/avg\/max\/mdev = [\d.]+\/[\d.]+\/[\d.]+\/[\d.]+ ms\nlearner@sandbox:~\$$/.test(term.allText()), 5000, () => term.allText());
    expect(await send('echo status=$?\r', /status=\d+\n/)).toContain('status=0\n');
    session.dispose();
  }, 20000);

  it('archivers refuse to write binary data to the terminal', async () => {
    const { send, session } = await terminal();
    expect(await send('tar -cz Documents; echo s=$?\r', /s=\d+/)).toContain('tar: Refusing to write archive contents to terminal (missing -f option?)\ntar: Error is not recoverable: exiting now\ns=2');
    expect(await send('gzip; echo s=$?\r', /s=\d+/)).toContain('gzip: compressed data not written to a terminal. Use -f to force compression.\nFor help, type: gzip -h\ns=1');
    expect(await send('zcat; echo s=$?\r', /s=\d+/)).toContain('gzip: compressed data not read from a terminal. Use -f to force decompression.\nFor help, type: gzip -h\ns=1');
    // allText() trims trailing spaces, so compare without them
    expect(await send('curl https://files.example.com/logo.png; echo s=$?\r', /s=\d+/)).toContain('Warning: Binary output can mess up your terminal. Use "--output -" to tell\nWarning: curl to output it to your terminal anyway, or consider "--output\nWarning: <FILE>" to save to a file.\ns=23');
    session.dispose();
  }, 20000);

  it('wget draws a progress bar on a terminal', async () => {
    const { send, session } = await terminal();
    const out = await send('wget https://files.example.com/hello.txt\r', /learner@sandbox:~\$$/);
    expect(out).toMatch(/Saving to: ‘hello\.txt’\n\nhello\.txt {16}100%\[={34}>\]     184  --\.-KB\/s    in 0s\n\n\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \([\d.]+ [KM]B\/s\) - ‘hello\.txt’ saved \[184\/184\]\n/);
    session.dispose();
  }, 20000);
});
