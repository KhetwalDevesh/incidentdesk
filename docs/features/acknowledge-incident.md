# Acknowledge an incident

Status: Approved

Your first practice feature. See Part 4 of `docs/LEARNING-GUIDE.md`.

## Goal

Let a responder show that someone is handling an incident, so others do not duplicate the work.

## User flow

1. A responder opens an incident with status `open`.
2. The responder acknowledges it.
3. The status becomes `acknowledged`, and the time and user are recorded.

## Permissions

| Action | Viewer | Responder | Admin |
|---|---|---|---|
| Acknowledge | No | Yes | Yes |

## API changes

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/v1/incidents/{id}/acknowledge` | 200 with the incident | 401, 403, 404, 409, 422 |

Add a `CONFLICT` code with status 409 to `ERROR_CODES`. The response adds `acknowledgedAt`, which is null until acknowledged. `acknowledgedBy` stays internal.

## Data changes

Add `acknowledgedAt` and `acknowledgedBy` to the `Incident` entity. Add a repository method to update the incident, with `tenantId` as its first argument.

## Edge cases and failures

- Already acknowledged: 409.
- Resolved: 409.
- Two simultaneous requests: one succeeds, and the other gets 409.

## Security

- Another tenant's incident returns 404.
- The acknowledging user comes from the principal, never the body.
- The request has no body.

## Out of scope

- Unacknowledging an incident
- Notifications

## Done when

- [ ] A responder and an admin can acknowledge an open incident
- [ ] A viewer gets 403
- [ ] Another tenant gets 404
- [ ] A repeat acknowledge gets 409
- [ ] Contract regenerated, and the checker reports the additive field as `SAFE`
- [ ] `pnpm check` passes
