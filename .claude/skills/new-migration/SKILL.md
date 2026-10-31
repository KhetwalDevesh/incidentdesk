---
name: new-migration
description: Create a database migration. Use whenever the database schema needs to change.
---

1. Read `.claude/rules/database.md`.
2. Find the highest number in `db/migrations/`, and create the next `NNNN_description.sql`.
3. Never edit an existing migration.
4. If the change is breaking, write only the expand step. Describe the later contract step in the migration's header comment.
5. Add `tenant_id` and a tenant-first index to any tenant-owned table.
6. State how the change is rolled back, and whether it locks a large table.
