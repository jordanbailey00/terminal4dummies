// Differential tests: run the same scripts in real bash (on the host) and in
// the simulator, and compare output. Only runs when BASH_DIFF=1 is set and
// a real bash is available, e.g.:  BASH_DIFF=1 npx vitest run src/test/bash-diff.test.ts

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeShell, run } from './harness';
import type { Shell } from '../shell/interpreter';

const ENABLED = process.env.BASH_DIFF === '1';

const FILES: Record<string, string> = {
  'a.txt': 'apple\nbanana\ncherry\n',
  'b.txt': 'one two three\nfour five\n',
  'notes.md': '# Notes\n- milk\n- eggs\n',
  'data.csv': 'name,age,city\nAva,31,Oslo\nBen,25,Lima\nCai,42,Oslo\n',
  'dir/c.log': 'ERROR x\nINFO y\nERROR z\n',
  'dir/sub/d.txt': 'deep\n',
  'empty.txt': '',
  'spaced name.txt': 'has spaces\n',
};

const CASES: string[] = [
  'echo hello world',
  'echo "a\\nb"; echo -e "a\\nb"; echo -n x; echo',
  "echo 'single $HOME' \"double\" \\$HOME",
  'x=5; echo $((x * 2)) $((10/3)) $((10%3)) $((2**10)) $(( -7 / 2 ))',
  'f=archive.tar.gz; echo ${f%.gz} ${f%%.*} ${f#*.} ${f##*.} ${f/tar/zip} ${#f}',
  'unset v; echo "[${v:-default}]" "[${v-dash}]"; v=; echo "[${v:-default}]" "[${v-dash}]"; echo "[${v:=set}]" $v',
  's="Hello World"; echo ${s^^} ${s,,} ${s:0:5} ${s: -5} ${s/o/0} ${s//o/0}',
  'echo {1..5} {a..e} {01..10..3} x{a,b,c}y {1,2}{3,4}',
  'echo *.txt; echo d*; echo [ab]*; echo nomatch*',
  'for f in *.txt; do echo "<$f>"; done',
  'ls; ls -a; ls dir',
  'ls -1 dir/sub; ls -d dir; ls nofile; echo $?',
  'cat a.txt b.txt | wc -l; wc a.txt; wc -w b.txt; wc -c < a.txt',
  'sort a.txt | head -2; sort -r a.txt; tail -1 a.txt',
  'grep an a.txt; grep -c ERROR dir/c.log; grep -n ERROR dir/c.log; grep -v ERROR dir/c.log; grep zzz a.txt; echo $?',
  'grep -r ERROR dir; grep -l ERROR dir/c.log a.txt; grep -i APPLE a.txt',
  'cut -d, -f1,3 data.csv; cut -c1-3 a.txt',
  'tr a-z A-Z < a.txt; echo hello | tr -d l; echo "a  b   c" | tr -s " "',
  'printf "%s=%d\\n" a 1 b 2; printf "%-6s|%5.2f|%03d\\n" ab 3.14159 7; printf "%x %o %c %%\\n" 255 8 hello',
  'test -f a.txt && echo file; test -d dir && echo dir; [ -e nope ] || echo missing; [ 3 -lt 10 ] && echo lt',
  '[[ hello == h* ]] && echo glob; [[ abc =~ ^a.c$ ]] && echo regex; [[ -z "" && -n x ]] && echo both',
  'case foo.txt in *.md) echo md;; *.txt|*.text) echo text;; *) echo other;; esac',
  'i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done; until [ $i -eq 0 ]; do i=$((i-1)); done; echo $i',
  'for ((i=0; i<3; i++)); do echo -n "$i "; done; echo',
  'f() { local x=inner; echo "$1-$x-$#"; return 3; }; x=outer; f a b; echo $? $x',
  'while read -r name age city; do echo "$name/$city"; done < <(tail -n +2 data.csv | tr , " ") 2>/dev/null || true',
  'tail -n +2 data.csv | while IFS=, read -r n a c; do echo "$n:$a"; done',
  '(cd dir; pwd); pwd',
  '{ echo a; echo b; } > out.txt; cat out.txt; echo c >> out.txt; wc -l out.txt',
  'ls nofile 2>&1 | wc -l; ls nofile 2>/dev/null; echo "status $?"',
  'echo $(echo "nested $(echo deep)") "$(echo "quoted   spaces")"',
  'wc -w <<< "one two three"; cat <<EOF\nheredoc $HOME\nEOF',
  "cat <<'EOF'\nliteral $HOME\nEOF",
  'mkdir -p x/y/z && touch x/y/z/f && ls -R x',
  'cp a.txt a2.txt && mv a2.txt a3.txt && ls a*; rm a3.txt; ls a3.txt',
  'mkdir m; rmdir m; rmdir dir; rm dir; mkdir dir; echo done',
  'cd nowhere; cd a.txt; echo $?',
  'echo "a b" | { read x y; echo "$y $x"; }',
  'set -- p q r; echo $# "$@" "$1"; shift; echo $*',
  'echo $((1 + 2 * 3)) $(( (1+2) * 3 )) $((7 > 3)) $((5 == 5 ? 1 : 0))',
  'a=(1 2 3) 2>/dev/null; echo ok',
  'true && false || echo fallback; false; echo $?; ! false; echo $?',
  'x=1; [ "$x" = 1 ] && echo eq; [ "$x" != 2 ] && echo ne',
  'echo "tab\there"; echo $\'tab\\there\'',
  'seq 3; seq 2 2 6; seq -s, 5',
  'head -c 5 a.txt; echo; head -n -1 a.txt',
  'sort -n <<< $\'10\\n9\\n100\'; sort -t, -k2 -n data.csv',
  'uniq -c <<< $\'a\\na\\nb\\na\'',
  'basename /a/b/c.txt .txt; dirname /a/b/c.txt; basename dir/',
  'echo ~ | sed "s|/.*|X|" 2>/dev/null || echo tilde',
  'cat "spaced name.txt"; cat spaced\\ name.txt',
  'chmod 600 a.txt && stat -c "%a %n" a.txt; chmod u+x,g+r a.txt; stat -c %A a.txt',
  'touch new.txt; ls -l new.txt | cut -c1-10',
  'ln -s a.txt link; ls -l link | cut -d" " -f1,9-; readlink link; cat link',
  'echo foo > f1; echo foo > f2; cmp f1 f2 && echo same 2>/dev/null; diff a.txt b.txt > /dev/null; echo $?',
  'type cd echo ls nonexistent 2>&1 | head -4',
  'printf "%s\\n" "$((16#ff))" "$((2#101))" "$((010))"',
  'echo "${UNSET_VAR:-fallback}" ${#PATH} > /dev/null; echo ok',
  'x=3; y=$((x++)); z=$((++x)); echo $x $y $z',
  'echo $? ; false; echo $?; (exit 7); echo $?',
  'for i in 1 2 3 4; do [ $i = 2 ] && continue; [ $i = 4 ] && break; echo $i; done',
  'echo one; exit 4; echo never',
  'echo <(true) >(true); x=<(true); echo $x; echo a<(true); echo hi 2>(cat); echo "<(x)"',
  'cat <(echo one) <(echo two); echo <(echo hi; exit 3); echo $?',
  'f=<(echo z); cat $f; wc -l < <(ls); paste -d: <(cut -d, -f1 data.csv) <(cut -d, -f3 data.csv)',
  'tee >(wc -c) <<< hello >/dev/null; wait',
  // common mistakes and their messages
  'cat nofile; cd dir/sub/d.txt; mkdir dir; rm dir; cp dir x; mv nofile x; echo $?',
  'wc nofile; head nofile; grep x nofile; touch dir/sub/new/x; rmdir nofile; chmod 999 a.txt; echo $?',
  'echo $((1/0)); echo after',
  'nosuchcmd; echo $?',
  'ls -z; echo $?; grep; echo $?; cat -y; echo $?',
  'rm -i a.txt < /dev/null; ls a.txt',
  'cp -r dir dir2 && ls -R dir2; mv a.txt dir/ && ls dir; rm -r dir && ls',
  // everyday text tools
  'cat -n a.txt; cat -A b.txt; nl a.txt; tac a.txt; rev a.txt',
  'sort -u <<< $\'b\na\nb\'; sort -k2 b.txt; uniq -d <<< $\'a\na\nb\'',
  'wc -l *.txt; head -n 2 a.txt b.txt; tail -n 1 a.txt b.txt',
  'printf "a\\tb\\tc\\n" | cut -f2; tr "[:lower:]" "[:upper:]" < b.txt; tr -s "a-z" <<< "aabbcc"',
  'expr 2 + 3; expr 5 \\* 2; expr 7 / 2; expr length hello',
  'printf "%5s|%-5s|\\n" a b; printf "%s\\n" one two three | paste -sd,',
  'ls -F; ls -p dir; ls -a dir; ls -1 | wc -l',
  'basename a/b c/d -a 2>/dev/null; basename -a a/b c/d; dirname .; dirname /; realpath a.txt dir/../b.txt',
  'test -s empty.txt; echo $?; [ -r a.txt -a -w a.txt ] && echo rw; [ -x a.txt ] || echo notx',
  'seq 5 | paste -sd+; sort data.csv | uniq | wc -l; yes | head -3',
  'file a.txt dir empty.txt; stat -c "%s %F" a.txt dir empty.txt',
  'ln a.txt hard; stat -c %h a.txt; ls > list.txt; cat list.txt',
  'echo café | wc -c; echo café | wc -m; printf "\\u00e9\\n"; echo -e "\\e[1mB\\e[0m" | od -c | head -2',
  // shell features
  'set -e; false; echo no',
  'set -u; echo $nope; echo after',
  'declare -i n=5; n+=3; echo $n; let x=2+3; echo $x; (( 5 > 3 )) && echo yes',
  'arr=(a b c); echo ${arr[1]} ${#arr[@]} ${arr[@]}; arr+=(d); echo ${arr[-1]} "${!arr[@]}"',
  'read -p "Name: " name <<< "Bob"; echo "Hi $name"; IFS=: read -ra parts <<< "a:b:c"; echo ${parts[1]}',
  'while IFS= read -r line; do echo "[$line]"; done < a.txt; for i in $(seq 1 3); do echo $i; done',
  'for f in dir/*; do echo $f; done; shopt -s nullglob; echo nomatch* end',
  'echo $((0x1F)) $((1<<4)) $(( RANDOM >= 0 )); printf -v var "%03d" 5; echo $var',
  'echo ${var:?not set}; echo after',
  'function g { echo g; }; g; f() { echo "$#:$1"; }; f "a b" c',
  'exec 3>&1; echo hi >&3; echo err >&2; ls nofile a.txt 2>&1 >/dev/null',
  '{ echo out; echo err >&2; } 2>&1 | sort; echo "$(ls nofile 2>&1)"',
  'trap "echo bye" EXIT; echo hi',
  'command -v ls cd; which ls; type -t ls cd if; echo $0',
  'env | grep ^HOME=; export X=1; bash -c "echo \\$X"; X=2 bash -c "echo \\$X"; bash -c "exit 3"; echo $?; sh -c "echo \\$0"',
  'case 5 in [0-9]) echo digit;; esac; echo ${#}; echo {a..c}{1..2}',
  'cat <<-EOF\n\tindented\n\tEOF\necho done',
  'sleep 0.1 && echo slept; true | false; echo ${PIPESTATUS[@]}',
  // a folder you can read but not enter
  // (one entry each: real ls reports in on-disk hash order)
  'mkdir nx; touch nx/a; chmod u-x nx; ls nx; echo "st=$?"; ls -l nx; echo "st=$?"; ls -F nx; echo "st=$?"; ls -ld nx/a; echo "st=$?"; cd nx; echo "st=$?"; chmod u+x nx',
  'mkdir nx; mkdir nx/sub; chmod u-x nx; ls -F nx; echo "st=$?"; ls -l nx; echo "st=$?"; chmod u+x nx',
  // byte viewers
  "printf 'hello\\n' | od; printf 'hello\\n' | od -c; printf 'a\\tb\\r\\n\\000\\177\\303\\251' | od -c",
  "printf 'hello\\n' | od -An -t x1; printf 'hello\\n' | od -t x1z; printf 'hello world\\n' | od -c -t x1; printf 'hello\\n' | od -x; printf 'hello\\n' | od -d",
  "printf 'hello\\n' | od -b; printf 'hi\\n' | od -a; head -c 64 /dev/zero | od -c; printf 'hello\\n' | od -A d -t u1; printf 'abcdefghijklmnopqrstuvwxyz' | od -c -w8",
  "printf 'hello\\n' | od -t d2 -t o2 -t x2; printf 'abc' | od -t x2; printf 'x' | od -t d1 -t c; od -c a.txt b.txt; printf '' | od -c",
  "printf 'hello\\n' | xxd; printf 'hello world, this is a longer line\\n' | xxd; printf 'hello\\n' | xxd -p; printf 'hello\\n' | xxd -u; printf 'hello\\n' | xxd -g1",
  "printf 'hello\\n' | xxd -c8; printf 'hi\\n' | xxd -b; head -c 64 /dev/zero | xxd; printf 'hello\\n' | xxd -i; printf 'hello\\n' | xxd -p | xxd -r -p; xxd -i a.txt; xxd a.txt | xxd -r",
  "printf 'hello\\n' | xxd -s 2 -l 3; printf 'abcdefghijklmnopqrstuvwxyz0123456789' | xxd -p; printf '' | xxd",
  "printf 'hello\\n' | hexdump -C; printf 'hello world, this is a longer line\\n' | hexdump -C; printf 'hello\\n' | hexdump; head -c 64 /dev/zero | hexdump -C; printf '' | hexdump -C",
  "printf 'hello\\n' | hexdump -c; printf 'hello\\n' | hexdump -x; printf 'hello\\n' | hexdump -b; printf 'hello\\n' | hexdump -d; printf 'hello\\n' | hexdump -o; head -c 40 /dev/zero | hexdump; hd a.txt",
  // arrays
  "arr=(a b c); echo ${arr[1]} ${#arr[@]} ${arr[@]}; arr+=(d); echo ${arr[-1]} \"${!arr[@]}\"\ndeclare -p arr\na=(x \"y z\"); a[7]=q; declare -p a; echo ${#a[@]} ${!a[@]}\nb=(); declare -p b; declare -A e; declare -p e; declare -a g; declare -p g",
  "c=(1 2); c+=(3); c[1]+=x; declare -p c; echo \"${c[@]:1}\" \"${c[@]: -1}\" \"${c[*]}\"\nset -- p q r s; echo \"${@:2:2}\" \"${*:3}\"; echo ${#c} ${#c[1]} ${#c[@]}\ndeclare -A m=([apple]=1 [banana]=2 [cherry]=3 [date]=4 [elderberry]=5 [fig]=6); echo \"${!m[@]}\"; declare -p m\nm[c d]=2; echo \"${m[c d]}\"; declare -A n=(k1 v1 k2 v2); declare -p n",
  "i=1; z[i + 1]=x; declare -p z\ny=([1]=x [3]+=y); declare -p y\nfor x in \"${a[@]}\"; do echo \"<$x>\"; done\nfor k in \"${!m[@]}\"; do echo \"$k=${m[$k]}\"; done | head -3",
  "IFS=: read -ra parts <<< \"a:b:c\"; echo ${parts[1]} ${#parts[@]}\nmapfile -t lines <<< $'one\\ntwo\\nthree'; declare -p lines\nprintf '%s\\n' 1 2 3 | { readarray nums; declare -p nums; }\ntrue | false; echo ${PIPESTATUS[@]}; false; echo ${PIPESTATUS[0]}",
  "[[ abc123 =~ ([a-z]+)([0-9]+) ]] && echo \"${BASH_REMATCH[0]} ${BASH_REMATCH[1]} ${BASH_REMATCH[2]}\"\nf() { echo \"${FUNCNAME[@]}\"; g; }; g() { echo \"${FUNCNAME[@]}\"; }; f\nn2=(5 3 8); echo $(( n2[0] + n2[2] )); (( n2[1]++ )); echo ${n2[1]}; (( cnt[x]+=2 )); declare -p cnt\nunset 'a[1]'; declare -p a; unset a[@]; declare -p a 2>&1",
  "x=hi; echo ${x[0]} \"${x[@]}\" ${#x[@]}; declare -A x2; declare -p x2\ndeclare -a q=(1 2); declare -A q; echo st=$?\nlocal_test() { local -a la=(9 8); local s; echo \"[${s-unset}]\" ${la[1]}; declare -p la s; }; local_test\necho ${arr[@]^^} ${arr[@]/b/B} ${arr[@]#a}",
  "arr2=(\"${arr[@]}\"); echo ${#arr2[@]}; echo \"${arr[*]}\"; IFS=,; echo \"${arr[*]}\"; unset IFS\n[[ -v arr[1] ]] && echo set1; [[ -v arr[9] ]] || echo unset9\necho \"${undefined_arr[@]}\" end\nreadonly ro=(1 2); ro[0]=5; echo after",
];

