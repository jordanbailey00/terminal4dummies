// Per-shell state: variables, functions, aliases, options, working directory.
// Subshells get a deep copy (fork) so changes don't leak back.

import { AssocArray } from './assoc';
import type { FunctionDef } from './parser/ast';
import type { Credentials } from './vfs/fs';

export interface Variable {
  /** The scalar value (for arrays, a copy of element 0). */
  value: string;
  exported: boolean;
  readonly: boolean;
  integer: boolean;
  /** Declared (`local x`, `declare -a x`, `export X`) but never assigned. */
  unset?: boolean;
  /** Indexed array elements; arrays may be sparse. */
  array?: Map<number, string>;
  /** Associative array (declare -A). */
  assoc?: AssocArray;
}

export function cloneVar(v: Variable): Variable {
  const c: Variable = { ...v };
  if (v.array) c.array = new Map(v.array);
  if (v.assoc) c.assoc = v.assoc.clone();
  return c;
}

function maxIndex(a: Map<number, string>): number {
  let m = -1;
  for (const k of a.keys()) if (k > m) m = k;
  return m;
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
  constructor(name: string, message = `${name}: readonly variable`) {
    super(message);
    this.name_ = name;
  }
}

/** `a[-9]=x` past the start of an array (reported like a readonly error). */
export class BadSubscriptError extends ReadonlyError {
  constructor(name: string, sub: string) {
    super(name, `${name}[${sub}]: bad array subscript`);
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
  /** Running a script file (bash script.sh), not -c or the prompt. */
  inScript = false;
  /** A login shell (ssh, sudo -i, su -, bash -l): `exit` says "logout". */
  loginShell = false;
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
    for (const [k, v] of this.vars) s.vars.set(k, cloneVar(v));
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
    s.inScript = this.inScript;
    s.dirStack = [...this.dirStack];
    s.localScopes = this.localScopes.map((m) => new Map([...m].map(([k, v]) => [k, v && cloneVar(v)])));
    s.funcNest = this.funcNest;
    s.lineno = this.lineno;
    return s;
  }

  getVar(name: string): Variable | undefined {
    return this.vars.get(name);
  }

  /** The value of $name: for arrays, element 0; undefined when unset. */
  get(name: string): string | undefined {
    const v = this.vars.get(name);
    if (!v) return undefined;
    if (v.array) return v.array.get(0);
    if (v.assoc) return v.assoc.get('0');
    return v.unset ? undefined : v.value;
  }

  set(name: string, value: string, opts: { exported?: boolean; force?: boolean } = {}): void {
    const existing = this.vars.get(name);
    if (existing) {
      if (existing.readonly && !opts.force) throw new ReadonlyError(name);
      // assigning to an array name sets element 0
      if (existing.array) existing.array.set(0, value);
      else if (existing.assoc) existing.assoc.set('0', value);
      existing.value = value;
      existing.unset = false;
      if (opts.exported) existing.exported = true;
      return;
    }
    this.vars.set(name, { value, exported: !!opts.exported, readonly: false, integer: false });
  }

  isArray(name: string): boolean {
    const v = this.vars.get(name);
    return !!v && (!!v.array || !!v.assoc);
  }

  isAssoc(name: string): boolean {
    return !!this.vars.get(name)?.assoc;
  }

  /** Elements as [key, value] in bash's order (a set scalar is element 0). */
  entries(name: string): [string, string][] {
    const v = this.vars.get(name);
    if (!v) return [];
    if (v.array) return [...v.array.keys()].sort((a, b) => a - b).map((k) => [String(k), v.array!.get(k)!]);
    if (v.assoc) return v.assoc.keys().map((k) => [k, v.assoc!.get(k)!]);
    return v.unset ? [] : [['0', v.value]];
  }

  /**
   * One element. Indexed arrays (and scalars, which act as one-element
   * arrays) take a number, counted from the end when negative; undefined
   * means unset, null a negative subscript before the start.
   */
  getElement(name: string, key: string | number): string | undefined | null {
    const v = this.vars.get(name);
    if (!v) return typeof key === 'number' && key < 0 ? null : undefined;
    if (v.assoc) return v.assoc.get(String(key));
    let i = Number(key);
    if (v.array) {
      if (i < 0) {
        i += maxIndex(v.array) + 1;
        if (i < 0) return null;
      }
      return v.array.get(i);
    }
    if (i < 0) return v.unset || i < -1 ? null : v.value;
    return i === 0 && !v.unset ? v.value : undefined;
  }

