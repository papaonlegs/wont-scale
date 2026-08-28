# 9 — Profitable at 100 users, bankrupt at 10,000

> What happens when someone calls this 10,000 times?

**Article:** https://papa.onle.gs/writing/profitable-at-100-bankrupt-at-10000.html
**Applies to you if:** you have any public or unauthenticated endpoint, especially one that calls a paid API (LLM, embeddings, SMS, email) or sits behind a subscription paywall
**Tier:** T1 (before real users) — the bill arrives before revenue does
**First fix:** put a rate limiter on your single most exposed, most expensive endpoint (~1–2 hours)

## What it is

Nobody asked what happens if someone calls this endpoint 10,000 times, because "what if someone hammers this?" was never part of your prompt. You have no rate limit, no cost model, and no way to tell a real signup wave from one script hitting the same route on repeat — so a traffic spike reads as an attack, and it stays invisible right up until it happens. Two invoices land for the same event: the attacker's, and your cloud provider's. Even with zero attackers, you get the same failure as organic inversion — cost per user climbing faster than revenue per user, exactly when growth starts working.

## Symptoms

- A traffic or usage spike reads as "I'm under attack" instead of a growth win
- API keys maxed out, with no way to tell which caller did it
- The subscription or paywall check turns out to be bypassable because it only ever lived client-side
- Junk writes hit the database from calls that were never validated
- A surprise bill arrives after the spending that caused it has already happened
- A mid-month budget alert forces the team to drop everything and contain the bleeding
- Cost per user rises while revenue per user stays flat as the user count grows (e.g. a flat $9/month plan against cost climbing from $1.20 to $16 per user)
- No way to distinguish a thousand genuine signups from one script hitting the same endpoint a thousand times

## Checks

### Code

```bash
# Find files that call a paid third-party API (LLM, embeddings, SMS, email)
# and flag any with no rate-limiting library referenced in the same file
rg -l -i '(openai|anthropic|cohere|elevenlabs|replicate|twilio|sendgrid)\.(chat|completions?|create|generate|send|embeddings?)' \
  --glob '*.{ts,js}' -g '!node_modules' \
  | xargs -I{} sh -c 'rg -q -i "ratelimit|rate-limit|@upstash/ratelimit|express-rate-limit" "{}" || echo "NO LIMITER NEARBY: {}"'
```
Bad result: any file printed — a route that fans out to a metered API with nothing in it guarding call volume.

```bash
# Find provider API keys shipped to the browser: NEXT_PUBLIC_-prefixed env
# vars holding key-shaped values, or hardcoded key-shaped strings in client code
# (Next.js convention — adjust the prefix for Vite/CRA's VITE_/REACT_APP_)
rg -in 'NEXT_PUBLIC_\w*(API_KEY|SECRET|TOKEN)\w*' --glob '*.{ts,tsx,env*}' -g '!node_modules'
rg -in '(sk-[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_\-]{30,})' \
  --glob '*.{ts,tsx,js,jsx}' -g '!node_modules'
```
Bad result: any match — a real provider key pattern, or an env var prefixed for client exposure holding one, shipped straight into the browser bundle.

```bash
# Find subscription/paywall checks that exist only in client components, with
# nothing matching in server routes or middleware (Next.js App Router layout)
rg -l '"use client"' --glob '*.{ts,tsx}' -g '!node_modules' \
  | xargs rg -l -i 'is(Subscribed|Pro|Premium|Paid)\b|subscription\.(status|active)'
rg -l -i 'is(Subscribed|Pro|Premium|Paid)\b|subscription\.(status|active)' \
  app/api middleware.ts src/middleware.ts 2>/dev/null
```
Bad result: the first command returns files and the second returns nothing — the only place the app checks entitlement is code running in the user's own browser, which they control.

### Database

```sql
-- Look for anywhere the app logs per-request cost or usage (Postgres;
-- Supabase keeps application tables in `public` by default too)
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name ~* '(usage|api_log|request_log|llm_usage|api_calls|cost)';
```
Bad result: zero rows. Nothing records what an individual request cost, so cost-per-request can't be graphed even after the fact, let alone alarmed on.

### Infrastructure

```bash
# Check whether the edge/host layer has any rate limiting or WAF configured
# ahead of your application code (Vercel, Cloudflare, Fly, Render — naming varies by host)
rg -in 'ratelimit|rate.?limit|firewall|waf' \
  vercel.json fly.toml render.yaml next.config.* middleware.ts 2>/dev/null
```
Bad result: no matches — nothing throttles a request before it reaches your code, and the first Code check above already told you whether your code throttles it either.

