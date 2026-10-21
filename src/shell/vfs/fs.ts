// An in-memory, Unix-like filesystem with inodes, permissions, symlinks and
// hard links. Everything the simulated shell does to "disk" goes through here.

import { decodeBinaryStream, isEncodedStream } from './binstream';
import { basename, isAbsolute, splitPath } from './path';

export type ErrCode =
  | 'ENOENT'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'EEXIST'
  | 'EACCES'
  | 'EPERM'
  | 'ENOTEMPTY'
  | 'EINVAL'
  | 'ELOOP'
  | 'EBUSY'
  | 'ENOSPC'
  | 'ENAMETOOLONG'
  | 'EXDEV';

export const ERR_MESSAGES: Record<ErrCode, string> = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EEXIST: 'File exists',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  ENOTEMPTY: 'Directory not empty',
  EINVAL: 'Invalid argument',
  ELOOP: 'Too many levels of symbolic links',
  EBUSY: 'Device or resource busy',
  ENOSPC: 'No space left on device',
  ENAMETOOLONG: 'File name too long',
  EXDEV: 'Invalid cross-device link',
};

export class FsError extends Error {
  readonly code: ErrCode;
  readonly path: string;
  constructor(code: ErrCode, path: string) {
    super(`${path}: ${ERR_MESSAGES[code]}`);
    this.code = code;
    this.path = path;
  }
  get reason(): string {
    return ERR_MESSAGES[this.code];
  }
}

export function strerror(err: unknown): string {
  if (err instanceof FsError) return err.reason;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** A program "compiled" into the simulator: running it calls a JS implementation. */
export interface NativeBinary {
  kind: 'native';
  command: string;
  size: number;
}

/** Opaque binary content (archives, compressed files, images...). */
export interface BlobData {
  kind: 'blob';
  /** What `file` should report, e.g. "gzip compressed data". */
  description: string;
  /** Structured payload understood by the tool that produced it (tar, gzip...). */
  payload: unknown;
  size: number;
}

export type BinaryData = NativeBinary | BlobData;
export type FileData = string | BinaryData;

export type DeviceKind = 'null' | 'zero' | 'tty' | 'random' | 'stdin' | 'stdout' | 'stderr';

interface InodeBase {
  ino: number;
  mode: number; // permission bits only (0o7777)
  uid: number;
  gid: number;
  atime: number;
  mtime: number;
  ctime: number;
  nlink: number;
}

export interface FileInode extends InodeBase {
  type: 'file';
  data: FileData;
}

export interface DirInode extends InodeBase {
  type: 'dir';
  entries: Map<string, Inode>;
  parent: DirInode; // root's parent is itself
}

export interface SymlinkInode extends InodeBase {
  type: 'symlink';
  target: string;
}

export interface DeviceInode extends InodeBase {
  type: 'chardev';
  device: DeviceKind;
}

export type Inode = FileInode | DirInode | SymlinkInode | DeviceInode;

export interface Credentials {
  uid: number;
  gid: number;
  groups: number[];
}

export const ROOT_CREDS: Credentials = { uid: 0, gid: 0, groups: [0] };

export const S_ISUID = 0o4000;
export const S_ISGID = 0o2000;
export const S_ISVTX = 0o1000;

const MAX_SYMLINK_DEPTH = 40;
const MAX_NAME = 255;

const textEncoder = new TextEncoder();

export function byteLength(s: string): number {
  // Fast path for ASCII.
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }
  return ascii ? s.length : textEncoder.encode(s).length;
}

export function dataSize(data: FileData): number {
  return typeof data === 'string' ? byteLength(data) : data.size;
}

const blobSizes = new WeakMap<BinaryData, number>();

/**
 * What a file costs against the disk quota: its text, or for archives and
 * other binary data the text kept inside them (programs are tiny).
 */
