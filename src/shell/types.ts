// Shared types for commands ("programs") that run inside the simulator.

import type { Proc } from './process';
import type { InputStream, OutputStream, SignalName } from './streams';
import type { System } from './system';
import type { TtyDriver } from './tty';
import type { Credentials } from './vfs/fs';
import type { ProcFs } from './procfs';

export type CommandCategory =
  | 'navigation'
  | 'files'
  | 'viewing'
  | 'search'
  | 'text'
  | 'permissions'
  | 'system'
  | 'processes'
  | 'shell'
  | 'network'
  | 'archives'
  | 'packages'
  | 'help'
  | 'fun';

export interface CommandDoc {
  /** Text after the dash in the NAME section: "list directory contents". */
  summary: string;
  synopsis: string[];
  /** Plain text paragraphs separated by blank lines. */
  description: string;
  options?: { flags: string; desc: string }[];
  examples?: { cmd: string; desc: string }[];
  seeAlso?: string[];
  section?: number;
  category: CommandCategory;
  /** A friendly note for beginners (Reference page only). */
  tip?: string;
}

export interface ExecOptions {
  creds?: Credentials;
  env?: Map<string, string>;
  cwd?: string;
  stdin?: InputStream;
  stdout?: OutputStream;
  stderr?: OutputStream;
  /** Use this argv[0] for display (e.g. sudo's child). */
  umask?: number;
}

export interface CommandContext {
  readonly argv: string[];
  /** argv without the command name. */
  readonly args: string[];
  /** Name used in messages ("ls: cannot access..."). */
  readonly name: string;
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
  env: Map<string, string>;
  cwd: string;
  creds: Credentials;
  umask: number;
  readonly system: System;
  readonly fs: ProcFs;
  /** The controlling terminal, when the process is attached to one. */
  readonly tty: TtyDriver | null;
  readonly proc: Proc;
  readonly signal: AbortSignal;
  /** Write to stdout. */
  out(s: string): Promise<void>;
  /** Write to stderr. */
  err(s: string): Promise<void>;
  /** Print "name: message" to stderr. */
  error(message: string): Promise<void>;
  /** Throw if killed; wait while stopped. */
  checkpoint(): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Run another program as a child process (PATH lookup applies). */
  exec(argv: string[], opts?: ExecOptions): Promise<number>;
  /** Handle a signal instead of dying from it. */
  onSignal(sig: SignalName, fn: (sig: SignalName) => void): () => void;
  /** Look up a program on $PATH. */
  which(name: string): string | null;
}

export type CommandImpl = (ctx: CommandContext) => Promise<number>;

export interface NativeCommand {
  name: string;
  run: CommandImpl;
  doc?: CommandDoc;
  /** Debian package that ships this command. */
  pkg: string;
  /** Install directory (default /usr/bin). */
  dir?: string;
  /** Apparent binary size for `ls -l`. */
  size?: number;
}
