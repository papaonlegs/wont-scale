/**
 * The shared findings contract (plan U1).
 *
 * One definition of the audit's vocabulary, imported by the assembler (U2), the
 * report renderer (U5), the mechanical path (U7), and the session's secret
 * checks (U4/KTD3). Nothing here reaches out to a model or the network — it is
 * pure data plus validators, so every consumer agrees on one artifact rather
 * than the last one to define it.
 */

export type Severity = 'critical' | 'high' | 'advisory';
export type Status = 'finding' | 'not-verified' | 'clean';
export type Tier = 'T1' | 'T2';

export interface Reason {
  slug: string;
  tier: Tier;
  severity: Severity;
  title: string;
  article: string;
}

export interface Finding {
  reason: number;
  slug: string;
  status: Status;
  severity: Severity;
  evidence: string[];
  not_verified_reason?: string;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

// The ten reasons, keyed by their canonical id. Slugs and article URLs match
// skills/scale-audit/references/NN-<slug>.md and the published series. Severity
// is the reconciled field (KTD7): a single "how bad" per reason that U5 and U7
// both read, instead of each deriving its own from the module Tier or the
// wizard's KILL_ORDER.
const SERIES = 'https://papa.onle.gs/writing';
export const REASONS: Readonly<Record<number, Reason>> = Object.freeze({
  1: { slug: 'data-models', tier: 'T2', severity: 'high', title: 'You have six data models and you think you have one', article: `${SERIES}/you-have-six-data-models.html` },
  2: { slug: 'query-performance', tier: 'T2', severity: 'high', title: '40ms locally, 40 seconds in production', article: `${SERIES}/40ms-locally-40-seconds-in-production.html` },
  3: { slug: 'authentication', tier: 'T1', severity: 'critical', title: 'The login page is a prop', article: `${SERIES}/the-login-page-is-a-prop.html` },
  4: { slug: 'authorisation', tier: 'T1', severity: 'critical', title: 'Authorisation is a vibe', article: `${SERIES}/authorisation-is-a-vibe.html` },
  5: { slug: 'trust-boundary', tier: 'T1', severity: 'critical', title: 'Your frontend talks straight to the database', article: `${SERIES}/your-frontend-talks-to-the-database.html` },
  6: { slug: 'idempotency', tier: 'T1', severity: 'high', title: 'Nothing is idempotent and everything runs twice', article: `${SERIES}/nothing-is-idempotent.html` },
  7: { slug: 'statelessness', tier: 'T2', severity: 'high', title: "It works on one box, and that's the whole problem", article: `${SERIES}/it-works-on-one-box.html` },
  8: { slug: 'observability', tier: 'T1', severity: 'high', title: "You didn't write it and you can't see it either", article: `${SERIES}/you-cant-see-it-either.html` },
  9: { slug: 'unit-economics', tier: 'T1', severity: 'high', title: 'Profitable at 100 users, bankrupt at 10,000', article: `${SERIES}/profitable-at-100-bankrupt-at-10000.html` },
  10: { slug: 'bus-factor', tier: 'T1', severity: 'high', title: "The bus factor isn't one, it's zero", article: `${SERIES}/the-bus-factor-is-zero.html` },
});

export const REASON_IDS: readonly number[] = Object.freeze(Object.keys(REASONS).map(Number));
export const SEVERITIES: readonly Severity[] = Object.freeze(['critical', 'high', 'advisory']);
export const STATUSES: readonly Status[] = Object.freeze(['finding', 'not-verified', 'clean']);

/** Ordinal rank of a severity for sorting — the one source of the ordering. */
export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);

/** Membership test that narrows `unknown` to a union member of the frozen list. */
const isOneOf = <T extends string>(arr: readonly T[], v: unknown): v is T => (arr as readonly unknown[]).includes(v);

/**
 * Build a finding for a reason from its canonical slug and severity. The single
 * builder used by the mechanical path and the session, so the shape (and the
 * conditional not_verified_reason) lives in one place.
 */
