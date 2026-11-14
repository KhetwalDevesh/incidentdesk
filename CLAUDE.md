# IncidentDesk

Multi-tenant incident management API. Product scope: @docs/spec.md. Status: Phase 2 in progress. Incidents and accounts persist in Postgres; the API issues its own JWTs.

## Commands

- Install: `pnpm install`
- Start Postgres in Docker: `pnpm db:up` (stop with `pnpm db:down`)
- Apply migrations: `pnpm db:migrate`
- Run API: `pnpm dev` (copy `.env.example` to `.env` first)
- Local webhook receiver for notification channels: `pnpm dev:receiver --port 4000 --mode ok` (modes and runtime switching in `scripts/dev-receiver.ts`)
- All checks: `pnpm check` (needs `pnpm db:up` for the repository parity tests)
- One test file: `pnpm vitest run path/to/file.test.ts`
- Typecheck: `pnpm typecheck`
- Lint and format: `pnpm lint:fix`
- Regenerate API contract: `pnpm contract:generate`

## Architecture

Dependencies point inward. Full reasoning: `docs/architecture.md`.

| Layer            | Path                       | May import                     |
| ---------------- | -------------------------- | ------------------------------ |
| Contract         | `src/contract/`            | Nothing from the app           |
| Domain           | `src/domain/`              | Contract                       |
| Services         | `src/services/`            | Domain, contract               |
| Repositories     | `src/repository/`          | Domain, contract               |
| Adapters         | `src/adapters/`            | Domain, contract               |
| Mappers          | `src/mappers/`             | Domain, contract               |
| HTTP and routes  | `src/http/`, `src/routes/` | Everything except repositories |
| Composition root | `src/containers/`          | Everything                     |

## Copy this, not your memory

`incidents` is the golden reference. New modules copy its shape: contract, domain port, repository, service, mapper, route, contract test. Use `/new-endpoint`.

## Source of truth

- API shape: Zod schemas in `src/contract/`. `contracts/openapi.yaml` is generated. Never edit it by hand.
- Feature behaviour: `docs/features/`. No feature work without a spec.
- Decisions: `docs/adr/`.

## Gotchas

- `tests/incidents.contract.test.ts` fails if a route is missing from `src/contract/openapi.ts`, or the reverse.
- Response schemas are strict, so a new field must be added to the schema and the mapper together.
- Applied migrations are immutable. A hook blocks edits. Add a new migration instead.
- Editing `.claude/hooks/` or `.claude/settings.json` takes effect in a new session.

## When a rule fails

Fix the cause. Do not weaken a test, widen `scripts/escape-hatch-baseline.json`, add `biome-ignore`, or use `--no-verify` unless the user approves it in this conversation.

## Definition of done

1. The feature spec's "Done when" list is met.
2. `pnpm check` passes, and you show the output.
3. The contract and its tests changed in the same diff as the behaviour.
4. New behaviour that can be misused has a test in `tests/security.test.ts`.
