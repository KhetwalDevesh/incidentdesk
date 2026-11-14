-- Creates the incidents table.
-- Rollback: DROP TABLE incidents;
-- Locking: new table, so nothing large is locked.

CREATE TABLE incidents (
	tenant_id text NOT NULL,
	id uuid NOT NULL,
	title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
	severity text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
	status text NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
	created_at timestamptz NOT NULL,
	created_by text NOT NULL,
	acknowledged_at timestamptz,
	acknowledged_by text,
	PRIMARY KEY (tenant_id, id)
);

CREATE INDEX incidents_tenant_created_idx ON incidents (tenant_id, created_at DESC, id);
