/**
 * The fix drive (plan U6, KTD3/KTD4/KTD5).
 *
 * The success floor: one fix applied, gated twice (consent, then the shown
 * diff), contained, and revertible. The drive itself is injected so the gate
 * logic — tractable selection, safe-state, the write canary, the containment
 * manifest, keep/revert — is verifiable without a live model.
 */

import { REASONS, severityRank } from './findings-schema.ts';
import type { Finding } from './findings-schema.ts';
import { safeState, manifest, containmentDiff, git } from './gitstate.ts';

export interface SkippedFinding {
  reason: number;
  title: string;
}

export interface TractableSelection {
  finding: Finding | null;
  skipped: SkippedFinding | null;
}

export interface RevertMarker {
  sha: string;
  command: string;
}

export interface IsolatedWip {
  sha: string;
  restoreCommand: string;
}

export interface FixResult {
  applied: boolean;
  contained?: boolean;
  reverted?: boolean;
  changed?: string[];
  diff?: string;
  revert?: RevertMarker;
  isolatedWip?: IsolatedWip | null;
  refusedReason?: string;
  state?: string;
  breach?: { gitWrites: string[]; escapes: string[]; unexpected: string[]; committed: boolean };
}

export type DriveFn = (prompt: string, cwd: string) => void | Promise<void>;
export type CanaryProbeFn = (cwd: string) => boolean | Promise<boolean>;

export interface ApplyFixArgs {
  root: string;
  finding: Finding;
  prompt: string;
  drive: DriveFn;
  canaryProbe?: CanaryProbeFn | null;
}

// Reasons whose module first-fix is additive and bounded — a real one-step fix.
// Structural rewrites (authz/trust-boundary/data-models/statelessness) are not
// offered as the auto fix; the report's professional nudge covers them instead.
const TRACTABLE = new Set([3, 6, 8, 9, 10]);

/**
 * Pick the fix to offer: the highest-severity finding whose reason is a
 * one-step fix. Returns { finding, skipped } — skipped names a worse finding
 * passed over, so the session can say plainly why.
 */
export function selectTractable(findings: Finding[]): TractableSelection {
  const open = findings.filter((f) => f.status === 'finding')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const finding = open.find((f) => TRACTABLE.has(f.reason)) || null;
  const skipped = finding && open[0] && open[0].reason !== finding.reason
    ? { reason: open[0].reason, title: REASONS[open[0].reason].title }
    : null;
  return { finding, skipped };
}

/**
 * Apply one fix. `drive(promptFile|prompt, cwd)` performs the actual edit (the
 * adapter's driveWrite, or the hand-off "reader pastes it" path) and returns
 * when the working tree may have changed. `canaryProbe(cwd)` re-checks the write
 * posture immediately before the drive; a positive escape refuses the drive.
 *
 * Returns a structured result the session renders and the report records:
 * { applied, contained, reverted, changed, revert, refusedReason }.
 */
export async function applyFix({ root, finding, prompt, drive, canaryProbe = null }: ApplyFixArgs): Promise<FixResult> {
  const state = safeState(root);
  if (!state.canFix) {
    return { applied: false, refusedReason: state.detail, state: state.state };
  }
  // Pre-drive containment canary against the WRITE posture (KTD3): if a scoped
  // write escapes the target, the sandbox is not honouring scope — refuse.
  if (canaryProbe) {
    const escaped = await canaryProbe(root);
    if (escaped) return { applied: false, refusedReason: 'write canary escaped the target; the sandbox is not honouring its scope', state: state.state };
  }

  const originalSha = state.headSha || git(root, ['rev-parse', 'HEAD']).out;

  // KTD5: never destroy the reader's uncommitted work. On a dirty tree, isolate
  // their work in a commit first (offered, not a silent stash) so the fix lands
  // on a clean base and reverting removes only the fix, leaving their work intact.
  let baseSha = originalSha;
  let isolatedWip: IsolatedWip | null = null;
  if (state.state === 'committed-dirty') {
    git(root, ['add', '-A']);
    const c = git(root, ['commit', '-m', 'wont-scale: your work in progress, isolated before the audit fix']);
    if (!c.ok) return { applied: false, refusedReason: 'could not isolate your uncommitted changes before the fix; commit or stash them and re-run', state: state.state };
    baseSha = git(root, ['rev-parse', 'HEAD']).out;
    isolatedWip = { sha: baseSha, restoreCommand: `git -C . reset --soft ${originalSha}` };
  }

  const before = manifest(root);
  await drive(prompt, root);
  const after = manifest(root);

  // Only files git now sees changed are "expected"; the WIP is already committed,
  // so anything else the manifest surfaces is scrutinised. Use bare-path commands
  // (not porcelain, whose leading status space the git() wrapper trims away).
  const tracked = git(root, ['diff', '--name-only', 'HEAD']).out.split('\n').filter(Boolean);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean);
  const gitChanged = [...tracked, ...untracked];
  const diff = containmentDiff(before, after, { expected: gitChanged });

  // HEAD must equal baseSha — the agent must not have committed on top.
  const postSha = git(root, ['rev-parse', 'HEAD']).out;
  const committed = Boolean(baseSha && postSha && baseSha !== postSha);

  // Revert restores to baseSha (the reader's work preserved when it was isolated).
  const revert: RevertMarker = { sha: baseSha, command: `git -C . reset --hard ${baseSha} && git -C . clean -fd` };

  if (!diff.contained || committed) {
    if (baseSha) { git(root, ['reset', '--hard', baseSha]); git(root, ['clean', '-fd']); }
    return {
      applied: false,
      contained: false,
      reverted: true,
      breach: { gitWrites: diff.gitWrites, escapes: diff.newEscapes, unexpected: diff.unexpected, committed },
      revert,
      isolatedWip,
    };
  }

  return {
    applied: true,
    contained: true,
    changed: diff.changed,
    diff: git(root, ['diff']).out,
    revert,
    isolatedWip,
  };
}

/** Revert an applied fix from a persisted marker (used on abort/keep=no). */
export function revertTo(root: string, sha: string): { ok: boolean; detail: string } {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return { ok: false, detail: 'invalid sha' };
  const r = git(root, ['reset', '--hard', sha]);
  git(root, ['clean', '-fd']);
  return { ok: r.ok, detail: r.out };
}
