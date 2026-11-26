-- Creates on-call schedules, their rotations and overrides, links alert sources to a schedule,
-- and gives incidents an assignee. Lets Slack post one delivery per reassignment.
-- Spec: docs/features/on-call-schedules.md
-- Rollback:
--   ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_event_check,
--     ADD CONSTRAINT notification_deliveries_event_check
--     CHECK (event IN ('incident.opened', 'incident.acknowledged', 'incident.resolved'));
--   (only once no row holds incident.reassigned), then
--   DROP INDEX notification_deliveries_event_key; recreate it on
--   (tenant_id, channel_id, incident_id, event); ALTER TABLE notification_deliveries DROP COLUMN occurrence;
--   ALTER TABLE incidents DROP COLUMN assignee_id, DROP COLUMN assignment_count;
--   ALTER TABLE alert_sources DROP COLUMN on_call_schedule_id;
--   DROP TABLE on_call_overrides, on_call_participants, on_call_schedules;
-- Locking: new tables lock nothing. Nullable columns and constant defaults only update the
-- catalog. Re-adding the delivery event CHECK and rebuilding its unique index scan
-- notification_deliveries under a lock; the 90-day purge keeps it small, so the lock is brief.

CREATE TABLE on_call_schedules (
	tenant_id uuid NOT NULL REFERENCES tenants (id),
	id uuid NOT NULL,
	name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
	-- An IANA zone name. The application checks it is one Node knows.
	time_zone text NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),
	handoff_time time NOT NULL,
	rotation_days integer NOT NULL CHECK (rotation_days BETWEEN 1 AND 28),
	starts_on date NOT NULL,
	is_default boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL,
	PRIMARY KEY (tenant_id, id)
);

CREATE UNIQUE INDEX on_call_schedules_tenant_name_key ON on_call_schedules (tenant_id, name);

-- At most one default schedule per tenant.
CREATE UNIQUE INDEX on_call_schedules_tenant_default_key
	ON on_call_schedules (tenant_id) WHERE is_default;

-- The rotation, in order. Removing a member or a schedule removes its rows, which may leave
-- gaps in position: the rotation is the remaining rows in position order.
CREATE TABLE on_call_participants (
	tenant_id uuid NOT NULL,
	schedule_id uuid NOT NULL,
	position integer NOT NULL CHECK (position >= 0),
	user_id uuid NOT NULL,
	PRIMARY KEY (tenant_id, schedule_id, position),
	FOREIGN KEY (tenant_id, schedule_id) REFERENCES on_call_schedules (tenant_id, id) ON DELETE CASCADE,
	FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX on_call_participants_schedule_user_key
	ON on_call_participants (tenant_id, schedule_id, user_id);

-- Serves the cascade when a member is removed.
CREATE INDEX on_call_participants_tenant_user_idx ON on_call_participants (tenant_id, user_id);

-- Overrides in one schedule never overlap. The repository refuses an overlap while holding a
-- row lock on the schedule, so two concurrent adds cannot both win.
CREATE TABLE on_call_overrides (
	tenant_id uuid NOT NULL,
	id uuid NOT NULL,
	schedule_id uuid NOT NULL,
	user_id uuid NOT NULL,
	starts_at timestamptz NOT NULL,
	ends_at timestamptz NOT NULL,
	-- Who added it. No foreign key: the override outlives the member who added it.
	created_by uuid NOT NULL,
	created_at timestamptz NOT NULL,
	PRIMARY KEY (tenant_id, id),
	CHECK (ends_at > starts_at),
	FOREIGN KEY (tenant_id, schedule_id) REFERENCES on_call_schedules (tenant_id, id) ON DELETE CASCADE,
	FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX on_call_overrides_schedule_ends_idx ON on_call_overrides (tenant_id, schedule_id, ends_at);

CREATE INDEX on_call_overrides_tenant_user_idx ON on_call_overrides (tenant_id, user_id);

-- Deleting a schedule unlinks its sources. SET NULL names the column, so tenant_id is kept.
ALTER TABLE alert_sources
	ADD COLUMN on_call_schedule_id uuid,
	ADD CONSTRAINT alert_sources_on_call_schedule_fkey
		FOREIGN KEY (tenant_id, on_call_schedule_id) REFERENCES on_call_schedules (tenant_id, id)
		ON DELETE SET NULL (on_call_schedule_id);

-- No foreign key from assignee_id: incidents.tenant_id is still text (see 0002). Removing a
-- member unassigns their incidents in the same transaction instead.
-- assignment_count counts manual reassignments, and numbers their Slack deliveries.
ALTER TABLE incidents
	ADD COLUMN assignee_id uuid,
	ADD COLUMN assignment_count integer NOT NULL DEFAULT 0 CHECK (assignment_count >= 0);

CREATE INDEX incidents_tenant_assignee_idx ON incidents (tenant_id, assignee_id)
	WHERE assignee_id IS NOT NULL;

-- A reassignment can happen many times, so each gets its own delivery, numbered by
-- occurrence. Old code writes 0, which keeps one delivery per event as before.
ALTER TABLE notification_deliveries
	ADD COLUMN occurrence integer NOT NULL DEFAULT 0 CHECK (occurrence >= 0),
	DROP CONSTRAINT notification_deliveries_event_check,
	ADD CONSTRAINT notification_deliveries_event_check CHECK (event IN (
		'incident.opened', 'incident.acknowledged', 'incident.resolved', 'incident.reassigned'
	));

DROP INDEX notification_deliveries_event_key;

CREATE UNIQUE INDEX notification_deliveries_event_key
	ON notification_deliveries (tenant_id, channel_id, incident_id, event, occurrence);
