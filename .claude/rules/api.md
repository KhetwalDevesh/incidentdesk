---
paths:
  - "src/routes/**"
  - "src/http/**"
  - "src/contract/**"
  - "src/mappers/**"
---

# API rules

Reference: `src/routes/incidents.ts`.

## Do

- Define or change the Zod schema in `src/contract/` first, then register the path in `src/contract/openapi.ts`.
- Run `pnpm contract:generate` in the same change.
- Parse every body, query and param with a contract schema.
- Send every response through a mapper. It is the allowlist of what leaves the API.
- Return errors with `problemResponse` as RFC 9457 `application/problem+json`, using a code from `ERROR_CODES`.
- Paginate list endpoints with `PageQuerySchema` and return `{ items, total, limit, offset }`.
- Return 201 with a `Location` header on create.

## Don't

- Don't return a domain object or database row directly.
- Don't remove, rename or change the type of a response field under `/v1`. Add a new field, or a new version.
- Don't add a value to a response enum until clients can read it.
- Don't put business rules in a route. Routes parse, call a service and map.
- Don't build an error by hand, or return 200 for a failure.
