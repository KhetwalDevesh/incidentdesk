-- Allows the member management audit actions: member.role_changed and member.removed.
-- Spec: docs/features/member-management.md
-- Expand only: the new list contains every old action, so no existing row is affected.
-- Rollback: re-add audit_events_action_check without the two actions, once no row uses them.
-- Locking: re-adding the CHECK scans audit_events once under an ACCESS EXCLUSIVE lock. The
-- 90-day purge keeps the table small, so the lock is brief.

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;

ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
	'tenant.created',
	'member.invited',
	'member.setup_completed',
	'member.role_changed',
	'member.removed',
	'user.login_succeeded',
	'user.login_failed',
	'incident.created',
	'incident.acknowledged',
	'incident.resolved',
	'alert.grouped',
	'alert_source.created',
	'notification_channel.created'
));
