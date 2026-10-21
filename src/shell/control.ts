// Control-flow signals used by the interpreter and builtins.

export class ExitException extends Error {
  readonly status: number;
  constructor(status: number) {
    super('exit');
    this.status = status;
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

