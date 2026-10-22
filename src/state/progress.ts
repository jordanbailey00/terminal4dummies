// Lesson progress, saved in localStorage.

import { useSyncExternalStore } from 'react';
import type { QuizEntry } from '../lessons/quiz';
import { safeGet, safeRemove, safeSet } from './prefs';

export interface LessonProgress {
  steps: string[];
  done: boolean;
  updated: number;
  /** Quiz results by question number (null: not answered yet). Present once the quiz was started. */
  quiz?: (QuizEntry | null)[];
}

export interface ProgressState {
  lessons: Record<string, LessonProgress>;
}

const KEY = 't4d.progress.v1';
let state: ProgressState = load();
const listeners = new Set<() => void>();

function load(): ProgressState {
  const raw = safeGet(KEY);
  if (!raw) return { lessons: {} };
  try {
    const parsed = JSON.parse(raw) as ProgressState;
    return parsed && parsed.lessons ? parsed : { lessons: {} };
  } catch {
    return { lessons: {} };
  }
}

function commit(next: ProgressState): void {
  state = next;
  safeSet(KEY, JSON.stringify(state));
  for (const l of listeners) l();
}

export function getProgress(): ProgressState {
  return state;
}

export function lessonProgress(id: string): LessonProgress | undefined {
  return state.lessons[id];
}

export function markSteps(lessonId: string, steps: string[], done: boolean): void {
  const prev = state.lessons[lessonId];
  const merged = Array.from(new Set([...(prev?.steps ?? []), ...steps]));
  if (prev && prev.done === (prev.done || done) && merged.length === prev.steps.length) return;
  commit({ lessons: { ...state.lessons, [lessonId]: { ...prev, steps: merged, done: prev?.done || done, updated: Date.now() } } });
}

/** Save a lesson's quiz results. */
export function setQuizEntries(lessonId: string, quiz: (QuizEntry | null)[]): void {
  const prev = state.lessons[lessonId];
  commit({ lessons: { ...state.lessons, [lessonId]: { steps: prev?.steps ?? [], done: prev?.done ?? false, updated: Date.now(), quiz: [...quiz] } } });
}

/** Clear a lesson's quiz answers so it can be taken again. */
export function resetQuiz(lessonId: string): void {
  const prev = state.lessons[lessonId];
  if (!prev?.quiz) return;
  const next = { ...prev, updated: Date.now() };
  delete next.quiz;
  commit({ lessons: { ...state.lessons, [lessonId]: next } });
}

export function resetLessonProgress(lessonId: string): void {
  const next = { ...state.lessons };
  delete next[lessonId];
  commit({ lessons: next });
}

export function resetAllProgress(): void {
  safeRemove(KEY);
  commit({ lessons: {} });
}

export function useProgress(): ProgressState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      state = load();
      for (const l of listeners) l();
    }
  });
}
