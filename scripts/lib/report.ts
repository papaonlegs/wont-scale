/**
 * The report renderer (plan U5).
 *
 * Findings JSON becomes WONT-SCALE-REPORT.md in the kit's voice — the session
 * renders it, never the driven model, so the report reads as one voice across
 * every CLI and stays testable without a live model (KTD1). Carries secret
 * redaction (RD5), the strict revert block (KTD9), and the beyond-depth
 * professional nudge (R11/AE4).
 */

import { REASONS, severityRank } from './findings-schema.ts';
import type { Finding, Severity } from './findings-schema.ts';
import type { RevertMarker } from './fix.ts';

const SEVERITY_HEADING: Record<Severity, string> = {
  critical: 'Critical — fix before more users arrive',
  high: 'High — fix before scale or payments',
  advisory: 'Advisory — schedule it',
};
const SERIES = 'https://papa.onle.gs/writing/index.html';

// Reasons whose fix is structural, not a one-step change — a finding here that a
// reader cannot self-fix is where R11's "consult a professional" belongs.
const STRUCTURAL_REASONS = new Set<number>([4, 5, 1, 7]);

const REVERT_BEGIN = '<!-- wont-scale:revert:begin -->';
const REVERT_END = '<!-- wont-scale:revert:end -->';

export interface RenderOptions {
  project?: string;
  date?: string;
  stack?: string;
  previous?: string | null;
  revert?: RevertMarker | null;
}

/**
 * Redact secret-shaped values from evidence (RD5): the report is written to the
 * target root and may be committed, so it must never carry a live secret. Keep
 * file:line and pattern name; replace long high-entropy or known-token runs.
 */
export function redact(text: unknown): string {
  return String(text)
    // known token prefixes
    .replace(/\b(sk|pk|rk|ghp|gho|xox[baprs]|AKIA|AIza)[-_A-Za-z0-9]{10,}\b/g, '[redacted-token]')
    // generic long high-entropy runs inside quotes (assignments)
    .replace(/(['"])[A-Za-z0-9_\-]{24,}\1/g, '$1[redacted]$1')
    // bare long alnum runs (>=32) that look like keys
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '[redacted]');
}

function escapeMarkerText(text: unknown): string {
  // Agent-authored evidence must never forge the revert delimiter (KTD9).
  return String(text).split(REVERT_BEGIN).join('').split(REVERT_END).join('');
}

function line(f: Finding): string {
  const r = REASONS[f.reason];
  const ev = (f.evidence || []).map((e) => redact(escapeMarkerText(e))).join('; ');
  const nudge = STRUCTURAL_REASONS.has(f.reason) && f.status === 'finding'
    ? ' If this is beyond your depth, this is the kind of finding worth bringing a professional in for.'
    : '';
  return `- **${r.title}** — ${ev || 'see the module'}. [Read](${r.article})${nudge}`;
}

/**
 * Render the report. `opts.previous` (a prior report string) enables a delta
 * note; `opts.revert` = { sha, command } writes the durable, strictly-delimited
 * revert block that U6's parser is the sole consumer of.
 */
export function renderReport(findings: Finding[], { project = 'your project', date = 'today', stack = '', previous = null, revert = null }: RenderOptions = {}): string {
  const bySeverity: Record<Severity, Finding[]> = { critical: [], high: [], advisory: [] };
  const notVerified: Finding[] = [];
  const clean: Finding[] = [];
  for (const f of findings) {
    if (f.status === 'not-verified') notVerified.push(f);
    else if (f.status === 'clean') clean.push(f);
    else bySeverity[f.severity]?.push(f);
  }

  const out: string[] = [];
  out.push(`# Won't-Scale Audit — ${project} — ${date}`);
  out.push('');
  if (stack) out.push(`**Stack:** ${stack}`);
  const crit = bySeverity.critical.length;
  out.push(`**Verdict:** ${crit ? `${crit} critical finding${crit === 1 ? '' : 's'} to fix before more users arrive.` : 'No critical findings — a good outcome.'}`);
  out.push('');

  if (previous) {
    out.push('_Re-run: this report diffs against the previous audit; fixed findings drop out._');
    out.push('');
  }

  for (const sev of ['critical', 'high', 'advisory'] as Severity[]) {
    const items = bySeverity[sev].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    if (!items.length) continue;
    out.push(`## ${SEVERITY_HEADING[sev]}`);
    out.push('');
    for (const f of items) out.push(line(f));
    out.push('');
  }

  if (clean.length) {
    out.push('## Verified clean');
    out.push('');
    for (const f of clean) out.push(`- **${REASONS[f.reason].title}** — checked, found sound.`);
    out.push('');
  }

  if (notVerified.length) {
    out.push('## Not verified');
    out.push('');
    out.push('_A check that could not run is reported here, never as a pass._');
    out.push('');
    for (const f of notVerified) {
      out.push(`- **${REASONS[f.reason].title}** — ${redact(escapeMarkerText(f.not_verified_reason || 'could not run'))}`);
    }
    out.push('');
  }

  if (revert) {
    out.push(`## Applied in this session`);
    out.push('');
    out.push('A fix was applied. To undo it, run the command in the block below. This block is machine-read; do not edit it.');
    out.push('');
    out.push(REVERT_BEGIN);
    out.push(`sha: ${String(revert.sha).replace(/[^0-9a-f]/gi, '').slice(0, 40)}`);
    out.push(`command: ${String(revert.command).split('\n')[0]}`);
    out.push(REVERT_END);
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(`The ten reasons in full: [${SERIES}](${SERIES}).`);
  out.push('');
  return out.join('\n');
}

/**
 * Parse a persisted revert block back out of a report (KTD9). Accepts only a
 * strict 40-hex SHA and a single command line from inside the delimiters, so a
 * report quoting a hostile repo cannot forge a marker that reverts elsewhere.
 */
export function parseRevertBlock(reportText: string): RevertMarker | null {
  const start = reportText.indexOf(REVERT_BEGIN);
  const end = reportText.indexOf(REVERT_END);
  if (start === -1 || end === -1 || end < start) return null;
  const body = reportText.slice(start + REVERT_BEGIN.length, end);
  const sha = (body.match(/^\s*sha:\s*([0-9a-f]{7,40})\s*$/m) || [])[1];
  const command = (body.match(/^\s*command:\s*(.+)$/m) || [])[1];
  if (!sha || !command) return null;
  return { sha, command: command.trim() };
}

export { REVERT_BEGIN, REVERT_END };
