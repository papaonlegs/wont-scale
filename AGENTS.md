# wont-scale — contributor notes

This repo is the companion audit kit for the series "10 reasons why your vibe coded
app won't scale" (https://papa.onle.gs/writing/index.html). If you are reading this
inside a Claude Code session opened on the kit itself, you are editing the kit — the
audit tools are meant to be *installed* into other projects (see README).

Editing rules:

- `skills/scale-audit/references/*.md` (the ten modules) are the canonical content.
  Every module follows the exact template — heading set, order, fact-check rules —
  described in the modules themselves; keep new content consistent with the others.
- The kit is authored in TypeScript under `scripts/` and shipped as compiled JavaScript in `dist/`. Run `npm install` once (its `prepare` step builds `dist/`), and `npm run build` after changing any `.ts`. Typecheck with `npm run typecheck` and test with `npm test` (both need Node 22.6+ to run the TypeScript directly).
- The Guardrail blocks inside the modules are the single source of truth for every generated guardrail surface (templates/AGENTS.snippet.md, the on-demand per-tool variants, and the two agent fallbacks). If you change a Guardrail block, regenerate the aggregates with `node dist/assemble.js --all`
  rather than editing them by hand.
- Fact-check discipline is non-negotiable: no invented incidents, no marketing
  statistics, flagged claims stay out (see any module's Evidence section for the
  citation style).
- British English throughout. No emoji. The voice is a sharp colleague, not a scold.
- Validate before committing: `npm run typecheck`, `npm test`, `claude plugin validate .`, and
  `node dist/first-audit.js --yes --no-write .`
