# On-call schedules and assignment

Status: Done

Phase 4, core flow step 4: "The on-call engineer gets a Slack alert." Slack delivery (`docs/features/slack-delivery.md`) posts to a channel. This feature decides who is on call, makes that person the incident's assignee when it opens, and removes the viewer role.

Decided by the user:

| Question | Decision |
|---|---|
| How shifts are defined | A rotation: an ordered list of members who take turns, handing over at a fixed local time every N days. Plus overrides: one member covering a time range, for a swap or holiday cover |
| Who manages them | Admins create, change and delete schedules, and add or remove any override. A responder may add an override that puts themself on call, and remove such an override. Every member can read schedules and who is on call |
| Several schedules | A tenant can have several. An alert source can be linked to one. One schedule can be the tenant's default |
| Assignee | When an incident opens, whoever is on call becomes its assignee by default: from the alert source's linked schedule, otherwise from the default schedule. It does not change at handover |
| Reassigning | Any member may reassign an unresolved incident to any member of the tenant, themself included. Only an admin may unassign it (set nobody) |
| Reassign in Slack | A reassignment posts a new `incident.reassigned` message |
| Who acts on an incident | Only the assignee, or an admin, may acknowledge or resolve an assigned incident. Any member may act on an unassigned one. Because any member may reassign, a responder can take an incident by assigning it to themself first; both steps are audited |
| Roles | The viewer role is removed. Existing viewers become responders. Roles are responder and admin |
| Emails | Every member sees the on-call person's and the assignee's email, and the member list opens to every role |
| Removed members | They leave every rotation, and their overrides are deleted |
| Audit | Every schedule, override and link change is audited |
| Delivery | One feature and one pull request |

## Goal

Answer "who is on call right now?" for each team, and make that person responsible for each new incident the moment it opens, so an alert never sits with nobody owning it.

## User flow

1. An admin creates a schedule: a name ("Payments"), a time zone ("Europe/London"), a handover time ("09:00"), a rotation length in days (7), the date the rotation starts, the members in order, and whether it is the tenant's default.
2. The first member is on call from the start date's handover time for 7 days, then the next, wrapping round to the first.
3. A responder going on holiday asks a colleague to cover. The colleague adds an override putting themself on call for that week. An admin can add one for anyone.
4. An admin links the alert source `prometheus-payments` to the Payments schedule.
5. An alert from that source opens an incident. Grace is on call for Payments, so Grace is the assignee. Slack says "Assigned to grace@acme.example".
6. Grace is busy with another incident, so she reassigns it to Alan. Slack says "Reassigned to alan@acme.example by grace@acme.example". Alan acknowledges and resolves it. A third responder who tries gets 403; an admin can step in.
7. An incident a person opens is assigned from the default schedule. With no default schedule, or nobody on call, it is unassigned, and any member can act on it.

### Who is on call at a time

1. An override covering that time wins.
2. Otherwise the rotation decides. Shift k starts at the handover time, in the schedule's time zone, on the start date plus k × rotation length days. The member at position k modulo the number of members is on call.
3. With no members and no override, nobody is on call. Before the rotation's first handover, only an override can put someone on call.

Handover follows the local clock, so a shift that crosses a daylight saving change is an hour shorter or longer. A handover time that does not exist that day (it falls in the skipped hour) happens at the first valid time after it.

### Which schedule assigns an incident

| Opened by | Schedule |
|---|---|
| An alert source linked to a schedule | That schedule |
| An unlinked alert source, or a person | The tenant's default schedule |
| Either, with no such schedule | None: unassigned |

The assignee is worked out once, at the opening time, and stored. A handover, a rotation change or a new override later does not move it. Only a manual reassignment does.

## Permissions

The viewer column is gone: every member is a responder or an admin.

