# 3 — The login page is a prop

> Attackers don't click. They curl.

**Article:** https://papa.onle.gs/writing/the-login-page-is-a-prop.html
**Applies to you if:** you have any API route, JWT, session, OTP flow, or storage bucket that a user doesn't have to go through your login form to reach.
**Tier:** T1 (before real users) — before you store a single real user's data.
**First fix:** add a short expiry (`exp` claim) to every JWT you issue, and confirm the server actually rejects expired tokens (~1 hour).

## What it is

Your app demos perfectly, because a demo only exercises the path a human clicks: login form, redirect, dashboard. An attacker skips all of that and calls the API directly with curl. If the underlying route was never taught to check who's calling — only the client-side route guard was — the data comes back anyway. This stays invisible for months, because nobody manually curls their own endpoints, and the AI that built the login form had no reason to also build the server-side check unless you asked for it explicitly.

## Symptoms

- Login page and client-side route guards look real, but curling a protected route with no token still returns data
- Some endpoints (e.g. `/api/billing`) verify a JWT and role server-side; others (`/api/account`, `/api/admin/users`) don't
- JWT signing secrets committed as literal strings in source, not read from environment
- Tokens issued with no `exp` claim and no way to revoke one once issued
- "Logout" removes the token from `localStorage` on the client — the same token still authenticates six months later
- Password rules stuck at decades-old defaults: length only, no breach check, no recent review
- OTP or registration endpoints callable anonymously, with no rate limiting
- Storage buckets (Firebase Storage, S3, GCS) left open to public read or write
- An app ID, client ID, or tenant slug is relied on as a secret gate, when it's actually visible in the network tab

## Checks

### Code

```bash
# Hardcoded JWT/signing secrets committed to source instead of read from env
rg -n -i 'jwt_secret|jwtsecret|signing_key|secret_key' \
  --glob '!node_modules' --glob '!*.lock' -g '*.{js,ts,jsx,tsx,py,go,rb}'
```
Bad result: a hit where the right-hand side is a quoted literal string, not `process.env.*`, `os.environ.*`, or a secrets-manager call.

```bash
# Find logout handlers and see whether any of them call the server
rg -n -i 'logout|signOut|sign_out' --glob '!node_modules' -g '*.{js,ts,jsx,tsx}'
```
Bad result: every hit is `localStorage.removeItem(...)` or a cookie clear, with no accompanying `fetch('/api/logout')`, `POST /session`, or provider `signOut()` call that reaches the server — the token itself is never invalidated.

```bash
# List API route handlers with no visible reference to an auth/session check
# (Next.js app/pages router shown — adapt the glob for Express, FastAPI, Rails, etc.)
for f in $(rg -l --glob 'app/api/**/*.{ts,js}' --glob 'pages/api/**/*.{ts,js}' '.'); do
  rg -qi 'getServerSession|requireAuth|verifyToken|supabase\.auth\.getUser|req\.headers\.authorization|auth\(\)' "$f" \
    || echo "NO AUTH REFERENCE: $f"
done
```
Bad result: any file printed — a route with no server-side auth check, worth curling directly (see Infrastructure below) to confirm it's actually exploitable.

### Database

```sql
-- Any revocation mechanism at the data layer at all? (Postgres/Supabase-flavoured — adapt names to your schema)
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (column_name ILIKE '%revoked%' OR column_name ILIKE '%blacklist%'
       OR table_name ILIKE '%session%' OR table_name ILIKE '%refresh_token%');
```
Bad result: empty set — no table or column anywhere in the schema can mark a token or session as invalid, so nothing issued can ever be revoked server-side.

```sql
-- Password column sanity check — should be a hash, never a plaintext value
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name ILIKE '%password%';
```
Bad result: a column literally called `password` (not `password_hash`); confirm by sampling a row — a real hash starts `$2b$`, `$2a$`, or `$argon2`, not plain text.

### Infrastructure

```bash
# Curl sensitive routes with no token against a deployed environment — replace with your real routes
for route in /api/account /api/admin/users /api/billing; do
  printf '%s -> ' "$route"
  curl -s -o /dev/null -w '%{http_code}\n' "https://$APP_HOST$route"
done
```
Bad result: anything other than 401/403 — a 200 (or data-bearing response) means an anonymous caller got in.

