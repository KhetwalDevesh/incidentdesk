-- Creates incident_postmortem_drafts (AI suggestions, and the worker's job queue) and
-- incident_postmortems (one document per incident), and allows the postmortem.saved and
-- postmortem.published audit actions.
-- Spec: docs/features/ai-postmortems.md
-- Rollback: DROP TABLE incident_postmortems, incident_postmortem_drafts; and re-add
--   audit_events_action_check without the two actions, once no row uses them.
-- Locking: new tables lock nothing. Re-adding the audit CHECK scans audit_events under a brief
-- ACCESS EXCLUSIVE lock.

-- The same shape as incident_summary_drafts (0018), with the sections in content.
CREATE TABLE incident_postmortem_drafts (
	tenant_id text NOT NULL,
	id uuid NOT NULL,
	incident_id uuid NOT NULL,
	state text NOT NULL CHECK (state IN ('pending', 'ready', 'failed', 'skipped')),
	-- The validated sections. Checked by the application's schema before it is stored.
	content jsonb,
	model text CHECK (char_length(model) BETWEEN 1 AND 200),
	failure_reason text CHECK (failure_reason IN (
		'provider_error', 'invalid_output', 'over_daily_cap', 'ai_disabled'
	)),
	requested_by text,
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	next_attempt_at timestamptz NOT NULL,
	input_tokens integer CHECK (input_tokens >= 0),
	output_tokens integer CHECK (output_tokens >= 0),
	last_error text,
	created_at timestamptz NOT NULL,
	completed_at timestamptz,
	PRIMARY KEY (tenant_id, id),
	CHECK ((state = 'ready') = (content IS NOT NULL AND model IS NOT NULL)),
	CHECK ((state IN ('failed', 'skipped')) = (failure_reason IS NOT NULL)),
	CHECK ((state = 'pending') = (completed_at IS NULL))
);

CREATE UNIQUE INDEX incident_postmortem_drafts_pending_key
	ON incident_postmortem_drafts (tenant_id, incident_id) WHERE state = 'pending';

CREATE INDEX incident_postmortem_drafts_incident_idx
	ON incident_postmortem_drafts (tenant_id, incident_id, created_at DESC, id);

-- The shared daily cap counts both kinds of draft since midnight UTC.
CREATE INDEX incident_postmortem_drafts_tenant_created_idx
	ON incident_postmortem_drafts (tenant_id, created_at);

-- Not tenant-first on purpose: the worker claims due drafts across every tenant.
CREATE INDEX incident_postmortem_drafts_pending_due_idx
	ON incident_postmortem_drafts (next_attempt_at) WHERE state = 'pending';

CREATE TABLE incident_postmortems (
	tenant_id text NOT NULL,
	incident_id uuid NOT NULL,
	-- Markdown, written by members or started from a draft. Never sent to Slack or logged.
	body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
	state text NOT NULL CHECK (state IN ('draft', 'published')),
	-- The draft it was started from, if any. No foreign key: the body outlives the draft.
	draft_id uuid,
	updated_by text NOT NULL,
	updated_at timestamptz NOT NULL,
	published_by text,
	published_at timestamptz,
	PRIMARY KEY (tenant_id, incident_id),
	CHECK ((state = 'published') = (published_at IS NOT NULL AND published_by IS NOT NULL))
);

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
	'postmortem.saved',
	'postmortem.published',
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
