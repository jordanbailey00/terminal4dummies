import { describe, expect, it } from 'vitest';
import { makeShell, run, sh1 } from './harness';

describe('basics', () => {
  it('echo', async () => {
    expect(await sh1('echo hello world')).toEqual({ stdout: 'hello world\n', stderr: '', status: 0 });
  });

  it('pwd and cd', async () => {
    const sh = makeShell();
    expect((await run(sh, 'pwd')).stdout).toBe('/home/learner\n');
    await run(sh, 'cd Documents');
    expect((await run(sh, 'pwd')).stdout).toBe('/home/learner/Documents\n');
    await run(sh, 'cd ..');
    expect((await run(sh, 'pwd')).stdout).toBe('/home/learner\n');
    await run(sh, 'cd /var/log');
    expect((await run(sh, 'pwd')).stdout).toBe('/var/log\n');
    expect((await run(sh, 'cd -')).stdout).toBe('/home/learner\n');
    await run(sh, 'cd /tmp; cd');
    expect((await run(sh, 'pwd')).stdout).toBe('/home/learner\n');
  });

  it('cd errors', async () => {
    const r = await sh1('cd nowhere');
    expect(r.stderr).toBe('bash: line 1: cd: nowhere: No such file or directory\n');
    expect(r.status).toBe(1);
  });

  it('ls in a pipe prints one per line', async () => {
    const r = await sh1('ls');
    expect(r.stdout).toBe('Desktop\nDocuments\nDownloads\nMusic\nPictures\nPublic\nTemplates\nVideos\nwelcome.txt\n');
  });

  it('ls -a sorts dotfiles like en_US', async () => {
    const r = await sh1('ls -a');
    expect(r.stdout.split('\n').slice(0, 8)).toEqual(['.', '..', '.bash_logout', '.bashrc', '.cache', '.config', 'Desktop', 'Documents']);
  });

  it('mkdir, touch, ls -l', async () => {
    const sh = makeShell();
    const r = await run(sh, 'mkdir projects && cd projects && touch a.txt b.txt && ls');
    expect(r.stdout).toBe('a.txt\nb.txt\n');
    const l = await run(sh, 'ls -l');
    expect(l.stdout).toMatch(/^total 0\n-rw-rw-r-- 1 learner learner 0 Oct 21 \d\d:\d\d a\.txt\n/);
  });

  it('pipes and redirection', async () => {
    const sh = makeShell();
    await run(sh, 'printf "b\\na\\nc\\na\\n" > list.txt');
    expect((await run(sh, 'sort list.txt | uniq')).stdout).toBe('a\nb\nc\n');
    expect((await run(sh, 'sort list.txt | uniq -c')).stdout).toBe('      2 a\n      1 b\n      1 c\n');
    expect((await run(sh, 'wc -l < list.txt')).stdout).toBe('4\n');
    expect((await run(sh, 'cat list.txt | wc -l')).stdout).toBe('4\n');
    await run(sh, 'echo more >> list.txt');
    expect((await run(sh, 'tail -n 1 list.txt')).stdout).toBe('more\n');
  });

  it('yes | head terminates', async () => {
    expect((await sh1('yes | head -n 3')).stdout).toBe('y\ny\ny\n');
  });

  it('variables and quoting', async () => {
    const sh = makeShell();
    await run(sh, 'name="Ada Lovelace"');
    expect((await run(sh, 'echo "Hello, $name"')).stdout).toBe('Hello, Ada Lovelace\n');
    expect((await run(sh, "echo 'Hello, $name'")).stdout).toBe('Hello, $name\n');
    expect((await run(sh, 'echo ${name:-x} ${missing:-default}')).stdout).toBe('Ada Lovelace default\n');
    expect((await run(sh, 'echo $((2 + 3 * 4))')).stdout).toBe('14\n');
    expect((await run(sh, 'echo $(echo inner)')).stdout).toBe('inner\n');
  });

  it('globbing and brace expansion', async () => {
    const sh = makeShell();
    await run(sh, 'mkdir g && cd g && touch a.txt b.txt c.log');
    expect((await run(sh, 'echo *.txt')).stdout).toBe('a.txt b.txt\n');
    expect((await run(sh, 'echo ?.log')).stdout).toBe('c.log\n');
    expect((await run(sh, 'echo *.none')).stdout).toBe('*.none\n');
    expect((await run(sh, 'echo {a,b}{1,2}')).stdout).toBe('a1 a2 b1 b2\n');
    expect((await run(sh, 'echo {1..5}')).stdout).toBe('1 2 3 4 5\n');
  });

  it('&& || ; and exit status', async () => {
    const sh = makeShell();
    expect((await run(sh, 'true && echo yes || echo no')).stdout).toBe('yes\n');
    expect((await run(sh, 'false && echo yes || echo no')).stdout).toBe('no\n');
    expect((await run(sh, 'ls nofile; echo $?')).stdout).toBe('2\n');
  });

  it('if / for / while', async () => {
    const sh = makeShell();
    expect((await run(sh, 'for i in 1 2 3; do echo n$i; done')).stdout).toBe('n1\nn2\nn3\n');
    expect((await run(sh, 'if [ -d Documents ]; then echo dir; else echo nodir; fi')).stdout).toBe('dir\n');
    expect((await run(sh, 'i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done')).stdout).toBe('0\n1\n2\n');
    expect((await run(sh, 'case foo.txt in *.txt) echo text;; *) echo other;; esac')).stdout).toBe('text\n');
  });

  it('functions', async () => {
    const sh = makeShell();
    await run(sh, 'greet() { echo "Hi, $1"; }');
    expect((await run(sh, 'greet Bob')).stdout).toBe('Hi, Bob\n');
  });

  it('scripts with shebang and permissions', async () => {
    const sh = makeShell();
    await run(sh, "printf '#!/bin/bash\\necho \"script says $1\"\\n' > s.sh");
    const denied = await run(sh, './s.sh');
    expect(denied.stderr).toBe('bash: line 1: ./s.sh: Permission denied\n');
    expect(denied.status).toBe(126);
    await run(sh, 'chmod +x s.sh');
    expect((await run(sh, './s.sh hi')).stdout).toBe('script says hi\n');
    expect((await run(sh, 'bash s.sh yo')).stdout).toBe('script says yo\n');
  });

  it('command not found', async () => {
    const r = await sh1('foobarbaz');
    expect(r.status).toBe(127);
    expect(r.stderr).toBe('bash: line 1: foobarbaz: command not found\n');
  });

  it('grep', async () => {
    const sh = makeShell();
    await run(sh, 'printf "apple\\nbanana\\nApple pie\\n" > f.txt');
    expect((await run(sh, 'grep apple f.txt')).stdout).toBe('apple\n');
    expect((await run(sh, 'grep -i apple f.txt')).stdout).toBe('apple\nApple pie\n');
    expect((await run(sh, 'grep -c a f.txt')).stdout).toBe('2\n');
    expect((await run(sh, 'grep -n banana f.txt')).stdout).toBe('2:banana\n');
    expect((await run(sh, 'grep -v an f.txt')).stdout).toBe('apple\nApple pie\n');
    expect((await run(sh, 'grep zzz f.txt')).status).toBe(1);
  });

  it('cut, tr, head', async () => {
    const sh = makeShell();
    expect((await run(sh, 'cut -d, -f2 Documents/fruit-sales.csv | head -3')).stdout).toBe('fruit\napple\nbanana\n');
    expect((await run(sh, 'echo hello | tr a-z A-Z')).stdout).toBe('HELLO\n');
  });

  it('rm, cp, mv', async () => {
    const sh = makeShell();
    await run(sh, 'echo hi > a.txt && cp a.txt b.txt && mv b.txt c.txt');
    expect((await run(sh, 'cat c.txt')).stdout).toBe('hi\n');
    const r = await run(sh, 'rm a.txt c.txt && ls a.txt');
    expect(r.stderr).toBe("ls: cannot access 'a.txt': No such file or directory\n");
    const d = await run(sh, 'mkdir d && rm d');
    expect(d.stderr).toBe("rm: cannot remove 'd': Is a directory\n");
    expect((await run(sh, 'rm -r d && echo gone')).stdout).toBe('gone\n');
  });

  it('heredoc', async () => {
    const sh = makeShell();
    const r = await run(sh, 'cat <<EOF\nline one\n$HOME\nEOF');
    expect(r.stdout).toBe('line one\n/home/learner\n');
  });
});
