-- Removes the viewer role, contract step: the database no longer accepts it.
-- Spec: docs/features/on-call-schedules.md. 0013 was the expand step, and every release since
-- has stopped reading or writing 'viewer'.
-- First converts any viewer still present, as 0013 did: one an old instance wrote while that
-- release rolled out. Each change is audited as member.role_changed with an anonymous actor.
-- Rollback: ALTER TABLE users DROP CONSTRAINT users_role_check, ADD CONSTRAINT users_role_check
--   CHECK (role IN ('viewer', 'responder', 'admin')); the converted rows stay responders.
-- Locking: re-adding the CHECK scans users once under an ACCESS EXCLUSIVE lock. The table holds
-- one row per member, so the lock is brief.

INSERT INTO audit_events
	(tenant_id, id, occurred_at, actor_type, actor_id, action, resource_type, resource_id, details, request_id)
SELECT tenant_id::text, gen_random_uuid(), now(), 'anonymous', NULL, 'member.role_changed',
	'user', id::text, jsonb_build_object('from', 'viewer', 'to', 'responder'), NULL
FROM users
WHERE role = 'viewer';

UPDATE users SET role = 'responder' WHERE role = 'viewer';

ALTER TABLE users DROP CONSTRAINT users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('responder', 'admin'));