export function storedSize(data: FileData): number {
  if (typeof data === 'string') return data.length;
  if (data.kind === 'native') return 64;
  let n = blobSizes.get(data);
  if (n === undefined) {
    try {
      n = 64 + (JSON.stringify(data.payload ?? null)?.length ?? 0);
    } catch {
      n = 64;
    }
    blobSizes.set(data, n);
  }
  return n;
}

export function inodeSize(node: Inode): number {
  switch (node.type) {
    case 'file':
      return dataSize(node.data);
    case 'dir':
      return 4096;
    case 'symlink':
      return byteLength(node.target);
    case 'chardev':
      return 0;
  }
}

/** Where a path points, plus the directory that holds (or would hold) it. */
export interface Resolved {
  node: Inode | null;
  parent: DirInode;
  name: string;
  /** Absolute physical path of the resolved location (symlinks expanded). */
  path: string;
}

export interface ResolveOptions {
  /** Follow a symlink in the final path component (stat vs lstat). */
  follow?: boolean;
}

export interface OpContext {
  cwd: string;
  creds: Credentials;
  umask?: number;
}

export interface FsOptions {
  now?: () => number;
  /** Total bytes of file data allowed before ENOSPC. */
  quota?: number;
}

/**
 * The filesystem. Methods take an OpContext describing who is asking and
 * from which working directory, mirroring how a kernel sees a process.
 */
export class VirtualFS {
  root: DirInode;
  private nextIno = 2;
  private readonly now: () => number;
  readonly quota: number;
  usedBytes = 0;
  /** Bumped on every mutation; lets the UI know when to persist. */
  version = 0;

  constructor(opts: FsOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.quota = opts.quota ?? 16 * 1024 * 1024;
    const t = this.now();
    const root = {
      ino: 1,
      type: 'dir',
      mode: 0o755,
      uid: 0,
      gid: 0,
      atime: t,
      mtime: t,
      ctime: t,
      nlink: 2,
      entries: new Map(),
    } as unknown as DirInode;
    root.parent = root;
    this.root = root;
  }

  time(): number {
    return this.now();
  }

  private touchMutation() {
    this.version++;
  }

  // ---------------------------------------------------------------------
  // Permission helpers

  static canAccess(node: Inode, creds: Credentials, want: number): boolean {
    if (creds.uid === 0) {
      if ((want & 1) === 0) return true;
      // root may execute only if someone may; directories are always searchable
      return node.type === 'dir' || (node.mode & 0o111) !== 0;
    }
    let bits: number;
    if (creds.uid === node.uid) bits = (node.mode >> 6) & 7;
    else if (creds.gid === node.gid || creds.groups.includes(node.gid)) bits = (node.mode >> 3) & 7;
    else bits = node.mode & 7;
    return (bits & want) === want;
  }

  private requireAccess(node: Inode, ctx: OpContext, want: number, path: string) {
    if (!VirtualFS.canAccess(node, ctx.creds, want)) throw new FsError('EACCES', path);
  }

  /** Sticky-bit rule: in a +t directory only the owner (or root) may delete/rename. */
  private requireCanUnlink(dir: DirInode, node: Inode, ctx: OpContext, path: string) {
    this.requireAccess(dir, ctx, 0o3, path);
    if (dir.mode & S_ISVTX) {
      const uid = ctx.creds.uid;
      if (uid !== 0 && uid !== node.uid && uid !== dir.uid) throw new FsError('EPERM', path);
    }
  }

  // ---------------------------------------------------------------------
  // Path resolution (the "namei" of the kernel)

  /** Absolute physical path of a directory inode. */
  pathOf(dir: DirInode): string {
    const parts: string[] = [];
    let cur = dir;
    let guard = 0;
    while (cur !== this.root && guard++ < 4096) {
      const parent = cur.parent;
      let found: string | null = null;
      for (const [name, child] of parent.entries) {
        if (child === cur) {
          found = name;
          break;
        }
      }
      if (found === null) return '/' + parts.reverse().join('/'); // detached
      parts.push(found);
      cur = parent;
    }
    return '/' + parts.reverse().join('/');
  }

