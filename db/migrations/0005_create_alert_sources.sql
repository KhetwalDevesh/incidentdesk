-- Creates alert_sources: monitoring tools allowed to post alerts for a tenant.
-- Spec: docs/features/alert-ingestion.md
-- Rollback: DROP TABLE alert_sources;
-- Locking: new table only, so nothing large is locked.

CREATE TABLE alert_sources (
	tenant_id uuid NOT NULL REFERENCES tenants (id),
	id uuid NOT NULL,
	name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
	-- The HMAC signing secret. The application encrypts it before insert. It is not hashed,
	-- because verifying a signature needs the plaintext.
	secret_ciphertext bytea NOT NULL,
	-- Last 4 characters of the secret, for a masked display without decrypting.
	secret_hint text NOT NULL CHECK (char_length(secret_hint) = 4),
	created_at timestamptz NOT NULL,
	PRIMARY KEY (tenant_id, id)
);

CREATE UNIQUE INDEX alert_sources_tenant_name_key ON alert_sources (tenant_id, name);

CREATE INDEX alert_sources_tenant_created_idx ON alert_sources (tenant_id, created_at, id);

-- Not tenant-first on purpose: the webhook finds a source by id before the tenant is known.
CREATE UNIQUE INDEX alert_sources_id_key ON alert_sources (id);
