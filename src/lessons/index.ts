// The curriculum: modules in order, each with its lessons.

import { anatomy, shortcuts, welcome } from './content/basics';
import { beyondLessons } from './content/beyond';
import { filesLessons } from './content/files';
import { lookingCloser, movingAround, whereAmI } from './content/navigation';
import { permissionsLessons } from './content/permissions';
import { processesLessons } from './content/processes';
import { readingLessons } from './content/reading';
import { scriptingLessons } from './content/scripting';
import { shellLessons } from './content/shell';
import { textLessons } from './content/text';
import type { Lesson, Module } from './types';

const ALL_MODULES: Module[] = [
  {
    id: 'basics',
    title: 'First steps',
    description: 'What a terminal is, how to run commands, and the shortcuts that make it pleasant.',
    lessons: [welcome, anatomy, shortcuts],
  },
  {
    id: 'navigation',
    title: 'Finding your way around',
    description: 'The folder tree, your home folder, and moving around with cd and ls.',
    lessons: [whereAmI, movingAround, lookingCloser],
  },
  {
    id: 'files',
    title: 'Working with files',
    description: 'Create, copy, move, rename and delete files and folders, and select many at once with wildcards.',
    lessons: filesLessons,
  },
  {
    id: 'reading',
    title: 'Reading and writing',
    description: 'Look inside files, find help for any command, edit text with nano, and send output into files.',
    lessons: readingLessons,
  },
  {
    id: 'text',
    title: 'Pipes and power tools',
    description: 'Chain commands together and search, sort, count and reshape text like a pro.',
    lessons: textLessons,
  },
  {
    id: 'permissions',
    title: 'Permissions and power',
    description: 'Who may read, change and run each file, how to act as the administrator, and how to install software.',
    lessons: permissionsLessons,
  },
  {
    id: 'shell',
    title: 'Your shell, your way',
    description: 'Variables, the PATH, exit codes, chaining commands, aliases and your .bashrc.',
    lessons: shellLessons,
  },
  {
    id: 'processes',
    title: 'Processes and jobs',
    description: 'See what is running, stop it, pause it, and run things in the background.',
    lessons: processesLessons,
  },
  {
    id: 'scripting',
    title: 'Automating with scripts',
    description: 'Save commands in a script and teach it to make decisions and repeat work.',
    lessons: scriptingLessons,
  },
  {
    id: 'beyond',
    title: 'Beyond this computer',
    description: 'Archives, downloads and remote computers, plus how to use what you learned on your own machine.',
    lessons: beyondLessons,
  },
];

/** Modules that have at least one lesson. */
export const MODULES: Module[] = ALL_MODULES.filter((m) => m.lessons.length > 0);

export const LESSONS: Lesson[] = MODULES.flatMap((m) => m.lessons);

export function lessonById(id: string): Lesson | undefined {
  return LESSONS.find((l) => l.id === id);
}

export function moduleOf(lesson: Lesson): Module {
  return MODULES.find((m) => m.id === lesson.moduleId)!;
}

export function neighbours(lesson: Lesson): { prev: Lesson | null; next: Lesson | null } {
  const i = LESSONS.indexOf(lesson);
  return { prev: LESSONS[i - 1] ?? null, next: LESSONS[i + 1] ?? null };
}