const HOME = '/home/learner';

function realBash(dir: string, script: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('bash', ['--norc', '--noprofile', '-c', script], {
    cwd: dir,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', HOME, TERM: 'dumb' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 1 };
}

function setupReal(dir: string): void {
  for (const [p, content] of Object.entries(FILES)) {
    const full = join(dir, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    chmodSync(full, 0o664);
  }
}

async function setupSim(sh: Shell, dir: string): Promise<void> {
  const fs = sh.system.fs;
  const ctx = { cwd: '/', creds: sh.state.creds, umask: 0o002 };
  fs.mkdir(dir, ctx);
  for (const [p, content] of Object.entries(FILES)) {
    const full = `${dir}/${p}`;
    const parts = full.split('/').slice(0, -1);
    let cur = '';
    for (const part of parts.filter(Boolean)) {
      cur += '/' + part;
      if (!fs.tryStat(cur, ctx)) fs.mkdir(cur, ctx);
    }
    fs.writeFile(full, content, ctx);
  }
  sh.state.cwd = dir;
  sh.state.set('PWD', dir);
}

describe.skipIf(!ENABLED)('simulator matches real bash', () => {
  const realDir = ENABLED ? mkdtempSync(join(tmpdir(), 't4d-diff-')) : '';
  afterAll(() => {
    if (realDir) rmSync(realDir, { recursive: true, force: true });
  });
  for (const script of CASES) {
    it(script.slice(0, 70), async () => {
      const dir = `${realDir}/case`;
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      setupReal(dir);
      const real = realBash(dir, script);
      const sh = makeShell();
      const simDir = '/home/learner/case';
      await setupSim(sh, simDir);
      // run it the way `bash -c` would (EXIT traps, error handling, $0)
      sh.system.fs.writeFile('/tmp/.case.sh', script, sh.opCtx());
      const sim = await run(sh, 'bash -c "$(cat /tmp/.case.sh)"');
      const norm = (s: string) => s.split(dir).join(simDir).replace(/\/usr\/bin\/bash: /g, 'bash: ');
      expect({ out: sim.stdout, err: sim.stderr, status: sim.status }).toEqual({ out: norm(real.stdout), err: norm(real.stderr), status: real.status });
    });
  }
});
