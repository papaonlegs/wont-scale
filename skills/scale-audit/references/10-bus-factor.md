# 10 — The bus factor isn't one, it's zero

> The bus factor doesn't count down from some healthy number.

**Article:** https://papa.onle.gs/writing/the-bus-factor-is-zero.html
**Applies to you if:** you've merged code you can't explain end-to-end without re-reading it — which is most vibe-coded apps past the first few files.
**Tier:** T1 (before real users) — it removes your ability to fix the rest.
**First fix:** adopt one rule — if you can't explain how it works, you don't merge it — and put it in your PR checklist today (~15 min to write down, then a habit you enforce).

## What it is

A program is a theory held by the people who built it — Peter Naur's phrase. Code and docs are a trace of that theory, not the theory itself: hand-written software still forms one somewhere, because you sat with the problem long enough to make the calls yourself. Vibe-coded software often never forms a theory at all: the architectural intent lived in the prompt, and you discarded the prompt the moment the code merged. It stays invisible while you're still around and the last few prompts are still fresh in your head, and turns into an archaeology problem the day you return to the code six months later, or someone else has to.

## Symptoms

- Nobody on the team, including whoever shipped it, can explain how the system works without re-reading the code
- Code review has degraded into "looks plausible", not a re-derivation of what the code should do
- Reviewers trust AI output because it "looks authoritative" — automation bias survives even careful adversarial review
- Six months later you're an archaeologist in a codebase with your own name on every commit
- Tests confirm what the code does, not what it should do — the same confirmation bias as generated docs, wearing a green checkmark
- High test coverage sits next to low confidence — a false sense of security, not a safety net
- Nobody can explain how the data model got tangled, or why the queue isn't idempotent
- Architectural decisions, where they were made at all, live only in a chat transcript or a prompt nobody kept

## Checks

### Code

```bash
# Look for any architecture decision records in the repo
find . -type d \( -iname 'adr' -o -iname 'adrs' -o -iname 'decisions' \) -not -path '*/node_modules/*'
rg -l -i '^Status:\s*(accepted|proposed|rejected|superseded|deprecated)' --glob '*.md' -g '!node_modules'
```
Bad result: both commands return nothing, on a codebase old enough to have made a real structural call — a new service, a new datastore, an auth rewrite, a queue.

```bash
# Find a system narrative doc, and compare its age to the most recent code change
find . -maxdepth 3 \( -iname 'ARCHITECTURE.md' -o -iname 'SYSTEM.md' -o -iname 'ONBOARDING.md' \) -not -path '*/node_modules/*'
git log -1 --format='doc last touched: %ar' -- ARCHITECTURE.md docs/ARCHITECTURE.md 2>/dev/null
git log -1 --format='code last touched: %ar' -- src app 2>/dev/null
```
Bad result: no narrative doc exists at all, or its last commit is months older than the most recent commit under `src`/`app` — the doc stopped being true a while ago. (Path names assume a typical Next.js/Node layout — adjust for yours.)

```bash
# Check whether prompts/specs used to generate code are kept anywhere, or actively excluded from version control
find . -maxdepth 2 -type d \( -iname 'prompts' -o -iname 'specs' -o -iname '.claude' -o -iname '.cursor' \) -not -path '*/node_modules/*'
rg -n 'prompts?/|specs?/|\.claude/|\.cursor/' .gitignore 2>/dev/null
```
Bad result: no prompts/specs directory exists, and/or `.gitignore` explicitly excludes the tool directories that would have held them — the reasoning behind the code was never kept, or was thrown away on purpose.

```bash
# Count how many of the last 20 commits have no body explaining why, only a subject line
empty=0
for h in $(git log -20 --format=%H); do
  git log -1 --format=%b "$h" | grep -q '[^[:space:]]' || empty=$((empty+1))
done
echo "$empty of 20 recent commits have no body"
```
Bad result: most commits have no body — the subject line is the only record of intent, and it rarely says why.

```bash
# Look for boundary/contract tests kept separately from implementation-adjacent unit tests
find . -type d \( -iname 'contract*' -o -iname 'integration*' -o -iname 'e2e*' -o -iname 'acceptance*' \) -not -path '*/node_modules/*'
```
Bad result: nothing found — every test in the repo is a unit test colocated with the implementation it tests, so nothing verifies behaviour independently of the same prompt that wrote the code.

### Database

