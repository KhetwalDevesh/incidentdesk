# Realtime status

Status: Approved

Phase 4, "realtime status": the last Phase 4 item. A stream of changes for each tenant, so a UI or wallboard updates the moment something happens instead of polling.

Decided by the user:

| Question | Decision |
|---|---|
| What is pushed | Incident lifecycle changes (opened, acknowledged, resolved, reassigned), a fresh dashboard snapshot after each, and on-call schedule and override changes |
| Authentication | The usual bearer token in the `Authorization` header. Clients read the stream with `fetch`, not `EventSource` |
| Missed events | No replay. On connect the server sends `ready`, and the client fetches current state once, then applies live events |
| Event content | The full resource as the API already shows it: the same mappers as `GET /v1/incidents/{id}`, `GET /v1/dashboard` and the schedule routes |

## Goal

During an incident, everyone looking at IncidentDesk should see the same thing at the same time: a new incident appears, an acknowledge turns it amber, a reassignment moves it to someone else, and the counts move with it, without anyone pressing refresh.

## User flow

1. Grace's browser opens `GET /v1/events` with her token, and receives `ready`.
2. It fetches `GET /v1/incidents` and `GET /v1/dashboard` once to start from current state.
3. An alert opens an incident in the worker. Every member of the tenant who is connected, on any API instance, receives `incident.opened` with the incident, then a `dashboard` snapshot.
4. Alan acknowledges it. Everyone receives `incident.acknowledged` and a new `dashboard`.
5. An admin adds an override putting Ada on call. Everyone receives `on_call_override.created`.
6. Grace's laptop sleeps, and the connection drops. On reconnect she receives `ready` and refetches, so nothing she missed is lost.

## Events

Each message is a Server-Sent Event with an `event` name and JSON `data`.

| Event | Data | Sent when |
|---|---|---|
| `ready` | `{}` | The stream opens. The client fetches current state now |
| `incident.opened`, `incident.acknowledged`, `incident.resolved`, `incident.reassigned` | `{ "incident": Incident }` | That change commits, made by a person or by the alert worker |
| `dashboard` | `Dashboard`, with no window | After incident changes, at most once a second per tenant |
| `on_call_schedule.created`, `on_call_schedule.updated` | `{ "schedule": OnCallSchedule }` | That change commits |
| `on_call_schedule.deleted` | `{ "id": "uuid" }` | That change commits |
| `on_call_override.created` | `{ "scheduleId": "uuid", "override": OnCallOverride }` | That change commits |
| `on_call_override.deleted` | `{ "scheduleId": "uuid", "id": "uuid" }` | That change commits |
| `resync` | `{}` | The server may have missed changes, or several incidents changed at once (a member was removed). The client refetches, as after `ready` |

- **Current state, not a diff:** an incident event carries the incident as it is when the API instance reads it, just after the change commits. If two changes land within milliseconds, both events may show the later state. Applying them in order still ends at the right state.
- **Heartbeat:** a comment line every 25 seconds keeps proxies from closing an idle stream. `retry: 3000` tells clients to wait 3 seconds before reconnecting.
- **Order:** events for one tenant arrive in commit order on each instance. Across a reconnect, `ready` and the refetch replace any ordering guarantee.

## Permissions

| Action | Responder | Admin |
|---|---|---|
| Open the stream and receive every event of their tenant | Yes | Yes |

Every event shows what the member could already read: incidents, the dashboard and schedules are open to every role.

