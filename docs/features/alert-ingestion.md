# Alert ingestion and automatic incidents

Status: Done

Phase 3. Requested by the user: incidents are created automatically from monitoring alerts, as in steps 1 and 2 of the core flow in `docs/spec.md`. The audit log is the other Phase 3 item and gets its own spec.

Decided by the user:

| Question | Decision |
|---|---|
| Payload format | Our own generic JSON. Vendor formats (Alertmanager, Grafana) come later as mappers onto it |
| Queue | A Postgres table, claimed by a worker with `FOR UPDATE SKIP LOCKED`. No new infrastructure |
| Grouping | An alert attaches to the source's unresolved incident with the same `dedupKey`. If there is none, a new incident opens |
| Resolved alerts | Recorded and attached only. A person still resolves the incident |
| Listing an incident's alerts | Cut from this slice |
| Source rotate, disable, delete | Left for a later slice |
| Encryption key for source secrets | Reuse `NOTIFICATION_ENCRYPTION_KEY`, under a different `SecretBox` context |
| Failed alerts | Visible to admins through the API |

## Goal

Let a tenant's monitoring tool open incidents without a person typing them in, and keep a flapping or repeating alert from opening one incident per notification.

## User flow

1. An admin adds an alert source, such as `prometheus-prod`. The response shows its id and signing secret once.
2. The admin configures the monitoring tool to POST alerts to `/webhooks/alerts/{sourceId}`, signed with that secret.
3. The webhook verifies the signature, stores the alert as `pending` and returns 202. It does not create the incident itself.
4. The worker claims pending alerts and, for each one:
   - `firing`, with an unresolved incident for the same source and `dedupKey`: attaches the alert to it, and increments `alertCount`.
   - `firing`, with no such incident: opens a new incident with the alert's title and severity, and attaches the alert.
   - `resolved`, with an unresolved incident: attaches the alert. The incident stays as it is.
   - `resolved`, with no unresolved incident: the alert is stored, with no incident.
5. Responders see the incident in `GET /v1/incidents`, acknowledge it and resolve it as today.
6. A `firing` alert after the incident is resolved opens a new incident.
7. An admin lists alerts by state, for example `GET /v1/alerts?state=failed`, to find alerts the worker gave up on.

```text
monitoring tool ──signed POST──► /webhooks/alerts/{sourceId} ──insert──► alerts (pending)
                                        │ 202                                  │
                                                         worker (SKIP LOCKED) ◄┘
                                                                │ one transaction
                                                                ▼
                                               attach to unresolved incident or open a new one
```

## Permissions

| Action | Viewer | Responder | Admin |
|---|---|---|---|
| Add an alert source | No | No | Yes |
| List alert sources | No | No | Yes |
| List alerts, including failed ones | No | No | Yes |
| Send an alert | Not a user action. Authenticated by the source's HMAC signature, not a bearer token |

## API changes

| Method | Path | Auth | Success | Errors |
|---|---|---|---|---|
| POST | `/v1/alert-sources` | Bearer, admin | 201 with the source and its secret | 401, 403, 409, 422 |
| GET | `/v1/alert-sources` | Bearer, admin | 200 with a page of sources | 401, 403, 422 |
| GET | `/v1/alerts` | Bearer, admin | 200 with a page of alerts, newest first | 401, 403, 422 |
| POST | `/webhooks/alerts/{sourceId}` | HMAC signature | 202 with `{ alertId }` | 401, 413, 422 |

- Create source body: `{ name }`. `name` is 1 to 100 characters, unique per tenant. Unknown fields get 422.
- Source response: `{ id, name, secretHint, createdAt }`. The create response alone adds `secret`. It is never returned again.
- Alert list query: `limit`, `offset`, and an optional `state` (`pending`, `processed` or `failed`). Without `state`, every alert is listed.
- Alert response: `{ id, sourceId, dedupKey, status, title, severity, details, state, attempts, incidentId, receivedAt, processedAt }`. `last_error` stays internal, because it can hold internal error text. It goes to server logs with the alert id instead.
- The incident response adds `origin` (`manual` or `alert`), `alertCount` (0 for manual incidents) and `lastAlertAt` (nullable). The change is additive.
- The webhook lives outside `/v1` and is registered before `requireAuth`, like `/v1/auth`.
- `ERROR_CODES` gains `PAYLOAD_TOO_LARGE: 413`.

