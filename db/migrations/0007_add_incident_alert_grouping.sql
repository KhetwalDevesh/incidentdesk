-- Lets alerts group into incidents: an incident opened by an alert source remembers the
-- source and dedup key, and counts the alerts attached to it.
-- Spec: docs/features/alert-ingestion.md
-- Rollback: DROP INDEX incidents_unresolved_group_key;
--           ALTER TABLE incidents DROP COLUMN alert_source_id, DROP COLUMN dedup_key,
--             DROP COLUMN alert_count, DROP COLUMN last_alert_at;
-- Locking: nullable columns and a constant default only update the catalog. The index build
-- blocks writes to incidents while it runs, which is brief at the current table size.
-- CREATE INDEX CONCURRENTLY cannot run inside the migration transaction.

ALTER TABLE incidents
	ADD COLUMN alert_source_id uuid,
	ADD COLUMN dedup_key text,
	ADD COLUMN alert_count integer NOT NULL DEFAULT 0 CHECK (alert_count >= 0),
	ADD COLUMN last_alert_at timestamptz;

-- At most one unresolved incident per source and key. Grouping upserts against this index,
-- so two workers that see the same new key cannot both open an incident.
-- Manual incidents have NULL keys, which never conflict.
CREATE UNIQUE INDEX incidents_unresolved_group_key
	ON incidents (tenant_id, alert_source_id, dedup_key)
	WHERE status <> 'resolved';
