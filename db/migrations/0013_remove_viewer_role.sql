-- Removes the viewer role, expand step: every viewer becomes a responder.
-- Spec: docs/features/on-call-schedules.md
-- Each change is audited as member.role_changed with an anonymous actor, the existing actor
-- type for a change no signed-in person made.
-- Contract step, in a later release: once no row holds 'viewer', a new migration drops it
-- from users_role_check. It stays allowed here, because an instance still running the old
-- code may write it while the deploy rolls out. New code reads a stray 'viewer' as responder.
-- Rollback: none needed for the data, which is valid either way. The audit entries stay.
-- Locking: updates only viewer rows in users, which is small.

INSERT INTO audit_events
	(tenant_id, id, occurred_at, actor_type, actor_id, action, resource_type, resource_id, details, request_id)
SELECT tenant_id::text, gen_random_uuid(), now(), 'anonymous', NULL, 'member.role_changed',
	'user', id::text, jsonb_build_object('from', 'viewer', 'to', 'responder'), NULL
FROM users
WHERE role = 'viewer';

UPDATE users SET role = 'responder' WHERE role = 'viewer';
