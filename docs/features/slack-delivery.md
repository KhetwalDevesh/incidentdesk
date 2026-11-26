# Slack delivery

Status: Approved

Phase 4, core flow step 4: "The on-call engineer gets a Slack alert." Builds on `docs/features/slack-notifications.md`, which added the encrypted notification channels and left delivery open. Answers that spec's open questions 2 (which events notify) and 3 (no automatic disabling).

Decided by the user:

| Question | Decision |
|---|---|
| Events that post | Incident opened (by a person or an alert source), acknowledged, and resolved. Repeat alerts grouped into an open incident do not post |
| Delivery path | A second AWS SQS standard queue, like alerts. The database row is the source of truth; the message carries ids only |
| Failures | Retry with backoff, honouring Slack's `Retry-After`, then mark the delivery failed. Admins can see each channel's deliveries. Channels are never disabled automatically |
| Webhook URLs | Only URLs whose origin is on a configured allowlist. Default `https://hooks.slack.com`; local development adds the dev receiver's `http://127.0.0.1:4000` |
| Actor's email | Shown in Slack even if the member is removed from IncidentDesk before the message is sent |

## Goal

Tell a team in their own Slack channel the moment an incident opens, and again when someone acknowledges or resolves it, so nobody has to watch the API. Delivery must never slow down or fail the incident change, and must survive Slack being down for a while.

## User flow

1. An incident is opened, acknowledged or resolved. In the same database transaction, one `notification_deliveries` row is written for each of the tenant's enabled channels whose `minSeverity` the incident meets. Each row holds a snapshot of the message: event, title, severity, actor reference, alert count and times. For a member, the actor is their email as it was at that moment; for an alert source, its name (see Message).
2. After the commit, the API (or the worker, for incidents opened by alerts) sends `{ tenantId, deliveryId }` to the notifications queue and records the send, as the alert webhook does.
3. The worker receives the message, starts an attempt, decrypts the channel's webhook URL, checks its origin against the allowlist, and POSTs the Slack message with a 5 second timeout and no redirects.
4. Slack's answer decides what happens next (see Response handling):
   - 2xx: the delivery is `delivered` and the message deleted.
   - Retryable (5xx, 408, timeout, network error): retry after the backoff (5 s, 30 s, 2 min, 10 min). Each counts as an attempt.
   - 429: retry after Slack's `Retry-After`, capped at 10 minutes, or the backoff if it is missing. A 429 does not count as an attempt.
   - Any other 4xx cannot succeed on retry, so the delivery fails at once.
5. After 5 counted attempts, or 1 hour after the row was created, the delivery is `failed`. The channel stays enabled.
6. An outbox sweeper re-sends deliveries whose queue message was lost, exactly as for alerts: unsent after 2 minutes, sent after 15.
7. An admin reads `GET /v1/notification-channels/{id}/deliveries` to see what was sent, what failed and why.

### Message

Plain Slack `mrkdwn` text, one message per event. Incoming webhooks cannot update or thread an earlier message.

```text
🔴 SEV1 incident opened: Checkout is down
Opened by alert source prometheus · 3 alerts · incident 7c9e…
✅ Acknowledged by grace@acme.example after 2m 39s
🟢 Resolved by grace@acme.example after 20m 4s
```

- The actor is named by email for a member, and by name for an alert source. Knowing who acknowledged is the point of the message for responders.
- The email is personal data sent to a third party, and the channel may not be the tenant's alone: a Slack Connect channel includes other companies. So:
  - The email is copied into the delivery row when the incident changes, so the message names the member even if they are removed (hard delete) before it is sent. This is the user's decision.
  - Once the delivery is `delivered` or `failed`, the worker removes the email from the row in the same update. The email stays in our database only while a delivery is pending (at most 1 hour), not for the 90 days of delivery history, so a removed member does not linger there. This matches the audit log, which never stores emails.
  - Messages already posted stay in Slack. IncidentDesk cannot delete them.
  - Admins choose the channel, so posting to a Slack Connect channel is their decision. The channel docs say so.
- Titles come from monitoring tools and people, so they are escaped (`&`, `<`, `>`), so a title cannot create links or `@channel` mentions.

### Response handling

| Slack's answer | Example | Result |
|---|---|---|
| 2xx | `200 ok` | `delivered` |
| 5xx, 408, timeout, network error | Slack outage | Retry with backoff; counts as an attempt |
| 429 | Rate limit of about 1 message per second per webhook, hit in an alert storm | Retry after `Retry-After` (seconds or an HTTP date, capped at 10 minutes); not counted, but bounded by the 1-hour limit |
| 404 `no_service`, 403 `invalid_token`, 410 `channel_is_archived`, 404 `channel_not_found` | Webhook revoked or channel archived | `failed`, `rejected`, at once |
| 400 `invalid_payload`, `no_text` | Our message is malformed | `failed`, `rejected`, at once, and logged as an error, since it is our bug, not the tenant's |
| 3xx | Redirect | `failed`, `rejected`, at once (redirects are refused) |

