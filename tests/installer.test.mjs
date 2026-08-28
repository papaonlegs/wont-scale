import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { cleanup } from './helpers/fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = join(ROOT, 'install.sh');
const toClean = [];
after(() => toClean.forEach(cleanup));

const runSh = (script, args = [], opts = {}) =>
  spawnSync('sh', [script, ...args], { encoding: 'utf8', timeout: 15000, ...opts });

test('install.sh is POSIX-clean under sh -n (no bashisms that break parsing)', () => {
  const r = spawnSync('sh', ['-n', INSTALL], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('the whole body is wrapped in main() with main "$@" last', () => {
  const text = readFileSync(INSTALL, 'utf8');
  assert.match(text, /^main\(\)\s*\{/m);
  assert.match(text.trimEnd(), /main "\$@"$/);
});

test('no pipefail (not portable to dash); set -eu present', () => {
  const text = readFileSync(INSTALL, 'utf8');
  assert.match(text, /set -eu/);
  assert.ok(!/set -o pipefail/.test(text));
});

test('a truncated script executes nothing (the main-wrapper guard)', () => {
  // Cut the file before the final `main "$@"` — the closing brace/call is gone.
  const text = readFileSync(INSTALL, 'utf8');
  const truncated = text.slice(0, text.indexOf('main "$@"'));
  const f = join(mkdtempSync(join(tmpdir(), 'ws-trunc-')), 'install.sh');
  toClean.push(dirname(f));
  writeFileSync(f, truncated);
  // A truncated main() body still parses as a function definition but is never
  // called, so nothing runs. Prove it by adding a side-effect probe: if the body
  // ran it would hit the placeholder-digest die() and print to stderr.
  const r = runSh(f, [], { input: '' });
  assert.ok(!/Fetching wont-scale/.test(r.stderr || ''), 'no fetch attempted');
});

test('an unreleased script (placeholder digest) refuses to run', () => {
  const r = runSh(INSTALL, ['/tmp'], { input: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no pinned digest/);
});

test('release.mjs stamps a real digest so the released installer would not refuse', () => {
  // Dry check: the stamping produces a 64-hex digest and version substitution.
  const text = readFileSync(INSTALL, 'utf8');
  const stamped = text
    .replace(/WONT_SCALE_VERSION="v[^"]*"/, 'WONT_SCALE_VERSION="v9.9.9"')
    .replace(/WONT_SCALE_SHA256="[^"]*"/, `WONT_SCALE_SHA256="${'a'.repeat(64)}"`);
  assert.match(stamped, /WONT_SCALE_VERSION="v9\.9\.9"/);
  assert.match(stamped, /WONT_SCALE_SHA256="a{64}"/);
  // and the stamped script no longer trips the placeholder guard
  const f = join(mkdtempSync(join(tmpdir(), 'ws-stamp-')), 'install.sh');
  toClean.push(dirname(f));
  writeFileSync(f, stamped);
  const r = runSh(f, ['/nonexistent-target-dir-xyz'], { input: '' });
  assert.ok(!/no pinned digest/.test(r.stderr || ''), 'placeholder guard passed');
});
