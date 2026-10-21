// A lightweight, purely visual terminal animation for the home page.

import { useEffect, useState } from 'react';

type Seg = { t: string; c?: 'dir' | 'exe' | 'err' | 'dim' | 'hl' | 'ok' };

interface Scene {
  cwd: string;
  cmd: string;
  out: Seg[][];
}

const SCENES: Scene[] = [
  { cwd: '~', cmd: 'ls', out: [[{ t: 'Documents', c: 'dir' }, { t: '  ' }, { t: 'Music', c: 'dir' }, { t: '  ' }, { t: 'Pictures', c: 'dir' }, { t: '  ' }, { t: 'welcome.txt' }]] },
  { cwd: '~', cmd: 'cd Documents', out: [] },
  {
    cwd: '~/Documents',
    cmd: 'grep -i milk todo.txt',
    out: [[{ t: 'buy ' }, { t: 'milk', c: 'hl' }]],
  },
  {
    cwd: '~/Documents',
    cmd: 'cut -d, -f2 fruit-sales.csv | sort | uniq -c | sort -rn | head -3',
    out: [[{ t: '      4 apple' }], [{ t: '      3 banana' }], [{ t: '      2 mango' }]],
  },
  { cwd: '~/Documents', cmd: 'mkdir -p projects/website && cd projects/website', out: [] },
  {
    cwd: '~/Documents/projects/website',
    cmd: 'sudo apt install cowsay',
    out: [[{ t: '[sudo] password for learner: ', c: 'dim' }], [{ t: 'Setting up cowsay (3.03+dfsg2-8) ...', c: 'dim' }]],
  },
  {
    cwd: '~/Documents/projects/website',
    cmd: 'cowsay "You did it!"',
    out: [[{ t: ' _____________' }], [{ t: '< You did it! >' }], [{ t: ' -------------' }], [{ t: '        \\   ^__^' }], [{ t: '         \\  (oo)\\_______' }], [{ t: '            (__)\\       )\\/\\' }], [{ t: '                ||----w |' }], [{ t: '                ||     ||' }]],
  },
];

function Prompt({ cwd }: { cwd: string }) {
  return (
    <>
      <span className="d-user">learner@sandbox</span>:<span className="d-path">{cwd}</span>$&nbsp;
    </>
  );
}

export function DemoTerminal() {
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [scene, setScene] = useState(reduce ? SCENES.length : 0);
  const [typed, setTyped] = useState(0);
  const [showOut, setShowOut] = useState(false);

  useEffect(() => {
    if (reduce) return;
    if (scene >= SCENES.length) {
      const t = window.setTimeout(() => {
        setScene(0);
        setTyped(0);
        setShowOut(false);
      }, 4500);
      return () => window.clearTimeout(t);
    }
    const s = SCENES[scene];
    if (typed < s.cmd.length) {
      const t = window.setTimeout(() => setTyped((n) => n + 1), typed === 0 ? 650 : 32 + Math.random() * 55);
      return () => window.clearTimeout(t);
    }
    if (!showOut) {
      const t = window.setTimeout(() => setShowOut(true), 260);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => {
      setScene((n) => n + 1);
      setTyped(0);
      setShowOut(false);
    }, 700 + s.out.length * 120);
    return () => window.clearTimeout(t);
  }, [scene, typed, showOut, reduce]);

  const visible = SCENES.slice(Math.max(0, Math.min(scene, SCENES.length) - 4), Math.min(scene, SCENES.length));
  const current = scene < SCENES.length ? SCENES[scene] : null;
  const lastCwd = SCENES[SCENES.length - 1].cwd;

  return (
    <div className="term-window demo-term" aria-label="Animated example of a terminal session" role="img">
      <div className="term-titlebar">
        <span className="term-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="term-title">learner@sandbox: {current?.cwd ?? lastCwd}</span>
      </div>
      <div className="demo-body" aria-hidden="true">
        {visible.map((s, i) => (
          <div key={`${scene}-${i}`}>
            <div>
              <Prompt cwd={s.cwd} />
              {s.cmd}
            </div>
            {s.out.map((line, j) => (
              <div key={j}>
                {line.map((seg, k) => (
                  <span key={k} className={seg.c ? `d-${seg.c}` : undefined}>
                    {seg.t}
                  </span>
                ))}
              </div>
            ))}
          </div>
        ))}
        {current ? (
          <div>
            <div>
              <Prompt cwd={current.cwd} />
              {current.cmd.slice(0, typed)}
              {!showOut && <span className="d-cursor" />}
            </div>
            {showOut &&
              current.out.map((line, j) => (
                <div key={j}>
                  {line.map((seg, k) => (
                    <span key={k} className={seg.c ? `d-${seg.c}` : undefined}>
                      {seg.t}
                    </span>
                  ))}
                </div>
              ))}
          </div>
        ) : (
          <div>
            <Prompt cwd={lastCwd} />
            <span className="d-cursor" />
          </div>
        )}
      </div>
    </div>
  );
}
