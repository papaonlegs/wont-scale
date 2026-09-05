#!/usr/bin/env node
/**
 * The interactive audit session (plan U4) — the hero path's Node entry point.
 * The bootstrap (install.sh) execs this after fetching the kit. It resolves the
 * target, discloses and asks consent BEFORE probing, drives the reader's AI CLI
 * through the ten modules (reading each module's findings JSON back from the
 * agent's final message), writes the
 * report, and offers the one consented fix with a shown diff and keep/revert.
 *
 * The testable core lives in scripts/lib/session.ts and the lib modules; this
 * wires the real adapters and I/O around them. Flags: --target <dir>, --yes,
 * --json, --no-fix, --no-drive, --cli <claude|codex> (pin the driven CLI; the
 * only way to choose one non-interactively).
 */

import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { resolveTarget, findSecretFiles, disclosure, runAuditLoop, extractFindingJson, degradeToMechanical } from './lib/session.ts';
import { detectAndProbe, BUCKETS } from './lib/adapters/index.ts';
import type { AdapterPresence, DrivenAdapter } from './lib/adapters/index.ts';
import { runMechanical } from './lib/mechanical.ts';
import { renderReport } from './lib/report.ts';
import { auditPromptFor, fixPrompt, taxonomyDigest } from './lib/assemble.ts';
import { Session } from './lib/state.ts';
import type { SessionErrorCode } from './lib/state.ts';
import { selectTractable, applyFix } from './lib/fix.ts';
import type { FixResult as LibFixResult } from './lib/fix.ts';
import { FINDING_JSON_SCHEMA } from './lib/findings-schema.ts';
import type { Finding } from './lib/findings-schema.ts';

const KIT_VERSION = '0.1.0';

interface Flags {
  target: string | null;
  yes: boolean;
  json: boolean;
  noFix: boolean;
  noDrive: boolean;
  /** A driven CLI id to pin (claude, codex). Null = ask when several are healthy, else the first. */
  cli: string | null;
}

/** The per-reason driver handed to runAuditLoop. */
type DriveModule = (reason: number, root: string, mechanical: Finding[]) => Promise<Finding>;

/** applyFix's own result plus the `kept` flag this CLI stamps once the reader keeps or reverts. */
type FixResult = LibFixResult & { kept?: boolean };

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { target: null, yes: false, json: false, noFix: false, noDrive: false, cli: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') flags.yes = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--no-fix') flags.noFix = true;
    else if (a === '--no-drive') flags.noDrive = true;
    else if (a === '--target') flags.target = argv[++i];
    else if (a === '--cli') flags.cli = (argv[++i] || '').trim().toLowerCase() || null;
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

/** Appended to every module prompt: how the answer comes back, and what sandbox noise to ignore. */
const DRIVE_OUTPUT_CONTRACT = `Output contract: your final message must be the findings JSON object and nothing
else — no prose before or after it, no code fence. Do not write any files; the
session captures your final message itself. If a shell command prints warnings
about xcrun, DARWIN_USER_TEMP_DIR or a /tmp cache file on macOS, they come from
the sandbox and are harmless — ignore them and read the command's real output.`;

const DRIVE_TIMEOUT_MS = 300000;

/** Today's date as YYYY-MM-DD in local time — a late-evening run is not filed under yesterday's UTC day. */
function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** One line, bounded, about why a drive process failed — for the not-verified reason. */
function describeDriveFailure(e: unknown, adapterId: string): string {
  const err = e as NodeJS.ErrnoException & { status?: number | null; stderr?: string };
  if (err && err.code === 'ETIMEDOUT') return `${adapterId} timed out after ${DRIVE_TIMEOUT_MS / 1000}s`;
  const stderr = String(err?.stderr || '').split('\n').map((l) => l.trim()).filter((l) => l && !/xcrun|DARWIN_USER_TEMP_DIR/.test(l)).pop() || '';
  const where = typeof err?.status === 'number' ? `exited ${err.status}` : (err?.message || 'failed').split('\n')[0];
  return `${adapterId} ${where}${stderr ? `: ${stderr.slice(0, 140)}` : ''}`;
}

/**
 * Drive one module through a healthy tier-1 adapter and READ ITS FINDINGS BACK.
 * The drive is read-only, so the agent is never asked to write a file (a
 * read-only sandbox rejects exactly that). The prompt tells it to answer with
 * the findings JSON as its final message; the adapter recovers that message
 * through the CLI's own channel (codex `-o`, claude's JSON envelope) and the
 * session parses and validates it (KTD1). A drive that fails or returns nothing
 * valid degrades to the mechanical slice — and a mechanical clean is reported
 * not-verified, never as a pass.
 */
