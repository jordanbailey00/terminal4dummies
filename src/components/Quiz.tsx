// The quiz at the end of a lesson. Questions come one at a time: tasks are
// answered by doing them in the terminal, multiple choice by picking an option.

import { useState } from 'react';
import type { Tip } from '../lessons/coach';
import type { QuizEntry, QuizRunner } from '../lessons/quiz';
import type { ChoiceQuestion, QuizQuestion, SolutionAction, TaskQuestion } from '../lessons/types';
import { Markdown } from './Markdown';

const LETTERS = 'abcd';

export interface QuizPanelProps {
  questions: QuizQuestion[];
  /** Saved results (null: the quiz was never started). */
  entries: (QuizEntry | null)[] | null;
  /** Present while the terminal is running the quiz. */
  runner: QuizRunner | null;
  /** The coach's explanation of the last failed command. */
  tip: Tip | null;
  onStart: () => void;
  onResume: () => void;
  onLeave: () => void;
  onShowTerminal: () => void;
}

export function QuizPanel({ questions, entries, runner, tip, onStart, onResume, onLeave, onShowTerminal }: QuizPanelProps) {
  const list = runner ? runner.entries : entries;
  const started = list !== null;
  const answered = list ? list.filter((e) => e !== null).length : 0;
  const finished = started && answered === questions.length;
  const current = runner && !finished ? runner.currentIndex : -1;
  const tasks = questions.filter((q) => q.kind === 'task').length;
  const score = list ? list.filter((e) => e?.status === 'right').length : 0;

  return (
    <section className="quiz" aria-labelledby="quiz-heading">
      <h2 id="quiz-heading" className="steps-heading">
        Quiz
      </h2>
      {!started && (
        <div className="quiz-intro">
          <p>
            {questions.length} questions: {tasks} you answer by doing them in the terminal, the rest by picking an answer. The terminal switches to a fresh copy of this lesson's files.
          </p>
          <button type="button" className="btn btn-accent" onClick={onStart}>
            start quiz
          </button>
        </div>
      )}
      {started && !runner && !finished && (
        <div className="quiz-intro">
          <p>
            {answered}/{questions.length} answered.
          </p>
          <div className="quiz-buttons">
            <button type="button" className="btn btn-accent" onClick={onResume}>
              continue quiz
            </button>
            <button type="button" className="btn" onClick={onStart}>
              start over
            </button>
          </div>
        </div>
      )}
      {started && (
        <ol className="quiz-list">
          {questions.map((q, i) => {
            const entry = list?.[i] ?? null;
            if (entry) return <AnsweredItem key={i} q={q} index={i} entry={entry} />;
            if (i === current && runner) {
              return q.kind === 'task' ? (
                <ActiveTask key={i} q={q} index={i} runner={runner} tip={tip} onShowTerminal={onShowTerminal} />
              ) : (
                <ActiveChoice key={i} q={q} index={i} runner={runner} />
              );
            }
            return (
              <li key={i} className="quiz-q upcoming">
                <span className="quiz-num">{i + 1}.</span>
                <span className="faint">{q.kind === 'task' ? 'terminal task' : 'multiple choice'}</span>
              </li>
            );
          })}
        </ol>
      )}
      {finished && (
        <div className="quiz-score">
          <span>
            score: {score}/{questions.length}
          </span>
          <button type="button" className="btn" onClick={onStart}>
            retry quiz
          </button>
          {runner && (
            <button type="button" className="btn" onClick={onLeave}>
              back to the lesson's terminal
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Prompt({ q, index }: { q: QuizQuestion; index: number }) {
  return (
    <div className="quiz-prompt">
      <span className="quiz-num">{index + 1}.</span>
      <Markdown source={q.prompt} />
    </div>
  );
}

function Solution({ actions }: { actions: SolutionAction[] }) {
  return (
    <ol className="quiz-solution">
      {actions.map((a, i) => (
        <li key={i}>{typeof a === 'string' ? <code>{a}</code> : a.label}</li>
      ))}
    </ol>
  );
}

function AnsweredItem({ q, index, entry }: { q: QuizQuestion; index: number; entry: QuizEntry }) {
  const verdict = entry.status === 'right' ? '✓ correct' : entry.status === 'wrong' ? '✗ wrong' : '– answer shown';
  return (
    <li className={`quiz-q answered ${entry.status}`}>
      <Prompt q={q} index={index} />
      {q.kind !== 'task' && <Options q={q} picked={entry.answer ?? null} />}
      <div className={`quiz-result ${entry.status}`}>
        <span className="quiz-verdict">
          {verdict}
          {q.kind === 'task' && entry.status === 'right' && entry.line ? (
            <>
              {' '}
              with <code>{entry.line}</code>
            </>
          ) : null}
          {q.kind === 'task' && entry.status === 'right' && (entry.tries ?? 0) > 1 ? ` · ${entry.tries} tries` : ''}
        </span>
        {q.kind === 'task' && entry.status === 'revealed' && <Solution actions={q.solution} />}
        <Markdown source={q.explain} />
      </div>
    </li>
  );
}

function Options({ q, picked, onPick }: { q: ChoiceQuestion; picked: number | null; onPick?: (i: number) => void }) {
  const done = picked !== null;
  return (
    <div className="quiz-options" role="group" aria-label="Answers">
      {q.options.map((o, oi) => {
        const state = !done ? '' : oi === q.answer ? ' right' : oi === picked ? ' wrong' : '';
        return (
          <button key={oi} type="button" className={`quiz-option${state}`} disabled={done} aria-pressed={done && oi === picked} onClick={() => onPick?.(oi)}>
            <span className="quiz-letter">{LETTERS[oi]})</span>
            <Markdown source={o} inline />
          </button>
        );
      })}
    </div>
  );
}

function ActiveChoice({ q, index, runner }: { q: ChoiceQuestion; index: number; runner: QuizRunner }) {
  return (
    <li className="quiz-q current" aria-current="step">
      <Prompt q={q} index={index} />
      <Options q={q} picked={null} onPick={(i) => runner.answer(i)} />
    </li>
  );
}

function ActiveTask({ q, index, runner, tip, onShowTerminal }: { q: TaskQuestion; index: number; runner: QuizRunner; tip: Tip | null; onShowTerminal: () => void }) {
  const [hint, setHint] = useState(false);
  const miss = runner.lastMiss;
  return (
    <li className="quiz-q current" aria-current="step">
      <Prompt q={q} index={index} />
      <div className="quiz-waiting">
        <span>→ do it in the terminal</span>
        <button type="button" className="btn mobile-only" onClick={onShowTerminal}>
          terminal
        </button>
      </div>
      {miss && (
        <div className="quiz-result wrong" role="status">
          <span className="quiz-verdict">
            ✗ not yet: <code>{miss.line.trim()}</code> didn't do it
          </span>
          {tip && (
            <>
              <strong className="quiz-tip-title">{tip.title}</strong>
              <Markdown source={tip.body} />
            </>
          )}
        </div>
      )}
      <div className="step-actions">
        {q.hint && (
          <button type="button" className="btn" onClick={() => setHint((h) => !h)} aria-expanded={hint}>
            {hint ? 'hide hint' : 'hint'}
          </button>
        )}
        {!runner.revealed ? (
          <button type="button" className="btn" onClick={() => runner.reveal()}>
            show answer
          </button>
        ) : (
          <button type="button" className="btn skip" onClick={() => runner.skip()}>
            skip
          </button>
        )}
      </div>
      {hint && q.hint && (
        <div className="step-hint">
          <Markdown source={q.hint} />
        </div>
      )}
      {runner.revealed && (
        <div className="step-hint">
          <p className="quiz-solution-label">one way to do it (this question won't count):</p>
          <Solution actions={q.solution} />
        </div>
      )}
    </li>
  );
}
