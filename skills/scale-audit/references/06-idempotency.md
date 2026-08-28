# 6 — Nothing is idempotent and everything runs twice

> The happy path is the only path your app was written for.

**Article:** https://papa.onle.gs/writing/nothing-is-idempotent.html
**Applies to you if:** you have webhooks, background jobs, a queue, or any POST/write endpoint a client or user can retry.
**Tier:** T1 (before real users) — your first user can trigger this
**First fix:** Add a database unique constraint on your highest-risk write path, e.g. `orders.stripe_event_id` (~30 min)

## What it is

Every write handler in your app assumes it executes exactly once, but load balancers time out and get retried, webhook providers redeliver on a schedule, queues redeliver on ack failure, and users double-click submit. None of that is broken infrastructure — SQS, Kafka, Stripe, GitHub, and every browser default to at-least-once delivery on purpose; exactly-once delivery over an unreliable network is a provable impossibility, not an engineering gap someone forgot to close. On a dev machine handling one request at a time, duplicates almost never surface; under real traffic and real network flakiness, they become routine. The bug is code that was never written to expect them.

## Symptoms

- A charge succeeds on the backend, but the load balancer times out before the response reaches the client — the user retries and pays twice.
- A webhook handler finishes successfully but slowly, and still gets a duplicate delivery because it missed the provider's response-time window.
- A queue consumer (SQS, Kafka) reprocesses a message it already handled — a second confirmation email, a second inventory decrement.
- Users double-click checkout/submit and generate two write operations for one intended action.
- A write handler's first executable line is the mutation itself — no lookup, no guard check, no idempotency key — before it touches the database or a payment API.
- No table in the schema records which webhook or queue events have already been processed.

## Checks

### Code

```bash
# Find where the codebase already handles idempotency keys (client-supplied header or event-derived)
rg -n -i 'idempotency' -g '*.{ts,tsx,js,jsx}' -g '!node_modules' .
```
Bad result: no matches anywhere, in a codebase that has payment, webhook, or queue-consumer endpoints.

```bash
# List POST/webhook route handlers so you can check whether the first lines are a guard/dedup lookup or the mutation itself
rg -n -A4 "export (async )?function POST|app\.post\(|router\.post\(" -g '*.{ts,tsx,js,jsx}' -g '!node_modules' .
```
Bad result: a handler whose first executable statement is the charge, insert, or email call, with no lookup before it.