- 429 is not counted because a burst of incidents would otherwise exhaust 5 attempts in minutes while Slack is healthy. The 1-hour limit stops a channel that is always rate limited from retrying forever.
- A permanent 4xx does not disable the channel (the user's decision). Every later delivery to it fails at once and cheaply, and the admin sees `rejected` with `lastStatus` in the history.

## Permissions

| Action | Viewer | Responder | Admin |
|---|---|---|---|
| Trigger a notification (open, acknowledge, resolve) | No | Yes, through the incident action | Yes |
| List a channel's deliveries | No | No | Yes |

## API changes

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/v1/notification-channels/{id}/deliveries?limit=&offset=` | 200 `{ items, total, limit, offset }`, newest first | 401, 403, 404 (unknown channel, or another tenant's), 422 |

`NotificationDelivery` response (strict):

```json
{
  "id": "uuid",
  "event": "incident.opened",
  "incidentId": "uuid",
  "state": "delivered",
  "attempts": 1,
  "failureReason": null,
  "lastStatus": 200,
  "createdAt": "2026-11-26T10:00:00.000Z",
  "deliveredAt": "2026-11-26T10:00:01.200Z"
}
```

- `event`: `incident.opened`, `incident.acknowledged` or `incident.resolved`. `state`: `pending`, `delivered` or `failed`.
- `failureReason`: null, or `rejected` (a 4xx other than 429), `unavailable` (5xx, 429, timeout or network error after the last attempt) or `host_not_allowed`. It is a fixed set. Slack's response body and error text are never returned.
- `lastStatus`: the last HTTP status Slack answered with, or null if no answer came (timeout, network error, host not allowed). A number only, so nothing from Slack's body leaks.
- **Tightened validation (breaking, decided by the user):** `POST /v1/notification-channels` now returns 422 for a `webhookUrl` whose origin is not on the allowlist. The schema does not change, but a request that used to succeed can now fail.

## Data changes

Migration `0011_create_notification_deliveries.sql`:

- `notification_deliveries (tenant_id, id, channel_id, incident_id, event, payload jsonb, state, attempts, next_attempt_at, sent_at, failure_reason, last_status, last_error, created_at, delivered_at)`, primary key `(tenant_id, id)`, foreign key to `notification_channels`.
- `payload` is the message snapshot. It holds no webhook URL (the worker decrypts that from the channel when it sends). It holds the actor's email only while `pending`; the update that marks the delivery `delivered` or `failed` removes it. The history route never returns `payload`.
- `last_error` is internal text and never returned. `last_status` is the last HTTP status, returned as `lastStatus`.
- Indexes:
  - `(tenant_id, channel_id, created_at DESC, id)` for the history;
  - `(next_attempt_at) WHERE state = 'pending'` for the sweeper, which runs across tenants;
  - `(created_at)` for a purge.
- Rows older than 90 days are purged by the worker, like audit events.

Code:

- **Ports:** `NotificationDeliveryRepository` (tenant-first: `startAttempt`, `markSent`, `complete`, `fail`, `listForChannel`); `DeliveryOutbox.claimOverdue` (cross-tenant); `WebhookSender` with an HTTP adapter (timeout, `redirect: "error"`).
- **Queue:** the SQS adapter and its in-memory twin become generic over the message, so alerts and notifications share them.
- **Writing deliveries:** `IncidentRepository.create` and `update`, and `AlertRepository.complete`, insert the delivery rows in the transaction they already share with the audit entry. Channel matching is a single `INSERT … SELECT` over the tenant's enabled channels.
- **Worker:** a second consumer loop, a second sweeper and a delivery purge.
- **Config:** `NOTIFICATION_QUEUE_URL` (API and worker), `NOTIFICATION_WEBHOOK_ORIGINS` (comma-separated, default `https://hooks.slack.com`), and `NOTIFICATION_ENCRYPTION_KEY` in the worker too. `.env.example` adds `http://127.0.0.1:4000` for the dev receiver.
- **Setup:** `pnpm sqs:setup --name incidentdesk-notifications-<you>` creates the queue and its DLQ. The existing IAM policy already covers `incidentdesk-*`.

## Edge cases and failures

- **Slack is down:** the incident change succeeds; deliveries retry for about 13 minutes, then fail. Nothing blocks the API.
- **Alert storm across many incidents:** Slack rate limits the webhook with 429s. Deliveries wait out `Retry-After` without using up attempts and fail only if still undelivered after 1 hour.
- **A huge or malformed `Retry-After`:** a value over 10 minutes is capped at 10 minutes; a value that cannot be parsed falls back to the backoff.
- **The actor was removed before the send:** the message still shows their email, taken from the pending row. After the send the row no longer holds it.
- **The actor changes their email before the send:** the message shows the email they had when they acted.
- **The queue is down when an incident changes:** the rows are saved unsent and the sweeper sends them later, as for alerts.
- **Duplicate queue message:** `startAttempt` only moves a `pending` row, so the second copy is deleted unread.
- **A crash after Slack accepted the post, before it was recorded:** the message comes back and Slack gets the post twice. Slack has no duplicate protection, so an occasional duplicate is accepted.
- **Ordering:** a standard queue does not keep order, so "acknowledged" can arrive before "opened" when both happen within seconds. Each message says what happened and when, so it reads correctly on its own.
- **A channel disabled or deleted after the row was written:** the delivery is still sent, since the row records the decision made at the time. Disabling stops future rows.
- **A channel created before the allowlist with a host outside it:** each delivery fails at once with `host_not_allowed`, and the admin sees it in the history.
- **Slack redirects:** the request fails rather than following the redirect, so an allowed host cannot bounce the server to an internal address.
- **No matching channel:** no rows and no messages.
- **An alert storm on an open incident:** grouped alerts do not post, so the channel gets one "opened" message.

## Security

- **SSRF:** the allowlist is checked when a channel is created and again before every send. Only `https` origins are allowed, except ones listed explicitly, such as the dev receiver. Redirects are refused. This replaces the accepted SSRF risk in `slack-notifications.md`.
- **Webhook URL:** decrypted only in the worker, at send time. It is never put in the queue, the delivery row, the API response or the logs.
- **Untrusted text:** titles are escaped for Slack `mrkdwn`, so `<!channel>`, `<http://…|click>` and `@here` cannot be injected through an alert or incident title.
- **Tenant boundary:**
  - The worker loads a delivery by `(tenantId, deliveryId)`, and loads its channel within the same tenant.
  - The history route returns 404 for another tenant's channel.
  - Isolation tests cover the route and the worker.
- **Responses:** they carry a fixed `failureReason`, never Slack's response body or internal error text.
- **Personal data:** a member's email is held in the delivery row only while it is pending, and removed when the delivery finishes. It is never put in the queue message, an API response or the logs.

## Out of scope

- A Slack app with OAuth, buttons or slash commands
- Mentioning the on-call person (needs on-call schedules)
- Threading or updating one Slack message per incident (incoming webhooks cannot)
- Choosing events per channel: every matching channel gets all three
- A message for each repeat alert
- Disabling a channel automatically
- Re-sending a failed delivery by hand
- Email, SMS and phone

## Done when

- [ ] Opening (by a person or an alert), acknowledging and resolving an incident writes one delivery per enabled channel meeting its minimum severity, in the change's transaction (`tests/notificationDeliveryRepository.parity.test.ts`, `tests/slackDelivery.contract.test.ts`)
- [ ] The worker posts the escaped message and marks it delivered. It retries 5xx, 408 and timeouts with backoff, fails after 5 attempts, and fails any other 4xx at once. A 429 waits `Retry-After` (capped at 10 minutes) without counting, and the delivery fails 1 hour after creation (`src/services/notifications/deliveryProcessor.test.ts`)
- [ ] A member removed before the send is still named by email in the message, and a finished delivery row holds no email (`deliveryProcessor.test.ts`, `tests/notificationDeliveryRepository.parity.test.ts`, `tests/security.test.ts`)
- [ ] A duplicate message posts once, and the sweeper re-sends only lost messages (`deliveryProcessor.test.ts`)
- [ ] A non-allowlisted origin is refused at channel creation (422) and at send time (`host_not_allowed`), and redirects are not followed (`tests/security.test.ts`, "slack delivery")
- [ ] The webhook URL appears in no queue message, row, response or log, and a title cannot inject a mention or link (`tests/security.test.ts`)
- [ ] Admins list a channel's deliveries; viewers and responders get 403; another tenant's channel gets 404 (`tests/slackDelivery.contract.test.ts`, `tests/security.test.ts`)
- [ ] A manual run through real SQS posts opened, acknowledged and resolved messages to the dev receiver
- [ ] Contract regenerated: additive, apart from the decided 422 for disallowed webhook origins
- [ ] `pnpm check` passes
