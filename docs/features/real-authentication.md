# Real authentication

Status: Done

Phase 2, second slice. Replaces development tokens with accounts stored in Postgres.

Decided by the user: the API issues its own JWTs, and signing up creates a new tenant with the signer as admin.

## Goal

Let a team sign up, invite members with a role, and call the API with a short-lived token, so each request's tenant and role come from a verified identity instead of a config string.

## User flow

1. A person signs up with a tenant name, email and password. A tenant is created, they become its admin, and they get an access token.
2. The admin adds a member by email and role. The response carries a one-time setup token. The admin passes it to the member outside the app; no email is sent.
3. The member sets a password with the setup token and gets an access token.
4. Anyone with a password logs in with email and password and gets an access token.
5. Each `/v1` request sends `Authorization: Bearer <token>`. The API verifies the token, then loads the user, so a removed user or a changed role takes effect on the next request.

## Permissions

| Action | Anonymous | Viewer | Responder | Admin |
|---|---|---|---|---|
| Sign up, log in, set password | Yes | Yes | Yes | Yes |
| List members | No | No | No | Yes |
| Add a member | No | No | No | Yes |

## API changes

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/v1/auth/signup` | 201 with a token | 409, 422 |
| POST | `/v1/auth/login` | 200 with a token | 401, 422 |
| POST | `/v1/auth/setup-password` | 200 with a token | 401, 422 |
| GET | `/v1/members` | 200 with a page of members | 401, 403, 422 |
| POST | `/v1/members` | 201 with the member and a setup token | 401, 403, 409, 422 |

- Token response: `{ accessToken, tokenType: "Bearer", expiresIn }`.
- Member: `{ id, email, role, status, createdAt }`. `status` is `pending` until the member sets a password, then `active`.
- Adding a member also returns `setupToken` and `setupTokenExpiresAt`. The token is shown once.
- Existing incident endpoints are unchanged.

## Data changes

Migration `0002_create_accounts.sql`:

- `tenants (id, name, created_at)`.
- `users (tenant_id, id, email, role, password_hash, created_at)`, keyed by `(tenant_id, id)`. `password_hash` is null while pending.
- A unique index on `users (email)`. A user belongs to exactly one tenant in this slice. This index is not tenant-first, because login looks a user up before the tenant is known.
- `password_setup_tokens (token_hash, tenant_id, user_id, expires_at, used_at)`. Only the SHA-256 of a token is stored.

Ports:

- `AccountRepository`: tenant-scoped reads and writes. `tenantId` is the first argument.
- `CredentialStore`: the only unscoped lookups (by email, by setup token hash) and signup. Kept separate so a reviewer can audit them in one place.
- `PasswordHasher` (argon2id) and `TokenService` (HS256 JWT) are ports with adapters in `src/adapters/`.

Config: `JWT_SECRET` (at least 32 characters) and `ACCESS_TOKEN_TTL_SECONDS` (default 3600) are required. `DEV_API_TOKENS` is removed.

## Edge cases and failures

- Signup or add member with an email that already exists: 409.
- Wrong password and unknown email return the same 401 body, and both run one hash verification so timing does not reveal which.
- Login by a pending member, who has no password yet: the same 401.
- Setup token unknown, expired or already used: 401. Two simultaneous uses: exactly one succeeds.
- Token with a bad signature, wrong algorithm, expired, or for a user who no longer exists: 401.
- Emails are trimmed and lowercased before storage and lookup.

## Security

- Passwords: 12 to 128 characters, hashed with argon2id. The upper limit stops hashing from being used for denial of service.
- Tokens carry only `sub` (user id), `tid` (tenant id), `iat` and `exp`. Role is read from the database on every request.
- Verification pins HS256, so an `alg: none` or other-algorithm token is refused.
- `JWT_SECRET` comes from `.env` locally and a secret manager in production. Never logged or returned.
- Setup tokens are 32 random bytes, stored only as a hash, single use, and expire after 72 hours.
- A member can only be added to the admin's own tenant. `tenantId` comes from the principal.
- Signup reveals whether an email is registered (409). Accepted for this slice.

## Out of scope

- Login rate limiting and lockout (needed before production)
- Refresh tokens and logout
- Changing a role or removing a member
- Users in more than one tenant
- Email delivery and password reset
- A foreign key from `incidents.tenant_id` to `tenants`

## Done when

- [x] Signup, login and setup-password each return a token that works on `/v1/incidents` (`tests/auth.contract.test.ts`)
- [x] A viewer and a responder get 403 on member management (`tests/security.test.ts`, "member management")
- [x] Wrong password, unknown email and pending member get identical 401 bodies ("login responses")
- [x] A tampered, expired or `alg: none` token gets 401, as do HS512, a wrong secret and a deleted user ("access tokens")
- [x] A user from another tenant cannot list or add that tenant's members ("keeps each tenant's members separate")
- [x] A setup token works once, and two simultaneous uses yield one success (HTTP test and Postgres parity test)
- [x] A parity test covers the account repositories against in-memory and Postgres (`tests/accountRepository.parity.test.ts`)
- [x] Contract regenerated, additive only (no removed lines in `contracts/openapi.yaml`)
- [x] `pnpm check` passes
