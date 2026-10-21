// Lesson content model.

import type { Shell } from '../shell/interpreter';
import type { EditorEvent } from '../shell/readline';
import type { CommandEvent } from '../shell/repl';
import type { System } from '../shell/system';

/** One thing to type or press. A string is a command line followed by Enter. */
export type SolutionAction = string | { keys: string; label: string; delay?: number };

export interface CheckContext {
  /** The command that just finished (null when the trigger was a key event). */
  ev: CommandEvent | null;
  /** The line-editor event that triggered this check, if any. */
  key: EditorEvent | null;
  /** Every command run so far in this lesson (oldest first). */
  commands: CommandEvent[];
  /** Every line-editor event so far in this lesson. */
  keys: EditorEvent[];
  sys: System;
  sh: Shell;
}

export interface Step {
  id: string;
  /** Short title shown in the step list. */
  title: string;
  /** Markdown: what to do. Write commands as `$ ls -a` to make them clickable. */
  instruction: string;
  hint?: string;
  /** What "Show me" types, and what the automated lesson test performs. */
  solution: SolutionAction[];
  /** Markdown shown after the step is completed. */
  explain?: string;
  check: (c: CheckContext) => boolean;
}

export interface LessonSetupEnv {
  sys: System;
  /** Absolute path of the learner's home directory. */
  home: string;
  /** Create a file owned by the learner (path relative to home unless absolute). */
  file(path: string, content: string, opts?: { mode?: number; daysAgo?: number; owner?: 'root' | 'learner' }): void;
  dir(path: string, opts?: { mode?: number; owner?: 'root' | 'learner' }): void;
  remove(path: string): void;
}

export interface Lesson {
  id: string;
  title: string;
  /** One sentence for the catalog. */
  summary: string;
  moduleId: string;
  minutes: number;
  /** Markdown shown above the steps (the concepts). */
  intro: string;
  setup?: (env: LessonSetupEnv) => void;
  /** Starting directory (relative to home). */
  startDir?: string;
  /** Text printed when the terminal starts (defaults to nothing). */
  banner?: string;
  steps: Step[];
  /** Markdown recap shown when the lesson is complete. */
  recap: string;
  /** Commands covered: [command, what it does]. */
  cheatsheet?: [string, string][];
  /** Markdown notes about macOS / Windows / real-world differences. */
  realWorld?: string;
}

export interface Module {
  id: string;
  title: string;
  description: string;
  lessons: Lesson[];
}
