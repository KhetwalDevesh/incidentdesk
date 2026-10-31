---
paths:
  - "db/**"
  - "src/repository/**"
---

# Database rules

## Do

- Add a new numbered file for every schema change: `db/migrations/NNNN_description.sql`. Use `/new-migration`.
- Put `tenant_id` on every tenant-owned table, and first in its indexes.
- Use expand then contract for breaking changes: add new, migrate readers and data, then remove old in a later release.
- Select explicit columns.

## Don't

- Don't edit an applied migration. A hook blocks it.
- Don't drop or rename a column in the same release that stops using it.
- Don't run `SELECT *`.
- Don't query unbounded rows. Every list has a limit.
- Don't connect tools to production. The Postgres MCP server, when added, uses a read-only development role.
