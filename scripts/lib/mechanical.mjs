/**
 * The mechanical audit path (plan U7).
 *
 * A no-drive audit that shares the taxonomy instead of inventing a second one:
 * a curated, zero-dependency subset of the module checks that a plain Node
 * process can run without a live model or a database. It has two jobs — the
 * fallback audit for readers with no AI CLI (R8), and the injection floor under
 * a driven audit (AE9): a module the drive calls clean where a mechanical check
 * fired is forced to not-verified.
 *
 * Findings emit in the shared schema so U5 renders drive and mechanical output
 * identically. Coverage is deliberately shallow — depth is what the AI drive
 * adds — and a reason a mechanical check cannot reach is reported not-verified,
 * never clean.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REASON_IDS, finding } from './findings-schema.mjs';

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|java|php)$/;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '__pycache__', 'coverage']);

/** Walk a repo once into { rel, text } records for each code file, bounded. */
function collectCodeFiles(root, { maxFiles = 4000 } = {}) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) stack.push(p); continue; }
      if (!CODE_EXT.test(e.name)) continue;
      let text;
      try { text = readFileSync(p, 'utf8'); } catch { continue; }
      files.push({ rel: relative(root, p), text });
      if (files.length >= maxFiles) break;
    }
  }
  return files;
}

/** Collect regex hits across the pre-walked file list as `rel:line`, capped. */
function grepFiles(files, re, { cap = 5 } = {}) {
  const hits = [];
  for (const f of files) {
    const lines = f.text.split('\n');
    for (let i = 0; i < lines.length && hits.length < cap; i++) {
      if (re.test(lines[i])) hits.push(`${f.rel}:${i + 1}`);
    }
    if (hits.length >= cap) break;
  }
  return hits;
}

/**
 * Per-reason mechanical detectors. Each returns one finding: a hit list means
 * `finding`, an empty scan means `clean`, and a reason a static pass cannot
 * settle (RLS enforcement, real query counts) returns `not-verified` with why.
 */
const DETECTORS = {
  3(files) { // authentication — hardcoded secrets, non-expiring tokens
    const secrets = grepFiles(files, /(jwt|token|secret|apikey|api_key)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i);
    if (secrets.length) return finding(3, 'finding', secrets);
    const noExpiry = grepFiles(files, /jwt\.sign\([^)]*\)/i);
    if (noExpiry.length) return finding(3, 'finding', noExpiry);
    return finding(3, 'clean', []);
  },
  4() { // authorisation — RLS enforcement needs a live DB
    return finding(4, 'not-verified', [], 'RLS enforcement needs a live database connection; run the AI audit or the SQL checks in the module');
  },
  5(files) { // trust boundary — privileged keys in client-exposed vars
    const all = [
      ...grepFiles(files, /NEXT_PUBLIC_[A-Z_]*(SERVICE|SECRET|ADMIN|PRIVATE)/),
      ...grepFiles(files, /service[_-]?role[_-]?key/i),
    ];
    return all.length ? finding(5, 'finding', all) : finding(5, 'clean', []);
  },
  6(files) { // idempotency — webhook handlers with no dedup
    const webhooks = grepFiles(files, /webhook|stripe\.webhooks|constructEvent/i);
    if (!webhooks.length) return finding(6, 'clean', []);
    const dedup = grepFiles(files, /idempotenc|processed_events|ON CONFLICT|unique.*event/i);
    return dedup.length ? finding(6, 'clean', dedup) : finding(6, 'finding', webhooks);
  },
  8(files, root) { // observability — no error tracker, console.log as telemetry
    const pkg = readPkg(root);
    const hasTracker = pkg && Object.keys(pkg.deps).some((d) =>
      /@sentry|posthog|dd-trace|@opentelemetry|newrelic|@highlight-run/.test(d));
    if (hasTracker) return finding(8, 'clean', ['error tracker in dependencies']);
    const logs = grepFiles(files, /console\.log|print\(/);
    return finding(8, 'finding', logs.length ? logs : ['no error-tracking dependency found']);
  },
  9(files) { // unit economics — metered API calls, rate limiting
    const metered = grepFiles(files, /openai|anthropic|@anthropic-ai|replicate|twilio|sendgrid/i);
    if (!metered.length) return finding(9, 'clean', []);
    const limiter = grepFiles(files, /rate.?limit|ratelimit|token.?bucket|@upstash\/ratelimit/i);
    return limiter.length ? finding(9, 'clean', limiter) : finding(9, 'finding', metered);
  },
  10(files, root) { // bus factor — README setup path, any tests
    const hasReadme = existsSync(join(root, 'README.md'));
    const hasTests = files.some((f) => /\.(test|spec)\./.test(f.rel) || f.rel.includes('__tests__'));
    const missing = [];
    if (!hasReadme) missing.push('no README.md');
    if (!hasTests) missing.push('no test files found');
    return missing.length ? finding(10, 'finding', missing) : finding(10, 'clean', []);
  },
};

function readPkg(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return { deps: { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } };
  } catch { return null; }
}

/** Reasons with no static detector — always not-verified in the mechanical path. */
const STATIC_ONLY_NOT_VERIFIED = {
  1: 'counting overlapping data models needs schema reading; run the AI audit',
  2: 'real query counts need a running app and production-shaped data; run the AI audit',
  7: 'single-box state assumptions need reading the deploy topology; run the AI audit',
};

/** Run the mechanical audit over a target repo, one finding per reason. */
export function runMechanical(root) {
  const files = collectCodeFiles(root); // one walk, shared across every detector
  return REASON_IDS.map((n) =>
    DETECTORS[n]
      ? DETECTORS[n](files, root)
      : finding(n, 'not-verified', [], STATIC_ONLY_NOT_VERIFIED[n] || 'no mechanical check for this reason'));
}

/**
 * AE9 reconcile: given the driven audit's findings and a fresh mechanical run,
 * force any reason the drive reported clean where a mechanical check found a
 * problem to not-verified. Schema validation constrains finding shape; this is
 * what stops a talked-into-clean agent from burying a real defect.
 */
export function reconcile(driveFindings, mechanicalFindings) {
  const mech = new Map(mechanicalFindings.map((f) => [f.reason, f]));
  return driveFindings.map((d) => {
    const m = mech.get(d.reason);
    if (d.status === 'clean' && m && m.status === 'finding') {
      return {
        ...d,
        status: 'not-verified',
        not_verified_reason: `drive reported clean but a mechanical check fired: ${m.evidence.join(', ')}`,
      };
    }
    return d;
  });
}
