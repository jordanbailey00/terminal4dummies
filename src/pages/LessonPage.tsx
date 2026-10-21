import type { Terminal } from '@xterm/xterm';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Markdown } from '../components/Markdown';
import { usePageTitle } from '../components/usePageTitle';
import { lessonById, moduleOf, neighbours, LESSONS } from '../lessons';
import { coach, type Tip } from '../lessons/coach';
import { LessonRunner, buildLessonSystem } from '../lessons/engine';
import type { Lesson, SolutionAction, Step } from '../lessons/types';
import { Link, navigate } from '../router';
import { createSystem } from '../shell';
import { clearMachine, loadMachine, saveMachine } from '../state/disk';
import { lessonProgress, markSteps, resetLessonProgress, useProgress } from '../state/progress';
import { TerminalView } from '../terminal/TerminalView';
import { createLiveSession, useLiveSession, type LiveSession } from '../terminal/useSession';
import { NotFound } from './NotFound';

const machineKey = (id: string) => `t4d.lesson.${id}.v1`;

function makeSession(lesson: Lesson): LiveSession {
  const saved = lessonProgress(lesson.id)?.steps.length ? loadMachine(machineKey(lesson.id)) : null;
  return createLiveSession({
    makeSystem: () => (saved ? createSystem({ snapshot: saved.fs }) : buildLessonSystem(lesson)),
    banner: lesson.banner ?? 'none',
    history: saved?.history,
    startDir: saved?.cwd ?? lesson.startDir,
  });
}

function solutionText(a: SolutionAction): string {
  return typeof a === 'string' ? a : a.label;
}

export function LessonPage({ lessonId }: { lessonId: string }) {
  const lesson = lessonById(lessonId);
  if (!lesson) return <NotFound />;
  return <LessonView key={lesson.id} lesson={lesson} />;
}

