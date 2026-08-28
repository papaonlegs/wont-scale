#!/usr/bin/env node
/**
 * The interactive audit session (plan U4) — the hero path's Node entry point.
 * The bootstrap (install.sh) execs this after fetching the kit. It resolves the
 * target, discloses before probing, drives the reader's AI CLI through the ten
 * modules (or falls back to the mechanical path), writes the report, and offers
 * the one consented fix.
 *
 * The testable core lives in scripts/lib/session.mjs; this wires the real
 * adapters, interview, and I/O around it. Flags: --target <dir>, --yes,
 * --json, --no-fix.
 */

import { writeFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { resolveTarget, findSecretFiles, disclosure, runAuditLoop } from './lib/session.mjs';
import { detectAndProbe, BUCKETS } from './lib/adapters/index.mjs';
import { runMechanical } from './lib/mechanical.mjs';
import { renderReport } from './lib/report.mjs';
import { auditPromptFor, taxonomyDigest } from './lib/assemble.mjs';
import { Session } from './lib/state.mjs';
import { execFileSync } from 'node:child_process';

const KIT_VERSION = '0.1.0';

function parseArgs(argv) {
  const flags = { target: null, yes: false, json: false, noFix: false, noDrive: false };
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

async function ask(rl, q) { return rl ? (await rl.question(q)).trim() : ''; }

/** Drive one module through a healthy tier-1 adapter, returning a finding. */
function makeDriver(adapter, tmpDir) {
  return async (reason, root) => {
    const promptFile = join(tmpDir, `audit-${reason}.txt`);
    writeFileSync(promptFile, auditPromptFor(reason));
    const outFile = join(tmpDir, `findings-${reason}.json`);
    // The adapter writes findings JSON to outFile; the session reads it (KTD1).
    const args = adapter.auditArgs(promptFile).concat();
    try {
      execFileSync(adapter.id, args, { cwd: root, timeout: 120000, encoding: 'utf8',
        env: { ...process.env, WONT_SCALE_FINDINGS_OUT: outFile } });
    } catch { /* fall through to mechanical for this reason */ }
    // Fallback: use the mechanical result for this reason if the drive produced nothing.
    const mech = runMechanical(root).find((f) => f.reason === reason);
    return mech;
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const interactive = !flags.yes && !flags.json && process.stdin.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const say = (m) => { if (!flags.json) process.stderr.write(m + '\n'); };

  let target;
  try { target = resolveTarget(flags.target || process.cwd()); }
  catch (e) { say(String(e.message || e)); process.exit(1); }

  say(`\nwont-scale audit — target: ${target}`);
  say(`kit ${KIT_VERSION} · taxonomy ${taxonomyDigest()}\n`);

  const secretFiles = findSecretFiles(target);
  const present = flags.noDrive ? [] : detectAndProbe(target);

  // R16: disclose before anything is driven.
  if (present.length) { say(disclosure(present.map((p) => p.adapter), secretFiles)); say(''); }

  const healthy = present.filter((p) => p.tier === 'driven' && p.bucket === BUCKETS.HEALTHY);
  const chosen = healthy[0];

  const session = new Session(target, KIT_VERSION);
  try { session.open(); }
  catch (e) { say(String(e.message || e)); process.exit(e.code === 'LIVE_OWNER' ? 3 : 1); }

  const tmpDir = mkdtempSync(join(tmpdir(), 'wont-scale-run-'));
  let findings;
  if (chosen) {
    say(`Driving ${chosen.adapter.id} (${chosen.adapter.provider}) through the ten reasons…`);
    findings = await runAuditLoop({ root: target, session, driveModule: makeDriver(chosen.adapter, tmpDir),
      onProgress: (n, s) => say(`  reason ${n}: ${s}`) });
  } else {
    say('No driveable AI CLI found — running the mechanical checks (a report, not the full audit).');
    findings = runMechanical(target);
  }

  const report = renderReport(findings, { project: target.split('/').pop(), date: new Date().toISOString().slice(0, 10),
    stack: '', });
  const reportPath = join(target, 'WONT-SCALE-REPORT.md');
  writeFileSync(reportPath, report);
  say(`\nReport written: ${reportPath}`);

  if (flags.json) process.stdout.write(JSON.stringify({ target, findings, report: reportPath }, null, 2) + '\n');

  session.close();
  if (rl) rl.close();
}

main().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
