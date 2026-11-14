-- Creates notification_channels: where each tenant's incident alerts are posted.
-- Spec: docs/features/slack-notifications.md (option A, Slack incoming webhooks).
-- Rollback: DROP TABLE notification_channels;
-- Locking: new table only, so nothing large is locked.

CREATE TABLE notification_channels (
	tenant_id uuid NOT NULL REFERENCES tenants (id),
	id uuid NOT NULL,
	kind text NOT NULL CHECK (kind IN ('slack_webhook')),
	name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
	-- The webhook URL is a secret. The application encrypts it before insert.
	target_ciphertext bytea NOT NULL,
	-- Last 4 characters of the URL, for a masked display without decrypting.
	target_hint text NOT NULL CHECK (char_length(target_hint) = 4),
	min_severity text NOT NULL DEFAULT 'sev4' CHECK (min_severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
	enabled boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL,
	PRIMARY KEY (tenant_id, id)
);

CREATE UNIQUE INDEX notification_channels_tenant_name_key ON notification_channels (tenant_id, name);

CREATE INDEX notification_channels_tenant_created_idx ON notification_channels (tenant_id, created_at, id);
