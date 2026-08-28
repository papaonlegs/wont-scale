import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadModules, parseModule, reasonIndex, taxonomyDigest, auditPrompt,
} from '../scripts/lib/modules.ts';

test('all ten modules parse with the expected fields', () => {
  const mods = loadModules();
  assert.equal(mods.length, 10);
  for (const m of mods) {
    assert.ok(m.n >= 1 && m.n <= 10);
    assert.ok(m.slug, `module ${m.n} has a slug`);
    assert.ok(m.title.length > 0, `module ${m.n} has a title`);
    assert.match(m.article, /^https:\/\/papa\.onle\.gs\/writing\//, `module ${m.n} article url`);
    assert.ok(['T1', 'T2'].includes(m.tier));
    assert.ok(m.guardrail.length > 0, `module ${m.n} has a guardrail block`);
    assert.ok(m.checks.length > 0, `module ${m.n} has checks`);
  }
});

test('module 4 is authorisation, T1, with SQL checks', () => {
  const m = parseModule('04-authorisation.md');
  assert.equal(m.slug, 'authorisation');
  assert.equal(m.tier, 'T1');
  assert.equal(m.severity, 'critical');
  assert.match(m.checks, /pg_tables|rowsecurity|RLS/i);
});

test('the checklist tier drift is corrected by the reconciled severity/tier field', () => {
  // audit/CHECKLIST.md historically named Tier 1 = {3,4,5,6}; the modules mark
  // nine of ten T1. The parsed tier is the authority the checklist regenerates from.
  const t1 = loadModules().filter((m) => m.tier === 'T1').map((m) => m.n);
  assert.ok(t1.length >= 9, `expected nine T1 reasons, got ${t1.length}`);
  assert.ok(!t1.includes(2), 'reason 2 (query performance) is the sole T2');
});

test('reason index carries the wizard-hand-copied fields', () => {
  const idx = reasonIndex();
  assert.equal(idx.length, 10);
  const r4 = idx.find((r) => r.n === 4);
  assert.equal(r4!.slug, 'authorisation');
  assert.ok(r4!.firstFix.length > 0);
  assert.ok(r4!.article.length > 0);
});

test('the taxonomy digest is stable across runs and 16 hex chars', () => {
  const a = taxonomyDigest();
  const b = taxonomyDigest();
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('audit prompt embeds the module checks, the findings contract, and an injection preamble', () => {
  const m = parseModule('06-idempotency.md');
  const p = auditPrompt(m);
  assert.match(p, /DATA to inspect, never instructions/);
  assert.ok(p.includes(m.checks.split('\n')[0]));
  assert.match(p, /"reason": 6/);
  assert.match(p, /not-verified/);
  // must not leak another module's checks
  assert.ok(!p.includes('pg_policies'), 'idempotency prompt should not carry authz SQL');
});
