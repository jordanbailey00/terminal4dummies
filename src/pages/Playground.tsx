import { useEffect, useRef, useState } from 'react';
import { createSystem } from '../shell';
import { IconReset } from '../components/Icons';
import { Markdown } from '../components/Markdown';
import { TerminalView } from '../terminal/TerminalView';
import { createLiveSession, useLiveSession } from '../terminal/useSession';
import { clearMachine, loadMachine, saveMachine } from '../state/disk';
import { usePageTitle } from '../components/usePageTitle';
import { coach, type Tip } from '../lessons/coach';
import type { Terminal } from '@xterm/xterm';

const KEY = 't4d.playground.v1';

const IDEAS = ['ls -la', 'cat welcome.txt', 'tree', 'man ls', 'cd Documents', 'grep -r milk .', 'history', 'sudo apt install cowsay', 'top', 'nano notes.txt', 'curl example.com', 'ssh webserver'];

export function Playground() {
  usePageTitle('Playground');
  const [generation, setGeneration] = useState(0);
  const skipSave = useRef(false);
  const live = useLiveSession(`playground-${generation}`, () => {
    skipSave.current = false;
    const saved = loadMachine(KEY);
    return createLiveSession({
      makeSystem: () => {
        if (saved) {
          const sys = createSystem({ snapshot: saved.fs });
          sys.hostname = saved.hostname || 'sandbox';
          return sys;
        }
        return createSystem();
      },
      history: saved?.history,
      banner: saved ? 'none' : 'welcome',
      startDir: saved?.cwd,
    });
  });
  const [tip, setTip] = useState<Tip | null>(null);
  const saveTimer = useRef(0);
  const termRef = useRef<Terminal | null>(null);

  // /playground?cmd=... types a command at the prompt (used by "Try it" buttons)
  useEffect(() => {
    if (!live) return;
    const cmd = new URLSearchParams(window.location.search).get('cmd');
    if (!cmd) return;
    let cancelled = false;
    void live.backend.whenAttached().then(() =>
      setTimeout(() => {
        if (!cancelled) live.session.typeAtPrompt(cmd);
      }, 400),
    );
    window.history.replaceState(null, '', '/playground');
    return () => {
      cancelled = true;
    };
  }, [live]);

  useEffect(() => {
    if (!live) return;
    const save = () => {
      if (skipSave.current) return;
      saveMachine(KEY, live.system, live.session.history.entries, live.session.shell.state.cwd);
    };
    live.system.hooks.onCommand = (ev) => {
      setTip(coach(ev, live.session.shell));
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(save, 400);
    };
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      window.clearTimeout(saveTimer.current);
      live.system.hooks.onCommand = undefined;
      save();
    };
  }, [live]);

  const reset = () => {
    if (!window.confirm('Reset the playground computer? All files you created here will be erased.')) return;
    skipSave.current = true;
    clearMachine(KEY);
    setTip(null);
    setGeneration((g) => g + 1);
  };

  const type = (cmd: string) => {
    if (!live) return;
    if (live.session.isBusy) return;
    live.session.typeAtPrompt(cmd);
    setTimeout(() => termRef.current?.focus(), 0);
  };

  return (
    <div className="playground">
      <div className="playground-head">
        <div>
          <h1>Playground</h1>
          <p className="muted">A free practice computer. Try anything; your files stay in this browser between visits.</p>
        </div>
        <div className="ideas" aria-label="Ideas to try">
          <span className="faint">Try:</span>
          {IDEAS.map((i) => (
            <button key={i} type="button" className="idea" onClick={() => type(i)}>
              {i}
            </button>
          ))}
        </div>
      </div>
      <div className="playground-term">
        {live && (
          <TerminalView
            key={generation}
            backend={live.backend}
            system={live.system}
            initialTitle="learner@sandbox: ~"
            onReady={(t) => (termRef.current = t)}
            actions={
              <button type="button" onClick={reset} title="Erase everything and start fresh">
                <IconReset /> Reset
              </button>
            }
          />
        )}
      </div>
      {tip && (
        <div className={`coach-tip playground-tip ${tip.kind}`} role="status">
          <div className="coach-head">
            <strong>{tip.kind === 'error' ? `What happened? ${tip.title}` : tip.title}</strong>
            <button type="button" className="coach-close" onClick={() => setTip(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
          <Markdown source={tip.body} onRun={type} />
        </div>
      )}
    </div>
  );
}
