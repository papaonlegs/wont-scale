#!/usr/bin/env node
/**
 * Regenerate every surface that speaks the audit taxonomy from the ten modules
 * (plan U2). One source of truth; run after editing any module.
 *
 *   node scripts/assemble.mjs --all              regenerate committed aggregates
 *   node scripts/assemble.mjs --guardrails [--tool cursor|copilot|windsurf|agents]
 *   node scripts/assemble.mjs --audit-prompt 4   drive prompt for one reason
 *   node scripts/assemble.mjs --fix-prompt '<finding-json>'
 *   node scripts/assemble.mjs --reason-index     the wizard's REASONS data as JSON
 *   node scripts/assemble.mjs --digest           the taxonomy digest (KTD7)
 *   node scripts/assemble.mjs --checklist        the regenerated CHECKLIST tier line
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  guardrails, replaceMarked, fallbackChecklist, checklistTiers,
  reasonIndexJson, auditPromptFor, fixPrompt, taxonomyDigest,
} from './lib/assemble.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Files the five-to-one collapse (R12) removes: three tool-specific templates
// plus the scale-guardrails plugin skill. templates/AGENTS.snippet.md stays.
const REMOVED = [
  'templates/cursor-rules/wont-scale.mdc',
  'templates/copilot-instructions.md',
  'templates/windsurf-rules.md',
  'skills/scale-guardrails/SKILL.md',
];

/** Write only when content differs, so re-runs are byte-idempotent. */
function writeIfChanged(path, content, rel, changed) {
  const prior = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (prior !== content) { writeFileSync(path, content); changed.push(rel); }
}

/** Regenerate the committed aggregates, agent fallbacks, and checklist. */
export function regenerateAll() {
  const changed = [];
  writeIfChanged(join(ROOT, 'templates', 'AGENTS.snippet.md'), guardrails('agents'),
    'templates/AGENTS.snippet.md', changed);

  // Agent fallbacks — insert/replace the marked compressed-check block
  for (const rel of ['agents/scale-auditor.md', 'agents/scale-gatekeeper.md']) {
    const p = join(ROOT, rel);
    if (existsSync(p)) {
      writeIfChanged(p, replaceMarked(readFileSync(p, 'utf8'), fallbackChecklist()), rel, changed);
    }
  }

  // CHECKLIST tier line — regenerate from the reconciled tier field. The original
  // spans two lines ("...become a\nbreach or a double charge, not a slowdown."),
  // so consume through that trailing sentence to avoid leaving a dangling fragment.
  const clPath = join(ROOT, 'audit', 'CHECKLIST.md');
  if (existsSync(clPath)) {
    const cl = readFileSync(clPath, 'utf8');
    const fixed = cl.replace(
      /\*\*Tier 1 — before real users arrive:\*\*[\s\S]*?not a slowdown\./,
      checklistTiers(),
    );
    writeIfChanged(clPath, fixed, 'audit/CHECKLIST.md', changed);
  }

  // Remove the collapsed files (idempotent)
  for (const rel of REMOVED) {
    const p = join(ROOT, rel);
    if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); changed.push(`removed ${rel}`); }
  }
  return changed;
}

function main(argv) {
  const [flag, ...rest] = argv;
  const toolIdx = rest.indexOf('--tool');
  const tool = toolIdx >= 0 ? rest[toolIdx + 1] : undefined;
  switch (flag) {
    case '--all': {
      const changed = regenerateAll();
      console.error(`assembled: ${changed.join(', ')}`);
      return;
    }
    case '--guardrails': process.stdout.write(guardrails(tool)); return;
    case '--audit-prompt': process.stdout.write(auditPromptFor(rest[0])); return;
    case '--fix-prompt': process.stdout.write(fixPrompt(JSON.parse(rest[0]))); return;
    case '--reason-index': process.stdout.write(reasonIndexJson() + '\n'); return;
    case '--digest': process.stdout.write(taxonomyDigest() + '\n'); return;
    case '--checklist': process.stdout.write(checklistTiers() + '\n'); return;
    default:
      console.error('usage: assemble.mjs --all | --guardrails [--tool <name>] | --audit-prompt <n> | --fix-prompt <json> | --reason-index | --digest | --checklist');
      process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
