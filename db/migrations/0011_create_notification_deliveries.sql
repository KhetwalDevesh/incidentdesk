-- Creates notification_deliveries: one row per channel per incident event posted to Slack.
-- Spec: docs/features/slack-delivery.md
-- Rollback: DROP TABLE notification_deliveries;
-- Locking: new table only, so nothing existing is locked.

-- tenant_id is uuid, like notification_channels, so the channel foreign key holds. There is
-- no foreign key to incidents, whose tenant_id is still text (see 0002).
CREATE TABLE notification_deliveries (
	tenant_id uuid NOT NULL,
	id uuid NOT NULL,
	channel_id uuid NOT NULL,
	incident_id uuid NOT NULL,
	event text NOT NULL CHECK (event IN ('incident.opened', 'incident.acknowledged', 'incident.resolved')),
	-- The message snapshot. Never the webhook URL. The actor's email is removed once the
	-- delivery is no longer pending.
	payload jsonb NOT NULL,
	state text NOT NULL CHECK (state IN ('pending', 'delivered', 'failed')),
	-- Counted attempts. A rate-limited (429) attempt is not counted.
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	next_attempt_at timestamptz NOT NULL,
	-- When a queue message for this delivery was last confirmed sent. Null until one is.
	sent_at timestamptz,
	failure_reason text CHECK (failure_reason IN ('rejected', 'unavailable', 'host_not_allowed')),
	last_status integer CHECK (last_status BETWEEN 100 AND 599),
	-- Internal error text. Never returned by the API.
	last_error text,
	created_at timestamptz NOT NULL,
	delivered_at timestamptz,
	PRIMARY KEY (tenant_id, id),
	FOREIGN KEY (tenant_id, channel_id) REFERENCES notification_channels (tenant_id, id),
	CHECK ((state = 'failed') = (failure_reason IS NOT NULL)),
	CHECK ((state = 'delivered') = (delivered_at IS NOT NULL))
);

-- One delivery per channel per incident event, so a retried incident change cannot post twice.
CREATE UNIQUE INDEX notification_deliveries_event_key
	ON notification_deliveries (tenant_id, channel_id, incident_id, event);

CREATE INDEX notification_deliveries_channel_created_idx
	ON notification_deliveries (tenant_id, channel_id, created_at DESC, id);

-- Not tenant-first on purpose: the sweeper claims due deliveries across every tenant.
CREATE INDEX notification_deliveries_pending_due_idx
	ON notification_deliveries (next_attempt_at) WHERE state = 'pending';

-- Not tenant-first on purpose: the 90-day purge runs across every tenant.
CREATE INDEX notification_deliveries_created_idx ON notification_deliveries (created_at);
