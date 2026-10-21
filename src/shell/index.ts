// Public entry point for the simulated computer.

import './builtins';
import { COMMANDS } from './commands';
import { buildHome, buildSystemImage, installPackages } from './image';
import { System, type SystemOptions } from './system';
import { VirtualFS, type SerializedFS } from './vfs/fs';

export { Session, type SessionOptions, type CommandEvent } from './session';
export { System } from './system';
export { VirtualFS } from './vfs/fs';
export { COMMANDS } from './commands';

export interface CreateSystemOptions extends SystemOptions {
  /** Restore a saved disk instead of building a fresh one. */
  snapshot?: SerializedFS;
  /** Put sample files in the home directory (default true). */
  samples?: boolean;
}

export function registerCommands(sys: System): void {
  for (const c of COMMANDS) sys.registerCommand(c);
}

/** A ready-to-use computer: Ubuntu-like disk image, programs, home directory. */
export function createSystem(opts: CreateSystemOptions = {}): System {
  if (opts.snapshot) {
    const fs = VirtualFS.deserialize(opts.snapshot, { now: opts.now });
    const sys = new System({ ...opts, fs });
    registerCommands(sys);
    return sys;
  }
  const sys = new System(opts);
  registerCommands(sys);
  buildSystemImage(sys);
  installPackages(sys, COMMANDS);
  buildHome(sys, 'root', { samples: false });
  buildHome(sys, 'learner', { samples: opts.samples ?? true });
  return sys;
}