  private walk(
    start: DirInode,
    startPath: string,
    components: string[],
    ctx: OpContext,
    follow: boolean,
    depth: { n: number },
    original: string,
  ): Resolved {
    let dir = start;
    let dirPath = startPath;
    if (components.length === 0) {
      return { node: dir, parent: dir.parent, name: basename(dirPath) || '/', path: dirPath };
    }
    for (let i = 0; i < components.length; i++) {
      const comp = components[i];
      const last = i === components.length - 1;
      if (comp.length > MAX_NAME) throw new FsError('ENAMETOOLONG', original);
      this.requireAccess(dir, ctx, 1, original);
      let node: Inode | undefined;
      let nodePath: string;
      if (comp === '.') {
        node = dir;
        nodePath = dirPath;
      } else if (comp === '..') {
        node = dir.parent;
        nodePath = dirPath === '/' ? '/' : dirPath.slice(0, dirPath.lastIndexOf('/')) || '/';
      } else {
        node = dir.entries.get(comp);
        nodePath = dirPath === '/' ? '/' + comp : dirPath + '/' + comp;
      }
      if (!node) {
        if (last) return { node: null, parent: dir, name: comp, path: nodePath };
        throw new FsError('ENOENT', original);
      }
      if (node.type === 'symlink' && (!last || follow)) {
        if (++depth.n > MAX_SYMLINK_DEPTH) throw new FsError('ELOOP', original);
        const target = node.target;
        const targetStart = isAbsolute(target) ? this.root : dir;
        const targetStartPath = isAbsolute(target) ? '/' : dirPath;
        const r = this.walk(targetStart, targetStartPath, splitPath(target), ctx, true, depth, original);
        if (!r.node) {
          if (last) return r; // dangling link: report where it points
          throw new FsError('ENOENT', original);
        }
        node = r.node;
        nodePath = r.path;
      }
      if (last) {
        const parent = comp === '.' || comp === '..' ? (node as DirInode).parent : dir;
        return { node, parent, name: comp, path: nodePath };
      }
      if (node.type !== 'dir') throw new FsError('ENOTDIR', original);
      dir = node;
      dirPath = nodePath;
    }
    throw new FsError('ENOENT', original); // unreachable
  }

  /** Resolve the process working directory string to an inode. */
  private cwdNode(ctx: OpContext, original: string): { dir: DirInode; path: string } {
    if (ctx.cwd === '/' || ctx.cwd === '') return { dir: this.root, path: '/' };
    const r = this.walk(this.root, '/', splitPath(ctx.cwd), { ...ctx, creds: ROOT_CREDS }, true, { n: 0 }, original);
    if (!r.node) throw new FsError('ENOENT', original);
    if (r.node.type !== 'dir') throw new FsError('ENOTDIR', original);
    return { dir: r.node, path: r.path };
  }

  resolve(path: string, ctx: OpContext, opts: ResolveOptions = {}): Resolved {
    if (path === '') throw new FsError('ENOENT', path);
    const trailingSlash = path.length > 1 && path.endsWith('/');
    const follow = opts.follow ?? true;
    let start: DirInode;
    let startPath: string;
    if (isAbsolute(path)) {
      start = this.root;
      startPath = '/';
    } else {
      const c = this.cwdNode(ctx, path);
      start = c.dir;
      startPath = c.path;
    }
    const r = this.walk(start, startPath, splitPath(path), ctx, follow || trailingSlash, { n: 0 }, path);
    if (trailingSlash && r.node && r.node.type !== 'dir') throw new FsError('ENOTDIR', path);
    return r;
  }

