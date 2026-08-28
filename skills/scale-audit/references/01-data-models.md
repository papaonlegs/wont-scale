# 1 — You have six data models and you think you have one

> Ask your codebase what a "user" is. Count the answers.

**Article:** https://papa.onle.gs/writing/you-have-six-data-models.html
**Applies to you if:** you have more than one table that could plausibly answer "what is a user" — `users`, `accounts`, `profiles`, `members`, or similar
**Tier:** T1 (before real users) — costs compound with every row written
**First fix:** list every table that could answer "what is a user", and who queries each one (~1 hour)

## What it is

Every feature request is a fresh prompt with no memory of the table you invented three prompts ago for the same concept, so you end up with `users`, then `accounts`, then `profiles`, then `members` — each authored in isolation, each looking authoritative from inside its own feature. Nothing forces them to agree, so they don't: you "join" them by matching an email string in application code instead of a real foreign key. It stays invisible while you're the only row in every table, and becomes your data model the day a customer cancels in one table and stays active in another.

## Symptoms

- Multiple tables represent the same concept — `users`, `accounts`, `profiles`, `members` — with no single one clearly authoritative
- Each table was added by a different feature request, not a schema decision
- Tables are "joined" by matching strings like email in application code, not real foreign keys
- No foreign key constraints between tables you'd expect to be related
- A user cancels in one table and stays "active" in another
- A permission or entitlement check reads whichever table someone remembered to update, not a guaranteed-authoritative one
- Copy-pasted code is overtaking refactored code in recent commits — the same habit, one level down, at the code layer
- Migration history shows renames or column drops in place rather than staged expand/contract steps

## Checks

### Code

```bash
# Find every model/table definition whose name suggests it represents a "user"
rg -in '(class|model|table)\s+\w*(user|account|profile|member)\w*' \
  --glob '*.{ts,js,py,rb,prisma,sql}' -g '!node_modules' -g '!dist'
```
Bad result: more than one distinct model name (User, Account, Profile, Member), each with its own id, email, or status column.

```bash
# Find app-code lookups joining records by matching an email string
# instead of a foreign key (adjust the field list for your domain)
rg -in '\.(where|filter|find\w*)\(.{0,50}email' \
  --glob '*.{ts,js,py,rb}' -g '!node_modules'
```
Bad result: a match spans two different models/tables — e.g. looking up an `Account` by the `email` on a `User` object rather than by `account.user_id`.

```bash
# List migrations and flag ones that rename or drop in place rather than
# staging expand/dual-write/backfill/contract (Prisma/Supabase/raw SQL layouts)
find . -type d \( -name migrations -o -name migrate \) -not -path '*/node_modules/*' \
  -exec ls -1 {} \;
rg -in 'RENAME (COLUMN|TABLE)|DROP (COLUMN|TABLE)' \
  -g '*migrat*/**/*.sql' -g '*migrat*/**/*.ts' -g '!node_modules'
```
Bad result: a rename or drop with no earlier "expand" migration that added the new column/table alongside the old one first.

### Database

```sql
-- List tables whose columns suggest they represent a "user"/"account"/
-- "profile"/"member" concept (Postgres; adjust schema name for Supabase)
SELECT table_name,
       string_agg(column_name, ', ' ORDER BY ordinal_position) AS columns
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name ~* '(user|account|profile|member)'
GROUP BY table_name
ORDER BY table_name;
```
Bad result: more than one table comes back, especially if two or more carry their own `email` or `password_hash` column.

```sql
-- Find identity-shaped columns (e.g. email) duplicated across tables —
-- a candidate for string-matched joins instead of foreign keys
SELECT column_name, array_agg(table_name ORDER BY table_name) AS tables
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name IN ('email', 'user_email', 'owner_email')
GROUP BY column_name
HAVING count(*) > 1;
```
Bad result: the same identity column exists on two or more tables.

```sql
-- List every real foreign key relationship in the schema (Postgres)
SELECT tc.table_name AS from_table, kcu.column_name AS from_column,
       ccu.table_name AS to_table, ccu.column_name AS to_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
ORDER BY from_table;
```
Bad result: none of the tables flagged by the first query appear here at all — they exist side by side with no enforced relationship, only convention.

### Infrastructure

```bash
# Check whether migration commands are environment-gated or just run
# against whatever DATABASE_URL happens to be exported (Resend-style risk)
rg -n 'migrate (deploy|dev|reset)|prisma migrate|supabase db push' \
  package.json Makefile scripts/*.sh 2>/dev/null
```
Bad result: a single generic `migrate` script with no `--env` flag, confirmation step, or distinct production credential — it runs against whichever database the shell happens to be pointed at.

## Questions to ask

- What is a "user" in this codebase, and how many tables would each give a different answer?
- Are related tables joined by real foreign keys, or by matching strings like email in application code?
- When did a status last disagree across tables — a cancelled user still "active" somewhere else?
- What fraction of recent commits refactor an existing table versus add a new one next to it?
- Did the last schema migration expand and contract in stages, or rename in place while everyone held their breath?

## The fix

1. Ask the codebase what a "user" is; list every table that could answer, and who reads each one (~1 hour)
2. Author one canonical model per core entity — apply Codd's normal forms so each fact is stored exactly once — and write down the ubiquitous language (Evans) so engineers and AI tooling share the same names (~half a day)
3. Add the missing foreign keys wherever tables are currently joined by matching a string like email (an afternoon per relationship, longer if the data is dirty)
4. Migrate via staged steps, never a rename in place: expand (add the new table, keep old ones live) → dual-write → backfill → migrate reads → migrate writes → contract (drop the old tables) (days to weeks depending on table size)
5. Decouple deploying the migration code from releasing the behaviour that depends on it
6. Get a second pair of eyes on the model before building further features on top of it

## Guardrail

```
Before creating a new table or model, grep the schema for existing tables that could represent the same entity (user, account, profile, member) and extend one of those instead of adding a new one.
Never join two tables by matching a string field like email in application code. Every relationship gets a real foreign key with a constraint, added in the same migration as the tables it relates.
Never rename or drop a column or table against a database holding real data in a single migration. Use expand (add new) → dual-write → backfill → migrate reads → migrate writes → contract (drop old), one migration per step.
Any migration command capable of targeting production requires an explicit environment flag or distinct credentials. It must never default to whatever DATABASE_URL happens to be set in the shell.
When asked to add a "user"-like concept, check the ubiquitous-language doc for the existing canonical name before inventing a new table.
```

## Evidence from the wild

- GitClear's analysis of 211 million changed lines (2020–2024) found copy-pasted code overtook refactored code for the first time on record in 2024, with refactoring falling under 10% of changes; a 2026 follow-up covering 623 million changes put refactoring at 3.8%.
- GitHub, November 2021: one schema migration (`ALTER TABLE`) cascaded into a replica crash-loop that took down Actions, the API, and pull requests.
- Resend, 21 February 2024: a migration command meant for a local database ran against production instead, dropping every table in production for twelve hours, per the company's own incident report.
- Codd's relational normal forms and Eric Evans' "ubiquitous language" remain the standard prescriptions for this exact problem — see [Database normalization](https://en.wikipedia.org/wiki/Database_normalization).