export function finding(reason: number, status: Status, evidence: string[] = [], notVerifiedReason: string | null = null): Finding {
  const r = REASONS[reason];
  return {
    reason,
    slug: r.slug,
    status,
    severity: r.severity,
    evidence,
    ...(status === 'not-verified' ? { not_verified_reason: notVerifiedReason ?? undefined } : {}),
  };
}

// One secret-path set (KTD3), consumed by both the R16 warning and the
// deny-read set — widened past the reviewer's minimum so a credential file is
// not silently sent to a model provider. Matched against basenames.
export const SECRET_PATH_PATTERNS: readonly RegExp[] = Object.freeze([
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
export function validateFinding(f: unknown): ValidationResult {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) {
    return { ok: false, error: 'finding must be an object' };
  }
  const o = f as Record<string, unknown>;
  if (typeof o.reason !== 'number' || !Number.isInteger(o.reason) || !(o.reason in REASONS)) {
    return { ok: false, error: `unknown reason id: ${JSON.stringify(o.reason)}` };
  }
  if (!isOneOf(STATUSES, o.status)) {
    return { ok: false, error: `invalid status: ${JSON.stringify(o.status)}` };
  }
  if (!isOneOf(SEVERITIES, o.severity)) {
    return { ok: false, error: `invalid severity: ${JSON.stringify(o.severity)}` };
  }
  if (!Array.isArray(o.evidence)) {
    return { ok: false, error: 'evidence must be an array' };
  }
  if (o.evidence.length > MAX_EVIDENCE_ITEMS) {
    return { ok: false, error: `evidence exceeds ${MAX_EVIDENCE_ITEMS} items` };
  }
  for (const e of o.evidence) {
    if (typeof e !== 'string') return { ok: false, error: 'evidence items must be strings' };
    if (e.length > MAX_EVIDENCE_CHARS) {
      return { ok: false, error: `evidence item exceeds ${MAX_EVIDENCE_CHARS} chars` };
    }
  }
  if (o.status === 'not-verified' && typeof o.not_verified_reason !== 'string') {
    return { ok: false, error: 'not-verified findings need a not_verified_reason' };
  }
  return { ok: true };
}

/** Type-predicate form of {@link validateFinding} — narrows `unknown` to `Finding`. */
export function isFinding(f: unknown): f is Finding {
  return validateFinding(f).ok;
}

/**
 * Validate a whole findings document: { reasons: Finding[] } with exactly one
 * entry per reason id, each valid. Unknown top-level fields are dropped by the
 * caller, not accepted here.
 */
export function validateFindingsDoc(doc: unknown): ValidationResult {
  if (doc === null || typeof doc !== 'object' || !Array.isArray((doc as { reasons?: unknown }).reasons)) {
    return { ok: false, error: 'findings doc must be { reasons: [...] }' };
  }
  const seen = new Set<number>();
  for (const f of (doc as { reasons: unknown[] }).reasons) {
    if (!isFinding(f)) return validateFinding(f);
    if (seen.has(f.reason)) return { ok: false, error: `duplicate reason id: ${f.reason}` };
    seen.add(f.reason);
  }
  return { ok: true };
}

/**
 * The one-finding contract as JSON Schema, for CLIs that can constrain the
 * agent's final message to a shape (codex `--output-schema`). Strict-mode
 * structured outputs require every property listed as required, so
 * not_verified_reason is always present and empty when unused; the session
 * strips the empty string on read-back.
 */
export const FINDING_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'integer', minimum: 1, maximum: 10 },
    slug: { type: 'string' },
    status: { type: 'string', enum: [...STATUSES] },
    severity: { type: 'string', enum: [...SEVERITIES] },
    evidence: { type: 'array', items: { type: 'string' }, maxItems: MAX_EVIDENCE_ITEMS },
    not_verified_reason: { type: 'string' },
  },
  required: ['reason', 'slug', 'status', 'severity', 'evidence', 'not_verified_reason'],
});

/** True when a basename matches any secret-path pattern (KTD3/R16). */
export function isSecretPath(basename: string): boolean {
  return SECRET_PATH_PATTERNS.some((re) => re.test(basename));
}
