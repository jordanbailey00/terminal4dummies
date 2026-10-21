// Per-shell state: variables, functions, aliases, options, working directory.
// Subshells get a deep copy (fork) so changes don't leak back.

import type { FunctionDef } from './parser/ast';
import type { Credentials } from './vfs/fs';

export interface Variable {
  value: string;
  exported: boolean;
  readonly: boolean;
  integer: boolean;
}

export interface ShellOptions {
  errexit: boolean;
  nounset: boolean;
  xtrace: boolean;
  pipefail: boolean;
  noclobber: boolean;
  noglob: boolean;
  // shopt
  nullglob: boolean;
  failglob: boolean;
  dotglob: boolean;
  nocaseglob: boolean;
  expand_aliases: boolean;
  histexpand: boolean;
}

export const DEFAULT_OPTIONS: ShellOptions = {
  errexit: false,
  nounset: false,
  xtrace: false,
  pipefail: false,
  noclobber: false,
  noglob: false,
  nullglob: false,
  failglob: false,
  dotglob: false,
  nocaseglob: false,
  expand_aliases: false,
  histexpand: false,
};

export class ReadonlyError extends Error {
  readonly name_: string;
  constructor(name: string) {
    super(`${name}: readonly variable`);
    this.name_ = name;
  }
}

export class ShellState {
  vars = new Map<string, Variable>();
  functions = new Map<string, FunctionDef>();
  aliases = new Map<string, string>();
  /** Remembered command locations (the `hash` table). */
  hash = new Map<string, string>();
  cwd = '/';
  positional: string[] = [];
  arg0 = 'bash';
  lastStatus = 0;
  lastBgPid: number | null = null;
  options: ShellOptions = { ...DEFAULT_OPTIONS };
  umask = 0o022;
  creds: Credentials;
  /** $$ — stays the same in subshells. */
  pid: number;
  /** $BASHPID */
  bashPid: number;
  ppid: number;
  interactive = false;
  dirStack: string[] = [];
  /** Saved outer values for `local` variables, one map per active function call. */
  localScopes: Map<string, Variable | undefined>[] = [];
  funcNest = 0;
  lineno = 0;
  startTime: number;

  constructor(creds: Credentials, pid: number, ppid: number, startTime: number) {
    this.creds = creds;
    this.pid = pid;
    this.bashPid = pid;
    this.ppid = ppid;
    this.startTime = startTime;
  }

  fork(newBashPid?: number): ShellState {
    const s = new ShellState({ ...this.creds, groups: [...this.creds.groups] }, this.pid, this.ppid, this.startTime);
    for (const [k, v] of this.vars) s.vars.set(k, { ...v });
    s.functions = new Map(this.functions);
    s.aliases = new Map(this.aliases);
    s.hash = new Map(this.hash);
    s.cwd = this.cwd;
    s.positional = [...this.positional];
    s.arg0 = this.arg0;
    s.lastStatus = this.lastStatus;
    s.lastBgPid = this.lastBgPid;
    s.options = { ...this.options };
    s.umask = this.umask;
    s.bashPid = newBashPid ?? this.bashPid;
    s.interactive = false;
    s.dirStack = [...this.dirStack];
    s.localScopes = this.localScopes.map((m) => new Map(m));
    s.funcNest = this.funcNest;
    s.lineno = this.lineno;
    return s;
  }

  getVar(name: string): Variable | undefined {
    return this.vars.get(name);
  }

  get(name: string): string | undefined {
    return this.vars.get(name)?.value;
  }

  set(name: string, value: string, opts: { exported?: boolean; force?: boolean } = {}): void {
    const existing = this.vars.get(name);
    if (existing) {
      if (existing.readonly && !opts.force) throw new ReadonlyError(name);
      existing.value = value;
      if (opts.exported) existing.exported = true;
      return;
    }
    this.vars.set(name, { value, exported: !!opts.exported, readonly: false, integer: false });
  }

  unset(name: string): void {
    const v = this.vars.get(name);
    if (v?.readonly) throw new ReadonlyError(name);
    this.vars.delete(name);
  }

  setExported(name: string, exported = true): void {
    const v = this.vars.get(name);
    if (v) v.exported = exported;
    else this.vars.set(name, { value: '', exported, readonly: false, integer: false });
  }

  isSet(name: string): boolean {
    return this.vars.has(name);
  }

  /** The environment handed to child programs. */
  exportedEnv(): Map<string, string> {
    const env = new Map<string, string>();
    for (const [k, v] of this.vars) if (v.exported) env.set(k, v.value);
    return env;
  }

  /** Begin a function call scope for `local`. */
  pushScope(): void {
    this.localScopes.push(new Map());
  }

  popScope(): void {
    const scope = this.localScopes.pop();
    if (!scope) return;
    for (const [name, saved] of scope) {
      if (saved === undefined) this.vars.delete(name);
      else this.vars.set(name, saved);
    }
  }

  /** Make `name` local to the current function call. */
  makeLocal(name: string): boolean {
    const scope = this.localScopes[this.localScopes.length - 1];
    if (!scope) return false;
    if (!scope.has(name)) {
      const cur = this.vars.get(name);
      scope.set(name, cur ? { ...cur } : undefined);
      if (cur) this.vars.set(name, { ...cur, exported: cur.exported });
    }
    return true;
  }
}
