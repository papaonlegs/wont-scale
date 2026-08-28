# 4 — Authorisation is a vibe

> "One missing WHERE org_id = ? isn't a bug, it's a data disclosure."

**Article:** https://papa.onle.gs/writing/authorisation-is-a-vibe.html
**Applies to you if:** you have more than one user, tenant, or org in your data — or ever will.
**Tier:** T1 (before real users) — one more tenant is all it takes.
**First fix:** enable RLS on every table holding tenant or user data, even before the policies are perfect (~30 min for a small schema).

## What it is

You didn't write forty consistent authorisation checks. You generated forty endpoints, one prompt at a time, and each one got its own interpretation of who's allowed to do what. On Supabase or Postgres this gets sharper: Row Level Security is opt-in and off by default, so an app can ship with no enforcement beyond whatever each handler happens to check. A missing tenant predicate on a multi-tenant query isn't a logic bug — it's a data disclosure. It stays invisible in the demo, because the founder is the only row in the table, and surfaces only once a second tenant's data sits next to the first.

## Symptoms

- Every endpoint checks permissions differently, and "who's allowed to do this" has no single answer
- Answering "who can see this record?" means grepping the codebase, not reading a policy
- Multi-tenant queries missing a consistent `WHERE org_id = ?` (or equivalent) predicate
- Row Level Security is disabled on some or all Supabase/Postgres tables holding tenant data
- Where RLS is enabled, some policies read `USING (true)` — allow everything
- Demo or seed data has only one tenant, so a cross-tenant leak has nowhere to show itself
- The Supabase anon key is the only thing standing between the browser and the whole database, and nobody has audited what it can reach
- A "security scan" exists that checks whether a table has *a* policy, not whether the policy is correct

## Checks

### Code

```bash
# Find inline authorisation logic written directly in handlers (role/permission checks scattered per-file)
rg -n "if\s*\(.*\b(role|permission|isAdmin|is_admin)\b" --type ts --type js -g '!**/node_modules/**'
```
Bad result: matches scattered across many route/handler files instead of concentrated in one shared policy module. (Assumes a JS/TS backend — swap the `--type` flags for your language.)

```bash
# Find Prisma/Supabase-style queries with no visible tenant filter nearby
rg -n "\.(findMany|findFirst|select)\(" --type ts -A2 | rg -v "org_id|orgId|tenant_id|tenantId|user_id|userId"
```
Bad result: query calls with no org/tenant/user filter in the surrounding lines — a candidate for cross-tenant leakage. (Prisma/Supabase-JS query names shown; grep your ORM's own method names if different.)

```bash
# Look for one shared policy/authz module that handlers actually import
rg -l "from ['\"].*/(policy|authz|permissions|abac|rbac)" --type ts --type js
```
Bad result: zero or near-zero matches despite dozens of handlers doing permission checks — nothing centralised for any of them to call into.

```bash
# Confirm the policy/authz layer has its own test suite, independent of feature tests
rg -l "describe\(.*\b(polic|authz|permission)" -g '*.test.*' -g '*.spec.*'
```
Bad result: no matches. Feature tests passing tells you the feature works, not that access control does.

### Database

```sql
-- Tables with Row Level Security disabled (Postgres/Supabase)
SELECT schemaname, tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND rowsecurity = false;
```
Bad result: any table listed that holds tenant, user, or billing data.

```sql
-- RLS policies with an always-true predicate — allow everything
SELECT schemaname, tablename, policyname, cmd, qual
FROM pg_policies
WHERE qual = 'true';
```
Bad result: any row returned. `USING (true)` is not a policy — it's RLS with the lock removed. (Postgres/Supabase-specific: `pg_policies` and `rowsecurity` are Postgres system catalogs; other databases expose row-level security differently.)

```sql
-- Policies that grant access to the anon (unauthenticated) role
SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies
WHERE 'anon' = ANY(roles);
```
Bad result: any policy here that isn't deliberately public. Anyone holding the public anon key can exercise it. (Supabase's `anon`/`authenticated` role model — adapt for other RLS setups.)

### Infrastructure

```bash
# Confirm where the Supabase anon/public key is referenced in the codebase
rg -n "SUPABASE_ANON_KEY|NEXT_PUBLIC_SUPABASE" -g '!*.test.*' -g '!node_modules'
```
Bad result: the anon key is used anywhere without RLS confirmed enabled on the tables it can reach (see Database checks above) — the anon key is public by design; RLS is the only wall behind it. (Supabase-specific — on Firebase check `firestore.rules`/`storage.rules` instead; if a server API sits in front of Postgres and the client never talks to the database directly, this check doesn't apply.)

## Questions to ask

- If you're asked "who can see this record?", can you answer without grepping the codebase?
- Does your demo or seed data include more than one tenant — enough for a cross-tenant leak to actually show up before a customer finds it?
- If an auditor asked for your access-control policy tomorrow, could you hand over one artefact, or forty handlers?
- Is RLS the only thing standing between your anon key and the whole database, and has anyone actually checked what it lets through?
- Do all your endpoints enforce authorisation the same way, or did each one get reasoned about — and forgotten about — independently?

## The fix

1. Enable RLS on every table holding tenant or user data, even with an imperfect starter policy — off is a fully open table, not a strict one (~30 min for a small schema).
2. Replace every `USING (true)` policy with a real predicate scoped to the authenticated user or org (~1–2 hours, depending on table count).
3. Add a second tenant to your demo and seed data, so a missing predicate fails a test instead of shipping (~30 min).
4. Build one policy layer — a shared module, or a coherent RLS policy set — and route every handler through it instead of deciding access inline (an afternoon for the core paths).
5. Write tests against the policy layer itself, independent of any feature, so authorisation has its own pass/fail (an afternoon).

## Guardrail

```
Enable Row Level Security and add a real policy on every new table, in the same migration. `USING (true)` is not a policy.
Never write an authorisation check inline inside a handler. Call the shared policy layer; if it has no rule for this case yet, add one before adding the endpoint.
Add an explicit tenant filter (org_id or equivalent) to every multi-tenant query. Never rely on RLS alone as the only enforcement point.
Always include at least two tenants in seed and test fixtures, so a missing tenant filter fails a test before it reaches production.
Do not build or accept a "security check" that only confirms a policy exists. Confirm what the policy allows.
```

## Evidence from the wild

- [CVE-2025-48757](https://nvd.nist.gov/vuln/detail/CVE-2025-48757) ("the Lovable curse") — found by Matt Palmer and Kody Low in March 2025 via a Lovable-built app. A scan of 1,645 public Lovable apps found 303 vulnerable endpoints across 170 projects (10.3%), CVSS 9.3, exposing emails, addresses, payment details, and API keys. Lovable's first response was denial, then deleted tweets, before it shipped a scanner that checks whether a policy exists on a table — not whether it's correct.
- [OWASP A01:2021](https://owasp.org/Top10/A01_2021-Broken_Access_Control/) ranks Broken Access Control the #1 web risk, found in 94% of tested applications.
- One vendor audit found 88% of 50 vibe-coded apps sampled had RLS disabled entirely — one audit's finding, not an industry rate.
- The same bug shape predates AI: First American Financial (2019, 885 million title documents exposed via sequential-ID IDOR), Parler (2021, 70TB scraped via unauthenticated sequential IDs), and the [2022 Optus breach](https://en.wikipedia.org/wiki/2022_Optus_data_breach) (9.8 million customers, via an unauthenticated API on a forgotten legacy domain).
