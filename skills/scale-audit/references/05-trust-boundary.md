# 5 — Your frontend talks straight to the database

> Everything in the client is attacker-controlled — including the "validation."

**Article:** https://papa.onle.gs/writing/your-frontend-talks-to-the-database.html
**Applies to you if:** you use Supabase, Firebase, or any client SDK that talks straight to a database, or a client-submitted price, role, quantity, or admin flag ever reaches a write
**Tier:** T1 (before real users) — unauthenticated data access, not a scale problem
**First fix:** Enable Row Level Security with default-deny on every table, then fix what breaks (~an afternoon)

## What it is

In the default vibe-coded stack, there is no backend. Your browser talks straight to the database through a Supabase or Firebase SDK, and the only thing between an attacker and your data is a policy layer — RLS or security rules — that AI tools write fluently and get wrong just as fluently. This is a legitimate architecture in principle, but everything you ship to the client — prices, roles, quantities, the "validation" that looks like a check — is attacker-controlled, and one missing rule exposes the whole database. It stays invisible because at a dozen users nobody opens devtools; at fifty thousand, someone always does.

## Symptoms

- Prices, roles, quantities, or `isAdmin` flags are set or checked in client-side JavaScript.
- A Supabase or Firebase project URL and API key are hardcoded in the shipped JS bundle.
- Row Level Security has never been enabled on some (or any) tables.
- A paywall or access gate is enforced only in CSS, not on the server.
- Anyone can open devtools, find the key in the Network tab, and query the REST API directly within minutes.
- Tables named `payments`, `orders`, or `transactions` accept writes from anyone, not just authenticated owners.
- The app works fine at a dozen users, then becomes attackable the moment traffic — and attention — scales up.

## Checks

### Code

```bash
# Find Supabase/Firebase client SDK calls inside browser-rendered components rather than server-only code
rg -n "supabase\.(from|rpc|storage)\(|firebase/(firestore|database)" \
  --glob '*.tsx' --glob '*.jsx' --glob '!**/api/**' --glob '!**/server/**' --glob '!node_modules' .
```
Bad result: hits inside page or component files with no server route in between — the browser is querying the database directly, not through an API you control (grep pattern is Supabase/Firebase-specific; adapt the SDK names for your stack).

```bash
# Look for price, role, or admin flags read from client state/props that could flow into a write call
rg -n "(isAdmin|role|price|amount|quantity)\s*[:=].*\b(props|state|useState|searchParams)\b" \
  --glob '*.tsx' --glob '*.jsx' .
```
Bad result: any match where the value feeds straight into a `.insert()`, `.update()`, or fetch body with no corresponding server-side re-check nearby.

```bash
# Find access gates that hide content with a CSS/class toggle rather than blocking the request server-side
rg -n "className=.*\b(blur|hidden|locked)\b" --glob '*.tsx' --glob '*.jsx' -l | \
  xargs -I{} rg -l "premium|paywall|isPro|locked" {}
```
Bad result: any file where a "premium" or "locked" state only toggles a CSS class — the underlying data or action is still reachable by stripping the class or calling the API directly.

### Database

```sql
-- List every table in the public schema and whether Row Level Security is enabled (Postgres/Supabase)
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY rowsecurity ASC, tablename;
```
Bad result: any row with `rowsecurity = false`, especially `payments`, `orders`, `transactions`, or `users`.

```sql
-- Find policies that allow everything -- "USING (true)" or "WITH CHECK (true)" is not a policy
SELECT schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE qual = 'true' OR with_check = 'true';
```
Bad result: any row returned, especially on a sensitive table — RLS is switched on but restricts nothing.

```sql
-- Tables with RLS switched on but no policy attached at all -- nobody finished the job
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true
  AND NOT EXISTS (
    SELECT 1 FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname
  );
```
Bad result: any row returned — the table's real access behaviour was never decided, only assumed.

### Infrastructure

