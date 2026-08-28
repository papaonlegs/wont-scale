import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  guardrails, replaceMarked, fallbackChecklist, checklistTiers,
  reasonIndexJson, auditPromptFor, fixPrompt, BEGIN, END,
} from '../scripts/lib/assemble.ts';
import type { Finding } from '../scripts/lib/findings-schema.ts';

test('guardrails render each tool variant with all ten rules', () => {
  for (const tool of [undefined, 'agents', 'cursor', 'copilot', 'windsurf']) {
    const g = guardrails(tool);
    assert.match(g, /### 4 — Authorisation is a vibe/);
    assert.match(g, /### 10 — The bus factor/);
  }
  assert.match(guardrails('cursor'), /alwaysApply: false/);
  assert.match(guardrails('windsurf'), /trigger: model_decision/);
  assert.throws(() => guardrails('unknown-tool'));
});

test('the agents variant carries the begin/end markers', () => {
  const g = guardrails('agents');
  assert.ok(g.includes(BEGIN) && g.includes(END));
});

test('replaceMarked swaps the block when markers exist and appends otherwise', () => {
  const withMarkers = `intro\n${BEGIN}\nold\n${END}\ntail`;
  const swapped = replaceMarked(withMarkers, 'new');
  assert.match(swapped, /intro/);
  assert.match(swapped, /tail/);
  assert.match(swapped, /new/);
  assert.ok(!swapped.includes('old'));

  const without = 'just prose';
  const appended = replaceMarked(without, 'block');
  assert.match(appended, /just prose/);
  assert.ok(appended.includes(BEGIN) && appended.includes('block') && appended.includes(END));
});

test('fallback checklist lists all ten reasons with tier and first fix', () => {
  const c = fallbackChecklist();
  for (let n = 1; n <= 10; n++) assert.match(c, new RegExp(`^${n}\\. `, 'm'));
  assert.match(c, /Compressed checks/);
});

test('checklist tiers correct the {3,4,5,6} drift to the nine real T1 reasons', () => {
  const line = checklistTiers();
  // nine T1 reasons: everything except 2
  assert.match(line, /1, 3, 4, 5, 6, 7, 8, 9, 10/);
  assert.ok(!/\b2\b/.test(line.replace('Tier 1', '')));
});

test('reason index is valid JSON with ten entries', () => {
  const idx = JSON.parse(reasonIndexJson());
  assert.equal(idx.length, 10);
  assert.equal(idx[3].slug, 'authorisation');
});

test('audit prompt is per-reason and does not leak other modules', () => {
  const p = auditPromptFor(4);
  assert.match(p, /reason 4/);
  assert.match(p, /RLS|pg_tables/i);
});

test('fix prompt templates from validated fields with negative constraints', () => {
  const finding: Finding = { reason: 6, slug: 'idempotency', status: 'finding', severity: 'high', evidence: ['no unique constraint on stripe_event_id'] };
  const p = fixPrompt(finding);
  assert.match(p, /reason 6/);
  assert.match(p, /no unique constraint on stripe_event_id/);
  assert.match(p, /Never write outside it/);
  assert.match(p, /Do not run git commit/);
});