## API changes

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/v1/events` | 200 `text/event-stream` | 401 |

- The event payload schemas are in the contract (`src/contract/events.ts`) and documented under the path, and the contract tests parse each one. OpenAPI cannot describe a stream's individual events, so the description lists them.
- No existing response changes. The new path is additive.

## How it works

- **Publishing in the transaction:** every write that produces an event calls `pg_notify('incidentdesk_changes', …)` inside its own transaction, as deliveries and audit entries are written today. Postgres delivers the notice only if the transaction commits, so a rolled-back change sends nothing. This covers the API and the alert worker, which are separate processes.
- **Notices carry ids only:** for example `{ tenantId, kind: "incident", id, event }`. Never titles, emails or other content, and never more than the 8000-byte limit (at most 50 ids, for a bulk member removal).
- **One listener per API instance:** each instance holds one dedicated `LISTEN` connection and an in-process hub of open streams, keyed by tenant.
- **Loading the payload:** for a notice whose tenant has open streams on that instance, the hub loads the resource once through the normal tenant-scoped repository and mapper, then writes it to each of that tenant's streams. Notices for tenants with no streams are dropped at once.
- **Dashboard:** recomputed once per tenant per instance, at most once a second, trailing the last incident change.
- **Member removal** sends `members_removed` with the user ids, in the removal's transaction. The hub closes those members' streams, and sends `resync` to the tenant, since their incidents were unassigned.

Ports and code:

- **Domain:** `ChangeNotice` (the id-only notice), a `ChangePublisher` used inside repository transactions, a `ChangeFeed` the hub subscribes to, and `EventHub` (connect, disconnect, publish).
- **Repositories:** incidents, alerts (an incident an alert opens), on-call and accounts publish their notices on the transaction's client. The in-memory twins publish to an in-memory feed at the same point as their change.
- **Adapter:** `src/adapters/pgChangeFeed.ts`. It holds a dedicated `LISTEN` client, reconnects with backoff, and emits a `resync` to every stream after reconnecting, since notices may have been missed.
- **Route:** Hono's `streamSSE`.
- **Auth:** `TokenClaims` gains `expiresAt`, so the stream can close when the token expires.

## Data changes

None. There is no new table and no migration. `NOTIFY` needs no schema.

## Edge cases and failures

- **The token expires:** the server closes the stream at the token's expiry time. The client reconnects with a fresh token and receives `ready`.
- **The member is removed:** their streams close at once (`members_removed`). Reconnecting gets 401.
- **A role changes:** nothing to do. Every event is visible to every role.
- **A slow client:** each stream buffers at most 100 events. Beyond that it is closed, and the client reconnects and resyncs. One slow reader never holds up others.
- **More than 5 streams for one member** (many tabs): the oldest is closed. This bounds connections per member.
- **The `LISTEN` connection drops:** the adapter reconnects with backoff (1 s, 2 s, 5 s, then every 10 s). After reconnecting it sends `resync` to every open stream.
- **The database is down when a stream opens:** the stream still opens, and receives `resync` once the listener reconnects.
- **An alert joins an open incident:** not pushed; alert grouping was not chosen. The incident's `alertCount` updates on the next event or refetch.
- **An on-call handover with no edit:** no event, because time passing changes nothing stored. Clients use `until` from `GET /v1/on-call-schedules/{id}/on-call` to refresh at the right moment.
- **An incident read for a notice is already gone, or belongs to another tenant:** skipped, which never happens for a valid notice. Incidents are never deleted.
- **The server shuts down:** streams close, and clients reconnect to another instance.
- **A tenant whose id is not a uuid** (old development rows): it works the same, since notices carry the tenant id as text.

## Security

- **Tenant boundary:**
  - The tenant comes only from the principal when the stream opens.
  - The hub keys streams by tenant, and writes a notice only to streams of the notice's tenant.
  - Payloads are loaded through tenant-scoped repositories, using the notice's tenant.
  - Isolation tests check that another tenant's changes never reach a stream.
- **Authentication:**
  - Only the `Authorization` header is accepted. `?token=` is ignored, so tokens stay out of URLs, logs and browser history.
  - A stream lives no longer than its token, and a removed member's streams close at once.
- **No secrets in events:** every payload passes through the existing allowlist mappers. Emails appear only within the tenant, as they do in the API.
- **Notices hold ids only:** anyone able to `LISTEN` on the database learns which ids changed, not what they contain.
- **Resource limits:** 5 streams per member, a 100-event buffer per stream, a 25-second heartbeat and a dashboard recomputed at most once a second per tenant.
- **No audit entries:** opening a stream changes nothing.

## Out of scope

- Replay of missed events (`Last-Event-ID`) and event storage
- Alerts joining incidents, audit events, member and channel changes as events
- Filtering a stream by event type or resource
- `EventSource` support, through a query token or stream tickets
- WebSockets, and sending anything from the client over the stream
- A limit on total streams per instance (left to the load balancer)
- On-call handover events driven by the clock

## Done when

- [ ] Each change sends its notice only when its transaction commits, in Postgres and in memory, from both the API and the alert worker (`tests/changeFeed.parity.test.ts`)
- [ ] `GET /v1/events` sends `ready`, then each listed event with the documented payload, and a debounced `dashboard` after incident changes (`tests/events.contract.test.ts`)
- [ ] Streams close at token expiry and on member removal; a sixth stream closes the oldest; a full buffer closes the stream; a reconnected listener sends `resync` (`tests/events.contract.test.ts`, `src/services/events/eventHub.test.ts`)
- [ ] Another tenant's changes never reach a stream, and `?token=` is not accepted (`tests/security.test.ts`, "realtime")
- [ ] Contract regenerated: one new path, no breaking change
- [ ] `pnpm check` passes
