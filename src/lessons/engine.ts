// Runs a lesson: builds its practice computer, watches the terminal, and
// marks steps complete when their checks pass.

import { createSystem } from '../shell';
import type { EditorEvent } from '../shell/readline';
import type { CommandEvent } from '../shell/repl';
import type { Session } from '../shell/session';
import type { System } from '../shell/system';
import { ROOT_CREDS, type OpContext } from '../shell/vfs/fs';
import { abs } from './checks';
import type { CheckContext, Lesson, LessonSetupEnv } from './types';

const DAY = 86400 * 1000;

/** A fresh computer prepared for a lesson. */
export function buildLessonSystem(lesson: Lesson, opts: { now?: () => number; delay?: System['delay'] } = {}): System {
  const sys = createSystem({ now: opts.now, delay: opts.delay });
  if (lesson.setup) lesson.setup(setupEnv(sys));
  return sys;
}

export function setupEnv(sys: System): LessonSetupEnv {
  const root: OpContext = { cwd: '/', creds: ROOT_CREDS, umask: 0o002 };
  const home = '/home/learner';
  const owner = (o: 'root' | 'learner' | undefined) => (o === 'root' ? { uid: 0, gid: 0 } : { uid: 1000, gid: 1000 });
  const mkdirp = (path: string, o: 'root' | 'learner' | undefined, mode?: number) => {
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      if (sys.fs.tryStat(cur, root)) continue;
      const n = sys.fs.mkdir(cur, root, 0o775);
      const own = owner(cur.startsWith(home) ? o ?? 'learner' : 'root');
      n.uid = own.uid;
      n.gid = own.gid;
      n.mode = 0o775;
    }
    if (mode !== undefined) sys.fs.lstat(path, root).mode = mode;
  };
  return {
    sys,
    home,
    file(path, content, o = {}) {
      const p = abs(path);
      mkdirp(p.slice(0, p.lastIndexOf('/')) || '/', o.owner);
      const n = sys.fs.writeFile(p, content, root, { mode: o.mode ?? 0o664 });
      n.mode = o.mode ?? 0o664;
      const own = owner(o.owner);
      n.uid = own.uid;
      n.gid = own.gid;
      if (o.daysAgo !== undefined) n.mtime = n.atime = sys.now() - o.daysAgo * DAY;
    },
    dir(path, o = {}) {
      mkdirp(abs(path), o.owner, o.mode);
    },
    remove(path) {
      const p = abs(path);
      const rm = (q: string) => {
        const n = sys.fs.tryStat(q, root, false);
        if (!n) return;
        if (n.type === 'dir') {
          for (const name of sys.fs.readdir(q, root)) rm(q + '/' + name);
          sys.fs.rmdir(q, root);
        } else sys.fs.unlink(q, root);
      };
      rm(p);
    },
  };
}

export interface StepState {
  done: boolean;
}

export type RunnerListener = (r: LessonRunner) => void;

/** Tracks progress through one lesson against a live session. */
export class LessonRunner {
  readonly lesson: Lesson;
  readonly session: Session;
  completed: Set<string>;
  commands: CommandEvent[] = [];
  keys: EditorEvent[] = [];
  lastEvent: CommandEvent | null = null;
  /** Step id that was most recently completed (for a celebration effect). */
  justCompleted: string | null = null;
  private listeners: RunnerListener[] = [];

  constructor(lesson: Lesson, session: Session, completed: Iterable<string> = []) {
    this.lesson = lesson;
    this.session = session;
    this.completed = new Set(completed);
  }

  get currentIndex(): number {
    const i = this.lesson.steps.findIndex((s) => !this.completed.has(s.id));
    return i === -1 ? this.lesson.steps.length : i;
  }

  get done(): boolean {
    return this.currentIndex >= this.lesson.steps.length;
  }

  subscribe(fn: RunnerListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(): void {
    for (const l of [...this.listeners]) l(this);
  }

  private context(ev: CommandEvent | null, key: EditorEvent | null): CheckContext {
    return { ev, key, commands: this.commands, keys: this.keys, sys: this.session.system, sh: this.session.shell };
  }

  /** Check the current step; returns true if it completed. */
  private evaluate(ev: CommandEvent | null, key: EditorEvent | null): boolean {
    const step = this.lesson.steps[this.currentIndex];
    if (!step) return false;
    let ok = false;
    try {
      ok = step.check(this.context(ev, key));
    } catch (e) {
      console.error('lesson check failed', e);
    }
    if (ok) {
      this.completed.add(step.id);
      this.justCompleted = step.id;
    }
    return ok;
  }

  onCommand(ev: CommandEvent): void {
    this.commands.push(ev);
    this.lastEvent = ev;
    this.justCompleted = null;
    this.evaluate(ev, null);
    this.emit();
  }

  onEditorEvent(e: EditorEvent): void {
    this.keys.push(e);
    if (this.keys.length > 200) this.keys.shift();
    if (this.evaluate(null, e)) this.emit();
  }

  /** Mark a step complete by hand ("Skip"). */
  skip(stepId: string): void {
    this.completed.add(stepId);
    this.justCompleted = stepId;
    this.emit();
  }
}
