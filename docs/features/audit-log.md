# Audit log

Status: Approved

Records every change in a tenant, and every sign-in, as an append-only event. Product spec, core flow step 6: "Every action is written to an audit log."

Decided by the user:

| Question | Decision |
|---|---|
| What is recorded | Incident lifecycle (including alert grouping), members and access, configuration, and sign-ins (successful and failed) |
| Who may read it | Every role (viewer, responder, admin) reads the whole tenant log |
| Retention | Append-only. Entries older than 90 days are purged. Nothing else can change or delete an entry |
| Read API | Both: a tenant-wide list with filters, and a per-incident timeline |
| Write consistency | Audited changes write their event in the same transaction, so a change never exists without its event |
| Sign-in events | Written after the response, not awaited, so timing never reveals whether an email exists. A lost sign-in event is accepted |
| Unknown emails | A failed login for an email no account has records nothing: there is no tenant to record it in |
| Actor and resource identity | Ids only. Names and emails are joined in by the Phase 4 dashboard |

## Goal

Give every member of a team a trustworthy record of who did what and when: who opened, acknowledged and resolved an incident, which alerts were grouped into it, who invited whom, who changed the configuration, and who signed in. The record must be complete, so an entry is written in the same transaction as the change it describes, and it must not be editable, so no API, code path or database statement can alter it.

## User flow

1. A member, an alert source or the worker makes a change. In the same database transaction, the change writes an audit event: actor, action, resource, a small allowlisted `details` object, the time and the request id.
2. A sign-in attempt for a known email writes `user.login_succeeded` or `user.login_failed` after the response is sent, so recording it never changes response timing.
3. Any member reads the tenant log at `GET /v1/audit-events`, newest first, filtered by action, resource, actor or time range.
4. Any member reads an incident's timeline at `GET /v1/incidents/{id}/events`, oldest first.
5. The worker purges entries older than 90 days, hourly, in batches.

### Events

| Action | Actor | Resource | `details` (allowlist) |
|---|---|---|---|
| `tenant.created` | the new user | tenant | `{ name }` |
| `member.invited` | the admin | the invited user | `{ role }` |
| `member.setup_completed` | the invited user | that user | `{}` |
| `user.login_succeeded` | that user | that user | `{}` |
| `user.login_failed` | anonymous | the user the email belongs to | `{}` |
| `incident.created` | a user, or an alert source | incident | `{ title, severity }` |
| `incident.acknowledged` | the user | incident | `{}` |
| `incident.resolved` | the user | incident | `{}` |
| `alert.grouped` | the alert source | incident | `{ alertId, dedupKey }` |
| `alert_source.created` | the admin | alert source | `{ name }` |
| `notification_channel.created` | the admin | notification channel | `{ name, type }` |

An alert that opens a new incident writes `incident.created` with the alert source as actor, and `alert.grouped` for itself. A resolved alert that attaches to nothing writes no event: no incident changed.

## Permissions

| Action | Viewer | Responder | Admin |
|---|---|---|---|
| List the tenant's audit events | Yes | Yes | Yes |
| Read an incident's timeline | Yes | Yes | Yes |
| Create, change or delete an audit event | No | No | No |

Events are written only by the code paths above, never through the API.

## API changes

