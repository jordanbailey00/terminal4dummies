// Every lesson must be solvable by following its own "Show me" solutions.

import { describe, expect, it } from 'vitest';
import { LESSONS } from '../lessons';
import { LessonRunner, buildLessonSystem } from '../lessons/engine';
import { Session } from '../shell/session';
import { HeadlessTerminal, settle, waitFor } from './harness';

describe('lessons are solvable', () => {
  for (const lesson of LESSONS) {
    it(lesson.id, async () => {
      const sys = buildLessonSystem(lesson);
      const term = new HeadlessTerminal(100, 30);
      const session = new Session({ system: sys, backend: term, banner: 'none', startDir: lesson.startDir });
      const runner = new LessonRunner(lesson, session);
      sys.hooks.onCommand = (ev) => runner.onCommand(ev);
      sys.hooks.onEditorEvent = (e) => runner.onEditorEvent(e);
      void session.start();
      await waitFor(() => /\$\s*$/.test(term.allText()));
      for (const step of lesson.steps) {
        for (const action of step.solution) {
          const before = runner.commands.length;
          if (typeof action === 'string') {
            term.type(action + '\r');
            const start = Date.now();
            while (runner.commands.length === before && Date.now() - start < 400) await settle(5);
          } else {
            await settle(action.delay ?? 60);
            term.type(action.keys);
            await settle(40);
          }
        }
        try {
          await waitFor(() => runner.completed.has(step.id), 4000);
        } catch {
          throw new Error(`step "${step.id}" did not complete.\nLast command: ${runner.lastEvent?.line}\nScreen:\n${term.allText()}`);
        }
      }
      expect(runner.done).toBe(true);
      session.dispose();
    }, 30000);
  }
});
