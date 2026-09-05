/**
 * The assembler (plan U2): every surface that speaks the audit taxonomy is
 * generated from the ten modules, so the session, the plugin, the agents, and
 * the guardrail files never drift apart. Pure string builders here; the thin
 * CLI in scripts/assemble.ts writes them to disk.
 */

import { loadModules, reasonIndex, taxonomyDigest, auditPrompt } from './modules.ts';
import type { ParsedModule as Module } from './modules.ts';
import type { Finding } from './findings-schema.ts';

const SERIES = 'https://papa.onle.gs/writing/index.html';
const REPO = 'https://github.com/papaonlegs/wont-scale';
export const BEGIN = '<!-- wont-scale:begin -->';
export const END = '<!-- wont-scale:end -->';

const htmlBanner = `<!-- wont-scale guardrails — generated from the audit modules; regenerate, don't hand-edit.\n     Source: ${REPO} · Series: ${SERIES} -->`;

function rulesBody(modules: Module[]): string {
  // m.title already carries its number (the module H1 is "4 — Authorisation is a vibe").
  return modules
    .filter((m) => m.guardrail)
    .map((m) => `### ${m.title}\n\n${m.guardrail}`)
    .join('\n\n');
}

/** The committed AGENTS.md snippet and on-demand per-tool variants (R12). */
export function guardrails(tool?: string, modules: Module[] = loadModules()): string {
  const body = rulesBody(modules);
  switch (tool) {
    case 'agents':
    case undefined:
      return `${htmlBanner}\n${BEGIN}\n\n## Won't-scale guardrails\n\nStanding rules for AI-assisted changes in this repo. Full audit modules and the essays behind each rule: ${SERIES}\n\n${body}\n\n${END}\n`;
    case 'cursor':
      return `---\ndescription: Guardrails against the ten scale failure modes of vibe-coded apps — apply when changing schema, auth, authorisation, client data access, webhooks, jobs, state, logging, or metered-API endpoints.\nalwaysApply: false\n---\n\n${htmlBanner}\n\n${body}\n`;
    case 'copilot':
      return `${htmlBanner}\n\n${body}\n`;
    case 'windsurf':
      return `---\ntrigger: model_decision\ndescription: Guardrails against the ten scale failure modes of vibe-coded apps — schema, auth, authorisation, client data access, webhooks, jobs, state, logging, metered APIs.\n---\n\n${htmlBanner}\n\n${body}\n`;
    default:
      throw new Error(`unknown guardrail tool: ${tool} (agents|cursor|copilot|windsurf)`);
  }
}

/** Replace the content between the wont-scale markers, or append a marked block. */
export function replaceMarked(existing: string, inner: string): string {
  const block = `${BEGIN}\n${inner}\n${END}`;
  if (existing.includes(BEGIN) && existing.includes(END)) {
    return existing.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block);
  }
  return `${existing.trimEnd()}\n\n${block}\n`;
}

/** The compact reason checklist injected into the two agent fallbacks. */
export function fallbackChecklist(modules: Module[] = loadModules()): string {
  const lines = modules.map((m) =>
    `${m.n}. **${m.title.replace(/^\d+\s*—\s*/, '')}** (${m.tier}, ${m.severity}) — ${m.firstFix || 'see the module'}`);
  return `## Compressed checks (generated — regenerate with \`node dist/assemble.js\`)\n\nWhen \`CLAUDE_PLUGIN_ROOT\` is unset the full modules are unavailable; audit against these:\n\n${lines.join('\n')}\n\nFull modules and evidence: ${SERIES}`;
}

/** audit/CHECKLIST.md tier lines, regenerated from the reconciled tier field. */
export function checklistTiers(modules: Module[] = loadModules()): string {
  const t1 = modules.filter((m) => m.tier === 'T1').map((m) => m.n).sort((a, b) => a - b);
  return `**Tier 1 — before real users arrive:** ${t1.join(', ')}. These are the ones that become a breach or a double charge, not a slowdown.`;
}

/** The reason index as JSON — replaces the wizard's hand-copied REASONS. */
export function reasonIndexJson(modules: Module[] = loadModules()): string {
  return JSON.stringify(reasonIndex(modules), null, 2);
}

/** The audit drive prompt for one reason (1-10). */
export function auditPromptFor(n: number | string, modules: Module[] = loadModules()): string {
  const m = modules.find((x) => x.n === Number(n));
  if (!m) throw new Error(`no module numbered ${n}`);
  return auditPrompt(m);
}

/**
 * The fix drive prompt for one validated finding. Templated from validated
 * fields only — never agent free-text passthrough (AE9/KTD3) — and carrying the
 * negative constraints that keep the fix contained.
 */
export function fixPrompt(finding: Finding, modules: Module[] = loadModules()): string {
  const m = modules.find((x) => x.n === Number(finding.reason));
  if (!m) throw new Error(`no module numbered ${finding.reason}`);
  const evidence = Array.isArray(finding.evidence) ? finding.evidence.slice(0, 8) : [];
  return `# Fix: reason ${m.n} — ${m.title}

Apply the smallest real fix for this one finding, and nothing else.

Recommended first fix for this reason: ${m.firstFix || '(see the module)'}

Evidence found:
${evidence.map((e) => `- ${e}`).join('\n') || '- (none supplied)'}

Hard constraints — the session verifies these afterwards and reverts on any breach:
- Change only files inside the target directory. Never write outside it.
- Never write under .git/ or any git hook directory.
- Do not run git commit, git push, or any git write command.
- Make one logical change. Do not refactor unrelated code.
- After the change, re-run this reason's own check and report whether it now passes.`;
}

export { taxonomyDigest };