```bash
# Find Stripe write calls and check whether idempotencyKey is passed in the request options
rg -n -A3 "stripe\.(charges|paymentIntents|subscriptions|checkout\.sessions)\.(create|update)\(" -g '*.{ts,tsx,js,jsx}' -g '!node_modules' .
```
Bad result: a matched call with no `idempotencyKey` in its options object. (Stripe-specific — swap for your processor's equivalent parameter if you use a different one.)

```bash
# Find queue consumers and check whether they look up a processed-message record before acting
rg -n -i "receiveMessage|sqsClient|consumer\.on\(.message|kafka.*[Cc]onsumer" -g '*.{ts,js}' -g '!node_modules' .
```
Bad result: a consumer callback that performs its side effect immediately, with no check against a processed-messages store. (Only applicable if you run a queue.)

### Database

Postgres-flavoured; the same queries work on Supabase since it's plain Postgres underneath. Adjust table names to your schema.

```sql
-- List unique/primary-key constraints on tables that look like event or idempotency logs
SELECT tc.table_name, tc.constraint_name, tc.constraint_type, kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
WHERE tc.constraint_type IN ('UNIQUE', 'PRIMARY KEY')
  AND tc.table_name ~* 'event|webhook|idempotency|processed'
ORDER BY tc.table_name;
```
Bad result: no rows — there's no table backstopping event or webhook processing, or the table exists with no unique constraint on its event-id column.

```sql
-- Check whether your orders/payments table has a unique constraint tying a row to one upstream charge or event
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.orders'::regclass
  AND contype = 'u';
```
Bad result: no rows — nothing stops two inserts for the same upstream event or charge id. (Swap `orders` for your actual payments/charges table.)

```sql
-- Look for duplicates that already happened — evidence, not theory
SELECT stripe_event_id, COUNT(*)
FROM orders
GROUP BY stripe_event_id
HAVING COUNT(*) > 1;
```
Bad result: any row returned. Run against a read replica if you have one. (Column/table names illustrative — match to your schema.)

### Infrastructure

```bash
# Check configured function/route timeouts against your slowest write handler (Vercel/Next.js/Fly)
rg -n "maxDuration|\"functions\"" vercel.json next.config.* fly.toml 2>/dev/null
```
Bad result: no timeout configuration at all, or a configured timeout shorter than the combined latency of the charge, email, and DB writes the handler performs — that gap is where a client times out and retries a request the server is still processing.

## Questions to ask

- What does your webhook handler do when the exact same event arrives twice — replay the event ID, or replay the side effect?
- If a user double-clicks checkout right now, how many charges land in your payment processor?
- Does your queue consumer assume "delivered" means "delivered exactly once," and what breaks the day that's wrong?
- Which of your write handlers were AI-generated, and has anyone actually verified the guard check is there — or just assumed it?
- When a load balancer times out mid-write and the caller retries, what in your system actually stops the second write?

## The fix

1. Add a database unique constraint on your highest-risk write path — `orders.stripe_event_id`, or a new `processed_events.event_id` — as the backstop (~30 min).
2. Wire the insert-then-branch pattern into every webhook handler: attempt the insert into `processed_events`; a constraint violation means already-processed — return 200, no-op; success means process the event (~an afternoon).
3. Add idempotency keys to every write/payment endpoint — client-supplied header or derived from the event ID — checked before any side effect runs (~an afternoon per endpoint).
4. Pass your payment processor's built-in idempotency-key parameter on every outbound API call, e.g. Stripe's `idempotencyKey` (~1 hr, mostly find-and-replace).
5. Add disable-on-click or pending-state guards to every submit button that triggers a write (~1 hr across the app).
6. Review every write handler — AI-generated ones first — and design each as if it will run twice with identical input, because it will (ongoing; prioritise payment and order paths first).

## Guardrail

```
Every new write or payment endpoint accepts and checks an idempotency key — client-supplied or derived from the event ID — before performing any side effect.
Every webhook handler inserts into a processed_events table (unique constraint on event_id) before charging, emailing, or updating state; a constraint violation is a no-op 200, not an error.
Webhook handlers return a 2xx response within the provider's timeout window (GitHub: 10 seconds) even when downstream processing is still running — respond first, do slow work after.
Never assume a queue message, webhook delivery, or POST request arrives exactly once. Write every handler to be safe if it runs twice with identical input.
Every submit button that triggers a write is disabled, or shows a pending state, from the first click until the request resolves.
When generating a write handler, the guard/dedup check is the first line, not an afterthought. Do not skip it because a duplicate "seems unlikely."
```

## Evidence from the wild

- Chase, Commonwealth Bank Australia, and NBT Bank have each had duplicate-transaction incidents reported in the press — real banks, not hypothetical MVPs.
- Stripe's own API needs an idempotency-key parameter to survive retries from its own SDKs — a payments-grade platform that still doesn't trust exactly-once delivery ([Stripe: idempotent requests](https://docs.stripe.com/api/idempotent_requests)).
- A study of LLM-generated code found 43.1% was more fragile than human-written reference code; over 90% of the gap traced to missing guard checks, 70% of those omitted on the function's first line — and in 63–69% of the missed cases, the model's own token probabilities had ranked the missing `if` check in its top three choices ([arXiv:2503.20197](https://arxiv.org/abs/2503.20197)).
- The Two Generals Problem is the formal proof that exactly-once delivery over an unreliable network can't be guaranteed — why SQS, Kafka, and every major webhook provider default to at-least-once instead.
- Retry windows assume you'll see duplicates: Stripe retries webhooks for up to 3 days, Shopify 8 times over 4 hours, GitHub 3 times within an hour and requires a 2xx reply within 10 seconds ([Stripe webhooks](https://docs.stripe.com/webhooks)).