### Webhook request

Headers:

| Header | Value |
|---|---|
| `X-IncidentDesk-Timestamp` | Unix time in seconds when the request was signed |
| `X-IncidentDesk-Signature` | `v1=` followed by the hex HMAC-SHA256 of `{timestamp}.{raw body}`, keyed with the source secret |

Body, a strict object:

| Field | Rule |
|---|---|
| `dedupKey` | Required. 1 to 200 characters. Alerts from one source with the same key group together |
| `title` | Required. 3 to 200 characters, trimmed, like a manual incident |
| `severity` | Required. `sev1` to `sev4` |
| `status` | `firing` or `resolved`. Defaults to `firing` |
| `details` | Optional. A flat object of string, number or boolean values, at most 50 keys |

Example signing, for the docs and the dev receiver:

```bash
ts=$(date +%s)
body='{"dedupKey":"db-cpu-high","title":"DB CPU above 90%","severity":"sev2"}'
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "localhost:3000/webhooks/alerts/$SOURCE_ID" \
  -H "Content-Type: application/json" \
  -H "X-IncidentDesk-Timestamp: $ts" \
  -H "X-IncidentDesk-Signature: v1=$sig" \
  --data "$body"
```

## Data changes

Migration `0005_create_alert_sources.sql` adds `alert_sources`:

| Column | Purpose |
|---|---|
| `tenant_id`, `id` | Primary key, tenant first |
| `name` | Unique per tenant |
| `secret_ciphertext` | The signing secret, sealed with the existing `SecretBox` under context `alert_source:{tenantId}:{id}`. It is encrypted, not hashed, because HMAC verification needs the plaintext |
| `secret_hint` | Last 4 characters of the secret |
| `created_at` | Ordering for lists |

Migration `0006_create_alerts.sql` adds `alerts`. It is both the queue and the alert history:

| Column | Purpose |
|---|---|
| `tenant_id`, `id` | Primary key, tenant first |
| `source_id` | The alert source |
| `dedup_key`, `title`, `severity`, `alert_status`, `details` (jsonb) | The validated payload |
| `received_at` | When the webhook accepted it |
| `state` | `pending`, `processed` or `failed` |
| `attempts`, `next_attempt_at`, `last_error` | Retry with backoff. After 5 attempts the state becomes `failed` |
| `incident_id` | Set when attached. Null for a resolved alert with no incident |
| `processed_at` | When the worker finished it |

Indexes: `(next_attempt_at)` where `state = 'pending'` for the worker, and `(tenant_id, received_at DESC, id)` for the alert list.

Migration `0007_add_incident_alert_grouping.sql` adds nullable `alert_source_id` and `dedup_key`, and `alert_count` (default 0) and `last_alert_at` to `incidents`, plus a partial unique index on `(tenant_id, alert_source_id, dedup_key) WHERE status <> 'resolved'`. The index makes grouping race-safe: two workers that receive the same new key cannot both open an incident. The second insert conflicts and attaches instead.

An incident opened by an alert has `created_by = 'alert_source:{sourceId}'`.

Code:

- Domain ports `AlertSourceRepository`, `AlertRepository` (enqueue, claim, mark), and an `openOrAttach` operation on the incident repository. Each has Postgres and in-memory implementations, with parity tests.
- `AlertIngestService.receive` verifies, validates and enqueues. `AlertProcessor.processBatch` groups the alerts.
- A new entrypoint `src/worker.ts` (`pnpm worker`, `pnpm dev:worker`) polls every second and stops cleanly on SIGTERM. Wiring goes in `src/containers/`.
- A signature verifier adapter that uses `crypto.timingSafeEqual`.

