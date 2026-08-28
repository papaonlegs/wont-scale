---
name: first-audit
description: Interactive setup interview that scopes a first production-readiness audit for the current project. Detects the stack, asks the user about stakes (real users, money, personal data), architecture, and team, then writes a prioritised wont-scale.config.json and a tailored FIRST-AUDIT.md plan. Use when the user wants to set up, scope, or start their first audit, or asks where to begin hardening a vibe-coded app.
argument-hint: "[target-directory]"
---

# First audit — setup interview

You are scoping a first audit of this project against the ten reasons vibe-coded apps
fail at scale. The output is a plan sized to the project's actual stakes — a weekend
prototype and an app moving real money must not get the same list.

Target directory: `$ARGUMENTS` if given, else the project root.

## Step 1 — detect before asking

Silently inspect (read-only): package.json / pyproject.toml / go.mod; ORM and schema
dirs (prisma/, supabase/, drizzle/, migrations/); auth and payment dependencies
(next-auth, @clerk, @supabase/supabase-js, firebase, stripe); metered-API SDKs
(openai, @anthropic-ai, resend, twilio); telemetry (@sentry, posthog, dd-trace,
@opentelemetry); deploy config (Dockerfile, vercel.json, fly.toml, render.yaml);
CI workflows; test files; README with a setup section.

Summarise in two lines, then confirm: "Here's what I detected — correct me if wrong."

## Step 2 — the interview

Ask with AskUserQuestion, two batches. Pre-fill defaults from detection and say so.
If AskUserQuestion is unavailable, ask the same questions in plain text, one batch
at a time.

Batch 1 — stakes (these gate everything):
1. **Users** — Who uses this today? (just me / invited beta / real users in production)
2. **Money** — Does real money move through it — payments, credits, billing? (yes / no)
3. **Data** — Does it store personal data beyond an email address? (yes / no / not sure)
4. **Bus factor** — If you disappeared for a month, could someone else run and change
   it from the README alone? (yes / no)

Batch 2 — architecture (skip any the detection already answered decisively):
5. **Data path** — Does browser code talk to the database directly (Supabase/Firebase
   client SDK), or does everything go through your own API? (direct / API / mixed / not sure)
6. **Authorisation** — Where is "can this user see this row" decided? (DB policy or RLS /
   API middleware / React components / nowhere / not sure)
7. **Retries** — Any webhooks, background jobs, or queues? What happens if the same
   event arrives twice? (dedup exists / nothing, it runs twice / no webhooks or jobs / not sure)
8. **Topology** — What runs the app? (one server or container / serverless / several
   instances / not sure)
9. **Cost path** — Do any endpoints call LLMs or other metered APIs? Are they rate-limited
   with per-user caps? (capped / uncapped / none)
10. **Visibility** — If production broke at 3am, how would you find out? (error tracker
    pages me / I'd see it in logs eventually / a user would email me)

## Step 3 — score and tier

- **Tier 2** (full depth) if real users AND (money or personal data). Otherwise **Tier 1**
  (the pre-launch set).
- Priority per reason: start from the answer that implicates it most directly —
  "nowhere/not sure" on authorisation, "direct" on data path, "nothing, it runs twice"
  on retries, "uncapped" on cost, "a user would email me" on visibility, and "no" on
  bus factor each pull that reason to the top. Detection evidence (e.g. anon key in
  client code, no telemetry dependency) beats self-report when they disagree.
- Reasons with no exposure (no webhooks → idempotency; no metered APIs → part of
  unit economics) are marked `not_applicable` rather than silently dropped.

## Step 4 — write two files

1. `wont-scale.config.json` in the project root:

```json
{
  "version": 1,
  "created": "<ISO date>",
  "tier": "tier1 | tier2",
  "stack": { "<detected summary>": "..." },
  "answers": { "<question-key>": "<answer>" },
  "priorities": [
    { "reason": 4, "slug": "authorisation", "priority": "critical", "because": "<one line>" }
  ],
  "not_applicable": [ { "reason": 6, "because": "no webhooks or background jobs" } ]
}
```

2. `FIRST-AUDIT.md` in the project root — the tailored plan:
   - **Start here** — the top three reasons, each with: why it's top for *this* project
     (cite the answer or detection that put it there), the first fix, an honest time
     box, and the article link.
   - **Then** — remaining applicable reasons in priority order, one line each.
   - **Not applicable** — with the reason why, so future-you can revisit.
   - **How to run it** — `/scale-audit` for the full pass now, or reason-by-reason
     (`/scale-audit 4`); re-run after fixes to see the diff.

## Step 5 — offer next moves

Offer exactly three, let the user choose:
1. Run `/scale-audit` now with the new priorities.
2. Install coding-time guardrails (copy the modules' Guardrail blocks into the
   project's AGENTS.md / CLAUDE.md — create the file if absent, append a marked
   section if present; never overwrite existing content).
3. Stop here — the plan stands alone.

Series index for links: https://papa.onle.gs/writing/index.html
