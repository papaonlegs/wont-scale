# The pre-scale checklist

Ten questions, one per reason. If you can answer all ten out loud, you are ahead of
almost every vibe-coded app in production. If one makes you look away, that's where
the audit starts.

1. Can you say, in one place, what a "user" is — and is it the only place?
2. Do you know how many queries your busiest endpoint makes per request?
3. If a session token leaked today, could you revoke it?
4. Can you show the policy that decides who sees what — without grepping handlers? Is RLS on?
5. What can an attacker reach with nothing but the keys in your JS bundle?
6. What happens when your payment webhook is delivered twice?
7. What breaks when you go from one instance to two?
8. Can you follow a single user's request across your whole system by one ID?
9. What does one request cost you — and who can make 10,000 of them?
10. Can you explain how it works? Then why did you merge it?

## Which of these matter first

**Tier 1 — before real users arrive:** 3, 4, 5, 6. These are the ones that become a
breach or a double charge, not a slowdown.

**Tier 2 — before scale or payments:** all ten. Run `/first-audit` (or
`node scripts/first-audit.mjs`) to get the order that fits *your* answers — a weekend
prototype and an app moving real money should not get the same list.

Each question has a full audit module — symptoms, runnable checks, fixes, and a
guardrail for your AI tools — in [`skills/scale-audit/references/`](../skills/scale-audit/references/),
and an essay-length answer in [the series](https://papa.onle.gs/writing/index.html).