## Edge cases and failures

- Unknown source id, missing headers, bad signature, or a timestamp more than 300 seconds from now: 401 with one message, so a valid source id cannot be found by probing.
- A body over 64 KB: 413, before reading the rest.
- Invalid JSON or schema: 422 with field errors. This happens only after the signature is valid.
- Replay inside the 300 s window: accepted. The repeat groups into the same incident and only increments `alertCount`. This is an accepted risk.
- The database is down at the webhook: 500, so the monitoring tool retries.
- The worker crashes mid-alert: its transaction rolls back. A claim leases the alert for 60 seconds, so another worker picks it up when the lease ends. An alert is never grouped twice: completing locks the row and requires it to still be `pending`.
- The alert's processing throws: `attempts` increments, with backoff of 5 s, 30 s, 2 min and 10 min, then `failed`. Failed rows stay for inspection.
- An alert arrives for an incident that a person has acknowledged: it attaches. The status stays `acknowledged`.
- Later alerts with a higher severity: the incident keeps its original severity. A person changes it.
- A manual incident never groups, because it has no `dedup_key`.
- Out-of-order alerts (`resolved` processed before `firing`): processed in `received_at` order per claim batch. A `resolved` alert with no incident is stored alone, and a later `firing` alert opens an incident. This is acceptable.

## Security

- The tenant comes from the source row that the path id selects, never from the body or headers. The source lookup by id alone is the only pre-tenant query in this feature. Audit its callers, like `CredentialStore`.
- The signature is verified over the raw bytes, with a constant-time comparison, before any JSON parsing, as `.claude/rules/security.md` requires.
- Secrets are generated as 32 random bytes in base64url, sealed at rest, shown once, and never logged or returned in errors.
- `title` and `details` are untrusted text. They are stored and returned as data, never rendered or interpreted here. Later Slack and AI phases must escape them, and treat them as data rather than instructions.
- Isolation tests: tenant B cannot list A's sources or A's alerts, and a source of A can never open or attach to an incident in B.
- `/webhooks/*` has no bearer auth. Only this route is mounted there.

## Out of scope

- Vendor payload formats (Alertmanager, Grafana, Datadog)
- Rotating, disabling or deleting a source, and rotating secrets. This is the next slice, because a leaked secret currently needs a database fix
- Auto-resolving or reopening incidents from alerts
- Severity escalation from later alerts
- Slack notification on auto-created incidents (Phase 4 delivery spec)
- The audit log (its own Phase 3 spec)
- Rate limiting per source
- AI summaries and severity suggestions (Phase 5)

## Done when

- [x] An admin creates a source and gets its secret once. A responder or viewer gets 403. A duplicate name gets 409 (`tests/alertSources.contract.test.ts`)
- [x] A signed alert gets 202 and a pending row. A bad signature, stale timestamp or unknown source gets 401 with an identical body. A 64 KB+ body gets 413 (`tests/alertIngest.contract.test.ts`)
- [x] The worker opens an incident for a new key, attaches a repeat key, ignores resolved incidents, and records a resolved alert without an incident (`src/services/alerts/alertProcessor.test.ts`)
- [x] Concurrent workers processing the same new key produce one incident. In Postgres, 8 workers give one incident with `alertCount` 8 (`tests/alertRepository.parity.test.ts`)
- [x] A throwing alert retries with backoff and becomes `failed` after 5 attempts (`alertProcessor.test.ts`, "alertProcessor failures")
- [x] An admin lists alerts and filters by `state=failed`. A responder or viewer gets 403. `lastError` is never in the response (`tests/alerts.contract.test.ts`)
- [x] Cross-tenant source, alert and incident isolation tests in `tests/security.test.ts` ("alert ingestion")
- [x] The incident response gains `origin`, `alertCount` and `lastAlertAt`. The contract is regenerated and additive only (no removed lines in `contracts/openapi.yaml`)
- [x] `pnpm check` passes (276 tests). A manual run against the dev database turned 3 signed alerts into 1 incident with `alertCount` 3