```sql
-- Tables with no documented purpose in the schema itself (Postgres; Supabase uses the same catalog)
SELECT c.relname AS table_name,
       obj_description(c.oid, 'pg_class') AS table_comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY table_comment IS NULL DESC, table_name;
```
Bad result: most or all rows show `table_comment` as null — the schema records what things are called, never why they're shaped that way.

```sql
-- Column-level documentation coverage, same idea at finer grain (Postgres/Supabase)
SELECT count(*) FILTER (WHERE col_description(pgc.oid, a.attnum) IS NOT NULL) AS documented,
       count(*) AS total_columns
FROM pg_attribute a
JOIN pg_class pgc ON pgc.oid = a.attrelid
JOIN pg_namespace n ON n.oid = pgc.relnamespace
WHERE n.nspname = 'public' AND pgc.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped;
```
Bad result: `documented` is at or near zero out of `total_columns` — not one column in the schema says why it exists.

## Questions to ask

- If the person who shipped this feature left tomorrow, who could maintain it with confidence — and how would you find out you were wrong?
- When your review process approves an AI-generated PR, did the reviewer re-derive what the code should do, or just decide it looked plausible?
- Were your tests written independently of the prompt that generated the code, or do they share its blind spots?
- Are the prompts and specs that produced your current codebase kept anywhere, or did they die the moment each PR merged?
- Can any engineer on your team explain how this system works end-to-end without re-opening the code?

## The fix

1. Adopt the merge rule today: if you, or the reviewer, can't explain how a change works, it doesn't merge — write it into your PR template or checklist (~15 min to write down, then a habit you enforce every PR).
2. Start writing ADRs for structural decisions going forward — a new service, a new datastore, an auth rewrite, a schema redesign, a change to how a queue behaves (~30 min per decision; retrofit the three or four biggest existing ones over the next week).
3. Write one system narrative document a new engineer reads on day one — what the system does, why it's shaped the way it is, what's expected to change (~half a day for a first draft).
4. For new features, write the specification, acceptance criteria, and boundary contract yourself before generating implementation code, and let the agent fill in unit tests underneath that boundary (~an hour per feature, ongoing).
5. Keep the prompts and specs that produced merged code — in the PR description, a specs folder, wherever — so the reasoning survives past merge, not just the output (~10 min per PR, ongoing).

## Guardrail

```
Before merging any change, the author must be able to explain how it works in their own words. If they can't, it does not merge — no exception for AI-generated code.
When you generate a structural or architectural change (new service, new datastore, new external dependency, schema redesign, a change to queue or job behaviour), write or update an ADR in the same change. The decision and the code land together.
Never discard the prompt or spec that produced a change. Include it in the PR description or commit message in full, not summarised.
Do not write contract or acceptance tests from the same prompt as the implementation they verify. If hand-written boundary tests do not already exist for the area you are touching, write them, or ask for them, before adding unit tests underneath.
When reviewing AI-generated code, re-derive what it is supposed to do from the spec or ADR before judging whether it looks correct. "Looks plausible" is not a review.
```

## Evidence from the wild

- Peter Naur's 1985 paper "[Programming as Theory Building](https://pages.cs.wisc.edu/~remzi/Naur.pdf)" is the thesis this module rests on: a program is a theory in the builders' heads, and code is only ever a trace of it.
- METR's randomised controlled trial (July 2025, [metr.org](https://metr.org)) had 16 experienced open-source developers complete 246 real tasks with Cursor and Claude. AI use made them 19% slower — while they had forecast being 24% faster, and believed afterward they'd been roughly 20% faster.
- DORA's 2024 State of DevOps report ([dora.dev](https://dora.dev)) found a 25% increase in AI adoption correlated with a 1.5% drop in throughput and a 7.2% drop in delivery stability — individual flow feels great, the shared system degrades.
- A comprehension quiz cited by Addy Osmani ([addyosmani.com](https://addyosmani.com)) found engineers who used AI to generate code scored 50% on questions about that code's behaviour, against 67% for engineers who used AI for Q&A only while writing the code themselves.
- GitClear's analysis found refactoring fell from 25% to under 10% of changed lines between 2021 and 2024, duplicated five-plus-line blocks rose eightfold, and cross-file reuse dropped 35% — a codebase getting less understood over time, not more.
- Developer surveys put the trust gap plainly: 96% of developers say they don't fully trust AI-generated code, yet only 48% consistently verify it before merging — the gap between suspicion and action is where this module lives.
