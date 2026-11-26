-- Indexes unresolved incidents by tenant and opening time, for the dashboard's live counts.
-- Spec: docs/features/dashboard-stats.md
-- The load query uses incidents_tenant_assignee_idx from 0012.
-- Rollback: DROP INDEX incidents_tenant_unresolved_idx;
-- Locking: the build blocks writes to incidents while it runs, which is brief at the current
-- table size. CREATE INDEX CONCURRENTLY cannot run inside the migration transaction.

CREATE INDEX incidents_tenant_unresolved_idx ON incidents (tenant_id, created_at)
	WHERE status <> 'resolved';
