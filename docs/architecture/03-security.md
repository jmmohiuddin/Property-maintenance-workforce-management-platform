# Security model

## Threat model

The realistic threats for this platform, roughly in order of likelihood:

1. **Cross-tenant data exposure** through a forgotten `WHERE tenant_id` clause. The most likely
   serious bug in any multi-tenant system, and the one this architecture is shaped around.
2. **Credential stuffing** against the customer portal.
3. **Insider access abuse**: a dispatcher or technician viewing or altering records they should not.
4. **PII exposure** through job photos, signatures and GPS traces, which are more sensitive than the
   job records themselves.
5. **Spam and abuse** of public forms.

## Tenant isolation

The boundary is in PostgreSQL, not in application code.

**Mechanism.** Every tenant-scoped table has `ENABLE ROW LEVEL SECURITY` *and*
`FORCE ROW LEVEL SECURITY`, with a policy filtering on
`current_setting('app.tenant_id')`. `withTenant()` opens a transaction, sets that variable
transaction-locally, and runs the callback inside it.

**Why `FORCE` matters.** Without it, policies are skipped for the table owner. A deployment that
accidentally connects as the owner then loses all isolation silently, with no error anywhere. It is
the single most important line in [`rls.sql`](../../packages/db/sql/rls.sql).

**Why the third argument to `set_config` matters.** `set_config('app.tenant_id', $1, true)` scopes
the setting to the transaction. Without the `true`, the value survives on the pooled connection and
leaks into the next checkout. That is the classic way RLS multi-tenancy is defeated in production.

**Why the app role must not own the tables and must have `NOBYPASSRLS`.** A superuser or owner
connection ignores every policy. `verify-rls.sql` check 10 asserts `rolbypassrls = false` so this
cannot regress unnoticed.

Because that misconfiguration is silent — every query keeps working, it just also returns other
tenants' rows — `assertNotBypassingRls()` in [`packages/db`](../../packages/db/src/index.ts) checks
the live connection at boot. It throws in production and logs a loud banner in development. Seeds
and migrations connect via a separate `DATABASE_ADMIN_URL` precisely so the application's
`DATABASE_URL` never needs elevated rights.

**Failure mode is silent-empty, not error.** `app_current_tenant()` returns `NULL` when unset, so a
query outside a tenant transaction returns zero rows rather than raising. This is the safer choice:
an exception can be caught and ignored by a caller, while zero rows breaks the feature loudly in
testing and never leaks in production.

### Verification

Ten checks in [`verify-rls.sql`](../../packages/db/sql/verify-rls.sql), all passing against
PostgreSQL 16:

| # | Asserts |
| --- | --- |
| 1 | No tenant context returns zero rows, not other tenants' rows |
| 2 | Tenant A sees exactly its own rows |
| 3 | Tenant A cannot read tenant B's rows even when naming them directly |
| 4 | Tenant A cannot INSERT a row stamped with tenant B's id |
| 5 | Tenant A cannot UPDATE a row's `tenant_id` to escape its own scope |
| 6 | Tenant A cannot DELETE tenant B's rows |
| 7 | Switching context switches the visible set with no bleed-through |
| 8 | `audit_log` rejects UPDATE even from the application role |
| 9 | No table with a `tenant_id` column lacks forced RLS |
| 10 | The application role does not have `BYPASSRLS` |

**Run this in CI on every migration.** A new table without a policy is a data breach waiting for
traffic, and check 9 is what catches it.

Two real bugs were found and fixed by these checks during development, both in the append-only audit
log: the generic policy loop was attaching a `FOR ALL` policy to `audit_log` (which permits UPDATE),
and a blanket `GRANT ON ALL TABLES` was re-opening the UPDATE privilege that a later `REVOKE` was
meant to remove. Both are now defended twice, and check 8 fails if either regresses. This is the
argument for executable security checks over reviewed security documentation.

## Audit trail

`audit_log` is append-only and written by a **database trigger**, not by application code. An audit
log the application can forget to write is not an audit log, and one it can rewrite is not evidence.

- No `UPDATE` or `DELETE` grant for the application role
- No policy permitting either operation
- Records only changed columns, ignoring `updated_at` (which changes on every write and would drown
  the signal)
