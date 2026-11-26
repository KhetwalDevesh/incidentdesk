# Member management

Status: Approved

Phase 2, finishing "tenants, roles": an admin changes a member's role and removes a member. Both were out of scope in `docs/features/real-authentication.md`.

Decided by the user:

| Question | Decision |
|---|---|
| Removal | Hard delete: the user row and its setup tokens are deleted. The email becomes free again |
| Last admin | Refused: a tenant always keeps at least one active admin |
| Self-changes | Refused: an admin cannot change their own role or remove themselves. Another admin must do it |
| Pending members | Removable. Removing one cancels the invite, so its unused setup token stops working |
| Removed members | Can be invited again with the same email |
| Who may do it | Admins only |
| Out of scope | Ownership transfer (an owner role above admin), a token revocation list, bulk changes, and restoring a removed member (invite them again instead) |
| Who counts as the one admin | Only an active admin, one who has set a password. A pending admin cannot sign in |
| Setting the current role | 200 with no change and no audit event |
| New audit actions | `member.role_changed` and `member.removed` are added to the response enum now, since nothing reads the audit log yet |
| Invite email | Not sent. The admin passes the setup token on, as today. Invite email and password reset will be a separate feature |

## Goal

Let an admin keep a team's access correct as people change jobs or leave: promote a responder to admin, demote an admin to viewer, cancel an invite sent to the wrong address, or remove someone who has left, with the change taking effect on that person's next request.

## User flow

1. An admin changes a member's role with `PATCH /v1/members/{id}` and `{ "role": "responder" }`. The member's next request uses the new role, because every request reloads the user.
2. An admin removes a member with `DELETE /v1/members/{id}`. The user row and any setup token are deleted. The member's next request with their old token gets 401, and an unused setup token gets 401 at `/v1/auth/setup-password`.
3. The admin can invite the same email again with `POST /v1/members`.
4. Each change writes an audit event in the same transaction: `member.role_changed` or `member.removed`.

## Permissions

| Action | Viewer | Responder | Admin |
|---|---|---|---|
| Change a member's role | No | No | Yes, not their own |
| Remove a member | No | No | Yes, not themselves |

Neither action may leave the tenant without an active admin, meaning an admin who has set a password.

## API changes

Additive only.

| Method | Path | Success | Errors |
|---|---|---|---|
| PATCH | `/v1/members/{id}` with `{ role }` | 200 `Member` | 401, 403 (not an admin), 404 (unknown member, or another tenant's), 409 (own role, or the last active admin), 422 (malformed id or body) |
| DELETE | `/v1/members/{id}` | 204, no body | 401, 403, 404, 409 (themselves, or the last active admin), 422 (malformed id) |

- `UpdateMemberRequest` is strict: `{ role: "viewer" | "responder" | "admin" }`.
- Setting the role a member already has returns 200 with the member unchanged, and writes no audit event.
- `AuditEvent.action` gains `member.role_changed` and `member.removed`. Nothing reads the audit log yet (the dashboard is Phase 4), so adding them now breaks no client. From here on, clients must show an action they do not know as plain text.

## Data changes

No new table and no new column.

- Migration `0010_audit_member_actions.sql` widens the `audit_events.action` CHECK constraint to include the two new actions. It drops and re-adds the constraint, which scans the table once under a brief lock. That is fine at current size, and the purge keeps the table bounded.
- `password_setup_tokens` already references `users` with `ON DELETE CASCADE`, so deleting a user deletes its tokens.
- Incidents keep `createdBy`, `acknowledgedBy` and `resolvedBy` as plain user ids, with no foreign key, so history survives a removal and shows the bare id.

Code:

- `AccountRepository.changeRole(tenantId, userId, role, audit)` and `AccountRepository.removeUser(tenantId, userId, audit)`. Each returns its outcome: `changed`, `unchanged` (role only), `removed`, `not_found` or `last_admin`. Each runs in one transaction that first locks the tenant's active admins (`FOR UPDATE`), so two admins demoting or removing each other at the same time cannot leave the tenant with none. The in-memory twin checks and writes with no `await` in between.
- `audit` builds the entry from the member as found. Its details are `member.role_changed { from, to }` and `member.removed { role, status }`.
- The member service checks that the caller is an admin and is not changing themselves, then maps the outcome to a result.
- Contract `UpdateMemberRequestSchema`, two routes in `src/routes/members.ts`, registered in `openapi.ts`.

## Edge cases and failures

- Two admins demote or remove each other at the same time: the admin rows are locked, so the second request waits, then sees one admin left and gets 409.
- The last active admin is targeted while a pending admin exists: still 409. A pending admin cannot sign in until they set a password, so they do not count.
- An admin changes or removes themselves: 409, even when other admins exist (user decision).
- A demoted admin is mid-session: their next admin-only request gets 403, because the role is read from the database on every request.
- A removed member is mid-session: their next request gets 401, the same as an invalid token.
- A removed pending member's setup token is used: 401 "Setup token is invalid, used or expired", the same answer as for any bad token.
- The removed email is invited again: a new user with a new id. Their old incidents and audit events keep the old id.
- Removing a member who does not exist, or who belongs to another tenant: 404.
- Setting the current role: 200, no change, no audit event.

## Security

- **Tenant boundary:** `tenantId` comes from the principal, and repository methods take it first. Another tenant's member returns 404, not 403. Isolation tests cover both routes.
- **Authorization:** admin only, checked in the service. The self-change and last-admin guards hold even when an admin's client misbehaves.
- **Race safety:** the last-admin rule is enforced inside the transaction under a row lock, not by a check before it.
- **Audit details:** only the role and status, never the email. Hard delete also removes the email from the `users` table.
- **Access ends:** every request reloads the user, so a removed member loses access on their next request without a token blocklist.

## Out of scope

- Ownership transfer, or an owner role above admin
- A token revocation list. It is not needed, because every request reloads the user
- Bulk changes, and restoring a removed member (they are invited again instead)
- Sending invite emails, and password reset: a separate feature
- Changing a member's email
- Members leaving a tenant by themselves

## Done when

- [ ] An admin changes a pending or active member's role, and setting the current role is a no-op (`tests/members.contract.test.ts`)
- [ ] An admin removes an active member, whose old token then gets 401, and a pending member, whose setup token then gets 401 (`tests/members.contract.test.ts`)
- [ ] A removed email can be invited again (`tests/members.contract.test.ts`)
- [ ] Self-changes and removing or demoting the last active admin get 409, and concurrent cross-demotion leaves exactly one admin (`tests/members.contract.test.ts`, `tests/accountRepository.parity.test.ts`)
- [ ] Viewers and responders get 403. Another tenant's member gets 404 (`tests/security.test.ts`, "member management")
- [ ] Each change writes one `member.role_changed { from, to }` or `member.removed { role, status }` event in its transaction, and a no-op writes none (`tests/audit.contract.test.ts`)
- [ ] Contract regenerated, additive only (no removed lines in `contracts/openapi.yaml`)
- [ ] `pnpm check` passes
