/**
 * Session state (plan U4, KTD9).
 *
 * One state file per target, keyed by the target's real path, under a
 * user-owned 0700 root in OS temp — never in the target repo. Carries a
 * kit-version stamp, chosen CLI, interview answers, per-module completion, and
 * the pre-fix marker. It is a liveness lock (owner PID + heartbeat): a stale
 * owner is reclaimed and resumed; only a live owner makes a second session
 * refuse. The report, not this file, is the durable revert source.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Finding } from './findings-schema.ts';

const STALE_MS = 15 * 60 * 1000; // an owner silent this long is presumed dead

/**
 * The persisted shape of one session's state file. `answers`, `cli`, and
 * `preFix` are reserved for the interview/CLI-choice/pre-fix-marker fields
 * described above; nothing in this kit reads their internals yet, so they
 * stay as loosely typed as the module doc comment leaves them. `pid` and
 * `heartbeat` are stamped by persist(); `findings` is written by the drive
 * loop via set().
 */
export interface SessionData {
  kitVersion: string;
  target: string;
  answers: Record<string, unknown>;
  completed: number[];
  cli: string | null;
  preFix: unknown;
  findings?: Finding[];
  pid?: number;
  heartbeat?: number;
}

function root(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'win';
  const base = join(tmpdir(), `wont-scale-${uid}`);
  // Refuse a symlinked or foreign-owned root (KTD9).
  if (existsSync(base)) {
    const ls = lstatSync(base);
    if (ls.isSymbolicLink()) throw new Error(`session root is a symlink: ${base}`);
    if (typeof process.getuid === 'function' && ls.uid !== process.getuid()) {
      throw new Error(`session root not owned by you: ${base}`);
    }
  } else {
    mkdirSync(base, { recursive: true, mode: 0o700 });
  }
  return base;
}

function keyFor(targetRealPath: string): string {
  return createHash('sha256').update(targetRealPath).digest('hex').slice(0, 16);
}

export class Session {
  target: string;
  kitVersion: string;
  file: string;
  data: SessionData | null;

  constructor(targetRealPath: string, kitVersion: string) {
    this.target = targetRealPath;
    this.kitVersion = kitVersion;
    this.file = join(root(), `${keyFor(targetRealPath)}.json`);
    this.data = null;
  }

  /** True when another live session already owns this target. */
  liveOwnerExists(): boolean {
    if (!existsSync(this.file)) return false;
    let prior: Partial<SessionData>;
    try { prior = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SessionData>; } catch { return false; }
    const age = Date.now() - (prior.heartbeat || 0);
    if (age > STALE_MS) return false; // stale — reclaimable
    if (prior.pid === process.pid) return false; // our own
    try { process.kill(prior.pid as number, 0); return true; } // alive and signalable
    catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } // EPERM = alive but not ours; ESRCH = dead/reclaimable
  }

  /** Load prior state for resume, or start fresh. Refuses a live co-owner. */
  open(): SessionData {
    if (this.liveOwnerExists()) {
      const err = new Error('another wont-scale session is already running on this target') as NodeJS.ErrnoException;
      err.code = 'LIVE_OWNER';
      throw err;
    }
    if (existsSync(this.file)) {
      try { this.data = JSON.parse(readFileSync(this.file, 'utf8')) as SessionData; } catch { this.data = null; }
    }
    // Kit-version skew: a newer kit reading an older state refuses to continue.
    if (this.data && this.data.kitVersion && this.data.kitVersion !== this.kitVersion) {
      const err = new Error(`state was written by kit ${this.data.kitVersion}, this is ${this.kitVersion} — start fresh`) as NodeJS.ErrnoException;
      err.code = 'VERSION_SKEW';
      throw err;
    }
    if (!this.data) {
      this.data = { kitVersion: this.kitVersion, target: this.target, answers: {}, completed: [], cli: null, preFix: null };
    }
    this.persist();
    return this.data;
  }

  set(patch: Partial<SessionData>): void { Object.assign(this.data as SessionData, patch); this.persist(); }
  markComplete(reason: number): void { const data = this.data as SessionData; if (!data.completed.includes(reason)) data.completed.push(reason); this.persist(); }
  isComplete(reason: number): boolean { return (this.data as SessionData).completed.includes(reason); }

  persist(): void {
    const data = this.data as SessionData;
    data.pid = process.pid;
    data.heartbeat = Date.now();
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  close(): void { try { rmSync(this.file, { force: true }); } catch { /* ignore */ } }
}
