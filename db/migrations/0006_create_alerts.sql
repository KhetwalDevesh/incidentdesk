-- Creates alerts: the ingestion queue and the history of every accepted alert.
-- Spec: docs/features/alert-ingestion.md
-- Rollback: DROP TABLE alerts;
-- Locking: new table only, so nothing large is locked.

CREATE TABLE alerts (
	tenant_id uuid NOT NULL,
	id uuid NOT NULL,
	source_id uuid NOT NULL,
	dedup_key text NOT NULL CHECK (char_length(dedup_key) BETWEEN 1 AND 200),
	title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
	severity text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
	alert_status text NOT NULL CHECK (alert_status IN ('firing', 'resolved')),
	details jsonb NOT NULL DEFAULT '{}',
	received_at timestamptz NOT NULL,
	state text NOT NULL CHECK (state IN ('pending', 'processed', 'failed')),
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	next_attempt_at timestamptz NOT NULL,
	-- Internal error text. Never returned by the API.
	last_error text,
	incident_id uuid,
	processed_at timestamptz,
	PRIMARY KEY (tenant_id, id),
	FOREIGN KEY (tenant_id, source_id) REFERENCES alert_sources (tenant_id, id)
);

-- Not tenant-first on purpose: the worker claims due alerts across every tenant.
CREATE INDEX alerts_pending_due_idx ON alerts (next_attempt_at) WHERE state = 'pending';

CREATE INDEX alerts_tenant_received_idx ON alerts (tenant_id, received_at DESC, id);
