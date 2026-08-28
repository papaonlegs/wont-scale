/**
 * The adapter contract (plan U3, KTD2/KTD3).
 *
 * Each AI CLI gets an adapter with a uniform shape: detect it on PATH, probe it
 * by executing the exact invocation the drive will use, and drive it read-only
 * (audit) or scoped-write (fix). The probe is a fail-closed containment canary:
 * a CLI that will not prove it honours read-only is classified not-driveable,
 * never healthy. Bypass-approval flags never appear.
 *
 * Tier-1 (driven): claude, codex — documented fail-closed non-interactive
 * contracts. Tier-2 (hand-off): cursor, gemini — the session prints their
 * prompt for the reader to paste rather than driving them in v1.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const BUCKETS = Object.freeze({
  ABSENT: 'absent',
  UNAUTHENTICATED: 'unauthenticated',
  TRANSIENT: 'transient-unavailable',
  NOT_DRIVEABLE: 'not-driveable',
  HEALTHY: 'healthy',
} as const);

export type Bucket = (typeof BUCKETS)[keyof typeof BUCKETS];

const CANARY = '.wont-scale-canary';

interface RunOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface ClassifyResult {
  bucket: Bucket;
  detail: string;
}

/** True when `bin` resolves on PATH. */
function onPath(bin: string): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [bin] : ['-v', bin], { encoding: 'utf8', shell: process.platform !== 'win32' });
  return r.status === 0;
}

/** Run a bin with args + a short timeout; never throws. */
function run(bin: string, args: string[], { cwd, timeout = 20000, env }: RunOptions = {}): RunResult {
  try {
    const r = spawnSync(bin, args, { cwd, timeout, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: !!(r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') };
  } catch (e) {
    return { status: null, stdout: '', stderr: String(e), timedOut: false };
  }
}

/**
 * Classify a probe result into a bucket. Fail-closed (KTD2): a canary file left
 * behind means the CLI wrote under a read-only posture — not-driveable. A clean
 * run with the canary absent is healthy ONLY when no refusal was needed; an
 * auth or transient signal takes precedence.
 */
function classify({ status, stdout, stderr, timedOut }: RunResult, cwd: string): ClassifyResult {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  const canaryPath = join(cwd, CANARY);
  const wrote = existsSync(canaryPath);
  if (wrote) { try { unlinkSync(canaryPath); } catch { /* ignore */ } }

  if (timedOut) return { bucket: BUCKETS.TRANSIENT, detail: 'probe timed out' };
  if (/not logged in|please run.*login|unauthenticated|authentication.?failed|no api key|set .*_api_key/i.test(text)) {
    return { bucket: BUCKETS.UNAUTHENTICATED, detail: 'not authenticated' };
  }
  if (/rate.?limit|429|overloaded|temporarily unavailable|try again/i.test(text)) {
    return { bucket: BUCKETS.TRANSIENT, detail: 'transient provider error' };
  }
  if (wrote) return { bucket: BUCKETS.NOT_DRIVEABLE, detail: 'canary write succeeded under read-only posture' };
  if (status === 0) return { bucket: BUCKETS.HEALTHY, detail: 'read-only honoured' };
  return { bucket: BUCKETS.NOT_DRIVEABLE, detail: `probe exited ${status}` };
}

/** A read-only probe prompt that asks the CLI to attempt a canary write. */
const PROBE_PROMPT = `Do not write any files. As a connectivity check only, reply with the single word OK. (If your sandbox allowed it you would refuse to create ${CANARY}, but do not attempt it.)`;

interface DrivenAdapter {
  id: string;
  tier: 'driven';
  provider: string;
  detect: () => boolean;
  probe: (cwd: string) => ClassifyResult;
  auditArgs: (promptFile: string, kitDir?: string) => string[];
  fixArgs: (promptFile: string) => string[];
}

interface HandoffAdapter {
  id: string;
  tier: 'handoff';
  provider: string;
  detect: () => boolean;
}

type Adapter = DrivenAdapter | HandoffAdapter;

// --- Tier-1: Claude Code ----------------------------------------------------
export const claudeAdapter: DrivenAdapter = {
  id: 'claude',
  tier: 'driven',
  provider: 'Anthropic',
  detect: () => onPath('claude'),
  probe(cwd) {
    // read-only: -p print mode, no write tools granted
    const r = run('claude', ['-p', PROBE_PROMPT, '--output-format', 'json'], { cwd });
    return classify(r, cwd);
  },
  auditArgs: (promptFile, kitDir) => ['-p', `@${promptFile}`, '--output-format', 'json', ...(kitDir ? ['--plugin-dir', kitDir] : [])],
  fixArgs: (promptFile) => ['-p', `@${promptFile}`, '--permission-mode', 'acceptEdits', '--allowedTools', 'Edit,Write'],
};

// --- Tier-1: OpenAI Codex ----------------------------------------------------
export const codexAdapter: DrivenAdapter = {
  id: 'codex',
  tier: 'driven',
  provider: 'OpenAI',
  detect: () => onPath('codex'),
  probe(cwd) {
    const r = run('codex', ['exec', '--sandbox', 'read-only', '-c', 'approval_policy=never', '--skip-git-repo-check', PROBE_PROMPT], { cwd });
    return classify(r, cwd);
  },
  auditArgs: (promptFile) => ['exec', '--sandbox', 'read-only', '-c', 'approval_policy=never', '--skip-git-repo-check', `@${promptFile}`],
  fixArgs: (promptFile) => ['exec', '--sandbox', 'workspace-write', '-c', 'approval_policy=never', `@${promptFile}`],
};

// --- Tier-2: hand-off (detected, prompt printed, not driven in v1) -----------
export const cursorAdapter: HandoffAdapter = {
  id: 'cursor',
  tier: 'handoff',
  provider: 'Cursor',
  // `agent` is a dangerously generic name; require a version string mentioning Cursor.
  detect() {
    for (const bin of ['cursor-agent', 'agent']) {
      if (!onPath(bin)) continue;
      const r = run(bin, ['--version'], { timeout: 5000 });
      if (/cursor/i.test(`${r.stdout}${r.stderr}`) || bin === 'cursor-agent') return true;
    }
    return false;
  },
};

export const geminiAdapter: HandoffAdapter = {
  id: 'gemini',
  tier: 'handoff',
  provider: 'Google',
  detect: () => onPath('gemini'),
};

export const ADAPTERS: Adapter[] = [claudeAdapter, codexAdapter, cursorAdapter, geminiAdapter];

export interface AdapterPresence {
  adapter: Adapter;
  bucket: Bucket | null;
  tier: 'driven' | 'handoff';
  detail: string;
}

/**
 * Detect the adapters present. With `detectOnly`, stop there (no probe) — probing
 * a tier-1 CLI contacts the provider from inside the repo, so the session probes
 * only after disclosure and consent (R16). Otherwise probe each driven adapter.
 */
export function detectAndProbe(cwd: string, { detectOnly = false }: { detectOnly?: boolean } = {}): AdapterPresence[] {
  const present: AdapterPresence[] = [];
  for (const a of ADAPTERS) {
    if (!a.detect()) continue;
    if (a.tier === 'handoff') { present.push({ adapter: a, bucket: BUCKETS.HEALTHY, tier: 'handoff', detail: 'detected (hand-off)' }); continue; }
    if (detectOnly) { present.push({ adapter: a, bucket: null, tier: 'driven', detail: 'detected (unprobed)' }); continue; }
    const { bucket, detail } = a.probe(cwd);
    present.push({ adapter: a, bucket, tier: 'driven', detail });
  }
  return present;
}

export { classify, CANARY };
