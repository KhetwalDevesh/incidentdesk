# Alert queue on AWS SQS

Status: Approved

Replaces the Postgres polling queue from `docs/features/alert-ingestion.md` with AWS SQS. Decision record: `docs/adr/0002-sqs-alert-queue.md`. The webhook, the alert list API and the grouping rules do not change.

Decided by the user:

| Question | Decision |
|---|---|
| Queue | AWS SQS, a standard queue (not FIFO). Grouping is already race-safe through the unique index, so ordering and exactly-once delivery are not needed |
| Message body | `{ tenantId, alertId }` only. The `alerts` row stays the source of truth |
| Lost sends | An outbox sweeper re-sends pending alerts that are overdue |
| Telling a lost send from a slow queue | A new `alerts.sent_at` column (migration 0008), set after `SendMessage` succeeds. The sweeper re-sends unsent rows after 2 minutes, and sent rows only after 15 minutes, so a queue backlog does not multiply messages |
| Local queue | Real AWS SQS, not an emulator: LocalStack has needed an account token since 2026.03. Each developer creates their own queue and dead-letter queue with `pnpm sqs:setup`, so workers never take each other's messages. Credentials come from an AWS CLI profile named in `AWS_PROFILE`, for an IAM user limited to the queue actions on `incidentdesk-*` |
| Region | `ap-southeast-2`. The organisation's service control policy allows SQS only there |
| CI | No AWS credentials in CI. Unit, contract and security tests use the in-memory queue. The SQS adapter's integration test runs on demand with `pnpm test:sqs`, against a developer's test queue |
| Postgres queue | Replaced, not kept as a second driver |
| Branch | `feat/alert-queue-sqs`, after alert ingestion was committed |

## Goal

Move alert delivery to a managed queue that scales without polling Postgres. That prepares for the Phase 6 AWS deployment, and keeps the guarantees we have today: every accepted alert is grouped exactly once, failures retry with backoff, and admins can see failed alerts.

## User flow

Unchanged for users. Internally:

1. The webhook verifies the request, inserts the alert row as `pending`, and sends `{ tenantId, alertId }` to SQS. When the send succeeds, it sets `sent_at`. It returns 202 either way. If the send fails, the row is already saved with `sent_at` empty, and the sweeper sends it later.
2. The worker long-polls SQS (up to 10 messages, 20 s wait). For each message:
   1. It validates the body. A malformed body is deleted and logged by message id.
   2. It starts an attempt: in one statement it increments `attempts` and sets `next_attempt_at` to now plus the visibility timeout, only if the row is still `pending`. If the row is not pending, the message is a duplicate, so the worker deletes it.
   3. It runs the existing `complete()` transaction, then deletes the message.
   4. On error it records the failure. If attempts remain, it changes the message's visibility to the backoff delay (5 s, 30 s, 2 min, 10 min), so SQS redelivers it then. After attempt 5, the row becomes `failed` and the message is deleted.
3. The sweeper runs in the worker every 30 s. It claims pending rows (`FOR UPDATE SKIP LOCKED`) whose `next_attempt_at` is overdue by more than the cutoff, and sets their `next_attempt_at` to now so that another sweeper skips them. It then sends each one and sets `sent_at` when the send succeeds. The cutoff is:
   - 2 minutes when `sent_at` is empty: the send failed or never happened.
   - 15 minutes when `sent_at` is set: the message was lost or reached the DLQ. A queue that is merely slow stays under this, so it gets no duplicates.

```text
monitoring tool ──signed POST──► webhook ──insert──► alerts (pending)
                                    │ send {tenantId, alertId}      ▲
                                    ▼                               │ overdue? re-send
                                   SQS ──receive──► worker ──complete()──┘ sweeper (every 30 s)
                                    │  error: visibility = backoff
                                    └─ 10 receives ──► DLQ (safety net)
```

## Permissions

No change.

## API changes

None. The contract, `contracts/openapi.yaml` and the response shapes are unchanged.

## Data changes

Migration `0008_add_alert_sent_at.sql` adds a nullable `alerts.sent_at timestamptz`. This is an expand-only change: no default, so it updates only the catalog and the lock is brief. Rows that are pending at deploy have `sent_at` empty, so the first sweep sends the old Postgres queue's backlog to SQS. Rollback: `ALTER TABLE alerts DROP COLUMN sent_at`, once no code reads it.

`next_attempt_at` changes meaning: "when this alert should have been handled by". It is set to `received_at` at enqueue, to now plus the visibility timeout when an attempt starts, to the retry time after a failure, and to now when the sweeper claims the row. The sweeper re-sends only rows past it by the cutoff (2 minutes unsent, 15 minutes sent), so it never races a message that is in flight or waiting for its backoff (the longest is 10 minutes). The existing `alerts_pending_due_idx` serves the sweeper.

Code:

