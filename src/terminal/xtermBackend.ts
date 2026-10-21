// Connects an xterm.js Terminal to the simulator's TerminalBackend interface.

import type { Terminal } from '@xterm/xterm';
import type { TerminalBackend } from '../shell/tty';

export class XtermBackend implements TerminalBackend {
  private term: Terminal | null = null;
  private dataListeners: ((d: string) => void)[] = [];
  private resizeListeners: ((c: number, r: number) => void)[] = [];
  private disposers: { dispose(): void }[] = [];
  /** Output written while no xterm is attached (replayed on attach). */
  private backlog: string[] = [];
  private backlogSize = 0;
  private lastCols = 80;
  private lastRows = 24;
  /** Transform raw key data before it reaches the shell (mobile Ctrl key). */
  inputFilter: ((d: string) => string) | null = null;
  private attachedOnce = false;
  private attachWaiters: (() => void)[] = [];

  /** Resolves once a sized terminal has been attached. */
  whenAttached(): Promise<void> {
    if (this.attachedOnce) return Promise.resolve();
    return new Promise((r) => this.attachWaiters.push(r));
  }

  attach(term: Terminal): void {
    this.detach();
    this.term = term;
    this.lastCols = term.cols;
    this.lastRows = term.rows;
    this.disposers.push(
      term.onData((d) => {
        const data = this.inputFilter ? this.inputFilter(d) : d;
        for (const l of this.dataListeners) l(data);
      }),
    );
    this.disposers.push(
      term.onResize(({ cols, rows }) => {
        this.lastCols = cols;
        this.lastRows = rows;
        for (const l of this.resizeListeners) l(cols, rows);
      }),
    );
    if (this.backlog.length) {
      term.write(this.backlog.join(''));
      this.backlog = [];
      this.backlogSize = 0;
    }
    if (!this.attachedOnce) {
      this.attachedOnce = true;
      for (const w of this.attachWaiters.splice(0)) w();
    }
  }

  detach(): void {
    for (const d of this.disposers) d.dispose();
    this.disposers = [];
    this.term = null;
  }

  get cols(): number {
    return this.term?.cols ?? this.lastCols;
  }

  get rows(): number {
    return this.term?.rows ?? this.lastRows;
  }

  write(data: string, done?: () => void): void {
    if (this.term) {
      this.term.write(data, done);
      return;
    }
    this.backlog.push(data);
    this.backlogSize += data.length;
    while (this.backlogSize > 200000 && this.backlog.length > 1) this.backlogSize -= this.backlog.shift()!.length;
    done?.();
  }

  onData(cb: (d: string) => void): () => void {
    this.dataListeners.push(cb);
    return () => {
      this.dataListeners = this.dataListeners.filter((l) => l !== cb);
    };
  }

  onResize(cb: (c: number, r: number) => void): () => void {
    this.resizeListeners.push(cb);
    return () => {
      this.resizeListeners = this.resizeListeners.filter((l) => l !== cb);
    };
  }

  /** Send input as if the user typed it. */
  type(data: string): void {
    for (const l of this.dataListeners) l(data);
  }
}
