// File descriptor table for running code.

import type { Job } from './process';
import { InputStream, NullInput, NullOutput, OutputStream } from './streams';

const NULL_IN = new NullInput();
const NULL_OUT = new NullOutput();

/** Open file descriptors plus the job (process group) the code runs in. */
export class IO {
  readonly fds: Map<number, InputStream | OutputStream>;
  job: Job;
  constructor(job: Job, fds?: Map<number, InputStream | OutputStream>) {
    this.job = job;
    this.fds = fds ?? new Map();
  }
  static of(job: Job, stdin: InputStream, stdout: OutputStream, stderr: OutputStream): IO {
    return new IO(
      job,
      new Map<number, InputStream | OutputStream>([
        [0, stdin],
        [1, stdout],
        [2, stderr],
      ]),
    );
  }
  clone(job?: Job): IO {
    return new IO(job ?? this.job, new Map(this.fds));
  }
  get stdin(): InputStream {
    const s = this.fds.get(0);
    return s instanceof InputStream ? s : NULL_IN;
  }
  get stdout(): OutputStream {
    const s = this.fds.get(1);
    return s instanceof OutputStream ? s : NULL_OUT;
  }
  get stderr(): OutputStream {
    const s = this.fds.get(2);
    return s instanceof OutputStream ? s : NULL_OUT;
  }
}

