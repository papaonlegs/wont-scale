# 8 — You didn't write it and you can't see it either

> Generated code you can't observe is a locked room.

**Article:** https://papa.onle.gs/writing/you-cant-see-it-either.html
**Applies to you if:** your request path has more than one hop — browser, web app, API, database, a third party like Stripe — and you can't currently follow one request across all of them
**Tier:** T1 (before real users) — an afternoon now, days lost later
**First fix:** wire up error tracking (Sentry or equivalent) so exceptions stop vanishing silently (~30 min)

## What it is

Hand-written code you can't observe well is survivable, because you still remember roughly how it works — your memory substitutes for the telemetry you never built. Generated code you can't observe is a locked room: you have neither the telemetry nor the memory to fall back on. Most vibe-coded apps ship with close to zero monitoring and close to zero observability, because nobody paused mid-build to ask what could go wrong at each hop. It stays invisible right up until a real user reports something vague — "checkout is slow sometimes" — and you discover you have no way to find out why. Most incident time isn't spent fixing. It's spent finding.

## Symptoms

- No correlation or request ID threaded through hops — browser, web app, API, database, and Stripe are each dead ends
- Logging is `console.log`/`print` scattered ad hoc, with no structure and nothing to grep by request
- Exceptions vanish silently — no error tracker is wired up to catch them
- Vague bug reports ("checkout is slow sometimes") take days to localise instead of minutes
- No single dashboard covers latency, traffic, errors, and saturation — you check five places, or none
- Nobody ever wrote down "what could go wrong here" for each hop in the system
- Logs, traces, or dashboards exist but nobody has a cadence to look at them — they only get opened once something's already on fire

## Checks

### Code

```bash
# Count unstructured log calls and check whether a structured logging library is even a dependency
# (JS/TS and Python stacks; adjust globs for other runtimes)
rg -c 'console\.(log|error|warn)\(|print\(' -g '*.{js,ts,jsx,tsx,py}' -g '!node_modules' -g '!dist' .
rg -i 'pino|winston|bunyan|structlog' package.json requirements.txt pyproject.toml 2>/dev/null
```
Bad result: dozens of unstructured log calls and no structured logging library in any dependency file.

```bash
# Look for a correlation/request ID being minted or propagated anywhere
rg -in 'x-request-id|request[_-]?id|correlation[_-]?id' -g '!node_modules' -g '!dist' .
```
Bad result: no matches, or matches confined to a single handler rather than middleware that runs on every request.

```bash
# Check whether an error-tracking SDK is installed and actually initialised, not just listed
rg -i 'sentry|bugsnag|rollbar' package.json requirements.txt 2>/dev/null
rg -in 'Sentry\.init|bugsnag\.start|Rollbar\(' -g '!node_modules' .
```
Bad result: the SDK appears in the dependency file but no `.init()`/`.start()` call exists anywhere in the codebase.

```bash
# Check for any distributed tracing setup at all
rg -i 'opentelemetry|@vercel/otel|@opentelemetry|datadog|newrelic|honeycomb' package.json 2>/dev/null
```
Bad result: no matches — no trace instrumentation exists anywhere in the request path.

```bash
# Find catch blocks that discard the exception instead of reporting it
rg -A2 'catch\s*\([^)]*\)\s*{' -g '*.{js,ts}' -g '!node_modules' . | rg -B2 '^\s*}\s*$'
```
Bad result: catch blocks with an empty body, or one that only writes to a local log the error tracker never sees.

### Database

```sql
-- Tables taking heavy sequential scans relative to index use (Postgres; Supabase uses the same catalog)
SELECT relname AS table_name,
       seq_scan,
       idx_scan,
       n_live_tup AS row_estimate
FROM pg_stat_user_tables
WHERE seq_scan > idx_scan
  AND n_live_tup > 10000
ORDER BY seq_scan DESC
LIMIT 20;
```
Bad result: a table with a large row estimate and seq_scan far ahead of idx_scan — full scans nobody noticed because dev data is small, a concrete root cause of the "slow sometimes" complaint.

