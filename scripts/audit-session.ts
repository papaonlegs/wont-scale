#!/usr/bin/env node
/**
 * The interactive audit session (plan U4) — the hero path's Node entry point.
 * The bootstrap (install.sh) execs this after fetching the kit. It resolves the
 * target, discloses and asks consent BEFORE probing, drives the reader's AI CLI
 * through the ten modules (reading each module's findings JSON back), writes the
 * report, and offers the one consented fix with a shown diff and keep/revert.
 *
 * The testable core lives in scripts/lib/session.ts and the lib modules; this
 * wires the real adapters and I/O around them. Flags: --target <dir>, --yes,
 * --json, --no-fix, --no-drive.
 */

import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { resolveTarget, findSecretFiles, disclosure, runAuditLoop, readDriveFindings } from './lib/session.ts';
import { detectAndProbe, BUCKETS } from './lib/adapters/index.ts';
import type { AdapterPresence } from './lib/adapters/index.ts';
import { runMechanical } from './lib/mechanical.ts';
import { renderReport } from './lib/report.ts';
import { auditPromptFor, fixPrompt, taxonomyDigest } from './lib/assemble.ts';
import { Session } from './lib/state.ts';
import { selectTractable, applyFix } from './lib/fix.ts';
import type { Finding } from './lib/findings-schema.ts';

const KIT_VERSION = '0.1.0';

interface Flags {
  target: string | null;
  yes: boolean;
  json: boolean;
  noFix: boolean;
  noDrive: boolean;
}

/** The tier-1 (driven) member of adapters/index.ts's Adapter union — the only kind `chosen` ever holds. */
type DrivenAdapter = Extract<AdapterPresence['adapter'], { tier: 'driven' }>;

/** runAuditLoop's `session` option, recovered from the function's own signature (session.ts's SessionLike isn't exported). */
type SessionForLoop = Parameters<typeof runAuditLoop>[0]['session'];

/** The per-reason driver handed to runAuditLoop. */
type DriveModule = (reason: number, root: string, mechanical: Finding[]) => Promise<Finding>;

interface RevertInfo {
  sha: string;
  command: string;
}

/** The shape applyFix resolves with when a fix was applied and stayed contained. */
interface FixApplied {
  applied: true;
  contained: true;
  changed: string[];
  diff: string;
  revert: RevertInfo;
  isolatedWip?: unknown;
  kept?: boolean;
}

/** The shape applyFix resolves with when it refused, or applied but escaped containment. */
interface FixNotApplied {
  applied: false;
  contained?: false;
  reverted?: boolean;
  refusedReason?: string;
  state?: string;
  breach?: unknown;
  revert?: RevertInfo;
  isolatedWip?: unknown;
  kept?: boolean;
}

type FixResult = FixApplied | FixNotApplied;

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { target: null, yes: false, json: false, noFix: false, noDrive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') flags.yes = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--no-fix') flags.noFix = true;
    else if (a === '--no-drive') flags.noDrive = true;
    else if (a === '--target') flags.target = argv[++i];
    else if (!a.startsWith('--') && !flags.target) flags.target = a;
  }
  return flags;
}

