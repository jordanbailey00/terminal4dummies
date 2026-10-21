// Reading from character devices: /dev/zero and /dev/urandom never end,
// /dev/null is always empty, /dev/tty and /dev/stdin are the terminal or
// whatever stdin is.

import type { Job } from './process';
import { InputStream, NullInput, yieldToEventLoop } from './streams';
import { TtyInput, type TtyDriver } from './tty';
import type { DeviceKind } from './vfs/fs';

/** An endless stream of generated chunks. */
class EndlessInput extends InputStream {
  readonly isTTY = false;
  private readonly chunk: () => string;
  private closed = false;
  constructor(chunk: () => string) {
    super();
    this.chunk = chunk;
  }
  protected async pull(signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) throw signal.reason;
    if (this.closed) return null;
    await yieldToEventLoop();
    return this.chunk();
  }
  close(): void {
    this.closed = true;
  }
}

/**
 * Random bytes for /dev/urandom. Kept below 128 so that every byte is one
 * character (the simulator's text is UTF-8), which keeps `head -c 16` exact.
 */
export function randomInput(random: () => number): InputStream {
  return new EndlessInput(() => {
    let s = '';
    for (let i = 0; i < 4096; i++) s += String.fromCharCode(Math.floor(random() * 128));
    return s;
  });
}

export function zeroInput(): InputStream {
  return new EndlessInput(() => '\0'.repeat(4096));
}

/** A stream for reading device `kind`; stdin and the terminal are supplied by the caller. */
export function deviceInput(kind: DeviceKind, env: { stdin: InputStream; tty: TtyDriver | null; job: Job; random: () => number }): InputStream {
  switch (kind) {
    case 'zero':
      return zeroInput();
    case 'random':
      return randomInput(env.random);
    case 'stdin':
      return env.stdin;
    case 'tty':
      return env.tty ? new TtyInput(env.tty, env.job) : new NullInput();
    default:
      return new NullInput();
  }
}
