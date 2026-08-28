import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REASONS, REASON_IDS, validateFinding, validateFindingsDoc, isSecretPath,
} from '../scripts/lib/findings-schema.ts';

test('the ten reasons are present with matching ids and slugs', () => {
  assert.equal(REASON_IDS.length, 10);
  assert.deepEqual(REASON_IDS, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(REASONS[4].slug, 'authorisation');
  assert.equal(REASONS[4].severity, 'critical');
});

test('a well-formed finding validates', () => {
  const f = { reason: 4, status: 'finding', severity: 'critical', evidence: ['no RLS on public.invoices'] };
  assert.equal(validateFinding(f).ok, true);
});

test('an unknown reason id is rejected', () => {
  const f = { reason: 99, status: 'finding', severity: 'high', evidence: ['x'] };
  const v = validateFinding(f);
  assert.equal(v.ok, false);
  assert.match(v.error!, /unknown reason id/);
});

test('over-long evidence is rejected', () => {
  const f = { reason: 1, status: 'finding', severity: 'high', evidence: ['x'.repeat(1000)] };
  assert.equal(validateFinding(f).ok, false);
});

test('a not-verified finding needs a reason', () => {
  const f: Record<string, unknown> = { reason: 2, status: 'not-verified', severity: 'high', evidence: [] };
  assert.equal(validateFinding(f).ok, false);
  f.not_verified_reason = 'drive timed out at module 2';
  assert.equal(validateFinding(f).ok, true);
});

test('a findings doc rejects duplicate reason ids', () => {
  const doc = { reasons: [
    { reason: 1, status: 'clean', severity: 'advisory', evidence: ['ok'] },
    { reason: 1, status: 'finding', severity: 'high', evidence: ['dup'] },
  ] };
  const v = validateFindingsDoc(doc);
  assert.equal(v.ok, false);
  assert.match(v.error!, /duplicate reason id/);
});

test('secret-path detection covers common credential filenames', () => {
  for (const name of ['.env', '.env.local', 'server.pem', 'private.key', 'id_rsa', '.npmrc', '.netrc', 'credentials.json', 'my-service-account-key.json', 'terraform.tfstate']) {
    assert.equal(isSecretPath(name), true, `${name} should be secret`);
  }
  for (const name of ['index.js', 'README.md', 'package.json']) {
    assert.equal(isSecretPath(name), false, `${name} should not be secret`);
  }
});
