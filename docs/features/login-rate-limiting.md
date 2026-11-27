# Login rate limiting

Status: Done

Closes a security gap before Phase 5: today anyone can try passwords against `POST /v1/auth/login` as fast as the server answers.

Decided by the user:

| Question | Decision |
|---|---|
| What is counted | Failed sign-ins per email and per client IP. Either limit blocks |
| Limits | 5 failures per email in 15 minutes locks that email for 15 minutes. 30 failures per IP in 15 minutes locks that IP for 15 minutes. A successful sign-in clears the email's count |
| Locked response | `429 Too Many Requests` with `Retry-After`, the same for known and unknown emails |
| Routes | Login (email and IP), setup-password (IP) and signup (IP) |

## Goal

Make online password guessing impractical:

- **Guessing one account's password** from many machines hits the email limit.
- **Trying one password against many accounts** from one machine (spraying) hits the IP limit.

Real users who mistype a few times are never affected.

## User flow

1. Grace mistypes her password twice, then signs in. Her count is cleared.
2. An attacker tries 5 wrong passwords for `grace@acme.example`. The 6th attempt, from any IP, gets 429 with `Retry-After: 900`, without the password being checked.
3. Fifteen minutes later the lock ends, and Grace signs in normally.
4. A bot tries one password against 30 different emails from one IP. Its next attempt, for any email, gets 429.
5. When an email locks for a member who exists, the tenant's audit log records `user.login_locked`.

## Rules

| Route | Key | What counts | Limit | Window | Lock |
|---|---|---|---|---|---|
| `POST /v1/auth/login` | Email | A failed sign-in | 5 | 15 min | 15 min |
| `POST /v1/auth/login` | IP | A failed sign-in | 30 | 15 min | 15 min |
| `POST /v1/auth/setup-password` | IP | An invalid, used or expired token | 10 | 15 min | 15 min |
| `POST /v1/auth/signup` | IP | Every attempt, successful or not | 10 | 1 hour | 1 hour |

How the rules behave:

- **Fixed window.** A key's window starts at its first counted event. When the window has passed, the next event starts a new one.
- **Lock.** Reaching the limit locks the key for the lock period, measured from the event that reached it.
- **Checked first.** Every limited route checks its keys before doing any work. A locked caller gets 429 without the password being hashed, which also stops the limits being used to make the server burn CPU.
- **The attempt that reaches the limit** gets its normal answer (401). Only later attempts get 429.
- **A successful sign-in** clears the email's count. It does not clear the IP's: one success must not let a sprayer reset their count.
- **Request validation failures (422) never count**, since no credential was checked.
- **Emails are keyed in lower case.** The API already lower-cases them (`EmailSchema`).

### The client IP

- **By default** the IP is the socket's remote address.
- **Behind a load balancer**, set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the API (default 0, at most 5). The IP is then read from `X-Forwarded-For`, that many entries from the right. Entries to the left of that could be written by the client, so they are never trusted.
- **IPv6 addresses are keyed by their `/64` prefix.** One client usually owns a whole `/64`, so keying by full address would let it rotate addresses freely.

## Permissions

These routes are public. The limits apply to every caller, with or without an account.

| Action | Anyone |
|---|---|
| Sign in, set a password, sign up, within the limits | Yes |

## API changes

| Method | Path | Success | New error |
|---|---|---|---|
| POST | `/v1/auth/login` | unchanged | 429 |
| POST | `/v1/auth/setup-password` | unchanged | 429 |
| POST | `/v1/auth/signup` | unchanged | 429 |

- **The 429 body** is an RFC 9457 problem with `code: "TOO_MANY_REQUESTS"` and `detail: "Too many attempts. Try again later."` It carries a `Retry-After` header with the whole seconds until the lock ends.
- **One answer for every caller:** the body is identical for known and unknown emails, and for email and IP locks, so a 429 reveals neither whether an account exists nor which limit was hit.
- **`ERROR_CODES` gains `TOO_MANY_REQUESTS: 429`**, a new value in the problem `code` enum (decided by the user). It is documented on the three routes, so typed clients see it in the regenerated contract. No route that exists today starts returning it except these three.

## Data changes

Migration `0017_create_auth_throttle.sql`:

- **`auth_throttle`** `(key, window_started_at, count, locked_until, updated_at)`, with primary key `key`. It is not tenant-owned: these routes run before any tenant is known, like the global email index on `users`.
  - Keys are `login:email:<sha256 of the email>`, `login:ip:<ip>`, `setup:ip:<ip>` and `signup:ip:<ip>`. Emails are stored only as a hash, so the table holds no email address.
  - Counting is one `INSERT … ON CONFLICT (key) DO UPDATE` statement. It starts a new window when the old one has passed, increments the count, and sets `locked_until` when the limit is reached. The row lock makes concurrent failures all count.
  - It runs in a transaction that first reads the lock in force under `SELECT … FOR UPDATE`. That way exactly one of many concurrent events reports starting a lock, so `user.login_locked` is written once. Found while building: comparing timestamps alone reported a new lock for every event sharing a millisecond.
  - An index on `updated_at` serves the purge.
