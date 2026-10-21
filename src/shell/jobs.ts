// The shell's job table (what `jobs`, `fg`, `bg` and `%1` refer to).

import type { Job } from './process';
import { SIGNAL_DESCRIPTIONS } from './streams';

export class JobTable {
  private list: Job[] = [];
  /** Most recent job ("+") and the one before it ("-"). */
  private current: Job | null = null;
  private previous: Job | null = null;

  add(job: Job): void {
    const used = new Set(this.list.map((j) => j.id));
    let id = 1;
    while (used.has(id)) id++;
    // bash numbers jobs after the highest active one
    const max = this.list.reduce((m, j) => Math.max(m, j.id), 0);
    job.id = Math.max(id, max + 1);
    this.list.push(job);
    this.list.sort((a, b) => a.id - b.id);
    this.makeCurrent(job);
  }

  makeCurrent(job: Job): void {
    if (this.current !== job) {
      this.previous = this.current;
      this.current = job;
    }
  }

  remove(job: Job): void {
    this.list = this.list.filter((j) => j !== job);
    if (this.current === job) {
      this.current = this.previous && this.list.includes(this.previous) ? this.previous : this.pickLatest();
      this.previous = this.pickLatest(this.current);
    } else if (this.previous === job) {
      this.previous = this.pickLatest(this.current);
    }
  }

  private pickLatest(except: Job | null = null): Job | null {
    // prefer stopped jobs, then the highest numbered
    const candidates = this.list.filter((j) => j !== except);
    const stopped = candidates.filter((j) => j.state === 'stopped');
    const pool = stopped.length ? stopped : candidates;
    return pool.length ? pool[pool.length - 1] : null;
  }

  all(): Job[] {
    return [...this.list];
  }

  get size(): number {
    return this.list.length;
  }

  marker(job: Job): '+' | '-' | ' ' {
    if (job === this.current) return '+';
    if (job === this.previous) return '-';
    return ' ';
  }

  getCurrent(): Job | null {
    return this.current;
  }

  /** Resolve a job spec: %1, %+, %%, %-, %name, %?text, or a bare number. */
  find(spec: string): Job | null | 'ambiguous' {
    let s = spec;
    if (s.startsWith('%')) s = s.slice(1);
    if (s === '' || s === '+' || s === '%') return this.current;
    if (s === '-') return this.previous;
    if (/^\d+$/.test(s)) return this.list.find((j) => j.id === Number(s)) ?? null;
    let matches: Job[];
    if (s.startsWith('?')) {
      const needle = s.slice(1);
      matches = this.list.filter((j) => j.command.includes(needle));
    } else {
      matches = this.list.filter((j) => j.command.startsWith(s));
    }
    if (matches.length > 1) return 'ambiguous';
    return matches[0] ?? null;
  }

  stoppedCount(): number {
    return this.list.filter((j) => j.state === 'stopped').length;
  }
}

/** Status column used by `jobs` and job notifications. */
export function jobStateText(job: Job): string {
  if (job.state === 'running') return 'Running';
  if (job.state === 'stopped') {
    return SIGNAL_DESCRIPTIONS[job.stopSignal ?? 'SIGTSTP'] ?? 'Stopped';
  }
  if (job.termSignal) return SIGNAL_DESCRIPTIONS[job.termSignal] ?? 'Terminated';
  if (job.status && job.status > 128 && job.status < 160) {
    // killed by a signal delivered to a single process
    const map: Record<number, string> = { 130: 'Interrupt', 137: 'Killed', 143: 'Terminated', 129: 'Hangup', 131: 'Quit' };
    if (map[job.status]) return map[job.status];
  }
  if (job.status === 0) return 'Done';
  return `Exit ${job.status}`;
}

/** "[1]+  Running                 sleep 100 &" */
export function formatJobLine(job: Job, marker: string, withPid = false): string {
  const state = jobStateText(job);
  const cmd = job.state === 'running' ? `${job.command} &` : job.command;
  const pid = withPid ? `${job.leaderPid} ` : '';
  return `[${job.id}]${marker}  ${pid}${state.padEnd(24)}${cmd}`;
}
