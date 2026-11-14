# Resolve an incident

Status: Done

Requested by the user: `POST /v1/incidents/{id}/resolve`. Completes the incident lifecycle.

## Goal

Let a responder mark an incident as fixed, so the team knows it is over and the record shows when it ended.

## User flow

1. A responder opens an incident. It may be acknowledged, but does not have to be.
2. The responder fixes the problem and resolves the incident.
3. The status becomes `resolved`, and the time and user are recorded.

```text
open ──acknowledge──► acknowledged ──resolve──► resolved
  └───────────────────resolve─────────────────────┘
```

Resolving straight from `open` is allowed, for a problem fixed before anyone acknowledged it. Resolving does not set `acknowledgedAt`.

## Permissions

| Action | Viewer | Responder | Admin |
|---|---|---|---|
| Resolve | No | Yes | Yes |

## API changes

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/v1/incidents/{id}/resolve` | 200 with the incident | 401, 403, 404, 409, 422 |

The incident response adds `resolvedAt`, which is null until resolved. `resolvedBy` stays internal.

## Data changes

Migration `0004_add_incident_resolution.sql` adds nullable `resolved_at` and `resolved_by` to `incidents`. The `Incident` entity gains `resolvedAt` and `resolvedBy`. The existing compare-and-set `update` is reused, with the status the service read as the expected status.

## Edge cases and failures

- Already resolved: 409.
- Two simultaneous resolves: one succeeds, and the other gets 409.
- Acknowledge and resolve at the same time on an open incident: whichever lands first wins. If resolve lands first, acknowledge gets 409. If acknowledge lands first, resolve gets 409 and can be retried.
- Acknowledging a resolved incident: 409, as before.

## Security

- Another tenant's incident returns 404 and stays unchanged.
- The resolving user comes from the principal, never the body.
- The request has no body. Any body is ignored.

## Out of scope

- Reopening a resolved incident
- A resolution note or cause
- Notifications and audit log entries

## Done when

- [x] A responder and an admin can resolve an open or acknowledged incident (`tests/incidents.contract.test.ts`, "resolve")
- [x] A viewer gets 403
- [x] Another tenant gets 404, and the incident is unchanged (`tests/security.test.ts`)
- [x] A repeat resolve gets 409, and two simultaneous resolves yield one 200 and one 409
- [x] `resolvedAt` and `resolvedBy` round-trip through Postgres (`tests/incidentRepository.parity.test.ts`)
- [x] Contract regenerated, additive only (no removed lines in `contracts/openapi.yaml`)
- [x] `pnpm check` passes (137 tests). Removing the in-memory status guard fails the 3 race tests
