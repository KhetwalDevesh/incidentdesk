-- Creates incident_summary_drafts: AI-written suggestions for an incident's summary and
-- severity, which are also the worker's job queue. Gives incidents an accepted summary, and
-- allows the incident.summary_set and incident.severity_changed audit actions.
-- Spec: docs/features/ai-summaries.md
-- Rollback: DROP TABLE incident_summary_drafts;
--   ALTER TABLE incidents DROP COLUMN summary, DROP COLUMN summary_updated_at,
--     DROP COLUMN summary_updated_by, DROP COLUMN summary_draft_id;
--   re-add audit_events_action_check without the two actions, once no row uses them.
-- Locking: the new table locks nothing. Nullable columns on incidents only update the catalog.
-- Re-adding the audit CHECK scans audit_events under a brief ACCESS EXCLUSIVE lock.

-- tenant_id is text, like incidents.tenant_id (see 0002).
CREATE TABLE incident_summary_drafts (
	tenant_id text NOT NULL,
	id uuid NOT NULL,
	incident_id uuid NOT NULL,
	state text NOT NULL CHECK (state IN ('pending', 'ready', 'failed', 'skipped')),
	summary text CHECK (char_length(summary) BETWEEN 1 AND 600),
	suggested_severity text CHECK (suggested_severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
	rationale text CHECK (char_length(rationale) BETWEEN 1 AND 300),
	-- The model that wrote a ready draft, as the provider reported it.
	model text CHECK (char_length(model) BETWEEN 1 AND 200),
	failure_reason text CHECK (failure_reason IN (
		'provider_error', 'invalid_output', 'over_daily_cap', 'ai_disabled'
	)),
	-- A member id, or null for a draft made when the incident opened.
	requested_by text,
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	next_attempt_at timestamptz NOT NULL,
	-- Never returned by the API.
	input_tokens integer CHECK (input_tokens >= 0),
	output_tokens integer CHECK (output_tokens >= 0),
	-- A fixed description, never the provider's raw message or any prompt text.
	last_error text,
	created_at timestamptz NOT NULL,
	completed_at timestamptz,
	PRIMARY KEY (tenant_id, id),
	CHECK ((state = 'ready') = (summary IS NOT NULL AND suggested_severity IS NOT NULL AND rationale IS NOT NULL AND model IS NOT NULL)),
	CHECK ((state IN ('failed', 'skipped')) = (failure_reason IS NOT NULL)),
	CHECK ((state = 'pending') = (completed_at IS NULL))
);

-- One pending draft per incident: asking again returns it.
CREATE UNIQUE INDEX incident_summary_drafts_pending_key
	ON incident_summary_drafts (tenant_id, incident_id) WHERE state = 'pending';

CREATE INDEX incident_summary_drafts_incident_idx
	ON incident_summary_drafts (tenant_id, incident_id, created_at DESC, id);

-- The daily cap counts a tenant's drafts since midnight UTC.
CREATE INDEX incident_summary_drafts_tenant_created_idx
	ON incident_summary_drafts (tenant_id, created_at);

-- Not tenant-first on purpose: the worker claims due drafts across every tenant.
CREATE INDEX incident_summary_drafts_pending_due_idx
	ON incident_summary_drafts (next_attempt_at) WHERE state = 'pending';

ALTER TABLE incidents
	ADD COLUMN summary text CHECK (char_length(summary) BETWEEN 1 AND 2000),
	ADD COLUMN summary_updated_at timestamptz,
	ADD COLUMN summary_updated_by text,
	-- The draft accepted, or null for a summary written by hand. No foreign key: drafts are
	-- keyed by (tenant_id, id), and the summary stays if a draft is ever removed.
	ADD COLUMN summary_draft_id uuid,
	ADD CONSTRAINT incidents_summary_complete_check
		CHECK ((summary IS NULL) = (summary_updated_at IS NULL AND summary_updated_by IS NULL));

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
	'incident.summary_set',
	'incident.severity_changed',
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