- Captures actor, actor kind (`user` / `system` / `ai` / `customer`), IP, user agent and request id
- Attached to the tables where "who changed this" is actually asked: jobs, visits, sign-offs, quotes,
  contracts, invoices, payments, customers, properties, assets, technicians, memberships, leave

Deliberately **not** attached to `technician_locations`, which would generate millions of rows and
bury the entries that matter.

`ai_interactions` is a parallel ledger for every AI call that influenced a business record: model,
prompt hash (not the prompt, which can carry customer PII), tokens, cost, the record it affected, and
whether a human accepted the output. This is what makes "the system quoted the wrong price"
answerable six months later.

## Authentication and authorisation (phase 2)

Designed, not yet built.

- **Sessions** are individually revocable rows with hashed tokens, so a compromised device can be
  killed without a global logout. The table exists.
- **MFA** columns exist on `users`. Mandatory for `owner`, `admin` and `accountant` roles; optional
  below that.
- **RBAC** is ten roles with a `permission_overrides` JSONB for tightening without inventing a new
  role per combination. Roles are the default; overrides are the exception.
- **Customer portal users** are `memberships` rows with `role = 'customer'` and a `customer_id`,
  scoping them to one customer account within a tenant.
- **Password hashing**: Argon2id. Rate limiting and lockout driven by `failed_login_count`.

### The authentication bootstrap problem, and how it is solved

RLS scopes every read to `current_setting('app.tenant_id')`. Authentication happens **before** a
tenant is known, so a login-by-email query has no tenant context and the `users` policy matches zero
rows. Login is therefore impossible under RLS as written. Every RLS-based system hits this; the
question is what you do about it.

This was found by testing, not by review: the first end-to-end login attempt failed with "email or
password is incorrect" against a user that demonstrably existed. Worth recording, because the
security model documented here previously claimed login ran through `withoutTenantBoundary()` — and
that would not have worked.

**Rejected:**

- *Loosen the `users` policy so "no tenant context" means "see everything".* This inverts the safe
  default: a forgotten `withTenant()` would then disclose everything instead of returning zero rows.
- *Connect as a superuser for auth.* Bypasses RLS for the whole connection — exactly what
  `assertNotBypassingRls()` exists to catch.
- *A second database role for auth.* Workable, but moves the boundary into connection-string
  configuration where it is invisible to code review.

**Chosen:** a fixed set of seven `SECURITY DEFINER` functions in
[`sql/auth-functions.sql`](../../packages/db/sql/auth-functions.sql), each performing exactly one
authentication step and returning only the columns that step needs. They see past RLS, but they are
the **only** way the application can, they are enumerable (`\df app_auth_*`), and each is short
enough to read in full during a review.

Three rules govern anything added there:

1. `SET search_path = public` on every function. Without it, a caller who controls `search_path` can
   shadow `users` with their own table and change what the function does. A verification query at
   the bottom of that file asserts no `SECURITY DEFINER` function is missing it.
2. Return the minimum. Never `SELECT *`, so a column added to `users` later cannot silently start
   flowing out of the auth path.
3. No function may accept a `tenant_id` from the caller and trust it.

`EXECUTE` is revoked from `PUBLIC` and granted only to `meridian_app`.

### The other definer functions

Two further functions exist outside the auth surface, and each earns its place the same way:

- [`sql/public-functions.sql`](../../packages/db/sql/public-functions.sql) — `app_public_resolve_tenant`,
  reachable by an unauthenticated visitor submitting the website quote form. It returns a tenant id
  and nothing else.
- [`sql/reference.sql`](../../packages/db/sql/reference.sql) — `app_next_reference`, which allocates
  job, quote and invoice numbers.

`app_next_reference` is worth reading in full, because it is the one place where the customer-scope
policies actively work against correctness. Allocation used to count existing rows in application
code. Under `withCustomerScope` that count sees only the calling customer's own jobs, so the "next"
number was one another customer in the same tenant already held — the unique index rejected it and
the customer's request failed with a database error on screen. Counting also races: two accountants
raising an invoice in the same second read the same count.

