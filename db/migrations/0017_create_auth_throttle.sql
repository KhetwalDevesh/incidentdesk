-- Creates auth_throttle: counts of failed sign-ins and other public auth attempts per key, and
-- the locks they cause. Allows the user.login_locked audit action.
-- Spec: docs/features/login-rate-limiting.md
-- Not tenant-owned: these routes run before any tenant is known, like the global email index
-- on users. Keys never hold an email: emails are stored only as a SHA-256 hash.
-- Rollback: DROP TABLE auth_throttle; and re-add audit_events_action_check without
--   user.login_locked, once no row uses it.
-- Locking: the new table locks nothing. Re-adding the audit CHECK scans audit_events under an
-- ACCESS EXCLUSIVE lock; the 90-day purge keeps it small, so the lock is brief.

CREATE TABLE auth_throttle (
	-- Such as login:email:<sha256>, login:ip:<ip>, setup:ip:<ip> or signup:ip:<ip>.
	key text PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 200),
	window_started_at timestamptz NOT NULL,
	count integer NOT NULL CHECK (count >= 0),
	locked_until timestamptz,
	updated_at timestamptz NOT NULL
);

-- Not tenant-first on purpose: the purge removes stale keys across every caller.
CREATE INDEX auth_throttle_updated_idx ON auth_throttle (updated_at);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;

ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
	'tenant.created',
	'member.invited',
	'member.setup_completed',
	'member.role_changed',
	'member.removed',
	'user.login_succeeded',
	'user.login_failed',
	'user.login_locked',
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