Additive only. No existing field, route or status changes.

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/v1/audit-events?action=&resourceType=&resourceId=&actorId=&from=&to=&limit=&offset=` | 200 `{ items, total, limit, offset }`, newest first | 401, 422 (unknown action or resource type, malformed time, `from` after `to`) |
| GET | `/v1/incidents/{id}/events?limit=&offset=` | 200 `{ items, total, limit, offset }`, oldest first | 401, 404 (unknown incident, or another tenant's), 422 |

`AuditEvent` response (strict):

```json
{
  "id": "uuid",
  "occurredAt": "2026-11-26T10:00:00.000Z",
  "action": "incident.acknowledged",
  "actor": { "type": "user", "id": "uuid" },
  "resource": { "type": "incident", "id": "uuid" },
  "details": {},
  "requestId": "uuid or null"
}
```

- `actor.type` is `user`, `alert_source` or `anonymous`. `actor.id` is null for `anonymous`.
- `action` and `resource.type` are enums. A new value is added to the response enum only once clients can read it (api rule).
- `requestId` is null for events the worker writes.

## Data changes

Migration `0009_create_audit_events.sql`:

- `audit_events (tenant_id, id, occurred_at, actor_type, actor_id, action, resource_type, resource_id, details jsonb, request_id)`, primary key `(tenant_id, id)`, with CHECK constraints on the enum columns.
- Indexes: `(tenant_id, occurred_at DESC, id)` for the list, `(tenant_id, resource_type, resource_id, occurred_at, id)` for timelines and resource filters, and `(occurred_at)` for the cross-tenant purge. The last is not tenant-first on purpose, like `alerts_pending_due_idx`.
- A trigger rejects every `UPDATE`, and every `DELETE` of a row younger than 90 days. Only the purge can delete, and only old rows, even if application code has a bug. `TRUNCATE` in test schemas is unaffected.

Code:

- Domain `src/domain/audit/types.ts`:
  - an `AuditEntry` type;
  - an `AuditEventReader` port (`list`, `listForResource`, both tenant-first);
  - an `AuditPurger` port (`purgeOlderThan(cutoff, limit)`), cross-tenant, used only by the worker.
- Atomic writes: each write method that makes an audited change takes the `AuditEntry` and inserts it in its own transaction. That covers incident `create` and `update`, account `signup`, `addMember` and `setupPassword`, source and channel `create`, and alert `complete`. The in-memory repositories share one in-memory audit store, as the alert repository already shares the incident store.
- Sign-ins: the auth service records them through a separate `AuditRecorder` port, after the response, without awaiting. A failed write is logged by event id only.
- Services build entries. They take the actor from the principal or the verified source, and the request id from the HTTP context. They inject the clock and id generator.
- Contract `src/contract/audit.ts`, two routes, a mapper (allowlist), parity tests for the repositories, and the purge loop in `src/worker.ts`.

## Edge cases and failures

- The audit insert fails: the change rolls back too and the request returns 500. A change never exists without its event.
- Two responders acknowledge at once: only the compare-and-set winner writes `incident.acknowledged`. The loser gets 409 and writes nothing.
- A duplicate alert message: `complete()` returns null without grouping, so no second `alert.grouped`.
- A failed login for an email no account has: nothing is recorded, since there is no tenant to record it in.
- A failed login for a known email: recorded after the response, not awaited, so timing does not reveal that the email exists. If the write fails, the event is lost and the error is logged by event id. This is accepted for sign-in events only.
- Many failed logins: each one is recorded. Rate limiting is out of scope.
- `from` later than `to`, or a malformed time: 422.
- An incident timeline for another tenant's incident, or an unknown one: 404.
- The purge runs in several workers at once: deletes by `(occurred_at < cutoff)` in batches with `FOR UPDATE SKIP LOCKED`, so the workers never conflict.
- An event refers to a resource that no longer exists: it is kept. Events outlive their resources.

## Security

- **Tenant boundary:** every read takes `tenantId` from the principal, and every repository method takes it first. Another tenant's incident timeline returns 404. Isolation tests cover both routes and the purge.
- **Who reads it:** every role reads the whole log (user decision). So `details` carries no secrets and no personal data beyond ids:
  - never passwords, tokens, setup tokens, source secrets, secret hints or webhook URLs;
  - never the email typed at a failed login;
  - actors and resources are ids only.
- **Integrity:** no write API. A database trigger blocks `UPDATE`, and `DELETE` of anything younger than 90 days. Writes share the change's transaction.
- **Untrusted input:** an alert's `title` and `dedupKey` come from a monitoring tool. They are stored and returned as data. Clients must render them as text.
- **Timing:** sign-in events never delay the response.
- **Logs:** a failed audit write logs the event id and action, never `details`.

## Out of scope

- Resolving actor and resource ids to names or emails. The Phase 4 dashboard joins them.
- Export, streaming to a SIEM, or webhooks for audit events
- Recording reads, such as who viewed an incident
- Alert processing failures (already visible at `GET /v1/alerts?state=failed`) and sweeper re-sends
- Rate limiting sign-ins
- Configurable retention per tenant
- Events for actions that do not exist yet: role changes, member removal, deleting a source or channel

## Done when

- [ ] Each action in the events table writes exactly one event with the documented actor, resource and `details`, in the same transaction as the change (`tests/audit.contract.test.ts`, `tests/auditRepository.parity.test.ts`)
- [ ] A failing audit insert rolls back the change (`tests/auditRepository.parity.test.ts`)
- [ ] The compare-and-set loser and a duplicate alert message write no event (`tests/audit.contract.test.ts`)
- [ ] Sign-ins are recorded for known emails only, and never delay or fail the login response (`src/services/auth/authService.test.ts`)
- [ ] `GET /v1/audit-events` lists newest first, filters by action, resource, actor and time range, paginates, and rejects bad filters with 422. All three roles can read it (`tests/audit.contract.test.ts`)
- [ ] `GET /v1/incidents/{id}/events` returns the timeline oldest first, and 404 for another tenant's incident (`tests/audit.contract.test.ts`, `tests/security.test.ts`)
- [ ] No response contains a password, token, secret, secret hint, webhook URL or a failed login's email (`tests/security.test.ts`)
- [ ] The trigger rejects `UPDATE`, and `DELETE` of rows younger than 90 days. The purge deletes only older rows (`tests/auditRepository.parity.test.ts`)
- [ ] Contract regenerated, additive only (no removed lines in `contracts/openapi.yaml`)
- [ ] Tenant isolation tests for both routes and the purge (`tests/security.test.ts`, "audit log")
- [ ] `pnpm check` passes