function LessonView({ lesson }: { lesson: Lesson }) {
  usePageTitle(lesson.title);
  useProgress();
  const mod = moduleOf(lesson);
  const { prev, next } = neighbours(lesson);
  const [generation, setGeneration] = useState(0);
  const live = useLiveSession(`${lesson.id}:${generation}`, () => makeSession(lesson));
  const [runner, setRunner] = useState<LessonRunner | null>(null);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [tip, setTip] = useState<Tip | null>(null);
  const [mobileTab, setMobileTab] = useState<'lesson' | 'terminal'>('lesson');
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef(0);

  useEffect(() => {
    if (!live) return;
    const saved = lessonProgress(lesson.id);
    const r = new LessonRunner(lesson, live.session, generation === 0 ? saved?.steps ?? [] : []);
    const sys = live.system;
    const persist = () => {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => saveMachine(machineKey(lesson.id), sys, live.session.history.entries, live.session.shell.state.cwd), 300);
    };
    sys.hooks.onCommand = (ev) => {
      const before = r.currentIndex;
      r.onCommand(ev);
      const t = coach(ev, live.session.shell);
      setTip(r.currentIndex !== before && t?.kind === 'error' ? null : t);
      persist();
    };
    sys.hooks.onEditorEvent = (e) => r.onEditorEvent(e);
    sys.hooks.onPrompt = (primary) => {
      if (!primary) {
        setTip({
          kind: 'info',
          title: 'The shell is waiting for more',
          body: 'The `>` prompt means your command is not finished yet, often because of a missing closing quote. Type the rest of it, or press <kbd>Ctrl</kbd>+<kbd>C</kbd> to start over.',
        });
      }
    };
    const off = r.subscribe(() => {
      markSteps(lesson.id, [...r.completed], r.done);
      if (r.justCompleted) {
        const step = lesson.steps.find((s) => s.id === r.justCompleted);
        const following = lesson.steps[r.currentIndex];
        setToast(step ? (following ? `✓ ${step.title}. Next: ${following.title}` : '✓ Lesson complete!') : null);
      }
      rerender();
    });
    setRunner(r);
    return () => {
      off();
      sys.hooks.onCommand = undefined;
      sys.hooks.onEditorEvent = undefined;
      sys.hooks.onPrompt = undefined;
      window.clearTimeout(saveTimer.current);
    };
  }, [live, lesson, generation]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const currentIndex = runner?.currentIndex ?? 0;
  const done = runner?.done ?? false;

  // keep the current step in view
  useEffect(() => {
    const el = panelRef.current?.querySelector('.step.current, .lesson-complete');
    if (el && runner && runner.completed.size > 0) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [currentIndex, done, runner]);

  const typeCommand = (cmd: string) => {
    if (!live) return;
    if (live.session.isBusy) {
      setNotice('A command is still running. Finish it or press Ctrl+C first.');
      return;
    }
    live.session.typeAtPrompt(cmd);
    setMobileTab('terminal');
    setTimeout(() => termRef.current?.focus(), 0);
  };

  const reset = () => {
    if (!window.confirm('Start this lesson over? Your progress in this lesson and its practice files will be reset.')) return;
    clearMachine(machineKey(lesson.id));
    resetLessonProgress(lesson.id);
    setTip(null);
    setGeneration((g) => g + 1);
  };

  const completedCount = runner ? lesson.steps.filter((s) => runner.completed.has(s.id)).length : 0;
  const lessonNumber = LESSONS.indexOf(lesson) + 1;
  const indexInModule = mod.lessons.indexOf(lesson) + 1;

  return (
    <div className={`lesson-layout show-${mobileTab}`}>
      <div className="lesson-tabs" role="tablist" aria-label="Lesson or terminal">
        <button type="button" role="tab" aria-selected={mobileTab === 'lesson'} className={mobileTab === 'lesson' ? 'active' : ''} onClick={() => setMobileTab('lesson')}>
          lesson
        </button>
        <button type="button" role="tab" aria-selected={mobileTab === 'terminal'} className={mobileTab === 'terminal' ? 'active' : ''} onClick={() => setMobileTab('terminal')}>
          terminal
        </button>
      </div>
      <section className="lesson-panel" ref={panelRef} aria-label="Lesson">
        <div className="lesson-crumbs">
          <Link to="/learn">← lessons</Link>
          <span className="faint">
            {mod.title} {indexInModule}/{mod.lessons.length}
          </span>
        </div>
        <h1 className="lesson-title">
          <span className="num">{String(lessonNumber).padStart(2, '0')}</span>
          {lesson.title}
        </h1>
        <div className="lesson-meta">
          <span>{lesson.minutes} min</span>
          <div className="progress" aria-hidden="true">
            <div className="progress-bar" style={{ width: `${(completedCount / lesson.steps.length) * 100}%` }} />
          </div>
          <span>
            {completedCount}/{lesson.steps.length} steps
          </span>
        </div>
        <Markdown source={lesson.intro} onRun={typeCommand} onNavigate={(h) => navigate(h)} className="lesson-intro" />

        <h2 className="steps-heading">Steps</h2>
        <ol className="steps">
          {lesson.steps.map((s, i) => (
            <StepItem
              key={s.id}
              step={s}
              index={i}
              state={runner?.completed.has(s.id) ? 'done' : i === currentIndex ? 'current' : 'todo'}
              justDone={runner?.justCompleted === s.id}
              tip={i === currentIndex ? tip : null}
              onDismissTip={() => setTip(null)}
              onRun={typeCommand}
              onSkip={() => runner?.skip(s.id)}
            />
          ))}
        </ol>

        {done && (
          <section className="lesson-complete">
            <div className="complete-label">✓ lesson complete</div>
            <Markdown source={lesson.recap} onRun={typeCommand} />
            {lesson.cheatsheet && (
              <table className="cheatsheet">
                <tbody>
                  {lesson.cheatsheet.map(([c, d]) => (
                    <tr key={c}>
                      <td>
                        <code>{c}</code>
                      </td>
                      <td>{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {lesson.realWorld && (
              <details className="real-world">
                <summary>On your own computer</summary>
                <Markdown source={lesson.realWorld} />
              </details>
            )}
            {next ? (
              <Link to={`/learn/${next.id}`} className="btn btn-accent">
                next: {next.title} →
              </Link>
            ) : (
              <Link to="/learn" className="btn btn-accent">
                all lessons
              </Link>
            )}
          </section>
        )}

        <nav className="lesson-nav" aria-label="Lesson navigation">
          {prev ? <Link to={`/learn/${prev.id}`}>← {prev.title}</Link> : <span />}
          {next && <Link to={`/learn/${next.id}`}>{next.title} →</Link>}
        </nav>
      </section>
      <section className="lesson-term" aria-label="Terminal">
        {live && (
          <TerminalView
            key={generation}
            backend={live.backend}
            system={live.system}
            initialTitle="learner@sandbox: ~"
            onReady={(t) => (termRef.current = t)}
            actions={
              <button type="button" onClick={reset} title="Start this lesson over">
                reset
              </button>
            }
          />
        )}
        {notice && <div className="term-notice">{notice}</div>}
      </section>
      {toast && mobileTab === 'terminal' && (
        <button type="button" className="step-toast" onClick={() => setMobileTab('lesson')}>
          {toast} <span className="faint">· view lesson</span>
        </button>
      )}
    </div>
  );
}

function StepItem({
  step,
  index,
  state,
  justDone,
  tip,
  onDismissTip,
  onRun,
  onSkip,
}: {
  step: Step;
  index: number;
  state: 'done' | 'current' | 'todo';
  justDone: boolean;
  tip: Tip | null;
  onDismissTip: () => void;
  onRun: (cmd: string) => void;
  onSkip: () => void;
}) {
  const [hint, setHint] = useState(false);
  const [shown, setShown] = useState(false);
  const single = step.solution.length === 1 && typeof step.solution[0] === 'string' ? (step.solution[0] as string) : null;
  const sequence = useMemo(() => step.solution.map(solutionText), [step]);
  return (
    <li className={`step ${state}${justDone ? ' just-done' : ''}`} aria-current={state === 'current' ? 'step' : undefined}>
      <div className="step-marker" aria-hidden="true">
        {state === 'done' ? '✓' : `${index + 1}.`}
      </div>
      <div className="step-content">
        <h3 className="step-title">
          {step.title}
          {state === 'done' && <span className="visually-hidden"> (done)</span>}
        </h3>
        {state === 'current' && (
          <>
            <Markdown source={step.instruction} onRun={onRun} />
            <div className="step-actions">
              {step.hint && (
                <button type="button" className="btn" onClick={() => setHint((h) => !h)} aria-expanded={hint}>
                  {hint ? 'hide hint' : 'hint'}
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (single) onRun(single);
                  else setShown((v) => !v);
                }}
              >
                {single ? 'type it for me' : shown ? 'hide solution' : 'show solution'}
              </button>
              {(hint || shown) && (
                <button type="button" className="btn skip" onClick={onSkip}>
                  skip step
                </button>
              )}
            </div>
            {hint && step.hint && (
              <div className="step-hint">
                <Markdown source={step.hint} onRun={onRun} />
              </div>
            )}
            {shown && !single && (
              <ol className="step-sequence">
                {sequence.map((s, i) => (
                  <li key={i}>{typeof step.solution[i] === 'string' ? <code>{s}</code> : s}</li>
                ))}
              </ol>
            )}
            {tip && (
              <div className={`coach-tip ${tip.kind}`} role="status">
                <div className="coach-head">
                  <strong>{tip.kind === 'error' ? 'what happened?' : tip.title}</strong>
                  <button type="button" className="coach-close" onClick={onDismissTip} aria-label="Dismiss">
                    dismiss
                  </button>
                </div>
                {tip.kind === 'error' && <div className="coach-title">{tip.title}</div>}
                <Markdown source={tip.body} onRun={onRun} />
              </div>
            )}
          </>
        )}
        {state === 'done' && step.explain && <Markdown source={step.explain} onRun={onRun} className="step-explain" />}
      </div>
    </li>
  );
}