- New port `AlertQueue` (replaces the `claimDue` one): `send(ref)`, `receive(max, waitSeconds)`, `delete(message)`, `retryAfter(message, delayMs)`.
- Adapters: `src/adapters/sqsAlertQueue.ts` (`@aws-sdk/client-sqs`) and an in-memory queue for unit and contract tests.
- `AlertRepository` gains `startAttempt(tenantId, alertId, leaseUntil)`, which returns the alert or null, and `markSent(tenantId, alertId, sentAt)`. The pre-tenant `claimDue` becomes `claimOverdue({ unsentBefore, sentBefore }, now, limit)` on a separate `AlertOutbox` port, used only by the sweeper. The processor computes the two cutoffs, so the repository holds no timing policy.
- `AlertProcessor` gets `processMessages()` and `sweep()`. `src/worker.ts` runs both.
- Config: `AWS_REGION`, `ALERT_QUEUE_URL`, and an optional `AWS_ENDPOINT_URL` for an emulator, unused by default. Credentials come from the default AWS provider chain. `.env.example` names a profile in `AWS_PROFILE` and holds no keys.
- `scripts/setup-sqs-queues.ts` (`pnpm sqs:setup --name <queue> --region <region>`) creates `<queue>` (visibility timeout 60 s, long poll 20 s, SSE on) and `<queue>-dlq`, with a redrive policy of `maxReceiveCount` 10. It is idempotent while the settings match.
- `pnpm test:sqs` runs `tests/*.integration.test.ts` through `vitest.integration.config.ts`, which loads `.env`. `pnpm test` excludes these files.
- The new dependency is `@aws-sdk/client-sqs`.

## Edge cases and failures

- SQS is down at the webhook: the row is saved with `sent_at` empty, and the response is still 202. The sweeper sends it once SQS recovers. The monitoring tool does not retry, so no duplicate alert is created.
- The send succeeds but `markSent` fails: the sweeper sends the row once more after 2 minutes. The duplicate is harmless.
- The queue has a backlog (a slow or stopped worker): sent rows are not re-sent until they are 15 minutes overdue, so the backlog does not grow from duplicates.
- Postgres is down at the webhook: 500, as today, so the monitoring tool retries.
- Duplicate delivery (standard queues are at-least-once, and the sweeper can re-send): `startAttempt` and `complete()` both require the row to be `pending`, and `complete()` locks the row. The second copy is deleted without effect.
- A worker crashes mid-alert: the transaction rolls back, and the message becomes visible again after 60 s. The attempt was already counted, so a crash loop still ends in `failed` after 5 attempts.
- A poison message that crashes the worker before `startAttempt`: it reaches the DLQ after 10 receives. The row stays `pending`, so the sweeper re-sends it once it is 15 minutes overdue. That repeats about every 25 minutes while the cause persists, which is bounded, and it shows in the DLQ.
- A malformed message body: deleted, and logged by message id only.
- A message for an unknown alert or tenant: `startAttempt` returns null, and the message is deleted.
- The worker stops on SIGTERM: it finishes the current batch. Messages it did not reach become visible again after the timeout.

## Security

- The body carries ids only, so whoever can send to the queue can only trigger processing of rows that already exist. They cannot inject alert content or pick a tenant's incident.
- `tenantId` in the message is written by our webhook, which took it from the source row. The worker still loads the row by `(tenantId, alertId)`, so a mismatched pair finds nothing.
- `claimOverdue` runs across all tenants, like `claimDue` today. Audit every caller.
- Local AWS credentials live in an AWS CLI profile, never in `.env` or the repository. Use an IAM user that can only call `sqs:CreateQueue`, `sqs:GetQueueAttributes`, `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:ChangeMessageVisibility` on `arn:aws:sqs:*:<account>:incidentdesk-*`.
- AWS credentials are never logged. In production, IAM limits the API role to `sqs:SendMessage` and the worker role to receive, delete and change visibility. That is Phase 6 infrastructure.
- Logs carry alert and message ids, never alert content.

## Out of scope

- Infrastructure as code (Terraform or CDK) for the real queue (Phase 6)
- DLQ alarms and redrive tooling
- A FIFO queue or per-tenant ordering
- Keeping the Postgres polling queue as a fallback
- Load testing (Phase 6)

## Done when

- [x] The webhook saves the row and sends `{ tenantId, alertId }`. A failed send still returns 202 and leaves the row pending (`tests/alertIngest.contract.test.ts`)
- [x] The worker groups alerts from queue messages, as before (`src/services/alerts/alertProcessor.test.ts`)
- [x] A duplicate message does not group twice, and a malformed or unknown message is deleted (`alertProcessor.test.ts`)
- [x] A failing alert retries with the backoff delays as visibility changes, and becomes `failed` after 5 attempts. A crash loop is counted too (`alertProcessor.test.ts`)
- [x] Migration 0008 adds `alerts.sent_at`. A successful send sets it, and a failed send leaves it empty (`tests/alertIngest.contract.test.ts`, `tests/alertRepository.parity.test.ts`)
- [x] The sweeper re-sends unsent pending rows after 2 minutes and sent ones only after 15 minutes. It never re-sends a row that is in flight, waiting for its backoff, or queued behind a backlog (`alertProcessor.test.ts`, `tests/alertRepository.parity.test.ts`)
- [x] The SQS adapter sends, receives, deletes and changes visibility against a real SQS test queue (`pnpm test:sqs`, `tests/sqsAlertQueue.integration.test.ts`: 3 passed against `ap-southeast-2`)
- [x] CI needs no AWS credentials, and `pnpm check` passes (296 tests)
- [x] A manual run through a real dev queue turns signed alerts into one grouped incident (3 signed alerts gave 202, then one incident with `alertCount` 3 within 3.3 s, each alert processed on attempt 1 with `sent_at` set)
- [x] The contract is unchanged
