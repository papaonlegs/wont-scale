# wont-scale — contributor notes

This repo is the companion audit kit for the series "10 reasons why your vibe coded
app won't scale" (https://papa.onle.gs/writing/index.html). If you are reading this
inside a Claude Code session opened on the kit itself, you are editing the kit — the
audit tools are meant to be *installed* into other projects (see README).

Editing rules:

- `skills/scale-audit/references/*.md` (the ten modules) are the canonical content.
  Every module follows the exact template — heading set, order, fact-check rules —
  described in the modules themselves; keep new content consistent with the others.
- The Guardrail blocks inside the modules are the single source of truth for
  `skills/scale-guardrails/SKILL.md` and everything in `templates/`. If you change a
  Guardrail block, regenerate the aggregates with `node scripts/assemble-guardrails.mjs`
  rather than editing them by hand.
- Fact-check discipline is non-negotiable: no invented incidents, no marketing
  statistics, flagged claims stay out (see any module's Evidence section for the
  citation style).
- British English throughout. No emoji. The voice is a sharp colleague, not a scold.
- Validate before committing: `claude plugin validate .` and
  `node scripts/first-audit.mjs --yes --no-write .`
