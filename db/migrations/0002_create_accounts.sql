-- Creates tenants, users and password setup tokens for real authentication.
-- Rollback: DROP TABLE password_setup_tokens, users, tenants;
-- Locking: new tables only, so nothing large is locked.
-- Later: add a foreign key from incidents.tenant_id to tenants once old development rows are gone.

CREATE TABLE tenants (
	id uuid PRIMARY KEY,
	name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
	created_at timestamptz NOT NULL
);

CREATE TABLE users (
	tenant_id uuid NOT NULL REFERENCES tenants (id),
	id uuid NOT NULL,
	email text NOT NULL CHECK (email = lower(email)),
	role text NOT NULL CHECK (role IN ('viewer', 'responder', 'admin')),
	password_hash text,
	created_at timestamptz NOT NULL,
	PRIMARY KEY (tenant_id, id)
);

-- Not tenant-first on purpose: login finds a user by email before the tenant is known.
-- Global uniqueness also enforces one tenant per user.
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE INDEX users_tenant_created_idx ON users (tenant_id, created_at, id);

-- Only the SHA-256 of each token is stored.
CREATE TABLE password_setup_tokens (
	token_hash text PRIMARY KEY,
	tenant_id uuid NOT NULL,
	user_id uuid NOT NULL,
	expires_at timestamptz NOT NULL,
	used_at timestamptz,
	FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX password_setup_tokens_tenant_user_idx ON password_setup_tokens (tenant_id, user_id);
