#!/usr/bin/env node
/**
 * Regenerates every guardrail aggregate from the canonical Guardrail blocks in
 * skills/scale-audit/references/*.md. Run after editing any module:
 *
 *   node scripts/assemble-guardrails.mjs
 *
 * Generates:
 *   skills/scale-guardrails/SKILL.md
 *   templates/AGENTS.snippet.md
 *   templates/cursor-rules/wont-scale.mdc
 *   templates/copilot-instructions.md
 *   templates/windsurf-rules.md
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REF = join(ROOT, 'skills', 'scale-audit', 'references');
const SERIES = 'https://papa.onle.gs/writing/index.html';

const modules = readdirSync(REF)
  .filter((f) => /^\d{2}-.*\.md$/.test(f))
  .sort();

const blocks = [];
for (const f of modules) {
  const text = readFileSync(join(REF, f), 'utf8');
  const title = (text.match(/^# (.+)$/m) || [])[1] || f;
  const section = text.split(/^## Guardrail\s*$/m)[1];
  if (!section) {
    console.error(`WARN: no "## Guardrail" section in ${f} — skipped`);
    continue;
  }
  const fence = section.match(/```[a-z]*\n([\s\S]*?)```/);
  if (!fence) {
    console.error(`WARN: no fenced block under Guardrail in ${f} — skipped`);
    continue;
  }
  blocks.push({ file: f, title, rules: fence[1].trim() });
}

if (blocks.length !== modules.length) {
  console.error(`Extracted ${blocks.length}/${modules.length} guardrail blocks.`);
}

const rulesBody = blocks
  .map((b) => `### ${b.title}\n\n${b.rules}`)
  .join('\n\n');

const banner = (style) =>
  style === 'html'
    ? `<!-- wont-scale guardrails v1 — generated from the audit modules; regenerate, don't hand-edit.\n     Source: https://github.com/papaonlegs/wont-scale · Series: ${SERIES} -->`
    : `# Generated from the wont-scale audit modules — regenerate, don't hand-edit.\n# Source: https://github.com/papaonlegs/wont-scale · Series: ${SERIES}`;

// --- skill ------------------------------------------------------------------

writeFileSync(join(ROOT, 'skills', 'scale-guardrails', 'SKILL.md'),
`---
name: scale-guardrails
description: Coding-time guardrails against the ten failure modes of vibe-coded apps. Use when writing or reviewing code that touches database schema or migrations, authentication or sessions, authorisation or RLS policies, client-side data access, webhooks or background jobs, payment flows, caching or cron, logging, or endpoints that call LLMs and other metered APIs.
---

# Scale guardrails

These rules exist so the ten failure modes from
[the series](${SERIES}) are prevented at write time
instead of found at audit time. Apply the sections relevant to the change in hand;
each links to a full module with symptoms, checks, and fixes one level down in
[../scale-audit/references/](../scale-audit/references/).

When the user asks to "install the guardrails", append the contents of
\`\${CLAUDE_PLUGIN_ROOT}/templates/AGENTS.snippet.md\` (or \`templates/AGENTS.snippet.md\`
in a checkout of the kit) to the project's AGENTS.md and/or CLAUDE.md inside the
marked section — create the file if it does not exist, and never overwrite content
outside the markers.

${rulesBody}
`);

// --- AGENTS.md snippet ------------------------------------------------------

writeFileSync(join(ROOT, 'templates', 'AGENTS.snippet.md'),
`${banner('html')}
<!-- wont-scale:begin -->

## Won't-scale guardrails

Standing rules for AI-assisted changes in this repo. Full audit modules and the
essays behind each rule: ${SERIES}

${rulesBody}

<!-- wont-scale:end -->
`);

// --- Cursor rule ------------------------------------------------------------

writeFileSync(join(ROOT, 'templates', 'cursor-rules', 'wont-scale.mdc'),
`---
description: Guardrails against the ten scale failure modes of vibe-coded apps — apply when changing schema, auth, authorisation, client data access, webhooks, jobs, state, logging, or metered-API endpoints.
alwaysApply: false
---

${banner('html')}

${rulesBody}
`);

// --- Copilot ----------------------------------------------------------------

writeFileSync(join(ROOT, 'templates', 'copilot-instructions.md'),
`${banner('html')}

${rulesBody}
`);

// --- Windsurf ---------------------------------------------------------------

writeFileSync(join(ROOT, 'templates', 'windsurf-rules.md'),
`---
trigger: model_decision
description: Guardrails against the ten scale failure modes of vibe-coded apps — schema, auth, authorisation, client data access, webhooks, jobs, state, logging, metered APIs.
---

${banner('html')}

${rulesBody}
`);

console.log(`Assembled ${blocks.length} guardrail blocks into 5 files.`);
