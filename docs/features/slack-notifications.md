# Slack notifications

Status: Draft

Phase 4. Decided by the user: option A, Slack incoming webhook URLs. This draft fixes the data model. The API, delivery worker and message format are still to be specified.

## Goal

Post a message to a tenant's own Slack channel when an incident is opened, so the team learns about it without watching the API.

## User flow

1. An admin creates an incoming webhook in Slack for a channel, such as `#shopkart-incidents`.
2. The admin adds it to IncidentDesk with a display name and a minimum severity.
3. When an incident at or above that severity is opened, IncidentDesk posts to every enabled channel of that tenant.

## Permissions

| Action | Viewer | Responder | Admin |
|---|---|---|---|
| List notification channels | No | No | Yes |
| Add, enable, disable or delete a channel | No | No | Yes |

## API changes

Requested by the user, so an admin can set the webhook URL with curl.

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/v1/notification-channels` | 201 with the channel | 401, 403, 409, 422 |
| GET | `/v1/notification-channels` | 200 with a page of channels | 401, 403, 422 |

- Create body: `{ name, webhookUrl, minSeverity?, enabled? }`. `minSeverity` defaults to `sev4` and `enabled` to `true`. Unknown fields get 422.
- Channel response: `{ id, kind, name, webhookUrlHint, minSeverity, enabled, createdAt }`. `webhookUrlHint` is `…` plus the last 4 characters. The full URL is never returned, including in the create response.
- A second channel with the same name in the same tenant: 409.
- Delete, enable and disable come later.

Encryption, answering open question 1: AES-256-GCM with a random 12-byte nonce per value. The tenant id and channel id are bound as associated data, so a ciphertext copied to another row or tenant fails to decrypt. The key is `NOTIFICATION_ENCRYPTION_KEY`, 32 bytes in base64. A leading version byte leaves room for key rotation.

## Data changes

Migration `0003_create_notification_channels.sql` adds `notification_channels`:

| Column | Purpose |
|---|---|
| `tenant_id`, `id` | Primary key, tenant first |
| `kind` | `slack_webhook` only, so other kinds can be added later |
| `name` | Display name, such as `#shopkart-incidents`. Unique per tenant |
| `target_ciphertext` | The webhook URL, encrypted by the application. The plaintext URL is never stored |
| `target_hint` | Last 4 characters of the URL, so the API can show a masked value without decrypting |
| `min_severity` | Lowest severity that notifies. `sev4` means every incident |
| `enabled` | Lets an admin pause a channel without deleting it |
| `created_at` | Ordering for lists |

A tenant can have several channels, for example `sev1` to `#oncall` and everything to `#incidents`.

## Edge cases and failures

- Slack is down or slow: incident creation still succeeds. Delivery runs outside the request, after the Phase 3 queue exists.
- Slack returns 404 or `invalid_token` for a revoked webhook: record the failure. Disabling the channel automatically is to be decided.
- No enabled channel: nothing is sent.

## Security

- The webhook URL is a secret, because anyone holding it can post to the channel. It is encrypted at rest, never returned, never logged.
- Decided by the user: any webhook URL is accepted, with no host, scheme or address restriction. `http` is allowed, and so are private, loopback and cloud metadata addresses. Accepted risk: an admin can make the server send requests to internal addresses (SSRF), and an `http` URL is sent unencrypted.
- `tenantId` comes from the principal. Isolation tests cover list, create and delete across tenants.
- The encryption key comes from config and a secret manager in production. Losing it makes stored URLs unreadable, so admins would re-enter them.

## Out of scope

- Slack app with OAuth and buttons (option B)
- Mentioning the on-call person
- Email, SMS and phone

## Open questions

1. Key rotation: how to re-encrypt stored URLs under a new key.
2. Which events notify: opened only, or also acknowledged and resolved.
3. Whether a channel is disabled after repeated delivery failures.

## Done when

- [x] Migration adds `notification_channels` with tenant-first keys and indexes
- [x] An admin can create and list channels, and a viewer or responder gets 403 (`tests/notificationChannels.contract.test.ts`)
- [x] The full webhook URL never appears in a response (`tests/security.test.ts`, "notification channels")
- [x] Webhook URLs encrypted at rest, proven by a repository test that reads the raw column (`tests/notificationChannelRepository.parity.test.ts`)
- [x] A ciphertext moved to another tenant or channel fails to decrypt (same test, and `src/adapters/aesGcmSecretBox.test.ts`)
- [x] Tenant isolation tests added
- [ ] An opened incident posts to the tenant's channel through the queue
- [x] Contract regenerated, with no breaking change (no removed lines)
- [ ] `pnpm check` passes
