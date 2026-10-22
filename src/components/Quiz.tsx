// The quiz at the end of a lesson: answers are checked right away, with an
// explanation, and saved with the lesson's progress.

import { useState, type ReactNode } from 'react';
import { isCorrect, type QuizAnswer } from '../lessons/quiz';
import type { CommandQuestion, ChoiceQuestion, QuizQuestion } from '../lessons/types';
import { resetQuiz, setQuizAnswer, useProgress } from '../state/progress';
import { Markdown } from './Markdown';

const LETTERS = 'abcd';

export function Quiz({ lessonId, questions }: { lessonId: string; questions: QuizQuestion[] }) {
  const progress = useProgress();
  const saved = progress.lessons[lessonId]?.quiz;
  // answers saved for a different set of questions (the quiz changed since) are dropped
  const answers: (QuizAnswer | null)[] = saved && saved.length === questions.length ? saved : questions.map(() => null);
  const answered = answers.filter((a) => a !== null).length;
  const correct = questions.filter((q, i) => isCorrect(q, answers[i])).length;
  return (
    <section className="quiz" aria-labelledby="quiz-heading">
      <h2 id="quiz-heading" className="steps-heading">
        Quiz
      </h2>
      <ol className="quiz-list">
        {questions.map((q, i) => (
          <li key={`${lessonId}-${i}`} className="quiz-q">
            <div className="quiz-prompt">
              <span className="quiz-num">{i + 1}.</span>
              <Markdown source={q.prompt} />
            </div>
            {q.kind === 'command' ? (
              // a fresh input after "retry"
              <CommandAnswer key={answers[i] === null ? 'open' : 'done'} q={q} answer={answers[i]} onAnswer={(a) => setQuizAnswer(lessonId, i, questions.length, a)} />
            ) : (
              <ChoiceAnswer q={q} answer={answers[i]} onAnswer={(a) => setQuizAnswer(lessonId, i, questions.length, a)} />
            )}
          </li>
        ))}
      </ol>
      <div className="quiz-score" role="status">
        <span>{answered === questions.length ? `score: ${correct}/${questions.length}` : `${answered}/${questions.length} answered`}</span>
        {answered > 0 && (
          <button type="button" className="btn" onClick={() => resetQuiz(lessonId)}>
            retry
          </button>
        )}
      </div>
    </section>
  );
}

function Result({ right, children }: { right: boolean; children: ReactNode }) {
  return (
    <div className={`quiz-result ${right ? 'right' : 'wrong'}`} role="status">
      <span className="quiz-verdict">{right ? '✓ correct' : '✗ not quite'}</span>
      {children}
    </div>
  );
}

function ChoiceAnswer({ q, answer, onAnswer }: { q: ChoiceQuestion; answer: QuizAnswer | null; onAnswer: (a: number) => void }) {
  const done = typeof answer === 'number';
  return (
    <>
      <div className="quiz-options" role="group" aria-label="Answers">
        {q.options.map((o, oi) => {
          const state = !done ? '' : oi === q.answer ? ' right' : oi === answer ? ' wrong' : '';
          return (
            <button key={oi} type="button" className={`quiz-option${state}`} disabled={done} aria-pressed={done && oi === answer} onClick={() => onAnswer(oi)}>
              <span className="quiz-letter">{LETTERS[oi]})</span>
              <Markdown source={o} inline />
            </button>
          );
        })}
      </div>
      {done && (
        <Result right={answer === q.answer}>
          <Markdown source={q.explain} />
        </Result>
      )}
    </>
  );
}

function CommandAnswer({ q, answer, onAnswer }: { q: CommandQuestion; answer: QuizAnswer | null; onAnswer: (a: string) => void }) {
  const [text, setText] = useState('');
  const done = typeof answer === 'string';
  const right = isCorrect(q, answer);
  return (
    <>
      <form
        className="quiz-command"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onAnswer(text);
        }}
      >
        <span className="quiz-dollar" aria-hidden="true">
          $
        </span>
        <input
          type="text"
          value={done ? answer : text}
          onChange={(e) => setText(e.target.value)}
          disabled={done}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          aria-label="Type the command"
          placeholder="type the command"
        />
        {!done && (
          <button type="submit" className="btn" disabled={!text.trim()}>
            check
          </button>
        )}
      </form>
      {done && (
        <Result right={right}>
          {!right && (
            <p className="quiz-model">
              answer: <code>{q.accept[0]}</code>
            </p>
          )}
          <Markdown source={q.explain} />
        </Result>
      )}
    </>
  );
}