  /** stat(2): follows symlinks. Throws ENOENT when missing. */
  stat(path: string, ctx: OpContext): Inode {
    const r = this.resolve(path, ctx, { follow: true });
    if (!r.node) throw new FsError('ENOENT', path);
    return r.node;
  }

  /** lstat(2): does not follow a final symlink. */
  lstat(path: string, ctx: OpContext): Inode {
    const r = this.resolve(path, ctx, { follow: false });
    if (!r.node) throw new FsError('ENOENT', path);
    return r.node;
  }

  tryStat(path: string, ctx: OpContext, follow = true): Inode | null {
    try {
      const r = this.resolve(path, ctx, { follow });
      return r.node;
    } catch {
      return null;
    }
  }

  exists(path: string, ctx: OpContext): boolean {
    return this.tryStat(path, ctx) !== null;
  }

  isDir(path: string, ctx: OpContext): boolean {
    return this.tryStat(path, ctx)?.type === 'dir';
  }

  isFile(path: string, ctx: OpContext): boolean {
    return this.tryStat(path, ctx)?.type === 'file';
  }

  realpath(path: string, ctx: OpContext): string {
    const r = this.resolve(path, ctx, { follow: true });
    if (!r.node) throw new FsError('ENOENT', path);
    if (r.node.type === 'dir') return this.pathOf(r.node);
    return r.path;
  }

  // ---------------------------------------------------------------------
  // Reading

  readdir(path: string, ctx: OpContext): string[] {
    const node = this.stat(path, ctx);
    if (node.type !== 'dir') throw new FsError('ENOTDIR', path);
    this.requireAccess(node, ctx, 4, path);
    return [...node.entries.keys()];
  }

  /** readdir returning inodes (lstat semantics for each entry). */
  readdirEntries(path: string, ctx: OpContext): [string, Inode][] {
    const node = this.stat(path, ctx);
    if (node.type !== 'dir') throw new FsError('ENOTDIR', path);
    this.requireAccess(node, ctx, 4, path);
    return [...node.entries.entries()];
  }

  readData(path: string, ctx: OpContext): FileData {
    const node = this.stat(path, ctx);
    if (node.type === 'dir') throw new FsError('EISDIR', path);
    this.requireAccess(node, ctx, 4, path);
    node.atime = this.now();
    if (node.type === 'chardev') return '';
    if (node.type !== 'file') throw new FsError('EINVAL', path);
    return node.data;
  }

  /** Read a file as text. Binary content is rendered as gibberish, like `cat` on a binary. */
  readFile(path: string, ctx: OpContext): string {
    return dataToText(this.readData(path, ctx));
  }

  readlink(path: string, ctx: OpContext): string {
    const node = this.lstat(path, ctx);
    if (node.type !== 'symlink') throw new FsError('EINVAL', path);
    return node.target;
  }

  // ---------------------------------------------------------------------
  // Writing

  private newInodeBase(ctx: OpContext, mode: number) {
    const t = this.now();
    return {
      ino: this.nextIno++,
      mode: mode & 0o7777,
      uid: ctx.creds.uid,
      gid: ctx.creds.gid,
      atime: t,
      mtime: t,
      ctime: t,
      nlink: 1,
    };
  }

  private chargeQuota(delta: number, path: string) {
    if (delta > 0 && this.usedBytes + delta > this.quota) throw new FsError('ENOSPC', path);
    this.usedBytes += delta;
  }

