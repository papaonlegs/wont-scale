/**
 * Git safe-state and filesystem containment (plan U6, KTD3/KTD5).
 *
 * The fix drive edits a stranger's repo, so every claim about what changed is
 * verified against the filesystem, not `git diff` alone — which omits gitignored
 * paths and everything under .git/, so a `.git/hooks/post-checkout` write (code
 * execution on the reader's next git op) would pass a git-only check as an empty
 * diff. The manifest is a realpath-resolved hash of every file under the target
 * including ignored paths and .git/, taken before and after the drive.
 */

import { readdirSync, readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** Run git in `root`; { ok, out } — never throws. Shared with fix.mjs. */
export function git(root, args) {
  try { return { ok: true, out: execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim() }; }
  catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
}

/**
 * Classify a target's git safe-state (KTD5). Returns { state, canFix, detail }.
 * Only 'clean' and 'committed-dirty' allow a fix; no-git, unborn-HEAD, and
 * mid-merge stay report-only with the exact command to change that.
 */
export function safeState(root) {
  const gitDir = git(root, ['rev-parse', '--git-dir']);
  if (!gitDir.ok) {
    return { state: 'no-git', canFix: false, detail: 'not a git repository — run `git init && git add -A && git commit -m "baseline"` first' };
  }
  // Resolve the real git-dir path (a linked worktree's .git is a file, not a dir),
  // so mid-merge/rebase detection works outside a classic .git directory. The
  // returned path is root-relative unless already absolute, so anchor it to root.
  const gp = (name) => {
    const p = git(root, ['rev-parse', '--git-path', name]).out;
    return isAbsolute(p) ? p : join(root, p);
  };
  if (existsSync(gp('MERGE_HEAD')) || existsSync(gp('rebase-merge')) || existsSync(gp('rebase-apply'))) {
    return { state: 'mid-merge', canFix: false, detail: 'a merge or rebase is in progress — finish or abort it before applying a fix' };
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    return { state: 'unborn-head', canFix: false, detail: 'the repo has no commits yet — run `git add -A && git commit -m "baseline"` first' };
  }
  const dirty = git(root, ['status', '--porcelain']).out;
  return { state: dirty ? 'committed-dirty' : 'clean', canFix: true, headSha: head.out, detail: dirty ? 'has uncommitted changes; the fix is isolated from them' : 'clean tree' };
}

const SKIP_WALK = new Set(['node_modules']);

/**
 * A realpath-resolved manifest of every file under `root` — including .git/ and
 * gitignored paths, excluding only node_modules for size — mapping relative path
 * to a content hash. A symlink whose real target escapes `root` is recorded as
 * an escape rather than followed.
 */
export function manifest(root) {
  const realRoot = realpathSync(root);
  const map = new Map();
  const escapes = [];
  const stack = [realRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP_WALK.has(e.name)) continue;
      const p = join(dir, e.name);
      let ls;
      try { ls = lstatSync(p); } catch { continue; }
      if (ls.isSymbolicLink()) {
        let target;
        try { target = realpathSync(p); } catch { map.set(relative(realRoot, p), 'broken-symlink'); continue; }
        if (relative(realRoot, target).startsWith('..')) { escapes.push(relative(realRoot, p)); continue; }
        map.set(relative(realRoot, p), `symlink:${relative(realRoot, target)}`);
        continue;
      }
      if (ls.isDirectory()) { stack.push(p); continue; }
      try {
        const h = createHash('sha1').update(readFileSync(p)).digest('hex');
        map.set(relative(realRoot, p), h);
      } catch { map.set(relative(realRoot, p), 'unreadable'); }
    }
  }
  return { map, escapes };
}

/**
 * Compare two manifests. Returns the containment verdict: which paths changed,
 * whether any land under .git/ or a hook directory, whether any symlink now
 * escapes the target, and whether only the shown diff's expected paths moved.
 */
export function containmentDiff(before, after, { expected = [] } = {}) {
  const changed = [];
  for (const [rel, hash] of after.map) {
    if (before.map.get(rel) !== hash) changed.push(rel);
  }
  for (const rel of before.map.keys()) {
    if (!after.map.has(rel)) changed.push(`${rel} (removed)`);
  }
  const gitWrites = changed.filter((c) => c.startsWith('.git/') || /(^|\/)(\.git\/hooks|\.husky)(\/|$)/.test(c));
  const newEscapes = after.escapes.filter((e) => !before.escapes.includes(e));
  const expectedSet = new Set(expected);
  const unexpected = changed.filter((c) => !expectedSet.has(c.replace(/ \(removed\)$/, '')));
  // Any change the shown diff did not account for — a git write, a symlink escape,
  // or a manifest-visible path git did not report — is a containment breach.
  const contained = gitWrites.length === 0 && newEscapes.length === 0 && unexpected.length === 0;
  return { changed, gitWrites, newEscapes, unexpected, contained };
}
