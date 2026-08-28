---
name: scale-guardrails
description: Coding-time guardrails against the ten failure modes of vibe-coded apps. Use when writing or reviewing code that touches database schema or migrations, authentication or sessions, authorisation or RLS policies, client-side data access, webhooks or background jobs, payment flows, caching or cron, logging, or endpoints that call LLMs and other metered APIs.
---

# Scale guardrails

These rules exist so the ten failure modes from
[the series](https://papa.onle.gs/writing/index.html) are prevented at write time
instead of found at audit time. Apply the sections relevant to the change in hand;
each links to a full module with symptoms, checks, and fixes one level down in
[../scale-audit/references/](../scale-audit/references/).

When the user asks to "install the guardrails", append the contents of
`${CLAUDE_PLUGIN_ROOT}/templates/AGENTS.snippet.md` (or `templates/AGENTS.snippet.md`
in a checkout of the kit) to the project's AGENTS.md and/or CLAUDE.md inside the
marked section — create the file if it does not exist, and never overwrite content
outside the markers.

### 1 — You have six data models and you think you have one

Before creating a new table or model, grep the schema for existing tables that could represent the same entity (user, account, profile, member) and extend one of those instead of adding a new one.
Never join two tables by matching a string field like email in application code. Every relationship gets a real foreign key with a constraint, added in the same migration as the tables it relates.
Never rename or drop a column or table against a database holding real data in a single migration. Use expand (add new) → dual-write → backfill → migrate reads → migrate writes → contract (drop old), one migration per step.
Any migration command capable of targeting production requires an explicit environment flag or distinct credentials. It must never default to whatever DATABASE_URL happens to be set in the shell.
When asked to add a "user"-like concept, check the ubiquitous-language doc for the existing canonical name before inventing a new table.

### 2 — 40ms locally, 40 seconds in production

Never write a .map()/.forEach()/loop that dereferences a relation property per row — use include/select (Prisma), embedded resource selects (Supabase), or a single JOIN/batched query instead.
Every new foreign-key column ships with a supporting index in the same migration that creates it.
Every serverless or edge deployment connects to Postgres through a pooler (PgBouncer, Supavisor, or the host's equivalent) — never a raw direct connection string.
Before marking a data-fetching change complete, state the query count for that endpoint and confirm it does not scale with row count.
Seed data includes at least one table with 1,000+ rows so N+1 patterns and missing indexes show up in development, not production.

### 3 — The login page is a prop

Enforce authentication and authorisation server-side on every new API route before touching data. A client-side route guard or a hidden UI button is not a security control.
Never hardcode a JWT secret, signing key, or API secret in source. Read it from environment variables or a secrets manager, always.
Give every JWT you issue a short expiry (`exp` claim), and make the server actually reject expired tokens.
Make "logout" a server-side call that revokes the token or session. Deleting a value from localStorage is not logout.
Default to a managed auth provider (Auth0, Clerk, Supabase Auth, Cognito) for anything handling passwords, sessions, or tokens. Do not hand-roll auth unless explicitly told to.
Keep every storage bucket you create (Firebase Storage, S3, GCS) private and authenticated by default. Treat public read or write as an explicit, reviewed exception, never the starting state.
Treat app IDs, client IDs, and tenant identifiers as public. Never use one as the sole gate on a registration, OTP, or admin endpoint.

### 4 — Authorisation is a vibe

Enable Row Level Security and add a real policy on every new table, in the same migration. `USING (true)` is not a policy.
Never write an authorisation check inline inside a handler. Call the shared policy layer; if it has no rule for this case yet, add one before adding the endpoint.
Add an explicit tenant filter (org_id or equivalent) to every multi-tenant query. Never rely on RLS alone as the only enforcement point.
Always include at least two tenants in seed and test fixtures, so a missing tenant filter fails a test before it reaches production.
Do not build or accept a "security check" that only confirms a policy exists. Confirm what the policy allows.

### 5 — Your frontend talks straight to the database

Enable Row Level Security with a real policy on every new Supabase/Firebase table, in the same migration that creates it. `USING (true)` or `WITH CHECK (true)` is not a policy — write the actual condition.
Never place a privileged credential (service-role key, Firebase admin key, direct database connection string) in client-rendered code or a client-exposed env var (`NEXT_PUBLIC_*` or equivalent). Only a short-lived session token belongs in the browser.
Treat every value that arrives from the client — price, quantity, role, `isAdmin`, ownership — as attacker-controlled. Re-derive or re-validate it server-side before writing it; never act on the client's copy.
Never implement a paywall, access gate, or role check only in CSS or client-side JavaScript. The check must live on the server that performs the read or write.
Route all browser-to-database traffic through an API layer or server function that re-authenticates and re-authorises the request. The browser never talks straight to the database.

### 6 — Nothing is idempotent and everything runs twice

Every new write or payment endpoint accepts and checks an idempotency key — client-supplied or derived from the event ID — before performing any side effect.
Every webhook handler inserts into a processed_events table (unique constraint on event_id) before charging, emailing, or updating state; a constraint violation is a no-op 200, not an error.
Webhook handlers return a 2xx response within the provider's timeout window (GitHub: 10 seconds) even when downstream processing is still running — respond first, do slow work after.
Never assume a queue message, webhook delivery, or POST request arrives exactly once. Write every handler to be safe if it runs twice with identical input.
Every submit button that triggers a write is disabled, or shows a pending state, from the first click until the request resolves.
When generating a write handler, the guard/dedup check is the first line, not an afterthought. Do not skip it because a duplicate "seems unlikely."

### 7 — It works on one box, and that's the whole problem

Never store session data, cache entries, or rate-limit counters in a module-level variable or in-process store — use Redis (or the project's existing shared store) for anything that must survive across requests or instances.
Never instantiate a cron job, setInterval, or scheduled timer inside the web/API process — schedule it through the project's job queue, or a single dedicated scheduler, so it runs exactly once no matter how many instances are running.
Never write uploaded or generated files to local disk as the only copy — upload to object storage (S3/GCS/R2/Supabase Storage) and treat local disk as scratch space a deploy can wipe.
Wire production session, cache, and rate-limit config to an external store in the same commit that adds the feature — don't ship the in-memory default and defer externalising it.
If a fix for "user got logged out" or "cache is wrong" involves adding sticky sessions or IP-affinity routing, stop — that's a workaround for state that should be externalised instead.

### 8 — You didn't write it and you can't see it either

Log structured JSON on every new API route or background job — never bare console.log or print — and include a request_id field on every log line.
Mint a request ID at the first hop of each request — or forward the caller's x-request-id if one exists — and pass it to every downstream call, log line, and error report, including calls to third parties like Stripe.
Wrap every external call (database, third-party API, queue) in error handling that reports to the project's configured error tracker. An empty catch block, or one that only logs locally, is not error handling.
When you add a new service, route, or hop to the request path, add its logging, request-ID propagation, and error reporting in the same change. Do not ship a hop uninstrumented and add observability later.
Never remove or downgrade an existing log statement, correlation-ID pass-through, or error-tracking call without adding an equivalent in the same change.

### 9 — Profitable at 100 users, bankrupt at 10,000

Every new public or unauthenticated endpoint gets a rate limiter (token bucket or sliding window) added in the same commit that creates it. No exceptions for "internal" or "temporary" routes.
Never call a paid third-party API (LLM, embeddings, SMS, email) from a public route without a per-user or per-IP limit already in front of it.
Enforce subscription, paywall, and entitlement checks in middleware or the server-side route handler. A check that only runs in a client component is a UI hint, not access control.
Never reference an API key, secret, or token inside a "use client" component or a NEXT_PUBLIC_-prefixed (or equivalent client-exposed) env var, unless that value is explicitly meant to be public.
Every endpoint that costs money per call logs that cost, so cost-per-request can be measured next to latency, not discovered on the invoice.
A spending cap is not a substitute for a rate limiter. Implement both, and point any budget alert at a channel a human actually watches.

### 10 — The bus factor isn't one, it's zero

Before merging any change, the author must be able to explain how it works in their own words. If they can't, it does not merge — no exception for AI-generated code.
When you generate a structural or architectural change (new service, new datastore, new external dependency, schema redesign, a change to queue or job behaviour), write or update an ADR in the same change. The decision and the code land together.
Never discard the prompt or spec that produced a change. Include it in the PR description or commit message in full, not summarised.
Do not write contract or acceptance tests from the same prompt as the implementation they verify. If hand-written boundary tests do not already exist for the area you are touching, write them, or ask for them, before adding unit tests underneath.
When reviewing AI-generated code, re-derive what it is supposed to do from the spec or ADR before judging whether it looks correct. "Looks plausible" is not a review.
