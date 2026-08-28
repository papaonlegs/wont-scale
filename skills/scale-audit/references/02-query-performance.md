# 2 — 40ms locally, 40 seconds in production

> Same code. Same query. A hundred times the rows.

**Article:** https://papa.onle.gs/writing/40ms-locally-40-seconds-in-production.html
**Applies to you if:** you have an ORM or query builder, any list-then-related-lookup code, or a serverless deployment sitting in front of Postgres.
**Tier:** T2 (before scale/payments) — invisible until production-scale data arrives.
**First fix:** put a connection pooler in front of Postgres (~30 min).

## What it is

Your code queries the database exactly the way it was written, every time. At ten rows that's eleven queries and a 40ms response; at ten thousand rows it's the same loop firing ten thousand times, because nothing about the code path changed — only the data did. Tests pass throughout, because a test suite checks correctness, not query count or query plan. Missing indexes behave the same way: a sequential scan is fine on 500 rows and silently becomes a multi-second scan on 2 million, with no error, no warning, no failing test. The failure is invisible until someone points production-shaped traffic and production-shaped data at it, and by then it's an incident, not a code review comment.

## Symptoms

- Requests that took 40ms locally take 40 seconds in production, on identical code and identical queries.
- ORM one-liners like `orders.map(o => o.customer.name)` that look clean in review but issue one query per row.
- Query count scales linearly (or worse) with row count: 11 queries on 10 rows in dev becomes tens of thousands of queries on tens of thousands of rows in production.
- A query that runs in 2ms on 500 rows silently becomes a multi-second sequential scan on 2 million rows, with no error or warning.
- Every test passes throughout, because functional correctness says nothing about query plans.
- "Too many clients already" errors under traffic bursts on serverless deployments.
- Connection count scales directly with traffic when nothing pools connections, exhausting Postgres's default `max_connections=100`.

## Checks

### Code

```bash
# Await calls inside .map()/.forEach() over a query result — one DB round-trip per row is the N+1 signature
rg -n --type=ts --type=js -g '!node_modules' '\.(map|forEach)\(\s*async'
```
Bad result: any hit where the awaited call inside the callback is itself a DB read (`prisma.*.find*`, `.select(`, `supabase.from(...)`, a TypeORM/Sequelize relation load) rather than a plain transform — each iteration issues its own query instead of using `include`/`select`/a join.

```bash
# Relation chains accessed inside a loop/map — lazy-loaded relation per item (JS shown; same idiom exists in Rails' each/ActiveRecord and Django's for/ORM)
rg -n '\.(map|forEach)\([^)]*=>\s*[\w.]+\.\w+\.\w+' --type=ts --type=js -g '!node_modules'
```
Bad result: `o.customer.name`-style chains inside the callback — the relation almost certainly isn't eager-loaded, so it fires a query per row.

### Database

```sql
-- Foreign-key columns with no supporting index (the usual source of slow joins and sequential scans as tables grow)
SELECT c.conrelid::regclass AS table_name, a.attname AS column_name
FROM pg_constraint c
JOIN pg_attribute a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey)
  )
ORDER BY table_name;
```
Bad result: any row returned. That foreign key has no index behind it — lookups and joins on it do a sequential scan that gets slower as the table grows.

```sql
-- Top queries by call count (requires the pg_stat_statements extension; Supabase and most managed Postgres enable it by default)
SELECT calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms, left(query, 120) AS query
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 20;
```
Bad result: a handful of near-identical queries — differing only in a `WHERE id = $1` — accounting for a disproportionate share of `calls`. That's N+1 firing in production.

```sql
-- Connection headroom vs Postgres's ceiling
SHOW max_connections;
SELECT count(*) FROM pg_stat_activity;
```
Bad result: active connections regularly close to `max_connections`, or `max_connections` still at Postgres's default of 100 while the app deploys as serverless functions that can burst well past that in concurrent invocations.

### Infrastructure

