import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveTarget, findSecretFiles, disclosure, runAuditLoop, readDriveFindings } from '../scripts/lib/session.ts';
import { writeFileSync as wf } from 'node:fs';
import { Session } from '../scripts/lib/state.ts';
import type { Finding } from '../scripts/lib/findings-schema.ts';
import { makeTempRepo, write, initGit, cleanup } from './helpers/fixtures.ts';
import { realpathSync } from 'node:fs';

const toClean: Array<string | (() => void)> = [];
after(() => toClean.forEach((c) => (typeof c === 'function' ? c() : cleanup(c))));
const repo = (): string => { const d = makeTempRepo('wont-scale-session-'); toClean.push(d); return d; };

test('resolveTarget refuses home, root, and marker-less dirs; accepts a project', () => {
  assert.throws(() => resolveTarget(homedir()), /home directory/);
  assert.throws(() => resolveTarget('/'), /filesystem root/);
  const bare = repo();
  assert.throws(() => resolveTarget(bare), /no project marker/);
  const proj = repo();
  write(proj, 'package.json', '{}');
  assert.equal(resolveTarget(proj), realpathSync(proj));
});

test('findSecretFiles surfaces credential files', () => {
  const r = repo();
  write(r, 'package.json', '{}');
  write(r, '.env', 'SECRET=x');
  write(r, 'config/service-account-key.json', '{}');
  const found = findSecretFiles(r);
  assert.ok(found.includes('.env'));
  assert.ok(found.some((f) => f.includes('service-account')));
});

test('disclosure names the provider and fires before any probe', () => {
  const d = disclosure([{ provider: 'Anthropic' }], ['.env']);
  assert.match(d, /Anthropic/);
  assert.match(d, /sends the code in this directory/);
  assert.match(d, /\.env/);
  assert.ok(!/nothing leaves your machine/i.test(d));
});

test('the audit loop drives ten modules and reconciles against the mechanical floor (AE9)', async () => {
  const r = repo();
  write(r, 'package.json', JSON.stringify({ dependencies: { stripe: '12' } }));
  write(r, 'src/webhook.js', 'stripe.webhooks.constructEvent(req); charge();\n'); // idempotency defect
  initGit(r);
  // a drive that lies: reports reason 6 clean
  const driveModule = async (n: number): Promise<Finding> => ({ reason: n, slug: 'x', status: n === 6 ? 'clean' : 'not-verified', severity: 'high', evidence: [], ...(n === 6 ? {} : { not_verified_reason: 'stub' }) });
  const findings = await runAuditLoop({ root: r, driveModule });
  const six = findings.find((f) => f.reason === 6);
  assert.equal(six!.status, 'not-verified', 'the lie is caught by the mechanical cross-check');
  assert.match(six!.not_verified_reason!, /mechanical check fired/);
});

test('the audit loop records completion and resumes without re-driving', async () => {
  const r = repo();
  write(r, 'package.json', '{}');
  initGit(r);
  const s = new Session(realpathSync(r), 'test-1');
  s.open();
  toClean.push(() => s.close());
  let drives = 0;
  const driveModule = async (n: number): Promise<Finding> => { drives++; return { reason: n, slug: 'x', status: 'clean', severity: 'high', evidence: [] }; };
  await runAuditLoop({ root: realpathSync(r), driveModule, session: s });
  assert.equal(drives, 10);
  // resume: a second loop re-uses recorded findings
  drives = 0;
  await runAuditLoop({ root: realpathSync(r), driveModule, session: s });
  assert.equal(drives, 0, 'nothing re-driven on resume');
  s.close();
});

test('a live co-owner makes a second session refuse; a stale one is reclaimable', () => {
  const r = repo();
  write(r, 'package.json', '{}');
  const real = realpathSync(r);
  const b = new Session(real, 'v1');
  // Craft a foreign live-owner state file directly (persist() would stamp our own
  // PID). pid 1 (launchd/init) is always alive and not ours — EPERM on signal.
  const foreign = { kitVersion: 'v1', target: real, answers: {}, completed: [], pid: 1, heartbeat: Date.now() };
  writeFileSync(b.file, JSON.stringify(foreign));
  assert.throws(() => b.open(), /already running/);
  // make that foreign owner stale — reclaimable
  writeFileSync(b.file, JSON.stringify({ ...foreign, heartbeat: Date.now() - 60 * 60 * 1000 }));
  assert.doesNotThrow(() => b.open());
  b.close();
});

test('readDriveFindings reads back and validates the drive output, else falls back', () => {
  const dir = repo();
  const fallback: Finding = { reason: 4, slug: 'authorisation', status: 'not-verified', severity: 'critical', evidence: [], not_verified_reason: 'mechanical could not check' };
  const out = join(dir, 'findings-4.json');
  // valid drive finding -> used
  wf(out, JSON.stringify({ reason: 4, slug: 'authorisation', status: 'finding', severity: 'critical', evidence: ['no RLS on invoices'] }));
  const good = readDriveFindings(out, 4, fallback);
  assert.equal(good.status, 'finding');
  assert.equal(good.evidence[0], 'no RLS on invoices');
  // wrong reason -> fallback (a poisoned result for the wrong module)
  wf(out, JSON.stringify({ reason: 9, status: 'clean', severity: 'high', evidence: [] }));
  assert.equal(readDriveFindings(out, 4, fallback).status, 'not-verified');
  // malformed JSON -> fallback
  wf(out, 'not json at all');
  assert.equal(readDriveFindings(out, 4, fallback), fallback);
  // missing file -> fallback
  assert.equal(readDriveFindings(join(dir, 'nope.json'), 4, fallback), fallback);
});

test('kit-version skew on resume refuses rather than continuing', () => {
  const r = repo();
  write(r, 'package.json', '{}');
  const real = realpathSync(r);
  const a = new Session(real, 'v1'); a.open();
  const b = new Session(real, 'v2');
  assert.throws(() => b.open(), /start fresh/);
  a.close();
});