| Action | Responder | Admin |
|---|---|---|
| Read schedules, overrides and who is on call | Yes | Yes |
| Create, change or delete a schedule, or set the default | No | Yes |
| Add or remove an override for themself | Yes | Yes |
| Add or remove an override for someone else | No | Yes |
| Link an alert source to a schedule | No | Yes |
| List members (`GET /v1/members`) | **Yes (was No)** | Yes |
| Invite, change or remove members | No | Yes |
| Create an incident | Yes | Yes |
| Acknowledge or resolve an assigned incident | **Only its assignee (was: any responder)** | Yes |
| Acknowledge or resolve an unassigned incident | Yes | Yes |
| Reassign an unresolved incident to a member (anyone, themself included) | Yes | Yes |
| Unassign an incident (set nobody) | No | Yes |

## API changes

### New

All under `/v1/on-call-schedules`, tenant-scoped, 404 for another tenant's schedule.

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/v1/on-call-schedules` | 201 schedule | 401, 403, 404 (unknown member), 409 (name taken), 422 |
| GET | `/v1/on-call-schedules` | 200 `{ items, total, limit, offset }`, by name | 401, 422 |
| GET | `/v1/on-call-schedules/{id}` | 200 schedule | 401, 404, 422 |
| PATCH | `/v1/on-call-schedules/{id}` | 200 schedule | 401, 403, 404, 409, 422 |
| DELETE | `/v1/on-call-schedules/{id}` | 204 | 401, 403, 404, 422 |
| GET | `/v1/on-call-schedules/{id}/on-call?at=` | 200 who is on call | 401, 404, 422 |
| POST | `/v1/on-call-schedules/{id}/overrides` | 201 override | 401, 403, 404, 409 (overlaps), 422 |
| GET | `/v1/on-call-schedules/{id}/overrides?from=&limit=&offset=` | 200 page, by start time | 401, 404, 422 |
| DELETE | `/v1/on-call-schedules/{id}/overrides/{overrideId}` | 204 | 401, 403, 404, 422 |
| PATCH | `/v1/alert-sources/{id}` | 200 alert source | 401, 403, 404, 422 |
| POST | `/v1/incidents/{id}/assign` | 200 incident | 401, 403 (unassign by a responder), 404 (incident or member), 409 (resolved), 422 |

Schedule (strict):

```json
{
  "id": "uuid",
  "name": "Payments",
  "timeZone": "Europe/London",
  "handoffTime": "09:00",
  "rotationDays": 7,
  "startsOn": "2026-12-07",
  "isDefault": true,
  "participants": [{ "userId": "uuid", "email": "grace@acme.example" }],
  "createdAt": "…"
}
```

- **Create and PATCH:** `name` (1–100), `timeZone` (an IANA zone), `handoffTime` (`HH:MM`), `rotationDays` (1–28), `startsOn` (a date), `participants` (0–50 distinct member ids, in order) and `isDefault`. PATCH takes any subset and replaces the list it is given.
  - Making a schedule the default makes the previous default an ordinary schedule, in the same transaction.
  - Changing the rotation changes who is on call from now on, but never an existing assignee.
- **Who is on call:** `{ at, onCall: null | { userId, email, source: "rotation" | "override", from, until } }`. `until` is the next handover, or the override's end.
- **Override:** `{ id, userId, email, startsAt, endsAt, createdBy, createdAt }`. It must end after it starts and after now, be at most 90 days long, and not overlap another override in the same schedule (409).
- **Overrides list:** `GET …/overrides` lists overrides that have not ended, or those ending after `from`.
- **Alert source PATCH:** `{ onCallScheduleId: uuid | null }`. The alert source response gains `onCallScheduleId`, and create accepts it.
- **Assign:** `{ assigneeId: uuid | null }`.
  - The member must belong to the caller's tenant, or the answer is 404 with path `assigneeId`.
  - `null` unassigns, admins only. A responder gets 403 "Only an admin can unassign an incident".
  - A resolved incident gets 409 "A resolved incident cannot be reassigned". Open and acknowledged incidents can be reassigned; acknowledging is not undone.
  - Assigning to the current assignee returns 200 and records nothing: no audit entry, no Slack post.
  - The change takes a row lock on the incident, so it cannot interleave with an acknowledge, a resolve or another reassignment.

### Changed (additive)

- The incident response gains `assignee: null | { id, email }`. It is the same in lists, single reads, acknowledge, resolve and assign.
- The delivery response's `event` enum gains `incident.reassigned`. The contract lists it, so typed clients see it in the regenerated schema, as with the new audit actions.

### Changed (breaking, decided by the user)

- **Viewer role removed:** `role: "viewer"` in an invite or a role change now gets 422, and responses never contain it. The `Member` and invite schemas list `responder` and `admin` only.
- **Member list opened up:** `GET /v1/members` returns 200 for responders, instead of 403.
- **Acknowledge and resolve restricted:** on an assigned incident they return 403 to anyone but the assignee or an admin. The detail is "Only the assignee or an admin can acknowledge this incident", and the same for resolve.

## Data changes

Migration `0012_create_on_call_schedules.sql`:

- **`on_call_schedules`** `(tenant_id uuid, id, name, time_zone, handoff_time time, rotation_days, starts_on date, is_default, created_at)`.
  - Primary key `(tenant_id, id)`, unique `(tenant_id, name)`.
  - Partial unique index `(tenant_id) WHERE is_default`, so a tenant has at most one default.
- **`on_call_participants`** `(tenant_id, schedule_id, position, user_id)`.
  - Primary key `(tenant_id, schedule_id, position)`, unique `(tenant_id, schedule_id, user_id)`.
  - `ON DELETE CASCADE` from the schedule and from the user.
- **`on_call_overrides`** `(tenant_id, id, schedule_id, user_id, starts_at, ends_at, created_by, created_at)`.
  - `ON DELETE CASCADE` from the schedule and from the user.
  - Index `(tenant_id, schedule_id, ends_at)`.
  - Overlaps are refused by the repository under a row lock on the schedule, so two concurrent adds cannot both win.
- **`alert_sources.on_call_schedule_id`** (nullable). The foreign key uses `ON DELETE SET NULL (on_call_schedule_id)`, so deleting a schedule unlinks sources without touching their `tenant_id`.
- **`incidents.assignee_id`** (nullable uuid). There is no foreign key, because `incidents.tenant_id` is still text (see 0002). A removed member is unassigned by the member removal itself, in its transaction, so their incidents never get stuck behind a missing assignee.
- **`incidents.assignment_count`** (int, default 0), raised by each manual reassignment. It names each reassignment for delivery deduplication.
- **`notification_deliveries.occurrence`** (int, default 0) and the event CHECK widened to `incident.reassigned`. The unique index `(tenant_id, channel_id, incident_id, event)` is replaced by `(tenant_id, channel_id, incident_id, event, occurrence)`, so each reassignment gets its own row while a retried insert still collapses. Old code writes occurrence 0, which keeps today's behaviour.

Migration `0013_remove_viewer_role.sql`, expand step:

- Sets every `viewer` to `responder`, and writes a `member.role_changed` audit entry for each (`from: viewer`, `to: responder`). The actor is `anonymous`, the existing type for a change with no signed-in person, so no new value is added to the response enum `actor.type`.
- The `users.role` CHECK still allows `viewer` in this release, because an instance on the old code could still write it while the deploy rolls out. Release 2 drops `viewer` from the CHECK in a new migration, once no row uses it. That is the contract step, noted in the header.
- **Contract step done** in `0016_drop_viewer_role.sql`: it converts, with an audit entry, any viewer written during that rollout, then narrows the CHECK to `responder` and `admin`. The read-time fallback that mapped a stray `viewer` to responder is removed (`tests/migrate.test.ts`).

Migration `0014_audit_on_call_actions.sql` widens the audit checks, expand only:

- Actions: `on_call_schedule.created`, `.updated`, `.deleted`, `on_call_override.created`, `.deleted`, `alert_source.updated`, `incident.assigned`.
- Resource type: `on_call_schedule`.
- Details hold ids, names and times, never emails.
- These new `action` values reach `GET /v1/audit-events` clients, as `member.role_changed` and `member.removed` did in 0010. The contract lists them, so typed clients see them in the regenerated schema.

Code:

- **Domain:** a pure `whoIsOnCall(schedule, participants, overrides, at)`, using `Intl` for time zones, since Node 22 has no `Temporal`. `Role` becomes `responder | admin`. `canRespond` is removed, since every member can respond.
- **Incident service:**
  - It works out the assignee before it creates the incident, and writes an `incident.assigned` audit entry with the assignee's id in the same transaction.
  - The alert worker does the same for an incident an alert opens.
  - Acknowledge and resolve check the assignee.
  - `assign` checks the role for `null`, the member's tenant and the state, then updates the assignee, raises `assignment_count`, writes `incident.assigned` (`{ from, to, manual: true }`, ids only) and inserts `incident.reassigned` deliveries, all in one transaction.
- **Repository, service, mappers and routes** for schedules, with an in-memory twin and parity tests, following the incidents shape.

## Slack message

```text
🔴 SEV1 incident opened: Checkout is down
Opened by alert source prometheus · 1 alert · incident 7c9e…
Assigned to grace@acme.example
```

- The assignee's email is copied into the delivery payload when the incident opens, and removed when the delivery finishes, exactly like the actor's email.
- An unassigned incident says "Unassigned".
- Acknowledged and resolved messages are unchanged.

A reassignment posts to every enabled channel whose minimum severity the incident meets:

```text
👤 SEV1 incident reassigned: Checkout is down
Reassigned to alan@acme.example by grace@acme.example · incident 7c9e…
```

- Unassigning says "Unassigned by ada@acme.example".
- Both emails are snapshotted and stripped when the delivery finishes, like the actor's.

## Edge cases and failures

- **The assignee is removed:** their incidents become unassigned in the same transaction, and any member can then act on them. They also leave rotations and lose their overrides. Who is on call can change at once.
- **The assignee is asleep:** an admin acknowledges or resolves instead. Nobody else can, by the user's decision.
- **A grouped alert joins an open incident:** the assignee does not change.
- **Reassigned to a member removed a moment earlier:** 404, since the member lookup and the update run in one transaction.
- **Reassigned twice quickly:** both are applied in order under the row lock, and Slack gets two posts, each with its own `occurrence`.
- **Reassigned after resolving:** 409.
- **A responder assigns an incident to themself, then acknowledges it:** allowed, by the user's decision. The audit log shows both steps.
- **A deleted schedule:** its participants and overrides go with it, linked alert sources are unlinked, and if it was the default the tenant has no default. Existing assignees stay.
- **The default schedule is unset or deleted:** later person-opened incidents are unassigned.
- **An empty rotation, a time before the rotation starts, or a gap with no override:** the incident is unassigned.
- **Two concurrent overlapping overrides:** one is created, the other gets 409.
- **An unknown or other-tenant member, schedule or source id in a request:** 404, naming the item (`participants.2`), as for bulk member changes.
- **A time zone Node does not know, an impossible date, or `handoffTime` `24:00`:** 422.
- **An old client sends `role: "viewer"`:** 422. A viewer who was signed in becomes a responder on their next request, since roles are read per request.
- **`at` far in the past or future:** answered from the current rotation and overrides; history is not kept.

## Security

- **Tenant boundary:**
  - Every query is tenant-first.
  - Member, schedule and source ids from a request are checked to belong to the caller's tenant before they are stored.
  - Another tenant's schedules, overrides and sources return 404.
  - Isolation tests cover every new route, and assignment never picks a member of another tenant.
- **Authorization, all checked in services:**
  - A responder may only add or remove an override whose `userId` is their own.
  - Only the assignee or an admin may acknowledge or resolve an assigned incident.
  - Any member may reassign within their tenant; only an admin may unassign. A member id from another tenant gets 404, never assigns.
  - Reassigning is the only way to take over an incident, and it is always audited with who did it.
- **Emails (the user's decision):**
  - Every member can see every other member's email, role and invite status, through the member list, schedules, overrides and assignees. Before, only admins could.
  - Emails never cross tenants, and never appear in audit details.
  - They reach Slack only in the "opened" and "reassigned" messages, and the delivery row drops them when the delivery finishes.
- **Removed role:** the viewer role disappears from the contract and the domain. Tests that used a viewer token now use a responder, or test the new 422. The tests asserting a 403 on the member list now assert 200 within the tenant, and that another tenant's members never appear. They are updated, not deleted.

## Out of scope

- Assignment changing at handover, and escalation or re-paging when nobody acknowledges
- Mentioning the person in Slack with `<@U…>` (needs Slack user ids)
- Layered schedules, follow-the-sun and restrictions such as weekdays only
- A list or calendar of future shifts, and a record of past shifts
- Filtering incidents by assignee
- Notifying people when their shift starts
- Phone, SMS and email paging

## Done when

- [x] `whoIsOnCall` follows the rotation, wraps round, prefers an override, hands over at the local time across a daylight saving change, and handles an empty rotation (`src/domain/onCall/whoIsOnCall.test.ts`)
- [x] Schedules, defaults, overrides and source links are stored the same in memory and in Postgres. Overlapping overrides are refused, including when two are added at once. Removing a member removes them from rotations, deletes their overrides and unassigns their incidents (`tests/onCallRepository.parity.test.ts`)
- [x] An incident opened by a linked alert source is assigned from its schedule, one opened by a person from the default schedule, and with neither it is unassigned. A handover never changes an assignee (`tests/onCall.contract.test.ts`, `src/services/alerts/alertProcessor.test.ts`)
- [x] Only the assignee or an admin can acknowledge or resolve an assigned incident; anyone can act on an unassigned one. A reassignment between an acknowledge's read and write makes it lose (`tests/onCall.contract.test.ts`, `tests/security.test.ts`, `src/services/incidents/incidentService.test.ts`)
- [x] Any member reassigns an unresolved incident to a tenant member; a responder's unassign gets 403, a resolved incident 409, another tenant's member or incident 404, and a no-op change records nothing (`tests/incidents.contract.test.ts`, `tests/onCall.contract.test.ts`, `tests/security.test.ts`)
- [x] Each reassignment posts one "reassigned" Slack message naming both people, two reassignments post twice, and the emails leave the row once delivered (`tests/slackDelivery.contract.test.ts`, `tests/notificationDeliveryRepository.parity.test.ts`, `tests/onCallRepository.parity.test.ts`)
- [x] Every new route returns its documented shapes and errors. Admins manage everything; a responder adds and removes only their own overrides (`tests/onCall.contract.test.ts`)
- [x] The viewer role is gone: existing viewers are responders, `viewer` in a request gets 422, and every member lists their own tenant's members (`tests/members.contract.test.ts`, `tests/migrate.test.ts`, `tests/security.test.ts`)
- [x] Another tenant's schedules, overrides, sources and members cannot be read, used or assigned (`tests/security.test.ts`, "on-call")
- [x] The "opened" Slack message names the assignee, or says "Unassigned", and the email leaves the row once delivered (`deliveryProcessor.test.ts`, `tests/slackDelivery.contract.test.ts`)
- [x] Every schedule, override, link and assignment change is audited, with no email in its details (`tests/audit.contract.test.ts`)
- [x] Contract regenerated: additive (including the new delivery event), apart from the three decided breaking changes
- [x] `pnpm check` passes
