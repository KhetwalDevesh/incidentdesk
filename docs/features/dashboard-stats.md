# Dashboard stats

Status: Approved

Phase 4, "dashboard". One read-only endpoint that tells a team, at a glance, how much is on fire right now and who is carrying it.

Decided by the user:

| Question | Decision |
|---|---|
| Numbers | Live counts of unresolved incidents by status and severity, with how many are unassigned. Load per person: unresolved incidents per assignee |
| Window | Optional `from` and `to`. When given, every number counts only unresolved incidents opened in that range. Without them, every unresolved incident |
| Load list | Only members holding at least one unresolved incident, plus the unassigned total |
| Who reads it | Every member: responders and admins |
| Freshness | Computed live on each request from the incidents table. No precomputed tables |

## Goal

During an outage, or at the start of a shift, a team needs one answer quickly: how many incidents are open or acknowledged, how severe they are, how many nobody owns yet, and who is overloaded. Today that means paging through `GET /v1/incidents` and counting by hand.

## User flow

1. Grace opens the dashboard at the start of her shift. It shows 7 unresolved incidents: 4 open and 3 acknowledged. 2 of them are sev1, and 1 is unassigned.
2. The load list shows Alan holding 4 and Grace holding 2. Alan is overloaded, so Grace takes one with `POST /v1/incidents/{id}/assign`.
3. An admin narrows the numbers to incidents opened during last night's release, from 22:00 to 02:00, to see what that release left behind.

## Numbers

All numbers count **unresolved** incidents (status `open` or `acknowledged`), read now. A window narrows them to those whose `createdAt` is at or after `from` and before `to`.

- **Totals:** `open`, `acknowledged` and `unassigned`. Unassigned counts unresolved incidents with no assignee, in either status.
- **By severity:** for each of sev1 to sev4, `open` and `acknowledged`. Every severity is always present, with zeros.
- **Load:** one row per member holding at least one unresolved incident: `open`, `acknowledged` and `total`.
  - Sorted by `total`, largest first, then by email.
  - At most 100 rows. `assigneeCount` gives how many members hold incidents, so a client can tell when the list was cut.

## Permissions

| Action | Responder | Admin |
|---|---|---|
| Read the dashboard | Yes | Yes |

## API changes

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/v1/dashboard?from=&to=` | 200 dashboard | 401, 422 |

Query:

- `from` and `to` are optional ISO 8601 timestamps with an offset. Give both or neither.
- `from` must be before `to`, and they may be at most 90 days apart. Anything else gets 422, naming the field.

Response (strict):

```json
{
  "generatedAt": "2026-11-26T09:00:00.000Z",
  "window": { "from": "2026-11-25T22:00:00.000Z", "to": "2026-11-26T02:00:00.000Z" },
  "totals": { "open": 4, "acknowledged": 3, "unassigned": 1 },
  "bySeverity": {
    "sev1": { "open": 2, "acknowledged": 0 },
    "sev2": { "open": 1, "acknowledged": 2 },
    "sev3": { "open": 1, "acknowledged": 1 },
    "sev4": { "open": 0, "acknowledged": 0 }
  },
  "load": [
    { "userId": "uuid", "email": "alan@acme.example", "open": 3, "acknowledged": 1, "total": 4 }
  ],
  "assigneeCount": 2
}
```

`window` is `null` when no range was given. Nothing else changes: the new path is additive.

## Data changes

Migration `0015_index_unresolved_incidents.sql`:

- A partial index `incidents (tenant_id, created_at) WHERE status <> 'resolved'`, so the counts read only unresolved rows, and a window narrows them by time.
- The existing `incidents (tenant_id, assignee_id) WHERE assignee_id IS NOT NULL` index serves the load query.
- No new tables. Rollback: `DROP INDEX`. The build briefly blocks writes to `incidents`, which is small. `CREATE INDEX CONCURRENTLY` cannot run inside the migration transaction.

Code, following the incidents shape:

- **Contract:** `src/contract/dashboard.ts`, with the query and response schemas, registered in `openapi.ts`.
- **Domain:** a port in `src/domain/dashboard/types.ts`: `IncidentStatsReader.unresolvedStats(tenantId, window)` returns counts by status, severity and assignment, and `load(tenantId, window, limit)` returns per-assignee counts and the assignee total.
- **Repository:** Postgres runs two `GROUP BY` queries. The in-memory twin counts over the shared incident store. A parity test runs the same calls on both.
- **Service:** reads both, and adds emails through `AccountRepository.findUsers`, as the incident service does for assignees.
- **Mapper and route:** `GET /v1/dashboard`.

## Edge cases and failures

- **No incidents, or none in the window:** zeros everywhere, every severity present, and an empty load list.
- **A window in the future, or before the tenant existed:** zeros, not an error.
- **Only one of `from` or `to`; `from` not before `to`; more than 90 days; no offset or a bad timestamp:** 422, naming the field.
- **Resolved incidents:** never counted, inside or outside a window.
- **A member removed:** their removal unassigns their incidents in its transaction, so those count as unassigned and the member leaves the load list.
- **An assignee whose email cannot be found** (a removal racing the read): their row is left out of `load`, and their incidents still count in `totals`.
- **More than 100 members holding incidents:** the top 100 by load; `assigneeCount` shows the real number.
- **Concurrent changes during the read:** the two queries may see slightly different moments. The numbers are a snapshot for display, not a ledger. Not worth a repeatable-read transaction at this scale.

## Security

- **Tenant boundary:** `tenantId` comes only from the principal. Both queries filter by it first. Isolation tests check that another tenant's incidents and assignees never appear in any number.
- **Emails:** the load list shows members' emails to every member. They can already see them through the member list (decided in `docs/features/on-call-schedules.md`). Emails never cross tenants.
- **Untrusted input:** `from` and `to` are parsed by the contract schema and passed as query parameters, never built into SQL.
- **Cost:** the window is capped at 90 days, the load list at 100 rows, and both queries use the partial index. Rate limiting is a separate feature.
- **No audit entries:** reading changes nothing, as for every other read.

## Out of scope

- Response times (time to acknowledge or resolve), daily trends and noisy alert sources: proposed separately if wanted
- Counts of resolved incidents
- Breakdowns per on-call schedule or alert source
- Precomputed rollups, caching and realtime push
- CSV or other exports

## Done when

- [ ] Totals, severity counts, unassigned and load are counted the same in memory and in Postgres, with and without a window, and resolved incidents never count (`tests/dashboardRepository.parity.test.ts`)
- [ ] `GET /v1/dashboard` returns the documented shape to responders and admins, sorts and caps the load list, and returns 422 for each bad window (`tests/dashboard.contract.test.ts`)
- [ ] Another tenant's incidents and assignees never appear (`tests/security.test.ts`, "dashboard")
- [ ] Contract regenerated: one new path, no breaking change
- [ ] `pnpm check` passes
