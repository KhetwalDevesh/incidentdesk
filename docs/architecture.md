# Architecture

Business logic sits in the middle and knows nothing about HTTP or storage, so either can change without touching it.

## Request path

```text
Client
  │  HTTP
  ▼
src/http        request id, auth, error handling
  ▼
src/routes      parse with a contract schema
  ▼
src/services    roles and business rules, returns Result<T>
  ▼
src/domain      ports (interfaces) and entities
  ▲
src/repository  implements the port: Postgres in the app, in-memory in unit tests, a parity test keeps them equal

src/mappers     turns an entity into a response on the way out
src/containers  wires concrete classes together
src/contract    Zod schemas, shared by all layers
```

## Why each boundary exists

| Decision | Reason |
|---|---|
| Services depend on ports | Tests run without a database, and Postgres can replace in-memory without changing services |
| Mappers build every response | A new internal field cannot leak by accident |
| `tenantId` is the first repository argument | A query cannot be written without choosing a tenant |
| Expected failures are `Result<T>` | The compiler forces callers to handle them |
| Identity comes only from the auth middleware | A client cannot claim another tenant |

## Failure handling

| Case | Response |
|---|---|
| Expected failure | Problem body with a registry code, from `Result<T>` |
| Invalid input | 422 with field errors |
| Thrown error | 500 with a fixed message |
| Another tenant's resource | 404 |
