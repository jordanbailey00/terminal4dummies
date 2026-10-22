// Quizzes: well-formed, mostly done in the terminal, and every task solvable
// by its own model answer (and not already "solved" before anything is typed).

import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../components/Markdown';
import { LESSONS } from '../lessons';
import { QuizRunner, buildQuizSystem } from '../lessons/quiz';
import type { QuizQuestion } from '../lessons/types';
import type { CommandEvent } from '../shell/repl';
import { Session } from '../shell/session';
import { HeadlessTerminal, settle, waitFor } from './harness';

function texts(q: QuizQuestion): string[] {
  return q.kind === 'task' ? [q.prompt, q.explain, q.hint ?? ''] : [q.prompt, ...q.options, q.explain];
}

describe('quiz runner', () => {
  const ev = (line: string) => ({ line, status: 0, execs: [] }) as unknown as CommandEvent;
  const session = { system: {}, shell: {} } as unknown as Session;
  const questions: QuizQuestion[] = [
    { kind: 'task', prompt: 'say hi', check: (c) => c.ev?.line === 'echo hi', solution: ['echo hi'], explain: 'e' },
    { prompt: 'pick b', options: ['a', 'b', 'c'], answer: 1, explain: 'e' },
    { kind: 'task', prompt: 'say bye twice', check: (c) => c.commands.filter((e) => e.line === 'echo bye').length >= 2, solution: ['echo bye', 'echo bye'], explain: 'e' },
    { kind: 'task', prompt: 'never', check: () => false, solution: ['true'], explain: 'e' },
  ];

  it('takes questions in order and counts tries', () => {
    const r = new QuizRunner(questions, session);
    r.onCommand(ev('ls'));
    expect(r.lastMiss?.line).toBe('ls');
    expect(r.entries[0]).toBeNull();
    r.onCommand(ev('echo hi'));
    expect(r.entries[0]).toEqual({ status: 'right', tries: 2, line: 'echo hi' });
    expect(r.currentIndex).toBe(1);
    r.onCommand(ev('echo hi'));
    expect(r.entries[1]).toBeNull();
    r.answer(2);
    expect(r.entries[1]).toEqual({ status: 'wrong', answer: 2 });
    // commands from earlier questions don't count for this one
    r.onCommand(ev('echo bye'));
    expect(r.entries[2]).toBeNull();
    r.reveal();
    r.onCommand(ev('echo bye'));
    expect(r.entries[2]?.status).toBe('revealed');
    r.skip();
    expect(r.entries[3]?.status).toBe('revealed');
    expect(r.done).toBe(true);
    expect(r.score).toBe(1);
  });
});

describe('quiz content', () => {
  for (const lesson of LESSONS) {
    it(lesson.id, () => {
      const quiz = lesson.quiz ?? [];
      const tasks = quiz.filter((q) => q.kind === 'task').length;
      const choices = quiz.length - tasks;
      expect(quiz.length, 'number of questions').toBeGreaterThanOrEqual(4);
      expect(quiz.length, 'number of questions').toBeLessThanOrEqual(6);
      expect(tasks, 'questions answered in the terminal').toBeGreaterThanOrEqual(3);
      expect(choices, 'multiple-choice questions').toBeLessThanOrEqual(2);
      const prompts = new Set<string>();
      for (const q of quiz) {
        expect(q.prompt.trim(), 'prompt').not.toBe('');
        expect(q.explain.trim(), `explanation for: ${q.prompt}`).not.toBe('');
        expect(prompts.has(q.prompt), `duplicate prompt: ${q.prompt}`).toBe(false);
        prompts.add(q.prompt);
        for (const t of texts(q)) {
          // `$ cmd` spans type themselves into the terminal when clicked
          expect(t, `clickable command in: ${t}`).not.toMatch(/`\$ /);
          expect(() => renderMarkdown(t)).not.toThrow();
        }
        if (q.kind === 'task') {
          expect(q.solution.length, `solution for: ${q.prompt}`).toBeGreaterThan(0);
          const first = q.solution.find((a): a is string => typeof a === 'string');
          // the prompt says what to achieve, not what to type
          if (first && first.length >= 4) expect(q.prompt, `prompt gives away the answer: ${first}`).not.toContain(first);
        } else {
          expect(q.options.length, `options for: ${q.prompt}`).toBeGreaterThanOrEqual(3);
          expect(q.options.length, `options for: ${q.prompt}`).toBeLessThanOrEqual(4);
          expect(new Set(q.options).size, `distinct options for: ${q.prompt}`).toBe(q.options.length);
          expect(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length, `answer index for: ${q.prompt}`).toBe(true);
        }
      }
    });
  }

  it('right answers are spread over the options', () => {
    const answers = LESSONS.flatMap((l) => l.quiz ?? []).flatMap((q) => (q.kind === 'task' ? [] : [q.answer]));
    if (answers.length < 20) return;
    for (const i of [0, 1, 2, 3]) {
      expect(answers.filter((a) => a === i).length / answers.length, `share of answers at option ${i}`).toBeLessThan(0.45);
    }
  });
});

describe('quizzes are solvable in the terminal', () => {
  for (const lesson of LESSONS) {
    const quiz = lesson.quiz ?? [];
    if (quiz.length === 0) continue;
    it(lesson.id, async () => {
      const sys = buildQuizSystem(lesson);
      const term = new HeadlessTerminal(100, 30);
      const session = new Session({ system: sys, backend: term, banner: 'none', startDir: lesson.quizStartDir ?? lesson.startDir });
      const runner = new QuizRunner(quiz, session);
      let events = 0;
      sys.hooks.onCommand = (ev) => {
        events++;
        runner.onCommand(ev);
      };
      sys.hooks.onEditorEvent = (e) => runner.onEditorEvent(e);
      void session.start();
      await waitFor(() => /\$\s*$/.test(term.allText()));
      for (const [i, q] of quiz.entries()) {
        if (q.kind !== 'task') {
          runner.answer(q.answer);
          expect(runner.entries[i]?.status).toBe('right');
          continue;
        }
        expect(q.check(runner.context(null, null)), `question ${i + 1} counts as done before anything was typed`).toBe(false);
        for (const action of q.solution) {
          const before = events;
          if (typeof action === 'string') {
            term.type(action + '\r');
            const start = Date.now();
            while (events === before && Date.now() - start < 400) await settle(5);
          } else {
            await settle(action.delay ?? 60);
            term.type(action.keys);
            await settle(40);
          }
        }
        try {
          await waitFor(() => runner.entries[i] !== null, 4000);
        } catch {
          throw new Error(`question ${i + 1} ("${q.prompt.slice(0, 60)}") was not answered by its solution.\nLast command: ${runner.lastMiss?.line}\nScreen:\n${term.allText()}`);
        }
        expect(runner.entries[i]?.status, `question ${i + 1}`).toBe('right');
      }
      expect(runner.done).toBe(true);
      session.dispose();
    }, 60000);
  }
});
