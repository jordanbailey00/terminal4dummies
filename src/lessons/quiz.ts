// Runs a lesson's quiz. Questions come one at a time: a task is answered by
// doing it in the terminal (checked after every command or key, like a lesson
// step), a multiple-choice question by picking an option on the page.

import type { EditorEvent } from '../shell/readline';
import type { CommandEvent } from '../shell/repl';
import type { Session } from '../shell/session';
import type { System } from '../shell/system';
import { buildLessonSystem, setupEnv } from './engine';
import type { CheckContext, Lesson, QuizQuestion } from './types';

export type QuizStatus = 'right' | 'wrong' | 'revealed';

export interface QuizEntry {
  status: QuizStatus;
  /** The option picked (multiple choice). */
  answer?: number;
  /** Commands run while working on a task, including the one that did it. */
  tries?: number;
  /** The command line that did it. */
  line?: string;
}

/** The quiz's computer: a fresh copy of the lesson's, plus the quiz's extras. */
export function buildQuizSystem(lesson: Lesson, opts: Parameters<typeof buildLessonSystem>[1] = {}): System {
  const sys = buildLessonSystem(lesson, opts);
  lesson.quizSetup?.(setupEnv(sys));
  return sys;
}

/** Saved answers, if they still fit this quiz (its questions may have changed since). */
export function savedEntries(quiz: QuizQuestion[], saved: unknown): (QuizEntry | null)[] | null {
  if (!Array.isArray(saved) || saved.length !== quiz.length) return null;
  const fits = saved.every((e) => e === null || (typeof e === 'object' && ['right', 'wrong', 'revealed'].includes((e as QuizEntry).status)));
  return fits ? (saved as (QuizEntry | null)[]) : null;
}

export class QuizRunner {
  readonly questions: QuizQuestion[];
  readonly session: Session;
  entries: (QuizEntry | null)[];
  /** What happened since the current question came up. */
  commands: CommandEvent[] = [];
  keys: EditorEvent[] = [];
  /** The last command that did not answer the current task. */
  lastMiss: CommandEvent | null = null;
  /** "Show answer" was used on the current question. */
  revealed = false;
  private listeners: (() => void)[] = [];

  constructor(questions: QuizQuestion[], session: Session, entries?: (QuizEntry | null)[] | null) {
    this.questions = questions;
    this.session = session;
    this.entries = entries ? [...entries] : questions.map(() => null);
  }

  get currentIndex(): number {
    const i = this.entries.findIndex((e) => e === null);
    return i === -1 ? this.entries.length : i;
  }

  get current(): QuizQuestion | null {
    return this.questions[this.currentIndex] ?? null;
  }

  get done(): boolean {
    return this.currentIndex >= this.questions.length;
  }

  get score(): number {
    return this.entries.filter((e) => e?.status === 'right').length;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  private finish(entry: QuizEntry): void {
    const i = this.currentIndex;
    this.entries = this.entries.map((e, k) => (k === i ? entry : e));
    this.commands = [];
    this.keys = [];
    this.lastMiss = null;
    this.revealed = false;
  }

  context(ev: CommandEvent | null, key: EditorEvent | null): CheckContext {
    return { ev, key, commands: this.commands, keys: this.keys, sys: this.session.system, sh: this.session.shell };
  }

  /** Check the current task; true if it is now done. */
  private evaluate(ev: CommandEvent | null, key: EditorEvent | null): boolean {
    const q = this.current;
    if (!q || q.kind !== 'task') return false;
    let ok = false;
    try {
      ok = q.check(this.context(ev, key));
    } catch (e) {
      console.error('quiz check failed', e);
    }
    if (ok) this.finish({ status: this.revealed ? 'revealed' : 'right', tries: this.commands.length, line: ev?.line.trim() });
    return ok;
  }

  onCommand(ev: CommandEvent): void {
    const q = this.current;
    if (!q || q.kind !== 'task') return;
    this.commands.push(ev);
    if (!this.evaluate(ev, null)) this.lastMiss = ev;
    this.emit();
  }

  onEditorEvent(e: EditorEvent): void {
    const q = this.current;
    if (!q || q.kind !== 'task') return;
    this.keys.push(e);
    if (this.keys.length > 200) this.keys.shift();
    if (this.evaluate(null, e)) this.emit();
  }

  /** Pick an option of the current multiple-choice question. */
  answer(option: number): void {
    const q = this.current;
    if (!q || q.kind === 'task') return;
    this.finish({ status: option === q.answer ? 'right' : 'wrong', answer: option });
    this.emit();
  }

  /** Show the answer to the current question (it no longer counts as right). */
  reveal(): void {
    this.revealed = true;
    this.emit();
  }

  /** Move on without answering. */
  skip(): void {
    if (this.done) return;
    this.finish({ status: 'revealed' });
    this.emit();
  }
}