- **The audit action CHECK gains `user.login_locked`** (expand only).
- **Purge:** the worker deletes rows whose window and lock both ended more than a day ago, hourly, in batches, alongside the audit purge.

Code:

- **Domain:** a `LoginThrottle` port with `lockedUntil(keys, now)`, `record(key, rule, now)` (returning whether that event locked the key) and `clear(key)`.
- **Repository:** Postgres, plus an in-memory twin and a parity test.
- **Service:** `authService` checks, then records or clears. The client IP reaches services through `RequestContext`, worked out by a middleware from the socket and `TRUSTED_PROXY_HOPS`.
- **Config:** `TRUSTED_PROXY_HOPS` (integer, 0 to 5, default 0).

## Audit

- **`user.login_locked`**, with an anonymous actor and the user as resource, when an email's lock starts and the email belongs to a member. It is written to that member's tenant. Details are empty: never the email or the IP.
- **Not audited:** IP locks, which belong to no tenant (they get a server log line with the key's kind and the lock end, not the IP), and blocked attempts (one entry per lock, not per request).
- **Unchanged:** `user.login_failed` is still written for each failure of a known email.

## Edge cases and failures

- **An attacker locks a victim out on purpose** by failing 5 times for their email. This is the known cost of per-email locking. The lock lasts only 15 minutes, and the attacker's IP limit still applies. CAPTCHA and lock-free alternatives are out of scope.
- **Many concurrent wrong guesses before the lock lands:** the check runs before the work, so requests already past it still finish. At most one round of concurrent requests gets through per lock; the count stays exact.
- **Many users behind one NAT or office IP:** 30 failures in 15 minutes from one IP is far above normal typing mistakes. Successful sign-ins never count toward the IP limit.
- **`TRUSTED_PROXY_HOPS` larger than the number of `X-Forwarded-For` entries:** the leftmost entry is used. Every caller still has a key, and no header is ever trusted past what the proxies wrote.
- **No remote address and no trusted header** (as in in-process tests): the key is `unknown`, shared by all such callers. This happens only in tests.
- **The throttle table is unavailable:** the route fails with 500, as for any database failure. It does not fall back to allowing unlimited attempts.
- **Clock:** the server's clock decides windows and locks. `Retry-After` is relative seconds, so the client's clock doesn't matter.
- **A pending member** (no password yet) fails sign-in as today, and the failure counts.

## Security

- **No enumeration:**
  - unknown emails are counted and locked exactly like known ones;
  - the 429 is identical for every key;
  - the lock check runs before the user lookup.
- **No CPU amplification:** a locked caller costs one indexed read, not an argon2 hash.
- **No personal data at rest:** emails are hashed in keys, and audit details stay empty. IPs are stored for up to a day after their lock ends, then purged.
- **No spoofed IPs:** `X-Forwarded-For` is ignored unless the operator configures trusted hops.
- **Tenant boundary:** there is no tenant data in this table. The only tenant write, the audit entry, goes to the member's own tenant.

## Out of scope

- CAPTCHA, proof-of-work and progressive delays
- Escalating locks for repeat offenders
- Limits on authenticated routes, and general API rate limiting
- Admin unlock, and notifying a member that their email was locked
- Allow-lists of trusted IPs
- Limiting per (email, IP) pair instead of per email

## Done when

- [x] Each rule counts, locks at its limit, and resets after its window, the same in memory and in Postgres, including concurrent failures (`tests/authThrottle.parity.test.ts`)
- [x] Login locks an email after 5 failures, and an IP after 30, with 429 and `Retry-After` for known and unknown emails alike. A success clears the email's count but not the IP's. A locked attempt never checks the password (`tests/auth.contract.test.ts`, `src/services/auth/authService.test.ts`)
- [x] Setup-password and signup lock by IP after 10 attempts (`tests/auth.contract.test.ts`)
- [x] The client IP comes from the socket, or from `X-Forwarded-For` only within `TRUSTED_PROXY_HOPS`, with IPv6 keyed by `/64` (`src/http/clientIp.test.ts`)
- [x] An email lock for a member writes `user.login_locked` with no email or IP in it (`tests/audit.contract.test.ts`)
- [x] The 429 reveals nothing about the account, and a spoofed `X-Forwarded-For` does not escape the IP limit (`tests/security.test.ts`, "login rate limiting")
- [x] Contract regenerated: `TOO_MANY_REQUESTS` and the 429 responses added, nothing removed
- [x] `pnpm check` passes
