/**
 * The shared findings contract (plan U1).
 *
 * One definition of the audit's vocabulary, imported by the assembler (U2), the
 * report renderer (U5), the mechanical path (U7), and the session's secret
 * checks (U4/KTD3). Nothing here reaches out to a model or the network — it is
 * pure data plus validators, so every consumer agrees on one artifact rather
 * than the last one to define it.
 */

// The ten reasons, keyed by their canonical id. Slugs and article URLs match
// skills/scale-audit/references/NN-<slug>.md and the published series. Severity
// is the reconciled field (KTD7): a single "how bad" per reason that U5 and U7
// both read, instead of each deriving its own from the module Tier or the
// wizard's KILL_ORDER.
export const REASONS = Object.freeze({
  1: { slug: 'data-models', tier: 'T2', severity: 'high', title: 'You have six data models and you think you have one' },
  2: { slug: 'query-performance', tier: 'T2', severity: 'high', title: '40ms locally, 40 seconds in production' },
  3: { slug: 'authentication', tier: 'T1', severity: 'critical', title: 'The login page is a prop' },
  4: { slug: 'authorisation', tier: 'T1', severity: 'critical', title: 'Authorisation is a vibe' },
  5: { slug: 'trust-boundary', tier: 'T1', severity: 'critical', title: 'Your frontend talks straight to the database' },
  6: { slug: 'idempotency', tier: 'T1', severity: 'high', title: 'Nothing is idempotent and everything runs twice' },
  7: { slug: 'statelessness', tier: 'T2', severity: 'high', title: "It works on one box, and that's the whole problem" },
  8: { slug: 'observability', tier: 'T1', severity: 'high', title: "You didn't write it and you can't see it either" },
  9: { slug: 'unit-economics', tier: 'T1', severity: 'high', title: 'Profitable at 100 users, bankrupt at 10,000' },
  10: { slug: 'bus-factor', tier: 'T1', severity: 'high', title: "The bus factor isn't one, it's zero" },
});

export const REASON_IDS = Object.freeze(Object.keys(REASONS).map(Number));
export const SEVERITIES = Object.freeze(['critical', 'high', 'advisory']);
export const STATUSES = Object.freeze(['finding', 'not-verified', 'clean']);

// One secret-path set (KTD3), consumed by both the R16 warning and the
// deny-read set — widened past the reviewer's minimum so a credential file is
// not silently sent to a model provider. Matched against basenames.
export const SECRET_PATH_PATTERNS = Object.freeze([
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /^id_[a-z0-9]+$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^credentials.*$/i,
  /service-account.*\.json$/i,
  /\.tfstate$/i,
]);

const MAX_EVIDENCE_ITEMS = 12;
const MAX_EVIDENCE_CHARS = 600;

/**
 * Validate one finding object against the closed contract. Returns
 * { ok: true } or { ok: false, error } — never throws on bad data, so a
 * poisoned or malformed drive result is rejected as data, not run as code.
 * Constraining shape here does not by itself stop suppression (an empty
 * findings array is valid) — the mechanical cross-check in U7 does that (AE9).
 */
export function validateFinding(f) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) {
    return { ok: false, error: 'finding must be an object' };
  }
  if (!Number.isInteger(f.reason) || !(f.reason in REASONS)) {
    return { ok: false, error: `unknown reason id: ${JSON.stringify(f.reason)}` };
  }
  if (!STATUSES.includes(f.status)) {
    return { ok: false, error: `invalid status: ${JSON.stringify(f.status)}` };
  }
  if (!SEVERITIES.includes(f.severity)) {
    return { ok: false, error: `invalid severity: ${JSON.stringify(f.severity)}` };
  }
  if (!Array.isArray(f.evidence)) {
    return { ok: false, error: 'evidence must be an array' };
  }
  if (f.evidence.length > MAX_EVIDENCE_ITEMS) {
    return { ok: false, error: `evidence exceeds ${MAX_EVIDENCE_ITEMS} items` };
  }
  for (const e of f.evidence) {
    if (typeof e !== 'string') return { ok: false, error: 'evidence items must be strings' };
    if (e.length > MAX_EVIDENCE_CHARS) {
      return { ok: false, error: `evidence item exceeds ${MAX_EVIDENCE_CHARS} chars` };
    }
  }
  if (f.status === 'not-verified' && typeof f.not_verified_reason !== 'string') {
    return { ok: false, error: 'not-verified findings need a not_verified_reason' };
  }
  return { ok: true };
}

/**
 * Validate a whole findings document: { reasons: Finding[] } with exactly one
 * entry per reason id, each valid. Unknown top-level fields are dropped by the
 * caller, not accepted here.
 */
export function validateFindingsDoc(doc) {
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.reasons)) {
    return { ok: false, error: 'findings doc must be { reasons: [...] }' };
  }
  const seen = new Set();
  for (const f of doc.reasons) {
    const v = validateFinding(f);
    if (!v.ok) return v;
    if (seen.has(f.reason)) return { ok: false, error: `duplicate reason id: ${f.reason}` };
    seen.add(f.reason);
  }
  return { ok: true };
}

/** True when a basename matches any secret-path pattern (KTD3/R16). */
export function isSecretPath(basename) {
  return SECRET_PATH_PATTERNS.some((re) => re.test(basename));
}
