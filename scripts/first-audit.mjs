#!/usr/bin/env node
/**
 * wont-scale first-audit wizard
 *
 * Interactive setup for a first production-readiness audit against the ten
 * reasons vibe-coded apps fail at scale:
 *   https://papa.onle.gs/writing/index.html
 *
 * Zero dependencies. Node >= 18.
 *
 * Usage:
 *   node scripts/first-audit.mjs [target-dir] [flags]
 *
 * Every question has a flag, so the wizard is scriptable:
 *   --users=none|beta|real     --money=yes|no        --pii=yes|no|unsure
 *   --bus=yes|no               --datapath=direct|api|mixed|unsure
 *   --authz=policy|api|components|nowhere|unsure
 *   --retries=dedup|none|na|unsure                   --topology=single|serverless|multi|unsure
 *   --cost=capped|uncapped|none                      --visibility=pager|logs|users
 *   --yes         accept detected/default answers, no prompts
 *   --json        print the config to stdout instead of a summary (implies --yes)
 *   --no-write    dry run: compute everything, write nothing
 *   --install-claude  copy the kit's skills/ and agents/ into <target>/.claude/
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERIES = 'https://papa.onle.gs/writing';

// ---------------------------------------------------------------- reasons ---

const REASONS = {
  1:  { slug: 'data-models',       title: 'You have six data models and you think you have one',
        article: `${SERIES}/you-have-six-data-models.html`,
        fix: 'Write down the one canonical model for your core entity; add real foreign keys', time: 'an afternoon' },
  2:  { slug: 'query-performance', title: '40ms locally, 40 seconds in production',
        article: `${SERIES}/40ms-locally-40-seconds-in-production.html`,
        fix: 'Turn on query logging and count the queries your busiest endpoint makes', time: '~30 min' },
  3:  { slug: 'authentication',    title: 'The login page is a prop',
        article: `${SERIES}/the-login-page-is-a-prop.html`,
        fix: 'Put sessions on a managed auth provider; make tokens expire and revocable', time: 'a day' },
  4:  { slug: 'authorisation',     title: 'Authorisation is a vibe',
        article: `${SERIES}/authorisation-is-a-vibe.html`,
        fix: 'Enable RLS with a real policy on every table, or centralise checks in one policy layer', time: 'half a day' },
  5:  { slug: 'trust-boundary',    title: 'Your frontend talks straight to the database',
        article: `${SERIES}/your-frontend-talks-to-the-database.html`,
        fix: 'Rotate any key that ever shipped in a bundle; move privileged calls server-side', time: 'half a day' },
  6:  { slug: 'idempotency',       title: 'Nothing is idempotent and everything runs twice',
        article: `${SERIES}/nothing-is-idempotent.html`,
        fix: 'Add a unique constraint on webhook event id; return 2xx fast, do slow work async', time: '~1 hour' },
  7:  { slug: 'statelessness',     title: "It works on one box, and that's the whole problem",
        article: `${SERIES}/it-works-on-one-box.html`,
        fix: 'Move sessions, cache, and cron out of the web process (DB, Redis, a scheduler)', time: 'a day' },
  8:  { slug: 'observability',     title: "You didn't write it and you can't see it either",
        article: `${SERIES}/you-cant-see-it-either.html`,
        fix: 'Add error tracking and a request ID threaded through every hop', time: 'an afternoon' },
  9:  { slug: 'unit-economics',    title: 'Profitable at 100 users, bankrupt at 10,000',
        article: `${SERIES}/profitable-at-100-bankrupt-at-10000.html`,
        fix: 'Rate-limit the expensive endpoint; set a billing alarm that pages you', time: '~1 hour' },
  10: { slug: 'bus-factor',        title: "The bus factor isn't one, it's zero",
        article: `${SERIES}/the-bus-factor-is-zero.html`,
        fix: 'Write the system narrative: what talks to what, and why', time: 'an afternoon' },
};

// When two findings tie on severity, this is the order that kills you first.
const KILL_ORDER = [4, 5, 3, 6, 9, 8, 2, 7, 1, 10];

// ------------------------------------------------------------------- args ---

const argv = process.argv.slice(2);
const flags = {};
let targetArg = null;
for (const a of argv) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  } else if (!targetArg) {
    targetArg = a;
  }
}
const TARGET = resolve(flags.target || targetArg || process.cwd());
const NON_INTERACTIVE = Boolean(flags.yes || flags.json);
const WRITE = !flags['no-write'];

if (!existsSync(TARGET) || !statSync(TARGET).isDirectory()) {
  console.error(`Target is not a directory: ${TARGET}`);
  process.exit(1);
}

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
const bold = (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const cyan = (s) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s);

// -------------------------------------------------------------- detection ---

function readJSON(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function walk(dir, matcher, { maxDepth = 4, maxHits = 5 } = {}, depth = 0, hits = []) {
  if (depth > maxDepth || hits.length >= maxHits) return hits;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return hits; }
  for (const e of entries) {
    if (hits.length >= maxHits) break;
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.next')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, matcher, { maxDepth, maxHits }, depth + 1, hits);
    else if (matcher(e.name, p)) hits.push(p);
  }
  return hits;
}

function detect(target) {
  const pkg = readJSON(join(target, 'package.json'));
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const has = (...names) => names.find((n) => Object.keys(deps).some((d) => d === n || d.startsWith(n)));

  const d = {
    node: Boolean(pkg),
    framework: has('next') ? 'next' : has('react') ? 'react' : has('express') ? 'express' :
               has('fastify') ? 'fastify' : has('hono') ? 'hono' : null,
    orm: has('prisma', '@prisma/client') ? 'prisma' : has('drizzle-orm') ? 'drizzle' :
         has('typeorm') ? 'typeorm' : has('sequelize') ? 'sequelize' : has('mongoose') ? 'mongoose' : null,
    supabaseClient: Boolean(has('@supabase/supabase-js')),
    firebase: Boolean(has('firebase', 'firebase-admin')),
    authDep: has('next-auth', '@auth/core', '@clerk/nextjs', '@clerk/clerk-sdk-node', 'lucia', 'passport', 'better-auth') || null,
    payments: has('stripe', '@paddle/paddle-node-sdk', '@lemonsqueezy/lemonsqueezy.js') || null,
    metered: has('openai', '@anthropic-ai/sdk', 'groq-sdk', 'replicate', 'resend', 'twilio', '@sendgrid/mail') || null,
    telemetry: has('@sentry/nextjs', '@sentry/node', '@sentry/react', 'posthog-js', 'posthog-node',
                   'dd-trace', '@opentelemetry/api', 'newrelic', '@highlight-run/node') || null,
    queue: has('bullmq', 'bee-queue', 'inngest', '@trigger.dev/sdk', '@upstash/qstash', 'graphile-worker') || null,
    prismaSchema: existsSync(join(target, 'prisma', 'schema.prisma')),
    supabaseDir: existsSync(join(target, 'supabase')),
    migrationsDir: ['migrations', 'prisma/migrations', 'supabase/migrations', 'drizzle']
      .some((m) => existsSync(join(target, m))),
    docker: existsSync(join(target, 'Dockerfile')),
    deploy: ['vercel.json', 'fly.toml', 'render.yaml', 'netlify.toml']
      .filter((f) => existsSync(join(target, f))),
    ci: existsSync(join(target, '.github', 'workflows')),
    tests: walk(target, (n) => /\.(test|spec)\.[jt]sx?$/.test(n) || n === '__tests__', { maxHits: 1 }).length > 0,
    readme: existsSync(join(target, 'README.md')),
    webhookFiles: walk(target, (n, p) => /webhook/i.test(n) && /\.(ts|js|tsx|jsx|py|rb|go)$/.test(n), { maxHits: 3 }),
    envFile: existsSync(join(target, '.env')),
    envIgnored: (() => {
      try { return readFileSync(join(target, '.gitignore'), 'utf8').split('\n').some((l) => l.trim().match(/^\.env(\..*)?$/) || l.trim() === '.env*'); }
      catch { return false; }
    })(),
  };

  d.readmeHasSetup = d.readme && /(^|\n)#+.*\b(setup|install|getting started|running|develop)/i
    .test((() => { try { return readFileSync(join(target, 'README.md'), 'utf8'); } catch { return ''; } })());

  d.summary = [
    d.framework ? d.framework : d.node ? 'node' : 'not a Node project (detection limited)',
    d.orm, d.supabaseClient ? 'supabase-js' : null, d.firebase ? 'firebase' : null,
    d.authDep ? `auth:${d.authDep}` : 'no auth dep found',
    d.payments ? `payments:${d.payments}` : null,
    d.metered ? `metered:${d.metered}` : null,
    d.telemetry ? `telemetry:${d.telemetry}` : 'no telemetry dep found',
    d.queue ? `queue:${d.queue}` : null,
    d.deploy.length ? `deploy:${d.deploy.join(',')}` : d.docker ? 'deploy:docker' : null,
    d.tests ? 'tests:present' : 'tests:none found',
  ].filter(Boolean).join(' · ');

  return d;
}

// -------------------------------------------------------------- questions ---

function defaultsFrom(d) {
  return {
    users: 'beta',
    money: d.payments ? 'yes' : 'no',
    pii: d.authDep || d.payments ? 'yes' : 'unsure',
    bus: d.readmeHasSetup && d.tests ? 'yes' : 'no',
    datapath: d.supabaseClient || d.firebase ? 'direct' : d.framework === 'next' ? 'api' : 'unsure',
    authz: d.supabaseClient ? 'unsure' : d.authDep ? 'api' : 'unsure',
    retries: d.webhookFiles.length || d.queue ? 'unsure' : 'na',
    topology: d.deploy.some((f) => f === 'vercel.json' || f === 'netlify.toml') ? 'serverless'
            : d.docker ? 'single' : 'unsure',
    cost: d.metered ? 'uncapped' : 'none',
    visibility: d.telemetry ? 'pager' : 'users',
  };
}

const QUESTIONS = [
  { key: 'users', text: 'Who uses this today?',
    options: { none: 'just me', beta: 'invited beta users', real: 'real users in production' } },
  { key: 'money', text: 'Does real money move through it (payments, credits, billing)?',
    options: { yes: 'yes', no: 'no' } },
  { key: 'pii', text: 'Does it store personal data beyond an email address?',
    options: { yes: 'yes', no: 'no', unsure: 'not sure' } },
  { key: 'bus', text: 'If you disappeared for a month, could someone else run and change it from the README alone?',
    options: { yes: 'yes', no: 'no' } },
  { key: 'datapath', text: 'Does browser code talk to the database directly (Supabase/Firebase SDK), or through your own API?',
    options: { direct: 'directly from the browser', api: 'everything goes through my API', mixed: 'a bit of both', unsure: 'not sure' } },
  { key: 'authz', text: 'Where is "can this user see this row" actually decided?',
    options: { policy: 'database policy / RLS', api: 'API middleware', components: 'React components', nowhere: 'nowhere, honestly', unsure: 'not sure' } },
  { key: 'retries', text: 'Webhooks, background jobs, queues — what happens if the same event arrives twice?',
    options: { dedup: 'deduplication exists', none: 'it runs twice', na: 'no webhooks or jobs', unsure: 'not sure' } },
  { key: 'topology', text: 'What runs the app in production?',
    options: { single: 'one server / container', serverless: 'serverless (Vercel, Lambda...)', multi: 'several instances', unsure: 'not sure' } },
  { key: 'cost', text: 'Endpoints that call LLMs or other metered APIs — rate-limited with per-user caps?',
    options: { capped: 'yes, capped', uncapped: 'no caps', none: 'no metered APIs' } },
  { key: 'visibility', text: 'If production broke at 3am, how would you find out?',
    options: { pager: 'error tracker alerts me', logs: "I'd see it in logs eventually", users: 'a user would email me' } },
];

async function interview(defaults) {
  const answers = {};
  // flag overrides first
  for (const q of QUESTIONS) {
    if (flags[q.key] !== undefined) {
      if (!q.options[flags[q.key]]) {
        console.error(`Invalid --${q.key}=${flags[q.key]} (expected: ${Object.keys(q.options).join('|')})`);
        process.exit(1);
      }
      answers[q.key] = flags[q.key];
    }
  }
  if (NON_INTERACTIVE) {
    for (const q of QUESTIONS) answers[q.key] ??= defaults[q.key];
    return answers;
  }

  // Piped stdin: readline drops lines emitted between question() calls, so
  // pre-read every answer up front and consume from the queue.
  if (!process.stdin.isTTY) {
    const queue = readFileSync(0, 'utf8').split('\n').map((l) => l.trim());
    let qi = 0;
    for (const q of QUESTIONS) {
      if (answers[q.key] !== undefined) continue;
      const raw = queue[qi++] ?? '';
      const keys = Object.keys(q.options);
      answers[q.key] = raw === '' ? defaults[q.key]
        : /^\d+$/.test(raw) && keys[Number(raw) - 1] ? keys[Number(raw) - 1]
        : q.options[raw] ? raw
        : defaults[q.key];
    }
    return answers;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('');
  console.log(bold('First audit — ten questions, sized to your stakes.'));
  console.log(dim('Enter a number, or press Enter to accept the detected default.\n'));
  let n = 0;
  for (const q of QUESTIONS) {
    n += 1;
    if (answers[q.key] !== undefined) continue; // set by flag
    const keys = Object.keys(q.options);
    const def = defaults[q.key];
    console.log(`${bold(`${n}.`)} ${q.text}`);
    keys.forEach((k, i) => {
      const marker = k === def ? cyan(' (default)') : '';
      console.log(`   ${i + 1}) ${q.options[k]}${marker}`);
    });
    let ans = null;
    while (ans === null) {
      const raw = (await rl.question('   > ')).trim();
      if (raw === '') ans = def;
      else if (/^\d+$/.test(raw) && keys[Number(raw) - 1]) ans = keys[Number(raw) - 1];
      else if (q.options[raw]) ans = raw;
      else console.log(dim(`   1-${keys.length}, or Enter for default.`));
    }
    answers[q.key] = ans;
    console.log('');
  }
  rl.close();
  return answers;
}

// ---------------------------------------------------------------- scoring ---

function score(a, d) {
  const tier = a.users === 'real' && (a.money === 'yes' || a.pii === 'yes') ? 'tier2' : 'tier1';
  const real = a.users === 'real';
  const stakes = a.money === 'yes' || a.pii === 'yes';

  const P = {}; // reason -> {priority, because}
  const set = (r, priority, because) => { P[r] = { priority, because }; };

  set(1, tier === 'tier2' ? 'high' : 'advisory', 'every audit starts by asking the schema what a user is');
  if (d.prismaSchema && d.supabaseDir) set(1, 'high', 'two schema sources detected (prisma/ and supabase/) — the model has already forked');

  set(2, real ? 'high' : 'advisory', real ? 'real users mean real row counts' : 'cheap to check now, expensive to discover later');

  if (a.users === 'none') set(3, 'advisory', 'no external users yet — fix before invites go out');
  else if (stakes && !d.authDep) set(3, 'critical', 'stakes are live and no managed auth dependency was detected');
  else set(3, 'high', 'sessions and token lifecycle need a second look before scale');

  if ((a.authz === 'nowhere' || a.authz === 'unsure' || a.authz === 'components') && a.users !== 'none')
    set(4, 'critical', `authorisation is decided ${a.authz === 'components' ? 'in the client' : 'nowhere you can point at'} — this is the finding that becomes a breach`);
  else if (a.datapath === 'direct' && a.authz !== 'policy')
    set(4, 'critical', 'the browser reaches the database but row policies are not the wall');
  else set(4, 'high', 'one policy layer, deny by default, tested independently — verify it holds');

  if ((a.datapath === 'direct' || a.datapath === 'mixed') && (d.supabaseClient || d.firebase) && stakes)
    set(5, 'critical', 'browser-to-database with real stakes: the bundle is attacker-controlled');
  else if (a.datapath === 'direct' || a.datapath === 'mixed')
    set(5, 'high', 'direct client data access — the policy layer is the only wall');
  else set(5, 'advisory', 'API-mediated access — verify no privileged keys ever reach the client');

  if (a.retries === 'na' && !d.webhookFiles.length && !d.queue)
    set(6, 'not_applicable', 'no webhooks or background jobs today');
  else if (a.retries === 'none' && a.money === 'yes')
    set(6, 'critical', 'payments plus at-least-once delivery and no dedup: double charges are a when, not an if');
  else if (a.retries === 'none' || a.retries === 'unsure')
    set(6, 'high', 'every webhook provider retries; the handler must assume duplicates');
  else set(6, 'advisory', 'dedup exists — verify the constraint is at the database, not in memory');

  if (a.topology === 'multi') set(7, 'high', 'several instances already — any in-process state is a live bug');
  else if (a.topology === 'serverless') set(7, 'advisory', 'serverless forces statelessness; watch connection pooling under reason 2');
  else set(7, tier === 'tier2' ? 'high' : 'advisory', 'one box today — the second instance is where topology bugs surface');

  if (a.visibility === 'users' && real) set(8, 'critical', 'real users are currently your monitoring');
  else if (a.visibility !== 'pager' || !d.telemetry) set(8, 'high', 'no error tracking dependency detected — generated code with no telemetry is a locked room');
  else set(8, 'advisory', 'telemetry exists — verify a request ID threads through every hop');

  if (a.cost === 'none') set(9, a.money === 'yes' ? 'high' : 'advisory', 'no metered APIs, but rate limits still gate abuse of whatever is expensive');
  else if (a.cost === 'uncapped' && real) set(9, 'critical', 'uncapped metered endpoints with real traffic: the invoice arrives before the incident report');
  else if (a.cost === 'uncapped') set(9, 'high', 'uncapped metered endpoints — one loop away from a very bad bill');
  else set(9, 'advisory', 'caps exist — verify billing alarms page a human');

  if (a.bus === 'no' && tier === 'tier2') set(10, 'critical', 'real stakes and nobody else can run it: this removes your ability to fix everything above');
  else if (a.bus === 'no') set(10, 'high', 'if you cannot hand it over, you cannot debug it under pressure either');
  else set(10, 'advisory', 'keep ADRs for anything structural; the rule stands — no merge you cannot explain');

  const rank = { critical: 0, high: 1, advisory: 2 };
  const priorities = Object.entries(P)
    .filter(([, v]) => v.priority !== 'not_applicable')
    .map(([r, v]) => ({ reason: Number(r), slug: REASONS[r].slug, ...v }))
    .sort((x, y) => rank[x.priority] - rank[y.priority] || KILL_ORDER.indexOf(x.reason) - KILL_ORDER.indexOf(y.reason));
  const notApplicable = Object.entries(P)
    .filter(([, v]) => v.priority === 'not_applicable')
    .map(([r, v]) => ({ reason: Number(r), because: v.because }));

  return { tier, priorities, notApplicable };
}

// ---------------------------------------------------------------- outputs ---

function renderPlan(project, det, answers, { tier, priorities, notApplicable }) {
  const top = priorities.slice(0, 3);
  const rest = priorities.slice(3);
  const L = [];
  L.push(`# First audit — ${project}`);
  L.push('');
  L.push(`_Generated ${new Date().toISOString().slice(0, 10)} by the [wont-scale](https://github.com/papaonlegs/wont-scale) first-audit wizard._`);
  L.push('');
  L.push(`**Tier:** ${tier === 'tier2' ? 'Tier 2 — real users and real stakes; full depth.' : 'Tier 1 — the pre-launch set. Short list, real fixes.'}`);
  L.push(`**Detected:** ${det.summary}`);
  L.push('');
  L.push('## Start here');
  L.push('');
  top.forEach((p, i) => {
    const r = REASONS[p.reason];
    L.push(`### ${i + 1}. ${r.title} — ${p.priority.toUpperCase()}`);
    L.push(`- **Why this is top for you:** ${p.because}.`);
    L.push(`- **First fix:** ${r.fix} (${r.time}).`);
    L.push(`- **Read:** [${r.article.split('/').pop().replace('.html', '')}](${r.article})`);
    L.push('');
  });
  if (rest.length) {
    L.push('## Then');
    L.push('');
    L.push('| # | Reason | Priority | Why |');
    L.push('|---|--------|----------|-----|');
    rest.forEach((p) => L.push(`| ${p.reason} | [${REASONS[p.reason].title}](${REASONS[p.reason].article}) | ${p.priority} | ${p.because} |`));
    L.push('');
  }
  if (notApplicable.length) {
    L.push('## Not applicable today');
    L.push('');
    notApplicable.forEach((p) => L.push(`- **${REASONS[p.reason].title}** — ${p.because}. Revisit when that changes.`));
    L.push('');
  }
  L.push('## Running the audit');
  L.push('');
  L.push('- **Claude Code:** install the kit (`/plugin marketplace add papaonlegs/wont-scale`, then `/plugin install wont-scale@wont-scale`), then run `/scale-audit` — it reads `wont-scale.config.json` and audits in the order above. One reason at a time: `/scale-audit 4`.');
  L.push('- **Any AI coding tool:** paste a reason module from `skills/scale-audit/references/` into the chat and ask it to run the Checks section against this repo.');
  L.push('- **Re-run after fixes:** the audit report diffs against the previous run; this plan regenerates with `node scripts/first-audit.mjs` from the kit.');
  L.push('');
  L.push(`_The ten reasons, in full: [${SERIES}/index.html](${SERIES}/index.html)_`);
  L.push('');
  return L.join('\n');
}

function nextSteps(det, target) {
  const L = [];
  L.push(bold('\nNext steps'));
  L.push(`  1. Read ${cyan('FIRST-AUDIT.md')} — your top three are not the same as anyone else's.`);
  if (existsSync(join(target, '.claude')) || det.node) {
    L.push(`  2. Claude Code: ${cyan('/plugin marketplace add papaonlegs/wont-scale')} then ${cyan('/plugin install wont-scale@wont-scale')}, then ${cyan('/scale-audit')}.`);
  }
  if (existsSync(join(target, '.cursor'))) {
    L.push(`  3. Cursor detected: ${cyan('node scripts/assemble.mjs --guardrails --tool cursor')} > ${cyan('.cursor/rules/wont-scale.mdc')}.`);
  }
  if (existsSync(join(target, '.github'))) {
    L.push(`  4. Copilot: ${cyan('node scripts/assemble.mjs --guardrails --tool copilot')} >> ${cyan('.github/copilot-instructions.md')}.`);
  }
  L.push(`  ${dim('Guardrails for any agent: templates/AGENTS.snippet.md → your AGENTS.md / CLAUDE.md.')}`);
  if (det.envFile && !det.envIgnored) {
    L.push(bold(`\n  ⚠ .env exists and .gitignore does not cover it. Check git history for committed secrets before anything else.`));
  }
  return L.join('\n');
}

function installClaude(target) {
  const dest = join(target, '.claude');
  mkdirSync(join(dest, 'skills'), { recursive: true });
  mkdirSync(join(dest, 'agents'), { recursive: true });
  for (const s of readdirSync(join(KIT_ROOT, 'skills'))) {
    cpSync(join(KIT_ROOT, 'skills', s), join(dest, 'skills', s), { recursive: true });
  }
  for (const a of readdirSync(join(KIT_ROOT, 'agents'))) {
    cpSync(join(KIT_ROOT, 'agents', a), join(dest, 'agents', a));
  }
  return dest;
}

// ------------------------------------------------------------------- main ---

const det = detect(TARGET);
const project = basename(TARGET);

if (!flags.json) {
  console.log('');
  console.log(bold(`wont-scale first audit — ${project}`));
  console.log(dim(`target: ${TARGET}`));
  console.log(`detected: ${det.summary}`);
}

const answers = await interview(defaultsFrom(det));
const result = score(answers, det);

const config = {
  version: 1,
  created: new Date().toISOString(),
  tier: result.tier,
  stack: det.summary,
  answers,
  priorities: result.priorities,
  not_applicable: result.notApplicable,
};

if (flags.json) {
  console.log(JSON.stringify(config, null, 2));
}

if (WRITE) {
  writeFileSync(join(TARGET, 'wont-scale.config.json'), JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(TARGET, 'FIRST-AUDIT.md'), renderPlan(project, det, answers, result));
  if (!flags.json) {
    console.log(`\nWrote ${cyan('wont-scale.config.json')} and ${cyan('FIRST-AUDIT.md')} to ${TARGET}`);
  }
} else if (!flags.json) {
  console.log(dim('\n--no-write: nothing written.'));
}

if (flags['install-claude'] && WRITE) {
  const dest = installClaude(TARGET);
  if (!flags.json) console.log(`Installed skills and agents into ${cyan(dest)}`);
}

if (!flags.json) {
  const top = result.priorities.slice(0, 3);
  console.log(bold(`\nTier: ${result.tier}. Start here:`));
  top.forEach((p, i) => {
    console.log(`  ${i + 1}. [${p.priority}] ${REASONS[p.reason].title}`);
    console.log(`     ${dim(p.because)}`);
  });
  console.log(nextSteps(det, TARGET));
  console.log('');
}
