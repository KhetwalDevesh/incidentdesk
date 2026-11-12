# Postgres persistence

Status: Done

Phase 2, first slice. Real authentication follows in its own spec.

Decided by the user: run Postgres in Docker, and proceed without a separate `/new-feature` round.

## Goal

Keep incidents across restarts by storing them in Postgres, without changing any service, route or API response.

## User flow

1. A developer runs `pnpm db:up` to start Postgres in Docker.
2. `pnpm db:migrate` applies every pending file in `db/migrations/`.
3. `pnpm dev` serves the API backed by Postgres. Restarting the API keeps incidents.

## Permissions

No change. Roles are still checked in services.

## API changes

None. The contract and `contracts/openapi.yaml` stay byte-identical.

## Data changes

- `docker-compose.yml` runs `postgres:17-alpine` on host port 54329, with a `incidentdesk` database for development and `incidentdesk_test` for tests.
- Migration `0001_create_incidents.sql` creates `incidents`, keyed by `(tenant_id, id)`, with a `(tenant_id, created_at DESC, id)` index for lists. Check constraints mirror the contract's enums and title length.
- A migration runner records applied files in `schema_migrations`, applies each file in a transaction, and holds an advisory lock so two runners cannot race.
- `PostgresIncidentRepository` implements `IncidentRepository` with `pg` and parameterized queries only.
- `update` is one `UPDATE ... WHERE tenant_id = $1 AND id = $2 AND status = $3 RETURNING ...`, so the acknowledge race stays atomic.
- `DATABASE_URL` becomes a required setting. The composition root picks the Postgres repository. Unit and contract tests keep the in-memory repository.

## Edge cases and failures

- Database down at startup: the first query fails and `app.onError` returns the fixed 500 body. The connection string never reaches a client.
- Two simultaneous acknowledges: one row update matches, the other returns no row and gets 409.
- Re-running `db:migrate`: applied files are skipped.
- A failed migration rolls back and is not recorded.

## Security

- Every query filters by `tenant_id`, which comes from the repository's first argument.
- No string-built SQL from input. Column names in `update` come from a fixed map.
- Development credentials live in `docker-compose.yml` and `.env.example` only. They are not production secrets.

## Out of scope

- Real authentication, tenants and members tables (next spec)
- Postgres MCP server with a read-only role
- Connection pool tuning and production deployment

## Done when

- [x] A parity test runs the same repository calls against in-memory and Postgres, including tenant isolation and the compare-and-set update (`tests/incidentRepository.parity.test.ts`)
- [x] Concurrent `update` calls on Postgres yield exactly one winner ("lets exactly one of many concurrent updates win")
- [x] Contract unchanged (`pnpm contract:check`)
- [x] CI runs the parity test against a Postgres service (PR #2, `tests` job: 18 parity tests passed)
- [x] `pnpm check` passes