/** Ask a yes/no; auto-yes when non-interactive (--yes / no TTY). */
async function confirm(rl: Interface | null, question: string, autoYes: boolean): Promise<boolean> {
  if (autoYes || !rl) return autoYes;
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

/**
 * Drive one module through a healthy tier-1 adapter and READ ITS FINDINGS BACK.
 * The prompt tells the agent to write findings JSON to WONT_SCALE_FINDINGS_OUT;
 * the session parses and validates it (KTD1). Falls back to the pre-computed
 * mechanical slice only when the drive produced nothing valid.
 */
function makeDriver(adapter: DrivenAdapter, tmpDir: string): DriveModule {
  return async (reason: number, root: string, mechanical: Finding[]): Promise<Finding> => {
    const promptFile = join(tmpDir, `audit-${reason}.txt`);
    const outFile = join(tmpDir, `findings-${reason}.json`);
    writeFileSync(promptFile, `${auditPromptFor(reason)}\n\nWrite the JSON object to: ${outFile}`);
    const fallback = mechanical.find((f) => f.reason === reason) as Finding;
    try {
      execFileSync(adapter.id, adapter.auditArgs(promptFile), {
        cwd: root, timeout: 120000, encoding: 'utf8',
        env: { ...process.env, WONT_SCALE_FINDINGS_OUT: outFile },
      });
    } catch { return fallback; }
    return readDriveFindings(outFile, reason, fallback);
  };
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const interactive = !flags.yes && !flags.json && process.stdin.isTTY;
  const rl: Interface | null = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const say = (m: string): void => { if (!flags.json) process.stderr.write(m + '\n'); };
  const finish = (code: number = 0): void => { if (rl) rl.close(); process.exit(code); };

  let target: string;
  try { target = resolveTarget(flags.target || process.cwd()); }
  catch (e: any) { say(String(e.message || e)); finish(1); return; }

  say(`\nwont-scale audit — target: ${target}`);
  say(`kit ${KIT_VERSION} · taxonomy ${taxonomyDigest()}\n`);

  const secretFiles: string[] = findSecretFiles(target);

  // Detect (cheap, local) up front; PROBE only after disclosure + consent, since
  // probing a tier-1 CLI contacts the provider from inside the repo (R16).
  const detected: AdapterPresence[] = flags.noDrive ? [] : detectAndProbe(target, { detectOnly: true });

  if (detected.length) {
    say(disclosure(detected.map((p) => p.adapter), secretFiles));
    say('');
    const ok = await confirm(rl, 'Probe these CLIs and run the audit? This sends your code to their provider.', flags.yes);
    if (!ok) { say('Stopped — nothing was sent. Re-run with --no-drive for the local mechanical report only.'); finish(0); return; }
  }

  const present: AdapterPresence[] = detected.length ? detectAndProbe(target) : [];
  const healthy: AdapterPresence[] = present.filter((p) => p.tier === 'driven' && p.bucket === BUCKETS.HEALTHY);
  const unauth: AdapterPresence[] = present.filter((p) => p.bucket === BUCKETS.UNAUTHENTICATED || p.bucket === BUCKETS.TRANSIENT);
  if (!healthy.length && unauth.length) {
    say(`Detected ${unauth.map((p) => p.adapter.id).join(', ')} but ${unauth[0].bucket} — log in and re-run, or continue with the mechanical report.`);
  }
  // Multiple healthy CLIs: let the reader choose (else the first).
  let chosen: AdapterPresence | undefined = healthy[0];
  if (healthy.length > 1 && rl) {
    say(`Multiple CLIs available: ${healthy.map((p, i) => `${i + 1}) ${p.adapter.id}`).join('  ')}`);
    const pick = parseInt((await rl.question('Which one? [1] ')).trim(), 10);
    if (pick >= 1 && pick <= healthy.length) chosen = healthy[pick - 1];
  }

  const session = new Session(target, KIT_VERSION);
  try { session.open(); }
  catch (e: any) { say(String(e.message || e)); finish(e.code === 'LIVE_OWNER' ? 3 : 1); return; }

  const tmpDir = mkdtempSync(join(tmpdir(), 'wont-scale-run-'));
  let findings: Finding[];
  if (chosen) {
    say(`Driving ${chosen.adapter.id} (${chosen.adapter.provider}) through the ten reasons…`);
    findings = await runAuditLoop({ root: target, session: session as unknown as SessionForLoop,
      driveModule: makeDriver(chosen.adapter as DrivenAdapter, tmpDir),
      onProgress: (n: number, s: string) => say(`  reason ${n}: ${s}`) });
  } else {
    say('No driveable AI CLI — running the mechanical checks (a report, not the full audit).');
    findings = runMechanical(target);
  }

  const reportPath = join(target, 'WONT-SCALE-REPORT.md');
  writeFileSync(reportPath, renderReport(findings, { project: target.split('/').pop(), date: new Date().toISOString().slice(0, 10) }));
  say(`\nReport written: ${reportPath}`);

  // The floor (R7/R10): offer one consented fix when a driveable agent is present.
  let fixResult: FixResult | null = null;
  if (chosen && !flags.noFix) {
    const activeAdapter = chosen.adapter as DrivenAdapter;
    const { finding, skipped }: { finding: Finding | null; skipped: { reason: number; title: string } | null } = selectTractable(findings);
    if (finding) {
      if (skipped) say(`(Skipping "${skipped.title}" — it's a structural change, not a one-step fix.)`);
      const go = await confirm(rl, `Apply the fix for "${finding.slug}" now?`, flags.yes);
      if (go) {
        fixResult = await applyFix({ root: target, finding,
          prompt: fixPrompt(finding),
          drive: async (prompt: string, root: string): Promise<void> => {
            const pf = join(tmpDir, 'fix-prompt.txt'); writeFileSync(pf, prompt);
            execFileSync(activeAdapter.id, activeAdapter.fixArgs(pf), { cwd: root, timeout: 180000, encoding: 'utf8' });
          } }) as FixResult;
        if (fixResult.applied) {
          say('\n--- proposed change ---\n' + fixResult.diff + '\n-----------------------');
          const keep = await confirm(rl, 'Keep this change?', flags.yes);
          if (!keep) {
            execFileSync('git', ['-C', target, 'reset', '--hard', fixResult.revert.sha]);
            execFileSync('git', ['-C', target, 'clean', '-fd']);
            say('Reverted.');
            fixResult.kept = false;
          } else { fixResult.kept = true; say(`Kept. To undo later: ${fixResult.revert.command}`); }
          // Re-render the report with the applied note + durable revert block (KTD9).
          writeFileSync(reportPath, renderReport(findings, { project: target.split('/').pop(),
            date: new Date().toISOString().slice(0, 10), revert: fixResult.kept ? fixResult.revert : null }));
        } else if (fixResult.contained === false) {
          say('The fix escaped its bounds and was reverted — nothing changed. See the report.');
        } else {
          say(`Fix not applied: ${fixResult.refusedReason || 'unknown'}`);
        }
      }
    } else {
      say('No one-step fix here — the top findings need considered work. Consider a professional if any are beyond your depth.');
    }
  }

  if (flags.json) process.stdout.write(JSON.stringify({ target, findings, report: reportPath,
    fix: fixResult ? { applied: fixResult.applied, kept: fixResult.kept ?? null } : null }, null, 2) + '\n');

  session.close();
  finish(0);
}

main().catch((e: any) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
