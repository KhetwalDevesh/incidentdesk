# ADR 0002: AWS SQS carries alert work; the alerts table stays the source of truth

Status: Accepted

## Decision

Alert delivery from the webhook to the worker uses an AWS SQS standard queue instead of polling the `alerts` table. Messages carry only `{ tenantId, alertId }`. The `alerts` row stays the source of truth for content, state and history. An outbox sweeper re-sends pending rows that are overdue. LocalStack provides SQS locally and in CI. The Postgres polling queue is removed, not kept as a fallback.

## Context

Alert ingestion shipped with a Postgres table queue (`FOR UPDATE SKIP LOCKED`, a 60 s lease and hand-rolled backoff). It is atomic with the incident write and needs no new infrastructure, but every worker polls the database, and retries and dead-lettering are our own code. Phase 6 deploys to AWS, where a managed queue removes the polling load and adds visibility timeouts, long polling and a DLQ.

Alternatives considered: pg-boss or graphile-worker (still Postgres), Redis with BullMQ, RabbitMQ, Kafka (overkill for this volume), and Temporal (better suited to escalation workflows).

SQS cannot share a transaction with Postgres. Sending the full payload would make the queue the source of truth, and would hide alerts from `GET /v1/alerts` until they were processed. Sending ids, with the row written first, keeps one source of truth. The cost is a sweeper to cover sends that fail after the insert.

## Consequences

- Local development and CI need LocalStack running, as they already need Postgres.
- A new runtime dependency, `@aws-sdk/client-sqs`, and new config: `AWS_REGION`, `ALERT_QUEUE_URL` and `AWS_ENDPOINT_URL`.
- Delivery is at least once. Correctness depends on `startAttempt` and `complete()` staying idempotent through the `pending` check and row lock.
- Retry backoff uses `ChangeMessageVisibility`. Attempts are counted in Postgres, so a crash loop still ends in `failed`.
- An alert whose send failed waits for the sweeper, up to about 2.5 minutes, before it is grouped.
- `alerts.sent_at` (migration 0008) records a confirmed send. The sweeper uses it to tell a lost send (re-sent after 2 minutes) from a slow queue (re-sent only after 15 minutes), so a backlog is not multiplied by duplicate messages.
- Being able to send to the queue gives no control over alert content or tenant choice.