```sql
-- Slowest queries by cumulative time, if pg_stat_statements is enabled
SELECT calls, mean_exec_time, total_exec_time, query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```
Bad result: the query errors because the extension was never enabled, or the top offenders are queries nobody can tie back to a specific endpoint or trace.

### Infrastructure

```bash
# Check whether anything is configured to receive logs, traces, or errors
# outside the running process (Vercel/Fly/Render-style ephemeral compute;
# less relevant if you run long-lived servers writing to local disk)
rg -i 'SENTRY_DSN|OTEL_EXPORTER|LOGTAIL|DATADOG_API_KEY|AXIOM_TOKEN|LOG_DRAIN' \
  .env.example .env.sample vercel.json fly.toml render.yaml 2>/dev/null
```
Bad result: no matches — nothing is configured to receive telemetry once the instance or function that produced it recycles, so the evidence disappears with the process.

## Questions to ask

- If checkout is reported "slow sometimes" today, can you localise the root cause in minutes, or does it take a multi-day investigation?
- Is there one ID that lets you follow a single user's request across browser, web app, API, database, and Stripe?
- When an exception fires in production right now, where does it go, and who ever sees it?
- Who actually reviews your dashboards, and on what cadence — only during incidents, or on a schedule?
- What's the fallback if your own logging pipeline goes down, the way Cloudflare's did?

## The fix

1. Wire up error tracking (Sentry or equivalent) so exceptions stop vanishing silently (~30 min)
2. Mint a correlation/request ID at the edge — load balancer, gateway, or first middleware hop — and thread it through every log line and outbound call, including third-party ones like Stripe (~1–2 hours)
3. Replace ad hoc `console.log`/`print` calls with structured JSON logs across every service in the request path (~half a day, can land incrementally)
4. Instrument one distributed trace spanning browser → web app → API → database → third party, e.g. via OpenTelemetry (~an afternoon)
5. Build one dashboard covering the four fundamental signals: latency, traffic, errors, saturation (~an afternoon)
6. Set a recurring cadence — weekly is enough — for someone to actually open the dashboard, not just during an incident (~15 min to schedule, then ongoing discipline)

None of this matters if nobody looks at it. The fix is an afternoon of work, not a platform migration — the hard part is doing it before the first incident forces you to, and keeping someone looking after it once it's built.

## Guardrail

```
Log structured JSON on every new API route or background job — never bare console.log or print — and include a request_id field on every log line.
Mint a request ID at the first hop of each request — or forward the caller's x-request-id if one exists — and pass it to every downstream call, log line, and error report, including calls to third parties like Stripe.
Wrap every external call (database, third-party API, queue) in error handling that reports to the project's configured error tracker. An empty catch block, or one that only logs locally, is not error handling.
When you add a new service, route, or hop to the request path, add its logging, request-ID propagation, and error reporting in the same change. Do not ship a hop uninstrumented and add observability later.
Never remove or downgrade an existing log statement, correlation-ID pass-through, or error-tracking call without adding an equivalent in the same change.
```

## Evidence from the wild

- Cloudflare, 14 November 2024: a failsafe overcorrection in Cloudflare's own log pipeline lost 55% of customer logs for three and a half hours — proof that even a company whose product is observability can go dark.
- DORA's 2025 State of AI-assisted Software Development report (around 5,000 respondents) found debugging is the software task most degraded by AI assistance, and that AI adoption without an observability foundation correlates with increased delivery instability, not less.
- Charity Majors' distinction, set out in Honeycomb's "Observability: A Manifesto," still holds: monitoring answers known-unknowns, observability answers unknown-unknowns. A vibe-coded app typically has close to zero of both.
- Google's SRE Book devotes a full chapter, ["Monitoring Distributed Systems"](https://sre.google/sre-book/monitoring-distributed-systems/), to the same four golden signals this module asks you to put on one dashboard: latency, traffic, errors, saturation.
- Stack Overflow's 2025 developer survey recorded trust in AI-generated code falling from 40% to 29% year over year, even as usage climbed to 84% — teams shipping more of it while trusting it less.
