import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../components/Markdown';
import { LESSONS } from '../lessons';
import { commandMatches, isCorrect, normalizeCommand } from '../lessons/quiz';
import type { CommandQuestion, QuizQuestion } from '../lessons/types';
import { parse } from '../shell/parser/parser';

function texts(q: QuizQuestion): string[] {
  return q.kind === 'command' ? [q.prompt, q.explain] : [q.prompt, ...q.options, q.explain];
}

describe('answer checking', () => {
  const q: CommandQuestion = { kind: 'command', prompt: 'p', accept: ['ls -a', /^ls\s+-[a-zA-Z]*a[a-zA-Z]*$/], explain: 'e' };
  it('normalizes what was typed', () => {
    expect(normalizeCommand('  $ ls    -a  ')).toBe('ls -a');
    expect(commandMatches(q, 'ls  -a')).toBe(true);
    expect(commandMatches(q, '$ ls -la')).toBe(true);
    expect(commandMatches(q, 'ls')).toBe(false);
    expect(commandMatches(q, '')).toBe(false);
    expect(normalizeCommand('touch  "a  b.txt"   c')).toBe('touch "a  b.txt" c');
    expect(isCorrect({ prompt: 'p', options: ['a', 'b', 'c'], answer: 1, explain: 'e' }, 1)).toBe(true);
    expect(isCorrect({ prompt: 'p', options: ['a', 'b', 'c'], answer: 1, explain: 'e' }, 2)).toBe(false);
  });
});

describe('lesson quizzes', () => {
  for (const lesson of LESSONS) {
    it(lesson.id, () => {
      const quiz = lesson.quiz ?? [];
      expect(quiz.length, 'number of questions').toBeGreaterThanOrEqual(3);
      expect(quiz.length, 'number of questions').toBeLessThanOrEqual(5);
      const prompts = new Set<string>();
      for (const q of quiz) {
        expect(q.prompt.trim(), 'prompt').not.toBe('');
        expect(q.explain.trim(), `explanation for: ${q.prompt}`).not.toBe('');
        expect(prompts.has(q.prompt), `duplicate prompt: ${q.prompt}`).toBe(false);
        prompts.add(q.prompt);
        for (const t of texts(q)) {
          // `$ cmd` spans become clickable terminal commands, which makes no sense in a quiz
          expect(t, `runnable span in: ${t}`).not.toMatch(/`\$ /);
          expect(() => renderMarkdown(t)).not.toThrow();
        }
        if (q.kind === 'command') {
          expect(typeof q.accept[0], 'first accepted answer is the model answer').toBe('string');
          expect(commandMatches(q, q.accept[0]), `model answer accepted: ${q.accept[0]}`).toBe(true);
          for (const a of q.accept) {
            if (typeof a === 'string') expect(() => parse(a), `valid shell syntax: ${a}`).not.toThrow();
            else expect(a.test(''), `pattern matches nothing: ${a}`).toBe(false);
          }
        } else {
          expect(q.options.length, `options for: ${q.prompt}`).toBeGreaterThanOrEqual(3);
          expect(q.options.length, `options for: ${q.prompt}`).toBeLessThanOrEqual(4);
          expect(new Set(q.options).size, `distinct options for: ${q.prompt}`).toBe(q.options.length);
          for (const o of q.options) expect(o.trim()).not.toBe('');
          expect(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length, `answer index for: ${q.prompt}`).toBe(true);
        }
      }
    });
  }

  it('right answers are spread over the options', () => {
    const answers = LESSONS.flatMap((l) => l.quiz ?? []).flatMap((q) => (q.kind === 'command' ? [] : [q.answer]));
    if (answers.length < 20) return;
    for (const i of [0, 1, 2, 3]) {
      expect(answers.filter((a) => a === i).length / answers.length, `share of answers at option ${i}`).toBeLessThan(0.45);
    }
  });
});
