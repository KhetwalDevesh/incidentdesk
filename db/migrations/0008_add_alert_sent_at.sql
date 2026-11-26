-- Records when an alert's queue message was confirmed sent, so the outbox sweeper can tell a
-- lost send (re-sent after 2 minutes) from a message still waiting in a slow queue (re-sent
-- only after 15 minutes). Alerts pending at deploy keep it NULL, so the first sweep moves the
-- old Postgres queue's backlog onto SQS.
-- Spec: docs/features/alert-queue-sqs.md
-- Expand only: nothing stops reading a column in this release.
-- Rollback: ALTER TABLE alerts DROP COLUMN sent_at; (once no code reads it)
-- Locking: a nullable column with no default only updates the catalog, so the lock is brief.
-- The sweeper's scan is served by the existing alerts_pending_due_idx.

ALTER TABLE alerts ADD COLUMN sent_at timestamptz;
