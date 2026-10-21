// Shell builtins: commands bash runs itself (no separate program on disk).

import type { IO } from '../io';
import type { Shell } from '../interpreter';
import type { InputStream, OutputStream } from '../streams';

export interface BuiltinContext {
  sh: Shell;
  argv: string[];
  args: string[];
  name: string;
  io: IO;
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
  out(s: string): Promise<void>;
  err(s: string): Promise<void>;
  /** Prints "bash: <name>: <message>". */
  error(message: string): Promise<void>;
}

export type BuiltinImpl = (ctx: BuiltinContext) => Promise<number>;

export interface BuiltinHelp {
  /** First line of `help`: "cd [-L|[-P [-e]] [-@]] [dir]" */
  usage: string;
  /** One-line summary. */
  summary: string;
  /** Longer explanation (plain text, wrapped by `help`). */
  body?: string;
}

export const BUILTINS = new Map<string, BuiltinImpl>();
export const BUILTIN_HELP = new Map<string, BuiltinHelp>();

/** Reserved words, reported by `type` as "shell keyword". */
export const KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'in',
  'function', 'time', '{', '}', '!', '[[', ']]', 'coproc',
]);

export function defineBuiltin(name: string, help: BuiltinHelp, impl: BuiltinImpl): void {
  BUILTINS.set(name, impl);
  BUILTIN_HELP.set(name, help);
}

/** Minimal option scanner for builtins: returns flags and the remaining args. */
export function scanFlags(args: string[], allowed: string): { flags: Set<string>; rest: string[]; bad: string | null } {
  const flags = new Set<string>();
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    for (const ch of a.slice(1)) {
      if (!allowed.includes(ch)) return { flags, rest: args.slice(i), bad: ch };
      flags.add(ch);
    }
  }
  return { flags, rest: args.slice(i), bad: null };
}