  /**
   * Write (or append to) a regular file, creating it if needed.
   * New files get `mode & ~umask` (default 0666 & ~022 = 0644).
   */
  writeFile(path: string, data: FileData, ctx: OpContext, opts: { append?: boolean; mode?: number } = {}): FileInode | DeviceInode {
    const r = this.resolve(path, ctx, { follow: true });
    const umask = ctx.umask ?? 0o022;
    if (r.node) {
      const node = r.node;
      if (node.type === 'dir') throw new FsError('EISDIR', path);
      if (node.type === 'chardev') return node; // writes to devices are handled by the caller
      if (node.type !== 'file') throw new FsError('EINVAL', path);
      this.requireAccess(node, ctx, 2, path);
      const oldSize = storedSize(node.data);
      let next: FileData;
      if (opts.append && typeof data === 'string') {
        next = (typeof node.data === 'string' ? node.data : dataToText(node.data)) + data;
      } else {
        next = data;
      }
      this.chargeQuota(storedSize(next) - oldSize, path);
      node.data = next;
      node.mtime = node.ctime = this.now();
      this.touchMutation();
      return node;
    }
    // create
    const dir = r.parent;
    if (r.name === '' || r.name === '.' || r.name === '..') throw new FsError('EISDIR', path);
    this.requireAccess(dir, ctx, 0o3, path);
    this.chargeQuota(storedSize(data), path);
    const node: FileInode = {
      ...this.newInodeBase(ctx, (opts.mode ?? 0o666) & ~umask),
      type: 'file',
      data,
    };
    dir.entries.set(r.name, node);
    dir.mtime = dir.ctime = this.now();
    this.touchMutation();
    return node;
  }

  /**
   * Open a path for writing the way a shell redirection does: create it if
   * missing, truncate unless appending. Returns the inode so later writes go
   * to the same file even if the process changes directory.
   */
  openForWrite(path: string, ctx: OpContext, opts: { append?: boolean; noclobber?: boolean } = {}): FileInode | DeviceInode {
    const r = this.resolve(path, ctx, { follow: true });
    if (r.node) {
      if (r.node.type === 'dir') throw new FsError('EISDIR', path);
      if (r.node.type === 'chardev') return r.node;
      if (r.node.type !== 'file') throw new FsError('EINVAL', path);
      if (opts.noclobber && !opts.append) throw new FsError('EEXIST', path);
      this.requireAccess(r.node, ctx, 2, path);
      if (!opts.append) {
        this.usedBytes -= storedSize(r.node.data);
        r.node.data = '';
        r.node.mtime = r.node.ctime = this.now();
        this.touchMutation();
      }
      return r.node;
    }
    return this.writeFile(path, '', ctx);
  }

  /** Append text to an already-open file inode (quota checked). */
  appendToInode(node: FileInode, data: string, path: string): void {
    const oldSize = storedSize(node.data);
    const text = (typeof node.data === 'string' ? node.data : dataToText(node.data)) + data;
    // binary data that came through a pipe or redirection (cat a.tgz > b.tgz) is stored as binary again
    const next: FileData = (isEncodedStream(text) && decodeBinaryStream(text)) || text;
    this.chargeQuota(storedSize(next) - oldSize, path);
    node.data = next;
    node.mtime = node.ctime = this.now();
    this.touchMutation();
  }

  /** Create an empty file if missing, otherwise update timestamps (like `touch`). */
  touch(path: string, ctx: OpContext, time?: number): void {
    const r = this.resolve(path, ctx, { follow: true });
    if (r.node) {
      const node = r.node;
      // Updating times to "now" needs write access (or ownership).
      if (!VirtualFS.canAccess(node, ctx.creds, 2) && ctx.creds.uid !== node.uid && ctx.creds.uid !== 0) {
        throw new FsError('EACCES', path);
      }
      const t = time ?? this.now();
      node.atime = node.mtime = t;
      node.ctime = this.now();
      this.touchMutation();
      return;
    }
    this.writeFile(path, '', ctx);
    if (time !== undefined) {
      const n = this.stat(path, ctx);
      n.atime = n.mtime = time;
    }
  }

