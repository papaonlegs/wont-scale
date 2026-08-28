# Report template

Write `WONT-SCALE-REPORT.md` in exactly this shape. Keep it scannable — the reader
should know their three worst problems inside thirty seconds.

```markdown
# Won't-Scale Audit — <project name> — <date>

**Stack:** <one line>
**Scope:** <all ten | tier1 | single reason | prioritised via wont-scale.config.json>
**Verdict in one line:** <e.g. "Two critical findings, both authorisation; everything else is schedulable.">

<If a previous WONT-SCALE-REPORT.md existed:>
**Since last audit (<date>):** <n> fixed, <n> new, <n> unchanged.

## Critical — fix before more users arrive

### [Reason <N> — <name>] <finding title>
- **Evidence:** `<file:line>` — <what was found, quoted or summarised>
- **Why it breaks:** <one or two sentences, concrete failure at scale>
- **First fix:** <smallest real step> (~<time>)
- **Read:** <article URL>

## High — fix before scale or payments

<same structure>

## Advisory — schedule it

<same structure, terser: one line of evidence + first fix each>

## Verified clean

- [Reason <N>] <what was checked and found sound — one line each>

## Not verified

- [Reason <N>] <which check could not run and why — missing DB access, unfamiliar stack, etc.>

## Suggested order of work

1. <finding> (~time)
2. ...
<Sum the times honestly. If the whole list is under a day, say so — that lands better
than it reading as a wall of debt.>
```

Rules:

- Findings sorted worst-first within each section.
- No finding without evidence. No severity inflation to make the report look thorough.
- Every finding cites its article — the report is also the reading list.
- British English. No emoji.
