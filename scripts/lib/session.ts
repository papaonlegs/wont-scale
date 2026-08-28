/**
 * The session orchestrator core (plan U4).
 *
 * Testable pieces of the interactive spine: target resolution and its refusals,
 * the R16 disclosure that fires before the probe, the secret-file scan, and the
 * per-module drive loop that reconciles every driven result against the
 * mechanical floor (AE9). The live-CLI wiring lives in the thin CLI; the drive
 * is injected here so the ordering and the reconcile are verifiable.
 */

import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { REASON_IDS, isSecretPath, finding, isFinding } from './findings-schema.ts';
import type { Finding, Status } from './findings-schema.ts';
import { runMechanical, reconcile } from './mechanical.ts';

const PROJECT_MARKERS: string[] = ['package.json', 'pyproject.toml', 'go.mod', 'Gemfile', 'Cargo.toml', 'pom.xml', '.git', 'requirements.txt', 'composer.json'];

/**
 * Resolve and vet the target directory. Refuses $HOME, filesystem root, and any
 * directory with no project marker — a hero command run from ~ must not audit a
 * whole home directory. Returns the real absolute path or throws.
 */
export function resolveTarget(dir: string): string {
  const real = realpathSync(dir);
  if (real === realpathSync(homedir())) throw new Error('refusing to audit your home directory — pass a project path with `sh -s -- /path/to/app`');
  if (real === '/' || real === realpathSync('/')) throw new Error('refusing to audit the filesystem root');
  const hasMarker = PROJECT_MARKERS.some((m) => existsSync(join(real, m)));
  if (!hasMarker) throw new Error(`no project marker in ${real} — is this the right directory? (looked for ${PROJECT_MARKERS.slice(0, 4).join(', ')}, …)`);
  return real;
}

/** Scan the target's top levels for secret-bearing files (R16/KTD3). */
export function findSecretFiles(root: string, { maxDepth = 3 }: { maxDepth?: number } = {}): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (e.isFile() && isSecretPath(e.name)) found.push(relative(root, join(dir, e.name)));
      else if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

// PROJECT_MARKERS is module-private; resolveTarget is the only consumer.

/**
 * The R16 disclosure string, composed before the probe. It names the providers
 * the probe will contact and the secret files present, so the reader learns
 * their code is about to leave the machine before it does.
 */
export function disclosure(adaptersPresent: Array<{ provider: string }>, secretFiles: string[]): string {
  const providers = [...new Set(adaptersPresent.map((a) => a.provider))];
  const lines: string[] = [];
  lines.push('Before I probe anything: the audit sends the code in this directory to');
  lines.push(`your own AI CLI's model provider (${providers.join(', ') || 'the detected provider'}). That includes`);
  lines.push("your employer's or customers' code if this is a work repo. Nothing is stored by");
  lines.push('this tool, but your provider sees what your agent reads.');
  if (secretFiles.length) {
    lines.push('');
    lines.push(`Secret-bearing files are present and would be readable by the audit: ${secretFiles.join(', ')}.`);
    lines.push('Move or exclude them, or continue knowing they may be read.');
  }
  return lines.join('\n');
}

/**
 * Read a driven module's findings JSON back and validate it (KTD1). Returns the
 * validated finding, or the fallback (the mechanical slice) when the file is
 * missing, unparseable, invalid, or for the wrong reason — so a poisoned or
 * malformed drive result degrades to the mechanical floor rather than being run
 * as data. This is the read-back the review flagged as missing.
 */
export function readDriveFindings(outFile: string, reason: number, fallback: Finding): Finding {
  if (!existsSync(outFile)) return fallback;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(outFile, 'utf8')); } catch { return fallback; }
  if (isFinding(parsed) && parsed.reason === reason) return parsed;
  return fallback;
}

/** Minimal shape of the session state object this loop reads and writes (see lib/state). */
interface SessionLike {
  data: { findings?: Finding[] } | null;
  isComplete(reason: number): boolean;
  markComplete(reason: number): void;
  set(patch: Record<string, unknown>): void;
}

/** A driven module call: returns a finding, or null/undefined on failure (caller falls back). */
type DriveModule = (reason: number, root: string, mechanical: Finding[]) => Promise<Finding | null | undefined> | Finding | null | undefined;

/** Per-module progress callback; status is the finding's status, or 'resumed' for a skipped/prior module. */
type OnProgress = (reason: number, status: Status | 'resumed') => void;

/**
 * Run the driven audit loop over the ten modules. `driveModule(reason, root)`
 * returns a finding (or throws/returns null on failure). Every driven result is
 * reconciled against a fresh mechanical run so a clean-where-a-check-fired
 * result becomes not-verified (AE9). `session` records per-module completion for
 * resume; already-complete reasons are skipped.
 */
export async function runAuditLoop({ root, driveModule, session = null, onProgress = () => {} }: {
  root: string;
  driveModule: DriveModule;
  session?: SessionLike | null;
  onProgress?: OnProgress;
}): Promise<Finding[]> {
  const mechanical = runMechanical(root); // one walk; also threaded to the driver
  const findings: Finding[] = [];
  for (const n of REASON_IDS) {
    if (session && session.isComplete(n) && session.data?.findings) {
      const prior = session.data.findings.find((f) => f.reason === n);
      if (prior) { findings.push(prior); onProgress(n, 'resumed'); continue; }
    }
    let f: Finding | null | undefined;
    try { f = await driveModule(n, root, mechanical); }
    catch (e) { f = finding(n, 'not-verified', [], `drive failed: ${String(e).slice(0, 120)}`); }
    if (!f) f = finding(n, 'not-verified', [], 'drive returned nothing');
    findings.push(f);
    if (session) { session.markComplete(n); session.set({ findings }); }
    onProgress(n, f.status);
  }
  // AE9 reconcile across the whole set
  return reconcile(findings, mechanical);
}
