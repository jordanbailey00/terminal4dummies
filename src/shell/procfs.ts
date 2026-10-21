// The filesystem as seen by one process: relative paths resolve against its
// working directory and permission checks use its credentials.

import { resolvePath } from './vfs/path';
import type {
  Credentials,
  DeviceKind,
  DirInode,
  FileData,
  FileInode,
  DeviceInode,
  Inode,
  OpContext,
  SymlinkInode,
  VirtualFS,
} from './vfs/fs';

export class ProcFs {
  readonly vfs: VirtualFS;
  private readonly getCtx: () => OpContext;

  constructor(vfs: VirtualFS, getCtx: () => OpContext) {
    this.vfs = vfs;
    this.getCtx = getCtx;
  }

  get ctx(): OpContext {
    return this.getCtx();
  }

  get cwd(): string {
    return this.getCtx().cwd;
  }

  get creds(): Credentials {
    return this.getCtx().creds;
  }

  /** Absolute, lexically normalized path (no symlink resolution). */
  abs(path: string): string {
    return resolvePath(this.cwd, path);
  }

  stat(path: string): Inode {
    return this.vfs.stat(path, this.ctx);
  }
  lstat(path: string): Inode {
    return this.vfs.lstat(path, this.ctx);
  }
  tryStat(path: string, follow = true): Inode | null {
    return this.vfs.tryStat(path, this.ctx, follow);
  }
  exists(path: string): boolean {
    return this.vfs.exists(path, this.ctx);
  }
  isDir(path: string): boolean {
    return this.vfs.isDir(path, this.ctx);
  }
  isFile(path: string): boolean {
    return this.vfs.isFile(path, this.ctx);
  }
  readdir(path: string): string[] {
    return this.vfs.readdir(path, this.ctx);
  }
  readdirEntries(path: string): [string, Inode][] {
    return this.vfs.readdirEntries(path, this.ctx);
  }
  readFile(path: string): string {
    return this.vfs.readFile(path, this.ctx);
  }
  readData(path: string): FileData {
    return this.vfs.readData(path, this.ctx);
  }
  readlink(path: string): string {
    return this.vfs.readlink(path, this.ctx);
  }
  realpath(path: string): string {
    return this.vfs.realpath(path, this.ctx);
  }
  writeFile(path: string, data: FileData, opts: { append?: boolean; mode?: number } = {}): FileInode | DeviceInode {
    return this.vfs.writeFile(path, data, this.ctx, opts);
  }
  touch(path: string, time?: number): void {
    this.vfs.touch(path, this.ctx, time);
  }
  mkdir(path: string, mode?: number): DirInode {
    return this.vfs.mkdir(path, this.ctx, mode);
  }
  rmdir(path: string): void {
    this.vfs.rmdir(path, this.ctx);
  }
  unlink(path: string): void {
    this.vfs.unlink(path, this.ctx);
  }
  rename(from: string, to: string): void {
    this.vfs.rename(from, to, this.ctx);
  }
  symlink(target: string, path: string): SymlinkInode {
    return this.vfs.symlink(target, path, this.ctx);
  }
  link(existing: string, path: string): void {
    this.vfs.link(existing, path, this.ctx);
  }
  chmod(path: string, mode: number, follow = true): void {
    this.vfs.chmod(path, mode, this.ctx, follow);
  }
  chown(path: string, uid: number | null, gid: number | null, follow = true): void {
    this.vfs.chown(path, uid, gid, this.ctx, follow);
  }
  setTimes(path: string, atime: number, mtime: number): void {
    this.vfs.setTimes(path, atime, mtime, this.ctx);
  }
  mknod(path: string, device: DeviceKind, mode?: number): DeviceInode {
    return this.vfs.mknod(path, device, this.ctx, mode);
  }
  canAccess(node: Inode, want: number): boolean {
    return (this.vfs.constructor as typeof VirtualFS).canAccess(node, this.creds, want);
  }
}
