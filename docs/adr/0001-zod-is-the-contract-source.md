# ADR 0001: Zod schemas are the API contract source

Status: Accepted

## Decision

Write API contracts as Zod schemas in `src/contract/`. Generate `contracts/openapi.yaml` from them.

## Context

A hand-written OpenAPI file and separate runtime validators are two sources of truth, and they drift.

## Consequences

- The same schema validates requests at runtime and checks responses in tests.
- `pnpm contract:check` fails CI when the generated file is stale.
- `tests/incidents.contract.test.ts` fails when a served route and the contract differ.
- Contract work still comes first. Schemas change before the implementation.
- OpenAPI features that the generator cannot express need extra metadata.