```bash
# Confirm a privileged service-role/admin key is never exposed to the browser bundle
grep -rnE "NEXT_PUBLIC_.*(SERVICE_ROLE|ADMIN|SECRET)" . --include=*.env* --include=*.ts --include=*.tsx 2>/dev/null
```
Bad result: any match — a privileged key given a client-exposed prefix, meaning it ships to every visitor's browser (`NEXT_PUBLIC_*` is Next.js's convention; check the equivalent public-var prefix for your framework).

```bash
# Check whether an API/BFF layer exists between browser and database at all
find . -type d \( -name "api" -o -name "server" -o -name "functions" \) -not -path "*/node_modules/*"
```
Bad result: nothing found — there is no server-side layer, meaning every data operation genuinely runs straight from the browser to the database.

## Questions to ask

- Does the browser hold a database credential that reaches every table, or a session token that reaches only what your API allows?
- Is RLS enabled on every table, or only the ones the team remembered?
- Where are price, quantity, role, and `isAdmin` actually enforced — client JavaScript, or a server that re-checks them?
- Has anyone opened devtools, copied the key out of the Network tab, and queried the REST API directly?
- If this runs on Supabase or Firebase, did anyone read the platform's own security-rules documentation, or just accept the defaults?

## The fix

1. Enable Row Level Security with a default-deny policy on every table today, and see what breaks (~an afternoon).
2. Grep the client bundle and source for a service-role or admin key, and for prices, roles, or `isAdmin` flags shipped to the browser (~1 hour).
3. Move any paywall or access gate that lives only in CSS into a server-side check (~an afternoon).
4. Put a backend-for-frontend / API layer between the browser and the database: the browser keeps only a short-lived session token, the server keeps the privileged credential (days, roll out per resource — see Microsoft's [Backends for Frontends pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends)).
5. Re-validate every client-submitted value — price, quantity, role, ownership — on the server before acting on it; never trust the client's copy (ongoing, enforce at code review).
6. If the app shipped fast with AI tools and has real users, get a second pair of eyes on it before adding more surface area (~half a day).

## Guardrail

```
Enable Row Level Security with a real policy on every new Supabase/Firebase table, in the same migration that creates it. `USING (true)` or `WITH CHECK (true)` is not a policy — write the actual condition.
Never place a privileged credential (service-role key, Firebase admin key, direct database connection string) in client-rendered code or a client-exposed env var (`NEXT_PUBLIC_*` or equivalent). Only a short-lived session token belongs in the browser.
Treat every value that arrives from the client — price, quantity, role, `isAdmin`, ownership — as attacker-controlled. Re-derive or re-validate it server-side before writing it; never act on the client's copy.
Never implement a paywall, access gate, or role check only in CSS or client-side JavaScript. The check must live on the server that performs the read or write.
Route all browser-to-database traffic through an API layer or server function that re-authenticates and re-authorises the request. The browser never talks straight to the database.
```

## Evidence from the wild

- Moltbook (January 2026) — Wiz researchers read the production JS bundle, found a hardcoded Supabase URL and key with RLS never enabled: roughly 1.5 million AI-agent API tokens and 65,000 emails, plus private agent messages, were exposed, and any agent could be taken over by anyone with the key. The founder confirmed the app was vibe-coded.
- The Firebase misconfiguration wave (January 2024) started when researchers registered on an AI hiring bot, Chattr, and got full database privileges just by signing up. Scanning further, they found roughly 900 misconfigured Firebase sites exposing 125 million-plus records, including more than 20 million plaintext passwords — years before "vibe coding" was a term, and the same failure AI tools now reproduce faster.
- leojr94's Cursor-built SaaS (March 2025): keys exposed client-side, a paywall enforced only in CSS, no server-side write validation. The founder's own "guys, i'm under attack" post went viral, and the app was shut down within five days.
- Escape.tech's scan of 5,600 vibe-coded apps traced 83% of exposures to Supabase RLS misconfiguration, including tables named `payments`, `orders`, and `transactions` left open to unauthenticated writes.
- GitGuardian's 2026 analysis found AI-assisted commits leak secrets at roughly twice the baseline rate — 3.2% versus 1.5%.
- Firebase's own [Security Rules documentation](https://firebase.google.com/docs/rules) states plainly: "clients aren't responsible for enforcing security."
