-- Records when and by whom an incident was resolved.
-- Spec: docs/features/resolve-incident.md
-- Rollback: ALTER TABLE incidents DROP COLUMN resolved_at, DROP COLUMN resolved_by;
-- Locking: adding nullable columns without a default only updates the catalog,
-- so the brief ACCESS EXCLUSIVE lock does not rewrite or scan the table.

ALTER TABLE incidents
	ADD COLUMN resolved_at timestamptz,
	ADD COLUMN resolved_by text;