```bash
# Does the DB connection string point at a pooler, or straight at Postgres? (Prisma/Node shown; check whatever env files your stack uses)
rg -n 'DATABASE_URL|POSTGRES_URL|DIRECT_URL' --glob '*.env*' -g '!node_modules'
```
Bad result: the host/port is the primary Postgres instance (port 5432, or a Supabase project's non-pooled host) rather than a pooler endpoint (PgBouncer on 6543, Supavisor, a `-pooler` hostname on Neon) — and the deployment target is serverless (Vercel, Fly, Lambda).

```bash
# Prisma-specific: an explicit connection_limit stops each serverless instance defaulting to a large pool of its own (Prisma-specific — check your ORM's equivalent pool-size setting otherwise)
rg -n 'connection_limit' prisma/schema.prisma .env* 2>/dev/null
```
Bad result: no match. Prisma then leaves each instance to open its own default-sized pool, and that multiplied across serverless concurrency exceeds `max_connections` fast.

## Questions to ask

- When did anyone last run `EXPLAIN ANALYZE` against production-sized data before shipping a change to this endpoint?
- Is the query budget enforced by something that fails the build, or is it a number someone glances at occasionally?
- If concurrent traffic doubled overnight, would the connection pool survive it, or would you learn about `max_connections` from a page?
- Are the indexes on this table there because someone observed the access pattern in production, or because they seemed reasonable at design time?
- Does the load test run against a dataset shaped like production, or the ten rows the seed script left behind?

## The fix

1. Put a connection pooler (PgBouncer, Supavisor, or your host's built-in equivalent) in front of Postgres — usually a connection-string swap (~30 min).
2. Run `EXPLAIN ANALYZE` on the slowest or most-hit endpoints against a production-scale dataset, not the seed data (~an afternoon).
3. Add indexes for the access patterns `EXPLAIN ANALYZE` actually surfaced, not guesses (~an afternoon, ongoing).
4. Wire a query-budget check into CI — Bullet, Django Debug Toolbar, or asserting query counts in Prisma test logs — so a PR that turns 1 query into 100 fails the build, not the pager (~a day).
5. Load-test with production-shaped data volumes before major releases, not the ten-row seed script (~ongoing practice).

## Guardrail

```
Never write a .map()/.forEach()/loop that dereferences a relation property per row — use include/select (Prisma), embedded resource selects (Supabase), or a single JOIN/batched query instead.
Every new foreign-key column ships with a supporting index in the same migration that creates it.
Every serverless or edge deployment connects to Postgres through a pooler (PgBouncer, Supavisor, or the host's equivalent) — never a raw direct connection string.
Before marking a data-fetching change complete, state the query count for that endpoint and confirm it does not scale with row count.
Seed data includes at least one table with 1,000+ rows so N+1 patterns and missing indexes show up in development, not production.
```

## Evidence from the wild

- [EffiBench](https://arxiv.org/pdf/2402.02037) benchmarked 42 LLMs on runtime efficiency against canonical human solutions: GPT-4-generated code ran roughly 3.1x slower on average, up to 13.9x slower with 43.9x more memory in worst cases — while passing every test.
- One engineer's widely shared write-up described identical code going from 11 queries and 10 rows in dev to 40,001 queries and 40,000 rows in production, passing every test the whole way — an individual account, not a corporate postmortem.
- Another engineer's write-up of an N+1 pattern surfacing at 50,000 users: a single page load issuing 12,847 queries, database CPU at 98%, connection pool exhausted — again an individual account, illustrative rather than a verified corporate incident.
- A separate write-up on an AI-generated pull request found 23 distinct N+1 patterns in one change, with a single endpoint issuing 847 SELECTs to render roughly 800 products — cited as an individual engineer's account.
- [Use The Index, Luke!](https://use-the-index-luke.com/) on indexing, and [Neon's connection pooling docs](https://neon.com/docs/connect/connection-pooling) on why serverless needs a pooler, are the reference material the original piece points to for the fix, not just the diagnosis.
