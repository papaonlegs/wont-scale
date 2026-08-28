/**
 * Build throwaway fixture repos in OS temp for tests (plan U1). Never committed
 * as nested git repos; git state is created at setup time. Each builder returns
 * an absolute path the caller cleans up.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

export function makeTempRepo(prefix = 'wont-scale-fixture-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function write(root: string, rel: string, content: string): string {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

export function initGit(root: string, { commit = true }: { commit?: boolean } = {}): void {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  if (commit) {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'initial');
  }
}

/** A repo with planted defects across several reasons. */
export function plantedDefectRepo(): string {
  const root = makeTempRepo();
  write(root, 'package.json', JSON.stringify({
    name: 'demo', dependencies: { next: '14.0.0', openai: '4.0.0', stripe: '12.0.0' },
  }, null, 2));
  write(root, 'src/auth.ts', 'const JWT_SECRET = "supersecrethardcodedvalue123";\nexport function sign(u) { return jwt.sign({ u }); }\n');
  write(root, 'src/client.ts', 'const key = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_KEY;\n');
  write(root, 'src/webhook.ts', 'export function handler(req) { stripe.webhooks.constructEvent(req.body); charge(); }\n');
  write(root, 'src/ai.ts', 'import OpenAI from "openai";\nexport const gen = (p) => new OpenAI().chat(p);\n');
  // no README, no tests -> bus factor
  initGit(root);
  return root;
}

/** A clean-ish repo: tracker present, rate limiting present, README + tests. */
export function cleanRepo(): string {
  const root = makeTempRepo();
  write(root, 'package.json', JSON.stringify({
    name: 'clean', dependencies: { '@sentry/node': '7.0.0', '@upstash/ratelimit': '1.0.0' },
  }, null, 2));
  write(root, 'README.md', '# Clean\n\n## Setup\nnpm install\n');
  write(root, 'src/index.test.js', 'test("ok", () => {});\n');
  write(root, 'src/index.js', 'export const ok = true;\n');
  initGit(root);
  return root;
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
