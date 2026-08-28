# 7 — It works on one box, and that's the whole problem

> Kill any web process mid-request and nothing is lost.

**Article:** https://papa.onle.gs/writing/it-works-on-one-box.html
**Applies to you if:** you have sessions, caches, rate limits, cron/scheduled jobs, or file uploads, and expect to run (or already run) more than one instance.
**Tier:** T1 (before real users) — the retrofit is a rewrite, not a patch.
**First fix:** move session storage to Redis (or your platform's managed store) via a drop-in adapter (~1–2 hours).

## What it is

Your app works fine on one instance because the AI wrote code that's correct for whatever topology the prompt implied — almost always a single running process. Caches, sessions, rate limits, cron jobs, and file writes all default to living in that one process's memory or on its local disk, which works perfectly and passes every test. The problem stays invisible for as long as you run one instance, because one instance never disagrees with itself. The moment a load balancer has a second place to send a request, none of that changes in the code — only the instance count does — and the app starts producing nondeterminism instead of errors.

## Symptoms

- No crash, no stack trace — just nondeterminism the moment a load balancer has more than one place to send a request.
- Instance B disagrees with whatever instance A cached: the same request returns different answers depending which process handles it.
- A user gets logged out on the refresh that happens to land on a different process than the one that authenticated them (in-memory sessions).
- The effective rate limit silently multiplies by however many instances are running (per-process counter dictionaries).
- A daily email or scheduled job fires once per instance instead of once total (cron/timers living inside the web process).
- Files written to local disk are simply gone the moment the next deploy replaces the box.
- The bug never reproduces in dev, because dev only ever runs one process.

## Checks

### Code

```bash
# Module-level caches: Maps/objects that persist across requests inside a single process
rg -ni -g '!node_modules' -g '!**/*.test.*' 'new (Map|WeakMap|LRUCache)\(|^\s*(const|let|var)\s+\w*[Cc]ache\w*\s*='
```
Bad result: hits inside route handlers, controllers, or middleware (not tests) with no Redis client wrapping them — that cache is per-process and will diverge across instances.

```bash
# Session middleware set up without an external store (Express/Flask/Rails all default to in-process storage)
rg -n 'express-session|flask_session|Rack::Session|ActionDispatch::Session' -g '!node_modules'
```
Bad result: a hit with no `store:` option (e.g. `connect-redis`, `connect-pg-simple`) or no `SESSION_TYPE=redis` nearby — sessions default to an in-process `MemoryStore` that a second instance never sees.

```bash
# Rate limiters instantiated without a shared backing store
rg -n 'express-rate-limit|rate-limiter-flexible|Flask-Limiter|rack-attack' -g '!node_modules'
```
Bad result: no `RedisStore`/`ioredis` argument near the hit — counters live in that process only, so the real limit is (configured limit × instance count).

```bash
# Cron/timers defined in the same codebase that serves HTTP traffic, rather than in a dedicated worker
rg -n 'node-cron|node-schedule|setInterval\(|APScheduler|Rufus::Scheduler|whenever' -g '!node_modules' -g '!**/workers/**' -g '!**/jobs/**'
```
Bad result: a hit inside `server.ts`, `app.js`, `main.py`, or anywhere the HTTP server boots — that scheduler starts fresh in every instance and fires once per instance.

```bash
# Local filesystem writes that might be the only copy of an uploaded/generated file
rg -n "fs\.writeFile|fs\.createWriteStream|open\(.*['\"]w" -g '!node_modules' -g '!**/*.test.*'
```
Bad result: a write to `./uploads`, `/tmp`, or `public/` with no nearby call to an S3/GCS/R2 SDK — that file does not survive the next deploy, and does not exist on any instance but the one that wrote it.

### Database

```sql
-- Is there an externalised session table? (connect-pg-simple, Django sessions, etc.)
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name ILIKE '%session%';
```
Bad result: no rows returned, while the code check above shows session middleware in use — sessions have nowhere to live but process memory. (Not conclusive alone if sessions are Redis-backed instead of Postgres-backed — pair with the code check.)

```sql
-- Currently held Postgres advisory locks: the usual mechanism for making a scheduled job run on exactly one instance
SELECT locktype, ((classid::bigint << 32) | objid::bigint) AS lock_key, granted, pid
FROM pg_locks
WHERE locktype = 'advisory';
```
Bad result: empty, while the code check above found cron/scheduled-job code — nothing in Postgres is serialising that job, so every running instance fires it. (Postgres/Supabase only; irrelevant once jobs run through a dedicated queue like Sidekiq or BullMQ.)

### Infrastructure

```bash
# How many web instances/replicas are actually configured to run?
grep -RniE 'replicas|instance_count|min_machines_running|processes:' fly.toml render.yaml Procfile ecosystem.config.js docker-compose.yml vercel.json 2>/dev/null
```
Bad result: nothing configured beyond a single default (never run at more than one), or a count greater than one configured while the code checks above found in-process state — meaning it's already broken and nobody's noticed yet.

```bash
# Sticky-session/affinity config is a red flag per Twelve-Factor — usually there to paper over in-process state
grep -RniE 'sticky|session[_-]?affinity|ip_hash' nginx.conf *.tf fly.toml render.yaml 2>/dev/null
```
Bad result: any match — someone already hit the symptom and routed around it at the load balancer instead of externalising the state. (Config filenames vary by host; check whatever load balancer or ingress config your infrastructure actually uses.)

## Questions to ask

- If you spin up a second instance right now, does the cache still agree with itself?
- Would the daily email fire once, or once per instance?
- Does a user get logged out simply because their next request lands on a different process than the one that authenticated them?
- Is "runs on one box" a documented assumption, or an untested one nobody ever wrote down?
- Could you add a second instance today with zero code changes — or would that require a rewrite?

## The fix

1. Move session storage to Redis (or your platform's managed store) via a drop-in adapter — `connect-redis`, `Flask-Session` with a Redis backend, and so on (~1–2 hours).
2. Swap in-process rate limiters for a Redis-backed store, e.g. `rate-limiter-flexible` with an `ioredis` client (~1 hour).
3. Move module-level/global caches to Redis, or drop them and lean on the database plus an edge/CDN cache instead (~half a day, depending on call sites).
4. Pull cron and scheduled jobs out of the web process into a real job system — Sidekiq, Celery, BullMQ — with a single scheduler, so scheduled work runs exactly once regardless of instance count (~a day).
5. Point file uploads and generated files at object storage (S3, GCS, R2, Supabase Storage) instead of local disk (~half a day).
6. Prove it: run two instances in staging and watch for cache drift, duplicate emails, and logout flapping before you ever run two in production (~an afternoon).
7. Treat statelessness as a decision made from the first commit on every new feature, not something bolted on later (ongoing).

## Guardrail

```
Never store session data, cache entries, or rate-limit counters in a module-level variable or in-process store — use Redis (or the project's existing shared store) for anything that must survive across requests or instances.
Never instantiate a cron job, setInterval, or scheduled timer inside the web/API process — schedule it through the project's job queue, or a single dedicated scheduler, so it runs exactly once no matter how many instances are running.
Never write uploaded or generated files to local disk as the only copy — upload to object storage (S3/GCS/R2/Supabase Storage) and treat local disk as scratch space a deploy can wipe.
Wire production session, cache, and rate-limit config to an external store in the same commit that adds the feature — don't ship the in-memory default and defer externalising it.
If a fix for "user got logged out" or "cache is wrong" involves adding sticky sessions or IP-affinity routing, stop — that's a workaround for state that should be externalised instead.
```

## Evidence from the wild

- [Rap Genius's 2013 "Heroku's Ugly Secret"](https://genius.engineering/herokus-ugly-secret/): Heroku silently switched routing from intelligent to random; at Rap Genius's traffic, 62% of request time was spent purely queueing, and an app needing 80 dynos under intelligent routing needed roughly 4,000 under random routing. Heroku's own GM publicly confirmed the failure.
- [The Twelve-Factor App, Factor VI — Processes](https://12factor.net/processes) calls sticky sessions "a violation... never to be used."
- [AWS Well-Architected Framework, Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html) recommends stateless application design for the same reason.
- [DHH, "The Majestic Monolith"](https://signalvnoise.com/the-majestic-monolith/) and [Shopify Engineering, "Under Deconstruction: The State of Shopify's Monolith"](https://shopify.engineering/shopify-monolith) (2.8 million lines of Ruby, still one deployable unit, running Shopify's BFCM peak — Shopify has reported per-minute BFCM sales that work out to well over $100M an hour) are the counterpoint: the lesson isn't "split into microservices," it's "make the monolith stateless."
- One ops write-up documented a backup cron job firing 28 times across replicated instances — an individual account, not a vendor or corporate postmortem.
