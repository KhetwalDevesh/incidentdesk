---
paths:
  - "src/**"
  - "tests/security.test.ts"
---

# Security rules

These hold on every code path.

## Tenant isolation

- `tenantId` comes only from `c.get("principal")`. Never from a body, query, param or header. `pnpm enforce` check 4 fails this.
- Every repository method takes `tenantId` as its first argument and filters by it.
- Another tenant's resource returns 404, not 403, so its existence is not revealed.
- Every new tenant-owned resource gets isolation tests in `tests/security.test.ts`.

## Authorization

- Check roles in services, on the server. Hiding a button is not access control.
- Default to denied. A new action needs an explicit allowed role.

## Input and webhooks

- Treat all input as hostile, including alert payloads from monitoring tools.
- Verify webhook HMAC signatures over the raw body with a constant-time comparison, before parsing.
- Use parameterized queries only.

## Secrets and logs

- Never log tokens, secrets or authorization headers, or return them in an error.
- A 500 response has a fixed message. Details stay in server logs with the request id.
- Secrets come from a secret manager in production and `.env` locally. Never commit them.
