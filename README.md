# wont-scale

Companion audit kit for **[10 reasons why your vibe coded app won't scale](https://papa.onle.gs/writing/index.html)**.

The series explains why vibe-coded apps fail when real users arrive. This repo is the
part you can run: the ten reasons as audit modules with runnable checks, packaged as a
Claude Code plugin, standalone skills and agents, guardrail rules for every major AI
coding tool, and an interactive wizard that scopes your first audit to your actual
stakes — because a weekend prototype and an app moving real money should not get the
same list.

## Start in sixty seconds

**Claude Code** (the full experience):

```
/plugin marketplace add papaonlegs/wont-scale
/plugin install wont-scale@wont-scale
/first-audit
```

`/first-audit` interviews you (stakes, architecture, team), detects your stack, and
writes a prioritised plan. Then `/scale-audit` runs the checks and writes an
evidence-first report. This repo is private — your git credentials for it must work
(`gh auth setup-git` if the marketplace add fails).

**Any terminal** (no AI required):

```
git clone git@github.com:papaonlegs/wont-scale.git
node wont-scale/scripts/first-audit.mjs /path/to/your-app
```

Ten questions, every one with a flag for scripting (`--yes`, `--json`,
`--users=real --money=yes ...`). Writes `wont-scale.config.json` and a tailored
`FIRST-AUDIT.md` into your repo. Add `--install-claude` to copy the skills and agents
into your project's `.claude/`.

**Cursor / Copilot / Codex / Windsurf** — install the guardrails so the failures stop
being reintroduced:

| Tool | Copy | To |
|------|------|----|
| Any agent (AGENTS.md standard) | `templates/AGENTS.snippet.md` | your `AGENTS.md` (append) |
| Claude Code (manual) | same snippet | your `CLAUDE.md` (append) |
| Cursor | `templates/cursor-rules/wont-scale.mdc` | `.cursor/rules/` |
| GitHub Copilot | `templates/copilot-instructions.md` | `.github/copilot-instructions.md` (append) |
| Windsurf / Devin | `templates/windsurf-rules.md` | `.windsurf/rules/` |
| CI (PR gatekeeper) | `templates/ci/wont-scale-audit.yml` | `.github/workflows/` |

## The ten reasons

| # | Read the essay | Run the audit module |
|---|----------------|----------------------|
| 1 | [You have six data models and you think you have one](https://papa.onle.gs/writing/you-have-six-data-models.html) | [01-data-models](skills/scale-audit/references/01-data-models.md) |
| 2 | [40ms locally, 40 seconds in production](https://papa.onle.gs/writing/40ms-locally-40-seconds-in-production.html) | [02-query-performance](skills/scale-audit/references/02-query-performance.md) |
| 3 | [The login page is a prop](https://papa.onle.gs/writing/the-login-page-is-a-prop.html) | [03-authentication](skills/scale-audit/references/03-authentication.md) |
| 4 | [Authorisation is a vibe](https://papa.onle.gs/writing/authorisation-is-a-vibe.html) | [04-authorisation](skills/scale-audit/references/04-authorisation.md) |
| 5 | [Your frontend talks straight to the database](https://papa.onle.gs/writing/your-frontend-talks-to-the-database.html) | [05-trust-boundary](skills/scale-audit/references/05-trust-boundary.md) |
| 6 | [Nothing is idempotent and everything runs twice](https://papa.onle.gs/writing/nothing-is-idempotent.html) | [06-idempotency](skills/scale-audit/references/06-idempotency.md) |
| 7 | [It works on one box, and that's the whole problem](https://papa.onle.gs/writing/it-works-on-one-box.html) | [07-statelessness](skills/scale-audit/references/07-statelessness.md) |
| 8 | [You didn't write it and you can't see it either](https://papa.onle.gs/writing/you-cant-see-it-either.html) | [08-observability](skills/scale-audit/references/08-observability.md) |
| 9 | [Profitable at 100 users, bankrupt at 10,000](https://papa.onle.gs/writing/profitable-at-100-bankrupt-at-10000.html) | [09-unit-economics](skills/scale-audit/references/09-unit-economics.md) |
| 10 | [The bus factor isn't one, it's zero](https://papa.onle.gs/writing/the-bus-factor-is-zero.html) | [10-bus-factor](skills/scale-audit/references/10-bus-factor.md) |

Each module is the same shape: symptoms you can observe, checks you can run (read-only
shell and SQL), the questions a grep can't answer, the fix in priority order with honest
time boxes, a copy-paste guardrail for your AI tools, and the real incidents behind it.
The modules work standalone — paste one into any AI chat and ask it to run the checks
against your repo.

The short version is [the pre-scale checklist](audit/CHECKLIST.md): ten questions,
answer them out loud.

## What's in the box

| Mechanism | Where | What it does |
|-----------|-------|--------------|
| `/scale-audit` skill | [skills/scale-audit](skills/scale-audit/SKILL.md) | Runs the checks, grades findings (Critical / High / Advisory), writes `WONT-SCALE-REPORT.md`, diffs against the last run. Scope it: `/scale-audit tier1`, `/scale-audit 4`. |
| `/first-audit` skill | [skills/first-audit](skills/first-audit/SKILL.md) | The setup interview, inside Claude Code. |
| `scale-guardrails` skill | [skills/scale-guardrails](skills/scale-guardrails/SKILL.md) | Auto-loads the rules when you're coding near one of the ten. |
| `scale-auditor` agent | [agents/scale-auditor.md](agents/scale-auditor.md) | Read-only subagent for the full audit — delegate it and keep working. |
| `scale-gatekeeper` agent | [agents/scale-gatekeeper.md](agents/scale-gatekeeper.md) | Reviews your working diff against the ten before you merge. PASS / WARN / BLOCK, evidence required. |
| First-audit wizard | [scripts/first-audit.mjs](scripts/first-audit.mjs) | The interview for plain terminals. Zero dependencies, Node 18+. |
| Guardrail templates | [templates/](templates/) | The same rules for AGENTS.md, Cursor, Copilot, Windsurf, and CI. Generated from the modules — edit there. |

Two principles run through all of it. **Evidence first:** no finding without file:line
or query output, and a check that couldn't run is reported as "not verified", never as
a pass. **Stakes first:** everything is tiered, so the report tells you what to fix
before more users arrive — not everything that could theoretically be better.

## After the audit

The audit finds what's already wrong. The guardrails stop it coming back: they are
standing rules for the AI tools that wrote the code in the first place — every new
table gets a real policy, every webhook assumes duplicates, every metered endpoint
gets a cap. Install them once and the next generated feature starts from a better
default.

If you'd rather have a second pair of eyes on what you've shipped — that's exactly
what a [vibe code audit](https://papa.onle.gs) is for.

---

MIT licence. The essays remain © [Farouk Umar](https://papa.onle.gs). This repo is
shared privately; please don't republish it.
