// Control-flow signals used by the interpreter and builtins.

export class ExitException extends Error {
  readonly status: number;
  /** Raised by a fatal expansion error (`${x:?}`, `set -u`) rather than `exit`. */
  readonly fatal: boolean;
  constructor(status: number, fatal = false) {
    super('exit');
    this.status = status;
    this.fatal = fatal;
  }
}
export class ReturnException extends Error {
  readonly status: number;
  constructor(status: number) {
    super('return');
    this.status = status;
  }
}
export class BreakException extends Error {
  levels: number;
  constructor(levels: number) {
    super('break');
    this.levels = levels;
  }
}
export class ContinueException extends Error {
  levels: number;
  constructor(levels: number) {
    super('continue');
    this.levels = levels;
  }
}

/** A redirection could not be set up ("bash: x: No such file or directory"). */
export class RedirectError extends Error {}

/**
 * An expansion error ("bad substitution", "division by 0"): like bash, the
 * shell abandons the rest of the command line (or script line) with status 1.
 */
export class AbortCommand extends Error {
  constructor() {
    super('abort');
  }
}