```bash
# Public storage bucket check (Firebase Storage / GCS — requires gcloud auth, read-only)
gsutil iam get "gs://$BUCKET_NAME" | rg -i 'allUsers|allAuthenticatedUsers'

# S3 equivalent (requires aws cli, read-only)
aws s3api get-public-access-block --bucket "$BUCKET_NAME"
aws s3api get-bucket-acl --bucket "$BUCKET_NAME" | rg -i 'AllUsers'
```
Bad result: `allUsers` granted any role on GCS/Firebase, or `BlockPublicAcls: false` / an `AllUsers` grantee on S3 — the bucket is world-readable or world-writable. (Skip this pair if you don't use cloud object storage.)

## Questions to ask

- If you curled every sensitive endpoint right now, with no token, how many would return data instead of a 401?
- What actually happens on the server when a user clicks "logout" — or does nothing happen there at all?
- Is anything in this system treated as secret — an app ID, client ID, tenant slug — that's actually visible in a network request?
- If a token leaked via a log file today, could you invalidate it?
- Has this auth layer had a security review by anyone other than the AI that wrote it?

## The fix

1. Add a short expiry (`exp` claim) to every JWT you issue, and make the server actually reject expired tokens (~1 hour).
2. Make "logout" a server-side call that revokes the token or session — not just `localStorage.removeItem` (~half a day).
3. Move auth enforcement into a shared middleware or gateway layer that every route passes through by default, rather than a per-handler check you have to remember to add (~a day, more depending on route count).
4. Rate-limit and require authentication on OTP and registration endpoints; bring password rules up to current OWASP guidance (~half a day).
5. Lock down any publicly-open storage bucket (Firebase Storage, S3, GCS) to authenticated access only (~30 min, but do it today).
6. Migrate to a managed auth provider (Auth0, Clerk, Supabase Auth, Cognito) so password hashing, token lifecycle, revocation, and MFA aren't yours to maintain (~a sprint).
7. Get a second pair of eyes on the AI-built auth layer — a focused audit — before you build more surface area on top of it.

## Guardrail

```
Enforce authentication and authorisation server-side on every new API route before touching data. A client-side route guard or a hidden UI button is not a security control.
Never hardcode a JWT secret, signing key, or API secret in source. Read it from environment variables or a secrets manager, always.
Give every JWT you issue a short expiry (`exp` claim), and make the server actually reject expired tokens.
Make "logout" a server-side call that revokes the token or session. Deleting a value from localStorage is not logout.
Default to a managed auth provider (Auth0, Clerk, Supabase Auth, Cognito) for anything handling passwords, sessions, or tokens. Do not hand-roll auth unless explicitly told to.
Keep every storage bucket you create (Firebase Storage, S3, GCS) private and authenticated by default. Treat public read or write as an explicit, reviewed exception, never the starting state.
Treat app IDs, client IDs, and tenant identifiers as public. Never use one as the sole gate on a registration, OTP, or admin endpoint.
```

## Evidence from the wild

- Stanford's Perry et al. study ([arXiv:2211.03622](https://arxiv.org/abs/2211.03622)) found developers using AI coding assistants wrote less secure code while reporting more confidence it was secure.
- Veracode's 2025 GenAI Code Security Report found 45% of AI-generated code samples failed security tests, with Java worst at 72% and XSS defences failing 86% of the time.
- BaxBench ([arXiv:2502.11844](https://arxiv.org/abs/2502.11844)) found roughly half of functionally-correct AI-generated backends contained an exploitable vulnerability.
- Tea app, July 2025: around 72,000 images — including roughly 13,000 verification selfies and government IDs — exposed via an unauthenticated Firebase Storage bucket; researchers attributed the code to unaudited AI generation.
- Wiz Research's disclosure on Base44, July 2025: registration and OTP-verification endpoints had no authentication at all, and a public app ID let anyone self-register a verified account inside a private enterprise app, bypassing SSO. Fixed within 24 hours of disclosure.
- Escape.tech's scan of 5,600 vibe-coded apps found 2,000+ high-impact vulnerabilities and 400+ exposed secrets live in production.
