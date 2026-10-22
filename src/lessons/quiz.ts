// Checking quiz answers.

import type { CommandQuestion, QuizQuestion } from './types';

/** Trim, drop a typed "$ " prompt, and collapse runs of blanks outside quotes. */
export function normalizeCommand(s: string): string {
  const t = s.trim().replace(/^\$\s+/, '');
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && quote !== "'" && i + 1 < t.length) {
      out += c + t[++i];
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      out += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (!out.endsWith(' ')) out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

export function commandMatches(q: CommandQuestion, input: string): boolean {
  const line = normalizeCommand(input);
  if (line === '') return false;
  return q.accept.some((a) => (typeof a === 'string' ? normalizeCommand(a) === line : a.test(line)));
}

/** A learner's answer: an option index (choice) or the typed text (command). */
export type QuizAnswer = number | string;

export function isCorrect(q: QuizQuestion, a: QuizAnswer | null | undefined): boolean {
  if (a === null || a === undefined) return false;
  if (q.kind === 'command') return typeof a === 'string' && commandMatches(q, a);
  return a === q.answer;
}
