---
name: scale-audit
description: Runs a production-readiness audit of the current project against the ten failure modes of vibe-coded apps — data models, query performance, authentication, authorisation/RLS, client trust boundary, idempotency, statelessness, observability, unit economics, and bus factor. Use when the user asks to audit the app, vibe-check the codebase, check production readiness, review before launch, or asks whether the app will scale.
argument-hint: "[all | tier1 | 1-10 | reason-slug]"
---

# Scale audit

You are auditing the current project against the ten reasons vibe-coded apps fail at scale
(the series: https://papa.onle.gs/writing/index.html). The audit is read-only: inspect,
never modify project files. The one file you write is the report.

## Scope

Resolve scope from `$ARGUMENTS`:

- empty or `all` — all ten reasons.
- `tier1` — only reasons marked Tier 1 in their module (the pre-launch set).
- a number `1`–`10` or a slug (`data-models`, `query-performance`, `authentication`,
  `authorisation`, `trust-boundary`, `idempotency`, `statelessness`, `observability`,
  `unit-economics`, `bus-factor`) — that reason only.

If `wont-scale.config.json` exists in the project root (written by `/first-audit`), read it:
audit in its priority order, skip reasons it marks not-applicable, and note in the report
that scope came from the wizard. The config never expands scope beyond `$ARGUMENTS`.

## Method

1. **Detect the stack** (2 minutes, not 20): package.json or equivalent, ORM/schema
   directories (prisma/, supabase/, drizzle/, migrations/), deploy config (Dockerfile,
   vercel.json, fly.toml, render.yaml), CI (.github/workflows). One-line summary.
2. **For each reason in scope**, read its module and run its Checks section against the
   project. Modules live one level down from this file:

   | # | Module | Covers |
   |---|--------|--------|
   | 1 | [references/01-data-models.md](references/01-data-models.md) | duplicate models, string joins, migration discipline |
   | 2 | [references/02-query-performance.md](references/02-query-performance.md) | N+1, indexes, pooling |
   | 3 | [references/03-authentication.md](references/03-authentication.md) | sessions, tokens, secrets |
   | 4 | [references/04-authorisation.md](references/04-authorisation.md) | policy layer, RLS, tenancy |
   | 5 | [references/05-trust-boundary.md](references/05-trust-boundary.md) | client-side keys, BFF |
   | 6 | [references/06-idempotency.md](references/06-idempotency.md) | webhooks, retries, dedup |
   | 7 | [references/07-statelessness.md](references/07-statelessness.md) | in-process state, cron, disk |
   | 8 | [references/08-observability.md](references/08-observability.md) | telemetry, correlation IDs |
   | 9 | [references/09-unit-economics.md](references/09-unit-economics.md) | rate limits, cost per request |
   | 10 | [references/10-bus-factor.md](references/10-bus-factor.md) | tests, docs, explainability |

   Run the module's shell checks with Bash and its SQL checks only if a database is
   reachable read-only (a psql/supabase connection the user already has configured).
   Never guess at credentials, and never run anything that writes.
3. **Record findings with evidence** — file:line, command output, or config value.
   A claim without evidence doesn't go in the report.
4. **Grade each finding**: Critical (data exposure or failure already possible today),
   High (breaks at the next stage — scale or payments), Advisory (worth scheduling).
   Use the module's Tier and the project's stakes (from the config, or ask once if
   unclear whether real users/money are live).
5. **Write the report** to `WONT-SCALE-REPORT.md` in the project root using
   [references/report-template.md](references/report-template.md). If the file already
   exists, note deltas — fixed since last run, new, unchanged — at the top.

## Honesty rules

- "Could not verify" is a first-class result. A check that didn't run is reported as
  not-verified, never as a pass.
- An empty Critical section is a good outcome; state it plainly, don't pad.
- Every finding links the matching article so the user can read the why, and names the
  smallest real first fix with an honest time estimate.

## After the report

Offer, don't push:
- fix the top finding now;
- install coding-time guardrails so the failures don't come back (`/scale-guardrails`
  explains, or copy the Guardrail blocks from the modules into AGENTS.md / CLAUDE.md);
- re-run `/scale-audit` after fixes — the report diffs against the previous run.
