import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMechanical, reconcile } from '../scripts/lib/mechanical.ts';
import { validateFinding } from '../scripts/lib/findings-schema.ts';
import type { Finding } from '../scripts/lib/findings-schema.ts';
import { plantedDefectRepo, cleanRepo, cleanup } from './helpers/fixtures.ts';

const toClean: string[] = [];
after(() => toClean.forEach(cleanup));

test('mechanical audit emits one valid finding per reason', () => {
  const root = plantedDefectRepo(); toClean.push(root);
  const findings = runMechanical(root);
  assert.equal(findings.length, 10);
  for (const f of findings) assert.equal(validateFinding(f).ok, true, `reason ${f.reason} valid: ${JSON.stringify(f)}`);
});

test('planted defects surface as findings; static-only reasons are not-verified', () => {
  const root = plantedDefectRepo(); toClean.push(root);
  const by = new Map(runMechanical(root).map((f) => [f.reason, f]));
  assert.equal(by.get(3)!.status, 'finding', 'hardcoded secret');
  assert.equal(by.get(5)!.status, 'finding', 'NEXT_PUBLIC service key');
  assert.equal(by.get(6)!.status, 'finding', 'webhook without dedup');
  assert.equal(by.get(9)!.status, 'finding', 'metered API without limiter');
  assert.equal(by.get(10)!.status, 'finding', 'no README/tests');
  // reasons with no static check are honestly not-verified, never clean
  assert.equal(by.get(1)!.status, 'not-verified');
  assert.equal(by.get(2)!.status, 'not-verified');
  assert.equal(by.get(4)!.status, 'not-verified');
  assert.equal(by.get(7)!.status, 'not-verified');
});

test('a clean repo reports clean where checks ran', () => {
  const root = cleanRepo(); toClean.push(root);
  const by = new Map(runMechanical(root).map((f) => [f.reason, f]));
  assert.equal(by.get(8)!.status, 'clean', 'has error tracker');
  assert.equal(by.get(10)!.status, 'clean', 'has README and tests');
  // no metered API -> clean (nothing to limit)
  assert.equal(by.get(9)!.status, 'clean');
});

test('AE9 reconcile forces a clean drive result to not-verified when a mechanical check fired', () => {
  const root = plantedDefectRepo(); toClean.push(root);
  const mechanical = runMechanical(root);
  // simulate a talked-into-clean agent reporting reason 3 clean
  const drive: Finding[] = [{ reason: 3, slug: 'authentication', status: 'clean', severity: 'critical', evidence: ['all good'] }];
  const reconciled = reconcile(drive, mechanical);
  assert.equal(reconciled[0].status, 'not-verified');
  assert.match(reconciled[0].not_verified_reason!, /mechanical check fired/);
});

test('reconcile leaves an honest clean result alone', () => {
  const root = cleanRepo(); toClean.push(root);
  const mechanical = runMechanical(root);
  const drive: Finding[] = [{ reason: 8, slug: 'observability', status: 'clean', severity: 'high', evidence: ['sentry configured'] }];
  const reconciled = reconcile(drive, mechanical);
  assert.equal(reconciled[0].status, 'clean');
});
