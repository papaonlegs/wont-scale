import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { classify, BUCKETS, CANARY, ADAPTERS, claudeAdapter, codexAdapter } from '../scripts/lib/adapters/index.ts';
import { makeTempRepo, cleanup } from './helpers/fixtures.ts';

const toClean: string[] = [];
after(() => toClean.forEach(cleanup));
const tmp = (): string => { const d = makeTempRepo('wont-scale-adapter-'); toClean.push(d); return d; };

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

const AUDIT = { prompt: 'audit reason 4', promptFile: '/tmp/p.txt', outFile: '/tmp/findings-4.json', schemaFile: '/tmp/finding.schema.json', kitDir: '/tmp/kit' };
const FIX = { prompt: 'fix reason 6', promptFile: '/tmp/fix.txt' };

test('tier-1 adapters ban approval-bypass flags in their drive args', () => {
  const banned = /--dangerously|--yolo|danger-full-access|--force|bypassPermissions/;
  for (const a of [claudeAdapter, codexAdapter]) {
    const audit = a.auditArgs(AUDIT).join(' ');
    const fix = a.fixArgs(FIX).join(' ');
    assert.ok(!banned.test(audit), `${a.id} audit args clean`);
    assert.ok(!banned.test(fix), `${a.id} fix args clean`);
  }
});

test('codex uses the config-override approval form, not the nonexistent flag', () => {
  const args = codexAdapter.auditArgs(AUDIT).join(' ');
  assert.match(args, /-c approval_policy=never/);
  assert.ok(!args.includes('--ask-for-approval'), 'codex exec has no --ask-for-approval');
});

test('the audit drive stays read-only and never asks the agent to write its findings', () => {
  // The regression: a read-only sandbox rejects the findings write, and every
  // module silently fell back to the mechanical slice. The CLI itself must own
  // the output channel, and the prompt travels as text, not an @file to fetch.
  const codex = codexAdapter.auditArgs(AUDIT);
  assert.deepEqual(codex.slice(0, 3), ['exec', '--sandbox', 'read-only']);
  assert.equal(codex[codex.indexOf('-o') + 1], AUDIT.outFile, 'codex writes the last message to -o itself');
  assert.equal(codex[codex.indexOf('--output-schema') + 1], AUDIT.schemaFile);
  assert.equal(codex[codex.length - 1], AUDIT.prompt, 'the prompt is the positional argument');
  assert.ok(!codex.some((x) => x.startsWith('@')), 'no @file reference the model must go and read');
  const claude = claudeAdapter.auditArgs(AUDIT);
  assert.deepEqual(claude.slice(0, 4), ['-p', AUDIT.prompt, '--output-format', 'json']);
  assert.ok(!claude.includes('--allowedTools'), 'the claude audit grants no write tools');
  // without a schema file codex is invoked without --output-schema
  assert.ok(!codexAdapter.auditArgs({ ...AUDIT, schemaFile: undefined }).includes('--output-schema'));
});

test('codex auditResult prefers the -o file and falls back to stdout', () => {
  const dir = tmp();
  const outFile = join(dir, 'findings-4.json');
  assert.equal(codexAdapter.auditResult({ stdout: 'transcript noise', outFile }), 'transcript noise');
  writeFileSync(outFile, '{"reason":4}');
  assert.equal(codexAdapter.auditResult({ stdout: 'transcript noise', outFile }), '{"reason":4}');
  unlinkSync(outFile);
});

test('claude auditResult unwraps the JSON envelope result, else returns the raw text', () => {
  const outFile = '/nonexistent/findings.json';
  const envelope = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"reason":4,"status":"clean"}' });
  assert.equal(claudeAdapter.auditResult({ stdout: envelope, outFile }), '{"reason":4,"status":"clean"}');
  assert.equal(claudeAdapter.auditResult({ stdout: 'plain text answer', outFile }), 'plain text answer');
  assert.equal(claudeAdapter.auditResult({ stdout: '[{"type":"system"},{"type":"result","result":"last"}]', outFile }), 'last');
});

test('the codex probe runs the same read-only shape as the drive', () => {
  // probe and drive share CODEX_READ_ONLY; the drive args must contain the
  // sandbox and approval overrides the probe proved.
  const args = codexAdapter.auditArgs(AUDIT);
  for (const flag of ['--sandbox', 'read-only', '-c', 'approval_policy=never', '--skip-git-repo-check']) assert.ok(args.includes(flag), flag);
});

test('adapters declare their tier and provider', () => {
  const driven = ADAPTERS.filter((a) => a.tier === 'driven').map((a) => a.id);
  const handoff = ADAPTERS.filter((a) => a.tier === 'handoff').map((a) => a.id);
  assert.deepEqual(driven, ['claude', 'codex']);
  assert.deepEqual(handoff, ['cursor', 'gemini']);
});