  mkdir(path: string, ctx: OpContext, mode = 0o777): DirInode {
    const r = this.resolve(path.replace(/\/+$/, '') || '/', ctx, { follow: false });
    if (r.node) throw new FsError('EEXIST', path);
    const dir = r.parent;
    this.requireAccess(dir, ctx, 0o3, path);
    const umask = ctx.umask ?? 0o022;
    const node = {
      ...this.newInodeBase(ctx, mode & ~umask),
      type: 'dir',
      entries: new Map(),
      parent: dir,
      nlink: 2,
    } as DirInode;
    dir.entries.set(r.name, node);
    dir.nlink++;
    dir.mtime = dir.ctime = this.now();
    this.touchMutation();
    return node;
  }

  rmdir(path: string, ctx: OpContext): void {
    const r = this.resolve(path.replace(/\/+$/, '') || '/', ctx, { follow: false });
    if (!r.node) throw new FsError('ENOENT', path);
    const node = r.node;
    if (node.type !== 'dir') throw new FsError('ENOTDIR', path);
    if (node === this.root) throw new FsError('EBUSY', path);
    if (r.name === '.') throw new FsError('EINVAL', path);
    if (r.name === '..') throw new FsError('ENOTEMPTY', path);
    if (node.entries.size > 0) throw new FsError('ENOTEMPTY', path);
    this.requireCanUnlink(r.parent, node, ctx, path);
    r.parent.entries.delete(r.name);
    r.parent.nlink--;
    r.parent.mtime = r.parent.ctime = this.now();
    this.touchMutation();
  }

  unlink(path: string, ctx: OpContext): void {
    const r = this.resolve(path, ctx, { follow: false });
    if (!r.node) throw new FsError('ENOENT', path);
    const node = r.node;
    if (node.type === 'dir') throw new FsError('EISDIR', path);
    this.requireCanUnlink(r.parent, node, ctx, path);
    r.parent.entries.delete(r.name);
    r.parent.mtime = r.parent.ctime = this.now();
    node.nlink--;
    node.ctime = this.now();
    if (node.nlink <= 0 && node.type === 'file') this.usedBytes -= storedSize(node.data);
    this.touchMutation();
  }

  private isAncestor(maybeAncestor: DirInode, node: DirInode): boolean {
    let cur: DirInode = node;
    let guard = 0;
    while (guard++ < 4096) {
      if (cur === maybeAncestor) return true;
      if (cur === this.root) return false;
      cur = cur.parent;
    }
    return false;
  }

  /** rename(2) semantics: replaces an existing destination of a compatible type. */
  rename(from: string, to: string, ctx: OpContext): void {
    const src = this.resolve(from, ctx, { follow: false });
    if (!src.node) throw new FsError('ENOENT', from);
    const dst = this.resolve(to.replace(/\/+$/, '') || '/', ctx, { follow: false });
    const node = src.node;
    if (node === this.root || src.name === '.' || src.name === '..') throw new FsError('EBUSY', from);
    this.requireCanUnlink(src.parent, node, ctx, from);
    this.requireAccess(dst.parent, ctx, 0o3, to);
    if (node.type === 'dir' && this.isAncestor(node, dst.parent)) throw new FsError('EINVAL', to);
    if (dst.node) {
      if (dst.node === node) return;
      if (node.type === 'dir') {
        if (dst.node.type !== 'dir') throw new FsError('ENOTDIR', to);
        if (dst.node.entries.size > 0) throw new FsError('ENOTEMPTY', to);
        dst.parent.nlink--;
      } else if (dst.node.type === 'dir') {
        throw new FsError('EISDIR', to);
      }
      this.requireCanUnlink(dst.parent, dst.node, ctx, to);
      if (dst.node.type === 'file') {
        dst.node.nlink--;
        if (dst.node.nlink <= 0) this.usedBytes -= storedSize(dst.node.data);
      }
    }
    src.parent.entries.delete(src.name);
    dst.parent.entries.set(dst.name, node);
    if (node.type === 'dir') {
      src.parent.nlink--;
      dst.parent.nlink++;
      node.parent = dst.parent;
    }
    const t = this.now();
    src.parent.mtime = src.parent.ctime = t;
    dst.parent.mtime = dst.parent.ctime = t;
    node.ctime = t;
    this.touchMutation();
  }