```bash
# Check whether a billing budget with a real alert exists (read-only; needs
# gcloud or aws CLI already authenticated — skip whichever provider doesn't apply)
gcloud billing budgets list --billing-account="$(gcloud billing accounts list --format='value(ACCOUNT_ID)' | head -1)" 2>/dev/null
aws budgets describe-budgets --account-id "$(aws sts get-caller-identity --query Account --output text)" 2>/dev/null
```
Bad result: no budgets returned, or a budget exists with an empty notification list — nothing is wired to alert a human before the invoice does.

## Questions to ask

- If someone called your most expensive endpoint 10,000 times in the next hour, what would it cost you, and who would find out first — you, or your bank?
- Is the subscription check enforced server-side, or is it one dev-tools edit away from free?
- Do you have a spending cap and a rate limiter, or just the one that only reacts after the money's already spent?
- Does the budget alert page a person, or does it sit as a number in a dashboard nobody opens on a Saturday?
- Can the system tell a thousand real signups apart from one script hitting the same endpoint a thousand times?

## The fix

1. Put a rate limiter — token bucket or sliding window, Redis-backed if you run more than one instance — in front of your most exposed, most expensive endpoint (~1–2 hours)
2. Move every subscription or paywall check server-side, into middleware or the route handler, never a client component alone (~1 hour per gated route)
3. Pull any API key currently shipped to the client into a server-only env var, and rotate the ones that were exposed (~1 hour, longer if you don't know how long it was exposed)
4. Add windowing and tiering so authenticated or paying callers get a higher limit than anonymous ones, the way GitHub's API separates unauthenticated from authenticated request quotas (an afternoon)
5. Track cost-per-request next to latency: log provider or DB cost per call and put it on the same dashboard you already watch (an afternoon)
6. Keep the rate limiter and add a spending cap on top of it — caps are reactive and lag real usage until billing catches up, limiters are preventive, you need both (~1 hour for the cap)
7. Wire the budget alert to something that pages a human — Slack, PagerDuty, SMS — not a number sitting in a console nobody opens (~30 min)

## Guardrail

```
Every new public or unauthenticated endpoint gets a rate limiter (token bucket or sliding window) added in the same commit that creates it. No exceptions for "internal" or "temporary" routes.
Never call a paid third-party API (LLM, embeddings, SMS, email) from a public route without a per-user or per-IP limit already in front of it.
Enforce subscription, paywall, and entitlement checks in middleware or the server-side route handler. A check that only runs in a client component is a UI hint, not access control.
Never reference an API key, secret, or token inside a "use client" component or a NEXT_PUBLIC_-prefixed (or equivalent client-exposed) env var, unless that value is explicitly meant to be public.
Every endpoint that costs money per call logs that cost, so cost-per-request can be measured next to latency, not discovered on the invoice.
A spending cap is not a substitute for a rate limiter. Implement both, and point any budget alert at a channel a human actually watches.
```

## Evidence from the wild

- Builder leojr94 posted "zero hand written code" about a Cursor-built SaaS on 15 March 2025; two days later, "guys, i'm under attack" — maxed-out API keys, a bypassed subscription paywall, and junk writes hitting the database. The app was gone within five days (the original X posts; also covered in TechStartups' "When vibe coding goes wrong").
- OWASP names this class of failure directly: [API4:2023 — Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/).
- Sysdig's LLMjacking research modelled stolen-credential abuse against LLM APIs at roughly $46,000/day at Claude 2.x pricing, rising past $100,000/day in the Claude 3 Opus era (sysdig.com).
- Tom's Hardware reported a developer's cloud bill hit $18,000-plus overnight, from a $7 test budget, despite a $1,400 spending cap already configured — usage outran billing enforcement before the cap could act.
- a16z's "The New Business of AI" found AI-native software running gross margins of 50–60%, against 60–80%-plus for traditional SaaS, with compute often consuming more than 25% of revenue (a16z.com).
- GitHub's own tiered API limits — 60 requests/hour unauthenticated versus 5,000/hour authenticated — are the standard shape of "tiering" as a fix; their engineering team has written about scaling that limiter with a sharded, replicated design on Redis (github.blog).
