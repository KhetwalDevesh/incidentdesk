-- Creates audit_events: an append-only record of every change and sign-in in a tenant.
-- Spec: docs/features/audit-log.md
-- Rollback: DROP TABLE audit_events; DROP FUNCTION audit_events_guard();
-- Locking: new table only, so nothing existing is locked.

-- tenant_id is text with no foreign key, like incidents.tenant_id, so events for every
-- table can be recorded. seq orders events written in the same instant.
CREATE TABLE audit_events (
	tenant_id text NOT NULL,
	id uuid NOT NULL,
	seq bigint GENERATED ALWAYS AS IDENTITY,
	occurred_at timestamptz NOT NULL,
	actor_type text NOT NULL CHECK (actor_type IN ('user', 'alert_source', 'anonymous')),
	actor_id text CHECK ((actor_type = 'anonymous') = (actor_id IS NULL)),
	action text NOT NULL CHECK (action IN (
		'tenant.created',
		'member.invited',
		'member.setup_completed',
		'user.login_succeeded',
		'user.login_failed',
		'incident.created',
		'incident.acknowledged',
		'incident.resolved',
		'alert.grouped',
		'alert_source.created',
		'notification_channel.created'
	)),
	resource_type text NOT NULL CHECK (resource_type IN (
		'tenant', 'user', 'incident', 'alert_source', 'notification_channel'
	)),
	resource_id text NOT NULL,
	details jsonb NOT NULL DEFAULT '{}',
	request_id text,
	PRIMARY KEY (tenant_id, id)
);

CREATE INDEX audit_events_tenant_occurred_idx ON audit_events (tenant_id, occurred_at DESC, seq DESC);
CREATE INDEX audit_events_tenant_resource_idx
	ON audit_events (tenant_id, resource_type, resource_id, occurred_at, seq);
-- Not tenant-first on purpose: the purge removes old events across every tenant.
CREATE INDEX audit_events_occurred_idx ON audit_events (occurred_at);

-- Append-only, even if application code has a bug: no row can change, and only rows older
-- than the 90-day retention can be deleted. TRUNCATE, used by test schemas, is not a row event.
CREATE FUNCTION audit_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'audit events cannot be changed' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF OLD.occurred_at > now() - interval '90 days' THEN
		RAISE EXCEPTION 'audit events younger than 90 days cannot be deleted'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN OLD;
END;
$$;

CREATE TRIGGER audit_events_append_only
	BEFORE UPDATE OR DELETE ON audit_events
	FOR EACH ROW EXECUTE FUNCTION audit_events_guard();
