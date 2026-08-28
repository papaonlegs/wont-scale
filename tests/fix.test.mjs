import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { selectTractable, applyFix, revertTo } from '../scripts/lib/fix.mjs';
import { makeTempRepo, write, initGit, git, cleanup } from './helpers/fixtures.mjs';

const toClean = [];
after(() => toClean.forEach(cleanup));
const repo = () => { const d = makeTempRepo('wont-scale-fix-'); toClean.push(d); return d; };
const F = (reason, severity) => ({ reason, status: 'finding', severity, evidence: ['x'] });

test('tractable selection skips structural findings for a one-step fix', () => {
  const { finding, skipped } = selectTractable([
    F(4, 'critical'), // authorisation — structural, not offered
    F(6, 'high'),     // idempotency — tractable
  ]);
  assert.equal(finding.reason, 6);
  assert.equal(skipped.reason, 4, 'names the worse finding it passed over');
});

test('selection returns nothing tractable when only structural findings exist', () => {
  const { finding } = selectTractable([F(4, 'critical'), F(5, 'critical'), F(1, 'high')]);
  assert.equal(finding, null);
});

test('a clean in-target fix applies and is contained', async () => {
  const r = repo();
  write(r, 'src/webhook.js', 'export function h() { charge(); }\n');
  initGit(r);
  const drive = async (_p, root) => writeFileSync(join(root, 'src', 'webhook.js'), 'export function h() { if (seen(id)) return; charge(); }\n');
  const res = await applyFix({ root: r, finding: F(6, 'high'), prompt: 'fix', drive });
  assert.equal(res.applied, true);
  assert.equal(res.contained, true);
  assert.ok(res.changed.includes('src/webhook.js'));
});

test('a fix that writes .git/hooks is caught and reverted loudly', async () => {
  const r = repo();
  write(r, 'src/a.js', 'x');
  initGit(r);
  const drive = async (_p, root) => {
    writeFileSync(join(root, 'src', 'a.js'), 'legit change');
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git', 'hooks', 'post-checkout'), 'rm -rf ~');
  };
  const res = await applyFix({ root: r, finding: F(6, 'high'), prompt: 'fix', drive });
  assert.equal(res.applied, false);
  assert.equal(res.contained, false);
  assert.equal(res.reverted, true);
  assert.ok(res.breach.gitWrites.some((g) => g.includes('post-checkout')));
  // the legit change was reverted too — the whole drive is rejected
  assert.equal(git(r, 'status', '--porcelain'), '');
});

test('a fix where the agent commits is caught (HEAD must not move)', async () => {
  const r = repo();
  write(r, 'src/a.js', 'x');
  initGit(r);
  const drive = async (_p, root) => {
    writeFileSync(join(root, 'src', 'a.js'), 'changed');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'agent committed unprompted');
  };
  const res = await applyFix({ root: r, finding: F(6, 'high'), prompt: 'fix', drive });
  assert.equal(res.applied, false);
  assert.equal(res.breach.committed, true);
});

test('the write canary refuses the drive when it escapes the target', async () => {
  const r = repo();
  write(r, 'src/a.js', 'x');
  initGit(r);
  let driven = false;
  const drive = async () => { driven = true; };
  const res = await applyFix({ root: r, finding: F(6, 'high'), prompt: 'fix', drive, canaryProbe: async () => true });
  assert.equal(res.applied, false);
  assert.match(res.refusedReason, /canary escaped/);
  assert.equal(driven, false, 'drive never ran');
});

test('no-git and unborn-HEAD targets refuse the fix report-only', async () => {
  const noGit = repo();
  write(noGit, 'a.js', 'x');
  const res = await applyFix({ root: noGit, finding: F(6, 'high'), prompt: 'fix', drive: async () => {} });
  assert.equal(res.applied, false);
  assert.equal(res.state, 'no-git');
  assert.match(res.refusedReason, /git init/);
});

test('revertTo restores a prior sha and rejects a bad sha', () => {
  const r = repo();
  write(r, 'a.js', 'one');
  initGit(r);
  const sha = git(r, 'rev-parse', 'HEAD');
  writeFileSync(join(r, 'a.js'), 'two');
  git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'second');
  const res = revertTo(r, sha);
  assert.equal(res.ok, true);
  assert.equal(git(r, 'rev-parse', 'HEAD'), sha);
  assert.equal(revertTo(r, 'not-a-sha').ok, false);
});
