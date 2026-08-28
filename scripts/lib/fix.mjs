/**
 * The fix drive (plan U6, KTD3/KTD4/KTD5).
 *
 * The success floor: one fix applied, gated twice (consent, then the shown
 * diff), contained, and revertible. The drive itself is injected so the gate
 * logic — tractable selection, safe-state, the write canary, the containment
 * manifest, keep/revert — is verifiable without a live model.
 */

import { execFileSync } from 'node:child_process';
import { REASONS } from './findings-schema.mjs';
import { safeState, manifest, containmentDiff } from './gitstate.mjs';

// Reasons whose module first-fix is additive and bounded — a real one-step fix.
// Structural rewrites (authz/trust-boundary/data-models/statelessness) are not
// offered as the auto fix; the report's professional nudge covers them instead.
const TRACTABLE = new Set([3, 6, 8, 9, 10]);

/**
 * Pick the fix to offer: the highest-severity finding whose reason is a
 * one-step fix. Returns { finding, skipped } — skipped names a worse finding
 * passed over, so the session can say plainly why.
 */
export function selectTractable(findings) {
  const rank = { critical: 0, high: 1, advisory: 2 };
  const open = findings.filter((f) => f.status === 'finding').sort((a, b) => rank[a.severity] - rank[b.severity]);
  const finding = open.find((f) => TRACTABLE.has(f.reason)) || null;
  const skipped = finding && open[0] && open[0].reason !== finding.reason
    ? { reason: open[0].reason, title: REASONS[open[0].reason].title }
    : null;
  return { finding, skipped };
}

function git(root, args) {
  try { return { ok: true, out: execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim() }; }
  catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
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
export async function applyFix({ root, finding, prompt, drive, canaryProbe = null }) {
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

  const before = manifest(root);
  const preSha = state.headSha || git(root, ['rev-parse', 'HEAD']).out;

  await drive(prompt, root);

  const after = manifest(root);
  // Only files git sees as changed are "expected"; everything else is scrutinised.
  const gitChanged = git(root, ['status', '--porcelain'])
    .out.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
  const diff = containmentDiff(before, after, { expected: gitChanged });

  // HEAD must be unchanged — the agent must not have committed.
  const postSha = git(root, ['rev-parse', 'HEAD']).out;
  const committed = preSha && postSha && preSha !== postSha;

  const revert = { sha: preSha, command: `git -C . reset --hard ${preSha} && git -C . clean -fd` };

  if (!diff.contained || committed || diff.gitWrites.length || diff.newEscapes.length) {
    // Containment breach — revert immediately and report loudly.
    if (preSha) { git(root, ['reset', '--hard', preSha]); git(root, ['clean', '-fd']); }
    return {
      applied: false,
      contained: false,
      reverted: true,
      breach: { gitWrites: diff.gitWrites, escapes: diff.newEscapes, committed },
      revert,
    };
  }

  return {
    applied: true,
    contained: true,
    changed: diff.changed,
    diff: git(root, ['diff']).out,
    revert,
  };
}

/** Revert an applied fix from a persisted marker (used on abort/keep=no). */
export function revertTo(root, sha) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return { ok: false, detail: 'invalid sha' };
  const r = git(root, ['reset', '--hard', sha]);
  git(root, ['clean', '-fd']);
  return { ok: r.ok, detail: r.out };
}

export { TRACTABLE };
