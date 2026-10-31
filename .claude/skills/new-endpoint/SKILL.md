---
name: new-endpoint
description: Add or change an API endpoint using the project's layered pattern. Use whenever a route is added or a response shape changes.
---

Copy the `incidents` module. Work through these steps in order:

1. Confirm a spec in `docs/features/` covers this endpoint. If not, stop and ask.
2. Add request and response schemas to `src/contract/<module>.ts`. Use `z.strictObject` for responses.
3. Register the path and every error status in `src/contract/openapi.ts`.
4. Run `pnpm contract:generate`.
5. Add the port to `src/domain/<module>/types.ts`, with `tenantId` first on repository methods.
6. Implement the repository, then the service returning `Result<T>`.
7. Add the mapper and route. The route only parses, calls the service and maps.
8. Wire the module in `src/containers/index.ts` and `src/http/app.ts`.
9. Add contract tests, plus tenant isolation tests in `tests/security.test.ts`.
10. Run `pnpm check` and show the output.
