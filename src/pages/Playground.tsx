import { useEffect, useRef, useState } from 'react';
import { createSystem } from '../shell';
import { IconReset } from '../components/Icons';
import { TerminalView } from '../terminal/TerminalView';
import { createLiveSession, useLiveSession } from '../terminal/useSession';
import { clearMachine, loadMachine, saveMachine } from '../state/disk';
import { usePageTitle } from '../components/usePageTitle';

const KEY = 't4d.playground.v1';

export function Playground() {
  usePageTitle('Playground');
  const [generation, setGeneration] = useState(0);
  const live = useLiveSession(`playground-${generation}`, () => {
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
    });
  });
  const saveTimer = useRef(0);

  useEffect(() => {
    if (!live) return;
    const save = () => {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => saveMachine(KEY, live.system, live.session.history.entries), 400);
    };
    live.system.hooks.onCommand = save;
    const onHide = () => saveMachine(KEY, live.system, live.session.history.entries);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.clearTimeout(saveTimer.current);
      saveMachine(KEY, live.system, live.session.history.entries);
    };
  }, [live]);

  const reset = () => {
    if (!window.confirm('Reset the playground computer? All files you created here will be erased.')) return;
    clearMachine(KEY);
    if (live) live.system.hooks.onCommand = undefined;
    setGeneration((g) => g + 1);
  };

  return (
    <div className="playground">
      <div className="playground-head">
        <div>
          <h1>Playground</h1>
          <p className="muted">A free practice computer. Try anything you like; your files are kept in this browser between visits.</p>
        </div>
      </div>
      <div className="playground-term">
        {live && (
          <TerminalView
            key={generation}
            backend={live.backend}
            initialTitle="learner@sandbox: ~"
            actions={
              <button type="button" onClick={reset} title="Erase everything and start fresh">
                <IconReset /> Reset
              </button>
            }
          />
        )}
      </div>
    </div>
  );
}