  symlink(target: string, linkPath: string, ctx: OpContext): SymlinkInode {
    const r = this.resolve(linkPath, ctx, { follow: false });
    if (r.node) throw new FsError('EEXIST', linkPath);
    this.requireAccess(r.parent, ctx, 0o3, linkPath);
    const node: SymlinkInode = { ...this.newInodeBase(ctx, 0o777), type: 'symlink', target };
    node.mode = 0o777;
    r.parent.entries.set(r.name, node);
    r.parent.mtime = r.parent.ctime = this.now();
    this.touchMutation();
    return node;
  }

  link(existing: string, newPath: string, ctx: OpContext): void {
    const src = this.resolve(existing, ctx, { follow: false });
    if (!src.node) throw new FsError('ENOENT', existing);
    if (src.node.type === 'dir') throw new FsError('EPERM', existing);
    const dst = this.resolve(newPath, ctx, { follow: false });
    if (dst.node) throw new FsError('EEXIST', newPath);
    this.requireAccess(dst.parent, ctx, 0o3, newPath);
    dst.parent.entries.set(dst.name, src.node);
    src.node.nlink++;
    src.node.ctime = this.now();
    this.touchMutation();
  }

  chmod(path: string, mode: number, ctx: OpContext, follow = true): void {
    const node = follow ? this.stat(path, ctx) : this.lstat(path, ctx);
    if (ctx.creds.uid !== 0 && ctx.creds.uid !== node.uid) throw new FsError('EPERM', path);
    node.mode = mode & 0o7777;
    node.ctime = this.now();
    this.touchMutation();
  }

  chown(path: string, uid: number | null, gid: number | null, ctx: OpContext, follow = true): void {
    const node = follow ? this.stat(path, ctx) : this.lstat(path, ctx);
    const creds = ctx.creds;
    if (creds.uid !== 0) {
      if (uid !== null && uid !== node.uid) throw new FsError('EPERM', path);
      if (gid !== null) {
        if (creds.uid !== node.uid) throw new FsError('EPERM', path);
        if (gid !== creds.gid && !creds.groups.includes(gid)) throw new FsError('EPERM', path);
      }
    }
    if (uid !== null) node.uid = uid;
    if (gid !== null) node.gid = gid;
    node.ctime = this.now();
    this.touchMutation();
  }

  setTimes(path: string, atime: number, mtime: number, ctx: OpContext): void {
    const node = this.stat(path, ctx);
    if (ctx.creds.uid !== 0 && ctx.creds.uid !== node.uid) throw new FsError('EPERM', path);
    node.atime = atime;
    node.mtime = mtime;
    node.ctime = this.now();
    this.touchMutation();
  }

  /** Create a character device node (used when building /dev). */
  mknod(path: string, device: DeviceKind, ctx: OpContext, mode = 0o666): DeviceInode {
    const r = this.resolve(path, ctx, { follow: false });
    if (r.node) throw new FsError('EEXIST', path);
    const node: DeviceInode = { ...this.newInodeBase(ctx, mode), type: 'chardev', device };
    node.mode = mode;
    r.parent.entries.set(r.name, node);
    this.touchMutation();
    return node;
  }

  /** Recompute usedBytes from scratch (after deserializing). */
  recomputeUsage(): void {
    const seen = new Set<number>();
    let total = 0;
    const visit = (dir: DirInode) => {
      for (const child of dir.entries.values()) {
        if (seen.has(child.ino)) continue;
        seen.add(child.ino);
        if (child.type === 'file') total += storedSize(child.data);
        else if (child.type === 'dir') visit(child);
      }
    };
    visit(this.root);
    this.usedBytes = total;
  }

  // ---------------------------------------------------------------------
  // Snapshots (for persistence in localStorage)

