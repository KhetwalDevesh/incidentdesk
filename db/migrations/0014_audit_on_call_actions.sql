-- Allows the on-call audit actions and the on_call_schedule resource type.
-- Spec: docs/features/on-call-schedules.md
-- Expand only: each new list contains every old value, so no existing row is affected.
-- Rollback: re-add both CHECKs without the new values, once no row uses them.
-- Locking: re-adding the CHECKs scans audit_events under an ACCESS EXCLUSIVE lock. The 90-day
-- purge keeps the table small, so the lock is brief.

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
	'incident.assigned',
	'alert.grouped',
	'alert_source.created',
	'alert_source.updated',
	'notification_channel.created',
	'on_call_schedule.created',
	'on_call_schedule.updated',
	'on_call_schedule.deleted',
	'on_call_override.created',
	'on_call_override.deleted'
));

ALTER TABLE audit_events DROP CONSTRAINT audit_events_resource_type_check;

ALTER TABLE audit_events ADD CONSTRAINT audit_events_resource_type_check CHECK (resource_type IN (
	'tenant', 'user', 'incident', 'alert_source', 'notification_channel', 'on_call_schedule'
));