The function takes its tenant from the connection GUC and never from an argument, so a caller cannot
allocate inside somebody else's tenant, and its whole body is one atomic `UPDATE ... RETURNING`
against a counter row. It is allowed to skip numbers on rollback: a gap in invoice numbers is a
question an accountant can answer, a duplicate is not.

## Second factor

TOTP, RFC 6238, verified against the published test vectors in
`packages/auth/test/totp.test.ts`. Three decisions are worth stating because each has a
plausible-sounding alternative that is worse:

**SHA-1 is deliberate.** RFC 6238 permits SHA-256 and SHA-512, and every mainstream authenticator
app ignores the `algorithm` parameter and assumes SHA-1 regardless. A "stronger" choice here
produces codes that never match. HMAC-SHA1 is unaffected by the collision attacks that retired SHA-1
for signatures, and the secret is 160 bits of CSPRNG output.

**A code cannot be used twice.** A code stays valid for its whole thirty-second step, so one read
over a shoulder — or captured by a phishing page — is replayable seconds later. `users.mfa_last_step`
records the last step that authenticated, and any step at or below it is refused. This is also why
the code that confirms enrolment cannot immediately be used to sign in.

**A challenge is not a session.** Passing the password on an enrolled account produces a row in
`mfa_challenges`, not a session: a separate table, its own five-minute life, its own attempt ceiling,
its own cookie name. A half-authenticated row in `sessions` would be one forgotten `WHERE` away from
being treated as a real login.

Recovery codes are single-use, stored as SHA-256 hashes (same reasoning as session tokens: 50 bits
of CSPRNG output has no structure for a slow hash to protect), and replaced wholesale on
re-enrolment. Turning the second factor off requires a current code or a recovery code, and revokes
every session except the one doing it.

The `app_mfa_*` functions in [`sql/mfa-functions.sql`](../../packages/db/sql/mfa-functions.sql) exist
for the same reason the auth ones do — a user proving a second factor has no session and therefore no
tenant context. Enrolment deliberately has no definer function: that user *is* signed in, so the
ordinary `users` policy covers it.

Both MFA tables belong to a user rather than a tenant, so they carry own-row policies like
`sessions`. That is not cosmetic: `user_recovery_codes` has no `tenant_id`, so the generic policy
loop skipped it entirely and it would have shipped unprotected, while `mfa_challenges` did have one
and so was given a tenant policy that would have let any colleague in the same tenant read every
challenge row.

## PII and data protection

Sensitive data in this system, in rough order of sensitivity:

1. **Job photos** taken inside customers' homes, with GPS coordinates
2. **Signatures** with location and IP
3. **Technician GPS traces**, which are employee-monitoring data
4. **Customer contact details and addresses**

Controls: files in object storage with tenant-scoped keys and time-limited signed URLs, never public
buckets. TLS 1.3 in transit, AES-256 at rest. Retention and deletion in
[the data lifecycle doc](04-data-lifecycle.md).

**Note for the UAE context:** technician GPS tracking is employee monitoring. It needs a documented
lawful basis and a written policy the technicians have seen. This is a compliance task, not an
engineering one, and it is not done.

## Application security

Built:

- Security headers in `next.config.ts`: HSTS with preload, `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`
- Server-side validation on the quote form via a shared Zod schema. The client copy is a convenience;
  the server copy is the one that counts, and it runs whether or not the browser executed JavaScript
- Honeypot field on the public form, returning the success shape to bots so they learn nothing
- No secrets in client bundles; the only public env var is the site URL

Not built, needed for phase 2:

- Rate limiting on auth and public form endpoints
- A Content-Security-Policy. Currently absent because the inline JSON-LD scripts need either a nonce
  or a hash, and doing that properly needs the middleware layer that arrives with auth
- CSRF protection beyond what server actions provide by default
- Webhook signature verification for the payment gateway
- Dependency scanning in CI

## Backup and recovery

Targets, not yet implemented: RPO 15 minutes via WAL archiving, RTO 4 hours. Point-in-time recovery
retained 30 days. **Restores must be tested quarterly** — an untested backup is a hypothesis.
