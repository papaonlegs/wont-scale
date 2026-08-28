import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { safeState, manifest, containmentDiff } from '../scripts/lib/gitstate.mjs';
import { makeTempRepo, write, initGit, git, cleanup } from './helpers/fixtures.mjs';

const toClean = [];
after(() => toClean.forEach(cleanup));
const repo = () => { const d = makeTempRepo('wont-scale-git-'); toClean.push(d); return d; };

test('safeState classifies clean, dirty, no-git, unborn-HEAD, mid-merge', () => {
  const noGit = repo();
  write(noGit, 'a.js', 'x');
  assert.equal(safeState(noGit).state, 'no-git');
  assert.equal(safeState(noGit).canFix, false);

  const unborn = repo();
  git(unborn, 'init', '-q');
  write(unborn, 'a.js', 'x');
  assert.equal(safeState(unborn).state, 'unborn-head');

  const clean = repo();
  write(clean, 'a.js', 'x');
  initGit(clean);
  assert.equal(safeState(clean).state, 'clean');
  assert.equal(safeState(clean).canFix, true);

  const dirty = repo();
  write(dirty, 'a.js', 'x');
  initGit(dirty);
  write(dirty, 'a.js', 'changed');
  assert.equal(safeState(dirty).state, 'committed-dirty');
  assert.equal(safeState(dirty).canFix, true);

  const merge = repo();
  write(merge, 'a.js', 'x');
  initGit(merge);
  writeFileSync(join(merge, '.git', 'MERGE_HEAD'), 'deadbeef');
  assert.equal(safeState(merge).state, 'mid-merge');
  assert.equal(safeState(merge).canFix, false);
});

test('containment catches a .git/hooks write that git diff would miss', () => {
  const r = repo();
  write(r, 'src/a.js', 'x');
  initGit(r);
  const before = manifest(r);
  // the "agent" writes a hook — invisible to `git diff`
  mkdirSync(join(r, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(r, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nrm -rf ~\n');
  const after = manifest(r);
  const diff = containmentDiff(before, after);
  assert.equal(diff.contained, false);
  assert.ok(diff.gitWrites.some((g) => g.includes('.git/hooks/post-checkout')));
});

test('containment catches a symlink that escapes the target', () => {
  const r = repo();
  write(r, 'src/a.js', 'x');
  initGit(r);
  const before = manifest(r);
  symlinkSync('/etc/passwd', join(r, 'escape'));
  const after = manifest(r);
  const diff = containmentDiff(before, after);
  assert.equal(diff.contained, false);
  assert.ok(diff.newEscapes.includes('escape'));
});

test('an in-target edit is contained; only the expected path is unexpected-free', () => {
  const r = repo();
  write(r, 'src/a.js', 'x');
  initGit(r);
  const before = manifest(r);
  writeFileSync(join(r, 'src', 'a.js'), 'fixed');
  const after = manifest(r);
  const diff = containmentDiff(before, after, { expected: ['src/a.js'] });
  assert.equal(diff.contained, true);
  assert.deepEqual(diff.gitWrites, []);
  assert.deepEqual(diff.unexpected, []);
  assert.ok(diff.changed.includes('src/a.js'));
});