  serialize(): SerializedFS {
    const inodes: Record<number, SerializedInode> = {};
    const visit = (node: Inode) => {
      if (inodes[node.ino]) return;
      const base = {
        mode: node.mode,
        uid: node.uid,
        gid: node.gid,
        atime: node.atime,
        mtime: node.mtime,
        ctime: node.ctime,
        nlink: node.nlink,
      };
      switch (node.type) {
        case 'file':
          inodes[node.ino] = { ...base, t: 'f', data: node.data };
          break;
        case 'symlink':
          inodes[node.ino] = { ...base, t: 'l', target: node.target };
          break;
        case 'chardev':
          inodes[node.ino] = { ...base, t: 'c', device: node.device };
          break;
        case 'dir': {
          const entries: [string, number][] = [];
          inodes[node.ino] = { ...base, t: 'd', entries };
          for (const [name, child] of node.entries) {
            entries.push([name, child.ino]);
            visit(child);
          }
          break;
        }
      }
    };
    visit(this.root);
    return { v: 1, root: this.root.ino, nextIno: this.nextIno, inodes };
  }

  static deserialize(snap: SerializedFS, opts: FsOptions = {}): VirtualFS {
    const fs = new VirtualFS(opts);
    const built = new Map<number, Inode>();
    const build = (ino: number, parent: DirInode | null): Inode => {
      const existing = built.get(ino);
      if (existing) return existing;
      const s = snap.inodes[ino];
      if (!s) throw new Error(`corrupt snapshot: missing inode ${ino}`);
      const base = {
        ino,
        mode: s.mode,
        uid: s.uid,
        gid: s.gid,
        atime: s.atime,
        mtime: s.mtime,
        ctime: s.ctime,
        nlink: s.nlink,
      };
      let node: Inode;
      if (s.t === 'f') node = { ...base, type: 'file', data: s.data };
      else if (s.t === 'l') node = { ...base, type: 'symlink', target: s.target };
      else if (s.t === 'c') node = { ...base, type: 'chardev', device: s.device };
      else {
        const dir = { ...base, type: 'dir', entries: new Map(), parent: null } as unknown as DirInode;
        dir.parent = parent ?? dir;
        built.set(ino, dir);
        for (const [name, childIno] of s.entries) dir.entries.set(name, build(childIno, dir));
        node = dir;
      }
      built.set(ino, node);
      return node;
    };
    fs.root = build(snap.root, null) as DirInode;
    fs.nextIno = snap.nextIno;
    fs.recomputeUsage();
    return fs;
  }
}

export interface SerializedBase {
  mode: number;
  uid: number;
  gid: number;
  atime: number;
  mtime: number;
  ctime: number;
  nlink: number;
}

export type SerializedInode =
  | (SerializedBase & { t: 'f'; data: FileData })
  | (SerializedBase & { t: 'l'; target: string })
  | (SerializedBase & { t: 'c'; device: DeviceKind })
  | (SerializedBase & { t: 'd'; entries: [string, number][] });

export interface SerializedFS {
  v: 1;
  root: number;
  nextIno: number;
  inodes: Record<number, SerializedInode>;
}

// A stable pseudo-random byte string so `cat /usr/bin/ls` looks like a binary.
function gibberish(seed: string, length: number): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let out = '\x7fELF\x02\x01\x01';
  const chars = '\x00\x01\x02\x03\x04\x05\x06@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~\x10\x11\x12\x13\x14\x15\x16\x17\x18\x1a\x1c\x1d\x1e\x1f';
  for (let i = 0; i < length; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    out += chars[(h >>> 0) % chars.length];
  }
  return out;
}

export function dataToText(data: FileData): string {
  if (typeof data === 'string') return data;
  if (data.kind === 'native') return gibberish(data.command, 96) + '\n';
  return gibberish(data.description, 64);
}

export function isBinaryData(data: FileData): data is BinaryData {
  return typeof data !== 'string';
}
