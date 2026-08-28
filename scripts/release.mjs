#!/usr/bin/env node
/**
 * Build the release tarball and stamp its digest into install.sh (plan U8).
 *
 *   node scripts/release.mjs <version>   e.g. v0.1.0
 *
 * Produces dist/wont-scale-<version>.tar.gz containing the kit (the payload the
 * session runs), computes its SHA-256, and writes that digest into a copy of
 * install.sh at dist/install.sh — so the published installer carries the
 * integrity anchor for the exact tarball it points at (KTD6). The tarball URL in
 * install.sh already pins <version>; publishing both as release assets is the
 * final manual step.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// What ships in the payload: the runnable kit, not the tests or dev scaffolding.
const INCLUDE = [
  'scripts', 'skills', 'agents', 'audit', 'templates', 'docs/ci',
  'package.json', 'README.md', 'LICENSE', '.claude-plugin',
];

function main() {
  const version = process.argv[2];
  if (!version || !/^v\d+\.\d+\.\d+$/.test(version)) {
    console.error('usage: release.mjs vX.Y.Z');
    process.exit(2);
  }
  const dist = join(ROOT, 'dist');
  mkdirSync(dist, { recursive: true });
  const tarball = join(dist, `wont-scale-${version}.tar.gz`);

  // Stage the included paths under a prefixed dir, then tar that — portable
  // across BSD tar (macOS) and GNU tar (the Linux release workflow), neither of
  // which shares a prefix-transform flag. --strip-components=1 removes the prefix on unpack.
  const stageRoot = join(tmpdir(), `wont-scale-stage-${process.pid}`);
  const stage = join(stageRoot, `wont-scale-${version}`);
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const rel of INCLUDE) {
    const src = join(ROOT, rel);
    if (existsSync(src)) cpSync(src, join(stage, rel), { recursive: true });
  }
  execFileSync('tar', ['-czf', tarball, '-C', stageRoot, `wont-scale-${version}`]);
  rmSync(stageRoot, { recursive: true, force: true });

  const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');

  const installer = readFileSync(join(ROOT, 'install.sh'), 'utf8')
    .replace(/WONT_SCALE_VERSION="v[^"]*"/, `WONT_SCALE_VERSION="${version}"`)
    .replace(/WONT_SCALE_SHA256="[^"]*"/, `WONT_SCALE_SHA256="${sha}"`);
  writeFileSync(join(dist, 'install.sh'), installer);

  const installerSha = createHash('sha256').update(installer).digest('hex');
  console.error(`release ${version}:`);
  console.error(`  tarball:   ${tarball}`);
  console.error(`  tarball sha256:   ${sha}`);
  console.error(`  installer: dist/install.sh`);
  console.error(`  installer sha256: ${installerSha}  (publish this in the README/gate email)`);
  console.error('\nUpload both dist/ files as assets on the GitHub release for this tag.');
}

main();
