import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classify, BUCKETS, CANARY, ADAPTERS, claudeAdapter, codexAdapter } from '../scripts/lib/adapters/index.mjs';
import { makeTempRepo, cleanup } from './helpers/fixtures.mjs';

const toClean = [];
after(() => toClean.forEach(cleanup));
const tmp = () => { const d = makeTempRepo('wont-scale-adapter-'); toClean.push(d); return d; };

test('a clean read-only run with no canary is healthy', () => {
  const dir = tmp();
  const { bucket } = classify({ status: 0, stdout: 'OK', stderr: '', timedOut: false }, dir);
  assert.equal(bucket, BUCKETS.HEALTHY);
});

test('fail-closed: a canary file left behind classifies not-driveable', () => {
  const dir = tmp();
  writeFileSync(join(dir, CANARY), 'x');
  const { bucket, detail } = classify({ status: 0, stdout: 'OK', stderr: '', timedOut: false }, dir);
  assert.equal(bucket, BUCKETS.NOT_DRIVEABLE);
  assert.match(detail, /canary write succeeded/);
  // the probe cleans up the canary it found
  assert.equal(existsSync(join(dir, CANARY)), false);
});

test('an auth error in output classifies unauthenticated', () => {
  const dir = tmp();
  const { bucket } = classify({ status: 1, stdout: '', stderr: 'Not logged in · Please run /login', timedOut: false }, dir);
  assert.equal(bucket, BUCKETS.UNAUTHENTICATED);
});

test('claude reports in-run failure on stdout with exit 0 — still caught', () => {
  const dir = tmp();
  const { bucket } = classify({ status: 0, stdout: '{"is_error":true,"result":"authentication_failed: no api key"}', stderr: '', timedOut: false }, dir);
  assert.equal(bucket, BUCKETS.UNAUTHENTICATED);
});

test('a timeout classifies transient, not not-driveable', () => {
  const dir = tmp();
  const { bucket } = classify({ status: null, stdout: '', stderr: '', timedOut: true }, dir);
  assert.equal(bucket, BUCKETS.TRANSIENT);
});

test('a rate-limit signal classifies transient', () => {
  const dir = tmp();
  const { bucket } = classify({ status: 1, stdout: '', stderr: 'Error 429: rate limit exceeded', timedOut: false }, dir);
  assert.equal(bucket, BUCKETS.TRANSIENT);
});

test('a non-zero exit with no clear signal is not-driveable, never healthy', () => {
  const dir = tmp();
  const { bucket } = classify({ status: 2, stdout: '', stderr: 'unexpected argument', timedOut: false }, dir);
  assert.equal(bucket, BUCKETS.NOT_DRIVEABLE);
});

test('tier-1 adapters ban approval-bypass flags in their drive args', () => {
  const banned = /--dangerously|--yolo|danger-full-access|--force|bypassPermissions/;
  for (const a of [claudeAdapter, codexAdapter]) {
    const audit = a.auditArgs('/tmp/p.txt', '/tmp/kit').join(' ');
    const fix = a.fixArgs('/tmp/p.txt').join(' ');
    assert.ok(!banned.test(audit), `${a.id} audit args clean`);
    assert.ok(!banned.test(fix), `${a.id} fix args clean`);
  }
});

test('codex uses the config-override approval form, not the nonexistent flag', () => {
  const args = codexAdapter.auditArgs('/tmp/p.txt').join(' ');
  assert.match(args, /-c approval_policy=never/);
  assert.ok(!args.includes('--ask-for-approval'), 'codex exec has no --ask-for-approval');
});

test('adapters declare their tier and provider', () => {
  const driven = ADAPTERS.filter((a) => a.tier === 'driven').map((a) => a.id);
  const handoff = ADAPTERS.filter((a) => a.tier === 'handoff').map((a) => a.id);
  assert.deepEqual(driven, ['claude', 'codex']);
  assert.deepEqual(handoff, ['cursor', 'gemini']);
});