  /** The index after the last element (where `a+=(x)` appends). */
  nextIndex(name: string): number {
    const v = this.vars.get(name);
    if (!v) return 0;
    if (v.array) return maxIndex(v.array) + 1;
    return v.unset || v.assoc ? 0 : 1;
  }

  setElement(name: string, key: string | number, value: string, rawSub = String(key)): void {
    let v = this.vars.get(name);
    if (v?.readonly) throw new ReadonlyError(name);
    if (!v) {
      v = { value: '', exported: false, readonly: false, integer: false, array: new Map() };
      this.vars.set(name, v);
    }
    v.unset = false;
    if (v.assoc) {
      v.assoc.set(String(key), value);
      if (String(key) === '0') v.value = value;
      return;
    }
    if (!v.array) {
      // a scalar turns into an array with its value as element 0
      v.array = new Map([[0, v.value]]);
    }
    let i = Number(key);
    if (i < 0) {
      i += maxIndex(v.array) + 1;
      if (i < 0) throw new BadSubscriptError(name, rawSub);
    }
    v.array.set(i, value);
    if (i === 0) v.value = value;
  }

  unsetElement(name: string, key: string | number): void {
    const v = this.vars.get(name);
    if (!v) return;
    if (v.readonly) throw new ReadonlyError(name);
    if (v.assoc) {
      v.assoc.delete(String(key));
      return;
    }
    let i = Number(key);
    if (!v.array) {
      if (i === 0 || i === -1) this.vars.delete(name);
      return;
    }
    if (i < 0) i += maxIndex(v.array) + 1;
    v.array.delete(i);
    if (i === 0) v.value = '';
  }

  /** Assign a whole array (`a=(...)`, or with append `a+=(...)`). */
  setArray(name: string, items: [string | number, string][], append = false): void {
    let v = this.vars.get(name);
    if (v?.readonly) throw new ReadonlyError(name);
    if (!v) {
      v = { value: '', exported: false, readonly: false, integer: false };
      this.vars.set(name, v);
    }
    if (v.assoc) {
      if (!append) v.assoc.clear();
      for (const [k, val] of items) v.assoc.set(String(k), val);
      v.value = v.assoc.get('0') ?? '';
    } else {
      if (!v.array) v.array = append && !v.unset ? new Map([[0, v.value]]) : new Map();
      else if (!append) v.array.clear();
      for (const [k, val] of items) v.array.set(Number(k), val);
      v.value = v.array.get(0) ?? '';
    }
    v.unset = false;
  }

  /** declare -a / declare -A: make `name` an (empty or converted) array. */
  makeArray(name: string, assoc: boolean): string | null {
    let v = this.vars.get(name);
    if (!v) {
      v = { value: '', exported: false, readonly: false, integer: false, unset: true };
      this.vars.set(name, v);
    }
    if (assoc) {
      if (v.array) return `${name}: cannot convert indexed to associative array`;
      if (!v.assoc) {
        v.assoc = new AssocArray();
        if (!v.unset) v.assoc.set('0', v.value);
      }
    } else {
      if (v.assoc) return `${name}: cannot convert associative to indexed array`;
      if (!v.array) v.array = v.unset ? new Map() : new Map([[0, v.value]]);
    }
    return null;
  }

  unset(name: string): void {
    const v = this.vars.get(name);
    if (v?.readonly) throw new ReadonlyError(name);
    this.vars.delete(name);
  }

  setExported(name: string, exported = true): void {
    const v = this.vars.get(name);
    if (v) v.exported = exported;
    else this.vars.set(name, { value: '', exported, readonly: false, integer: false, unset: true });
  }

  isSet(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** The environment handed to child programs (arrays can't be exported). */
  exportedEnv(): Map<string, string> {
    const env = new Map<string, string>();
    for (const [k, v] of this.vars) if (v.exported && !v.unset && !v.array && !v.assoc) env.set(k, v.value);
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

  /**
   * Make `name` local to the current function call. Like bash, the local
   * starts out unset (keeping only the export attribute); a readonly
   * global stays as it is, so assigning to it still fails.
   */
  makeLocal(name: string): boolean {
    const scope = this.localScopes[this.localScopes.length - 1];
    if (!scope) return false;
    if (!scope.has(name)) {
      const cur = this.vars.get(name);
      scope.set(name, cur ? cloneVar(cur) : undefined);
      if (cur && !cur.readonly) this.vars.set(name, { value: '', exported: cur.exported, readonly: false, integer: false, unset: true });
    }
    return true;
  }
}