function makeDriver(adapter: DrivenAdapter, tmpDir: string): DriveModule {
  const schemaFile = join(tmpDir, 'finding.schema.json');
  writeFileSync(schemaFile, JSON.stringify(FINDING_JSON_SCHEMA, null, 2));
  return async (reason: number, root: string, mechanical: Finding[]): Promise<Finding> => {
    const promptFile = join(tmpDir, `audit-${reason}.txt`);
    const outFile = join(tmpDir, `findings-${reason}.json`);
    const prompt = `${auditPromptFor(reason)}\n\n${DRIVE_OUTPUT_CONTRACT}`;
    writeFileSync(promptFile, prompt);
    const fallback = mechanical.find((f) => f.reason === reason) as Finding;
    let stdout = '';
    try {
      stdout = execFileSync(adapter.id, adapter.auditArgs({ prompt, promptFile, outFile, schemaFile }), {
        cwd: root, timeout: DRIVE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return degradeToMechanical(fallback, `the AI drive failed (${describeDriveFailure(e, adapter.id)})`);
    }
    const parsed = extractFindingJson(adapter.auditResult({ stdout, outFile }), reason);
    return parsed ?? degradeToMechanical(fallback, `${adapter.id} returned no valid findings JSON for this reason`);
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
  catch (e: unknown) { const err = e as { message?: string }; say(String(err.message || err)); finish(1); return; }

  say(`\nwont-scale audit — target: ${target}`);
  say(`kit ${KIT_VERSION} · taxonomy ${taxonomyDigest()}\n`);

  const secretFiles: string[] = findSecretFiles(target);

  // Detect (cheap, local) up front; PROBE only after disclosure + consent, since
  // probing a tier-1 CLI contacts the provider from inside the repo (R16).
  const allDetected: AdapterPresence[] = flags.noDrive ? [] : detectAndProbe(target, { detectOnly: true });
  // --cli pins one driven CLI: only it is disclosed, probed, and driven.
  const detected: AdapterPresence[] = flags.cli ? allDetected.filter((p) => p.tier === 'driven' && p.adapter.id === flags.cli) : allDetected;
  if (flags.cli && !detected.length && !flags.noDrive) {
    say(`--cli ${flags.cli}: not found on PATH${allDetected.length ? ` (detected: ${allDetected.map((p) => p.adapter.id).join(', ')})` : ''}. Driven CLIs: claude, codex.`);
    finish(1); return;
  }

  if (detected.length) {
    say(disclosure(detected.map((p) => p.adapter), secretFiles));
    say('');
    const ok = await confirm(rl, 'Probe these CLIs and run the audit? This sends your code to their provider.', flags.yes);
    if (!ok) { say('Stopped — nothing was sent. Re-run with --no-drive for the local mechanical report only.'); finish(0); return; }
  }

  const present: AdapterPresence[] = detected.length
    ? detectAndProbe(target).filter((p) => detected.some((d) => d.adapter.id === p.adapter.id))
    : [];
  const healthy: AdapterPresence[] = present.filter((p) => p.tier === 'driven' && p.bucket === BUCKETS.HEALTHY);
  const unauth: AdapterPresence[] = present.filter((p) => p.bucket === BUCKETS.UNAUTHENTICATED || p.bucket === BUCKETS.TRANSIENT);
  if (!healthy.length && unauth.length) {
    say(`Detected ${unauth.map((p) => p.adapter.id).join(', ')} but ${unauth[0].bucket} — log in and re-run, or continue with the mechanical report.`);
  }
  // A pinned CLI that did not probe healthy is a stop, not a silent swap to another provider.
  if (flags.cli && !healthy.length && present.length) {
    say(`--cli ${flags.cli} is ${present[0].bucket} (${present[0].detail}) — fix that and re-run, or run without --cli.`);
    finish(1); return;
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
  catch (e: unknown) {
    const err = e as NodeJS.ErrnoException & { code?: SessionErrorCode };
    say(String(err.message || err));
    finish(err.code === 'LIVE_OWNER' ? 3 : 1);
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'wont-scale-run-'));
  let findings: Finding[];
  if (chosen) {
    say(`Driving ${chosen.adapter.id} (${chosen.adapter.provider}) through the ten reasons…`);
    findings = await runAuditLoop({ root: target, session,
      driveModule: makeDriver(chosen.adapter as DrivenAdapter, tmpDir),
      onProgress: (n: number, s: string) => say(`  reason ${n}: ${s}`) });
  } else {
    say('No driveable AI CLI — running the mechanical checks (a report, not the full audit).');
    findings = runMechanical(target);
  }

  const reportPath = join(target, 'WONT-SCALE-REPORT.md');
  writeFileSync(reportPath, renderReport(findings, { project: target.split('/').pop(), date: localDate() }));
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
            const promptFile = join(tmpDir, 'fix-prompt.txt'); writeFileSync(promptFile, prompt);
            execFileSync(activeAdapter.id, activeAdapter.fixArgs({ prompt, promptFile }), { cwd: root, timeout: 300000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
          } });
        if (fixResult.applied) {
          say('\n--- proposed change ---\n' + fixResult.diff! + '\n-----------------------');
          const keep = await confirm(rl, 'Keep this change?', flags.yes);
          if (!keep) {
            execFileSync('git', ['-C', target, 'reset', '--hard', fixResult.revert!.sha]);
            execFileSync('git', ['-C', target, 'clean', '-fd']);
            say('Reverted.');
            fixResult.kept = false;
          } else { fixResult.kept = true; say(`Kept. To undo later: ${fixResult.revert!.command}`); }
          // Re-render the report with the applied note + durable revert block (KTD9).
          writeFileSync(reportPath, renderReport(findings, { project: target.split('/').pop(),
            date: localDate(), revert: fixResult.kept ? fixResult.revert! : null }));
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
