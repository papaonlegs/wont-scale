# wont-scale

Companion audit kit for **[10 reasons why your vibe coded app won't scale](https://papa.onle.gs/writing/index.html)**.

The series explains why vibe-coded apps fail when real users arrive. This repo is the
part you can run — two ways in.

## Audit your repo now

One command runs an interactive session: it detects your stack and your AI CLI, drives
that CLI through the ten reasons, writes an evidence-first report, and offers to apply
the first fix — with the diff shown and your say-so before anything changes.

```
curl -fsSL https://github.com/papaonlegs/wont-scale/releases/latest/download/install.sh | sh
```

Prefer to read it before you run it (you should):

```
curl -fsSL https://github.com/papaonlegs/wont-scale/releases/latest/download/install.sh -o install.sh
less install.sh          # the published SHA-256 is in the release notes
sh install.sh /path/to/your-app
```

**What leaves your machine:** the audit sends the code it reads to *your own* AI CLI's
model provider (Anthropic for Claude Code, OpenAI for Codex). If this is a work repo,
that is your employer's or customers' code — the session tells you before it probes, and
warns you when secret-bearing files are present. Nothing is stored by this tool. No AI
CLI on the machine? The session runs a lighter mechanical check and hands you the report
plus the deeper prompts to run yourself.

## Or browse the kit

The whole audit is here to read and take. Every reason is a module with symptoms you can
observe, checks you can run (read-only shell and SQL), the questions a grep can't answer,
the fix in priority order, a copy-paste guardrail for your AI tools, and the real
incidents behind it.

**Claude Code plugin:**

```
/plugin marketplace add papaonlegs/wont-scale
/plugin install wont-scale@wont-scale
/first-audit
```

`/first-audit` interviews you and writes a prioritised plan; `/scale-audit` runs the
checks and writes the report.

**Plain terminal wizard** (no AI required):

```
git clone https://github.com/papaonlegs/wont-scale.git
cd wont-scale && npm install          # builds the kit; Node 18+
node dist/first-audit.js /path/to/your-app
```

Ten questions, every one with a flag for scripting (`--yes`, `--json`,
`--users=real --money=yes ...`). Writes `wont-scale.config.json` and a tailored
`FIRST-AUDIT.md` into your repo.

**Guardrails for Cursor / Copilot / Codex / Windsurf** — install them so the failures
stop being reintroduced:

| Tool | Command / copy | To |
|------|----------------|----|
| Any agent (AGENTS.md standard) | `templates/AGENTS.snippet.md` | your `AGENTS.md` / `CLAUDE.md` (append) |
| Cursor | `node dist/assemble.js --guardrails --tool cursor` | `.cursor/rules/wont-scale.mdc` |
| GitHub Copilot | `node dist/assemble.js --guardrails --tool copilot` | `.github/copilot-instructions.md` (append) |
| Windsurf / Devin | `node dist/assemble.js --guardrails --tool windsurf` | `.windsurf/rules/wont-scale.md` |
| CI (PR gatekeeper, optional) | `docs/ci/wont-scale-audit.yml` | `.github/workflows/` |

The tool-specific variants are generated on demand from the ten modules rather than committed, so there is one source of truth to keep current.

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
| Guardrail generator | [scripts/assemble.ts](scripts/assemble.ts) | One canonical snippet (`templates/AGENTS.snippet.md`) plus on-demand tool-specific variants — `node dist/assemble.js --guardrails --tool cursor`. All generated from the ten modules. |
| `scale-auditor` agent | [agents/scale-auditor.md](agents/scale-auditor.md) | Read-only subagent for the full audit — delegate it and keep working. |
| `scale-gatekeeper` agent | [agents/scale-gatekeeper.md](agents/scale-gatekeeper.md) | Reviews your working diff against the ten before you merge. PASS / WARN / BLOCK, evidence required. |
| Audit session | [scripts/audit-session.ts](scripts/audit-session.ts) | The curl-installed session: detect, disclose, drive the AI CLI, report, consented fix. `--no-drive` runs the fast mechanical report. |
| First-audit wizard | [scripts/first-audit.ts](scripts/first-audit.ts) | The scoping interview for plain terminals. No runtime dependencies, Node 18+. |
| Guardrail generator | [scripts/assemble.ts](scripts/assemble.ts) | Everything the audit says is generated from the ten modules — guardrail variants, drive prompts, the reason index. One source of truth; edit the modules, run `--all`. |

Two principles run through all of it. **Evidence first:** no finding without file:line
or query output, and a check that couldn't run is reported as "not verified", never as
a pass. **Stakes first:** everything is tiered, so the report tells you what to fix
before more users arrive — not everything that could theoretically be better.

**Moved recently:** the tool-specific guardrail files (`templates/cursor-rules/`,
`templates/copilot-instructions.md`, `templates/windsurf-rules.md`) and the
`scale-guardrails` skill are no longer committed — they're generated on demand from the
modules. Regenerate any one with `node dist/assemble.js --guardrails --tool <cursor|copilot|windsurf>`.
The CI template moved to [`docs/ci/`](docs/ci/wont-scale-audit.yml).

## After the audit

The audit finds what's already wrong. The guardrails stop it coming back: they are
standing rules for the AI tools that wrote the code in the first place — every new
table gets a real policy, every webhook assumes duplicates, every metered endpoint
gets a cap. Install them once and the next generated feature starts from a better
default.

If you'd rather have a second pair of eyes on what you've shipped — that's exactly
what a [vibe code audit](https://papa.onle.gs) is for.

---

MIT licence. The essays remain © [Farouk Umar](https://papa.onle.gs).
