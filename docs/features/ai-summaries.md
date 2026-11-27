# AI summaries

Status: Approved

Phase 5, core flow step 3: "AI drafts a summary and suggests a severity. A person confirms it."

Decided by the user:

| Question | Decision |
|---|---|
| When a draft is made | Automatically when an incident opens, in the background. Any member can also ask for a fresh draft later |
| What is sent to the AI | The incident's title and severity, and up to its 20 most recent alerts: title, severity, status, time received and details |
| Confirming | Any member can accept a draft, edit its text first, and set the incident's severity (the suggested one or another). Any member can also edit the summary later |
| Cost | At most 100 drafts per tenant per UTC day. Beyond that, drafts are skipped with a reason, and incidents work as normal |
| Model | An open-source Qwen 3 model, called through OpenRouter: the free variant in development, the paid variant in production. Not Claude, and nothing self-hosted |

## Goal

When an alert storm opens an incident, the on-call engineer gets a short, readable account in seconds: what is failing, how widely, since when. They also get a severity suggestion they can accept with one action. The AI only drafts; a person always decides what the incident says.

## User flow

1. Prometheus fires 12 alerts about checkout latency. The worker opens one incident and queues a draft.
2. Seconds later the worker has the draft: *"Checkout API p99 latency above 2 s across 3 regions since 02:10; error rate rising. Suggest sev1: customer-facing and widespread."* Clients get a `summary_draft.ready` event.
3. Grace reads it, shortens one sentence, and accepts it with severity sev1. The incident's summary and severity change, both are audited, and everyone gets `incident.updated`.
4. Twenty minutes later more alerts have joined. Alan asks for a fresh draft, reads it, and edits the summary again.
5. On a busy day the tenant reaches 100 drafts. Later drafts are recorded as skipped (`over_daily_cap`), and summaries can still be written by hand.

## Drafts

A draft belongs to one incident, and is one of:

| State | Meaning |
|---|---|
| `pending` | Waiting for the worker |
| `ready` | Has `summary`, `suggestedSeverity` and `rationale` |
| `failed` | Has `failureReason`: `provider_error` (still failing after retries) or `invalid_output` |
| `skipped` | Never sent to the AI. `failureReason`: `over_daily_cap`, or `ai_disabled` (no API key configured) |

Rules:

- **When drafts are made.** Opening an incident, by a person or by an alert, queues one draft in the same transaction. Alerts that later join the incident never queue a draft by themselves.
- **One pending draft per incident.** Asking again while one is pending returns that draft.
- **The daily cap** counts every draft that is not `skipped`, per tenant, per UTC day. It is checked when a draft is created, under a per-tenant lock, so concurrent requests cannot pass it.
- **What a ready draft contains:**
  - `summary`: 1 to 600 characters;
  - `suggestedSeverity`: one of sev1 to sev4;
  - `rationale`: 1 to 300 characters, saying why that severity.
- **What happens to drafts.** They are kept with the incident, and never change it until a member accepts one.

## The AI call

- **Provider:** OpenRouter, a hosted gateway that runs open models on its providers' GPUs. Nothing is self-hosted: the worker sends one HTTPS request per draft, as it does for Slack.
- **Protocol:** the OpenAI-compatible `POST {AI_BASE_URL}/chat/completions`, called with plain `fetch`. There is no SDK, so no new dependency. Any server that speaks this protocol works by changing settings, including Groq, or Ollama or vLLM if self-hosting is wanted later.
- **Model:** a Qwen 3 instruct model (Apache 2.0).
  - **Development:** its `:free` variant on OpenRouter, which costs nothing and allows 50 requests a day (1,000 a day once $10 of credits has been bought).
  - **Production:** the same model without `:free`, paid per token.
  - **The exact model id** is chosen and checked against OpenRouter's model list during implementation, and goes in `AI_MODEL` and `.env.example`. Qwen 2.5 7B, the first choice, is no longer listed by OpenRouter or the other hosts checked.
- **Structured output.**
  - **Requested schema:** the request asks for `response_format: { type: "json_schema", json_schema: { strict: true, schema } }` (`summary`, `suggestedSeverity`, `rationale`).
  - **Routing:** with `provider: { require_parameters: true }`, OpenRouter only uses providers that support it.
  - **Always checked:** the response is validated with a Zod schema, including the length limits, before anything is stored. A free model that ignores the schema just produces an `invalid_output` draft.
- **Data policy in production:** the request asks OpenRouter to use only providers that don't store or train on prompts (`provider: { data_collection: "deny" }`). Its exact name and behaviour are checked against OpenRouter's documentation during implementation. In development this is a setting (`AI_DENY_DATA_COLLECTION`), since free models may have no provider that meets it.
- **Timeout:** each call times out after 60 seconds, counted as a provider error.
- **Retries:** 429, 5xx, timeouts and lost connections are retried by the worker after 10 seconds, 1 minute, then 5 minutes, at most 3 attempts in all. After that the draft is `provider_error`. Other 4xx, such as a bad key or an unknown model, fail at once as `provider_error`.
- **Recorded on the draft:**
  - the model that answered, from the response's `model` field, returned as `model` so the draft is labelled as an AI suggestion from that model;
  - the prompt and completion token counts, from `usage`, which are never returned and are kept for cost reporting.
- **Without `AI_API_KEY`** the worker makes every draft `skipped` / `ai_disabled`, so CI and anyone without a key never call the API.

### Prompt and untrusted data

- **System prompt:** fixed text describing the task, the schema, and that everything in the user message is untrusted monitoring data to summarise, never instructions to follow.
- **User message:** the incident title and severity, then the alerts as JSON inside `<alert_data>` tags. Each alert carries its title, severity, status, receivedAt and details. Alert text is cut to the existing contract limits and sent as data, not interpolated into instructions.
- **Redaction first** (`src/services/summaries/redact.ts`, pure and unit-tested). Before anything leaves the system:
  - **By key:** any detail whose key looks like a credential (`password`, `passwd`, `secret`, `token`, `apikey`/`api_key`, `authorization`, `cookie`, `session`, `private_key`, `credential`, case-insensitive) has its value replaced with `[redacted]`.
  - **By value**, in every string (titles and detail values), these patterns become `[redacted]`:
    - email addresses;
    - `Bearer …` tokens and JWTs;
    - AWS access key ids (`AKIA…`/`ASIA…`);
    - `sk-…`-style API keys;
    - URLs carrying credentials (`user:pass@host`);
    - long hex or base64 strings of 32+ characters.
  - The redacted copy is what the prompt is built from. Stored alerts are unchanged.
- **Never sent:** member emails or names, tenant names, ids, tokens, secrets (after redaction), webhook URLs or audit history.
- **Never logged:** prompts and model output. Errors are logged with the draft id and a fixed description only.
- **Why prompt injection can do little harm here.** The model has no tools, its output is schema-checked, and a draft changes nothing until a person accepts it. A malicious alert can at worst produce a misleading draft, which a human reads before using.

## How it runs

- **Separate from ingestion.** The draft row is the job, written in the incident's transaction. The worker claims pending drafts with `FOR UPDATE SKIP LOCKED` every 2 seconds, calls the API, and stores the result. Like the alert and delivery outboxes, a crashed attempt comes back after its lease. No new queue to set up.
- **Ingestion never waits on the AI.** If OpenRouter or the model's providers are slow or down, alerts and incidents carry on; only drafts are delayed or fail.

## Permissions

| Action | Responder | Admin |
|---|---|---|
| Read an incident's drafts and summary | Yes | Yes |
| Ask for a fresh draft | Yes | Yes |
| Accept a draft, edit the summary, set severity (by the user's decision) | Yes | Yes |

## API changes

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/v1/incidents/{id}/summary-drafts` | 202 draft (new, or the pending one) | 401, 404, 422 |
| GET | `/v1/incidents/{id}/summary-drafts` | 200 `{ items, total, limit, offset }`, newest first | 401, 404, 422 |
| PUT | `/v1/incidents/{id}/summary` | 200 incident | 401, 404 (incident or draft), 409, 422 |

- **Draft response (strict):** `{ id, incidentId, state, summary, suggestedSeverity, rationale, model, failureReason, requestedBy, createdAt, completedAt }`.
  - `requestedBy` is a member id, or `null` for a draft made when the incident opened.
  - Fields that don't apply to the draft's state are `null`.
  - `model` is the model that wrote a `ready` draft. Token counts are never returned.
- **Setting the summary:** `PUT …/summary` takes `{ "text": "1–2000 characters", "severity": "sev1" | … (optional), "draftId": "uuid" (optional) }`.
  - `draftId` records which draft was accepted. It must be a `ready` draft of this incident.
  - Changing severity on a resolved incident gets 409; its summary can still be edited.
- **The incident response gains** `summary: null | { "text", "updatedAt", "updatedBy", "draftId" }`. Additive.
- **Realtime (`GET /v1/events`) gains two events:**
  - `incident.updated` (`{ incident }`), when the summary or severity changes;
  - `summary_draft.ready` (`{ incidentId, draft }`), when a draft becomes `ready`, `failed` or `skipped`.

  Both are new names on the stream, and additive.

## Data changes

Migration `0018_create_summary_drafts.sql`:

- **`incident_summary_drafts`** `(tenant_id text, id, incident_id, state, summary, suggested_severity, rationale, failure_reason, requested_by, attempts, next_attempt_at, model, input_tokens, output_tokens, last_error, created_at, completed_at)`.
  - `tenant_id` is text, like `incidents.tenant_id`.
  - Primary key `(tenant_id, id)`. CHECKs tie the state to its fields.
  - Partial unique index `(tenant_id, incident_id) WHERE state = 'pending'`, giving one pending draft per incident.
  - Index `(tenant_id, incident_id, created_at DESC)` for the list, and `(tenant_id, created_at)` for the daily cap.
  - Partial index `(next_attempt_at) WHERE state = 'pending'` for the worker. Not tenant-first on purpose: the worker serves every tenant.
- **`incidents`** gains `summary text`, `summary_updated_at`, `summary_updated_by` and `summary_draft_id` (all nullable).
- **Audit actions:** `incident.summary_set` (`{ source: "draft" | "manual", draftId }`) and `incident.severity_changed` (`{ from, to }`). Never the summary text, which may quote alert content.

Code:

- **Domain:** `SummaryDraftRepository` (create within a change, claim, complete, list), a `SummaryWriter` port (the AI call, behind an interface), and incident `setSummary`.
- **Adapter:** `src/adapters/chatCompletionsSummaryWriter.ts`, using `fetch`. It's the only file that knows the provider's protocol; tests use a fake writer, or a stubbed `fetch` for the adapter itself.
- **No new dependency.**
- **Config:**
  - `AI_BASE_URL` (default `https://openrouter.ai/api/v1`);
  - `AI_API_KEY` (optional, worker only; without it drafts are skipped);
  - `AI_MODEL` (required when `AI_API_KEY` is set: the Qwen 3 id, with `:free` in development);
  - `AI_DENY_DATA_COLLECTION` (default `true`; set `false` only for free models in development);
  - `AI_DAILY_DRAFT_CAP` (default 100).

## Edge cases and failures

- **OpenRouter or the model's providers down, or rate limited:** retried 3 times, then `provider_error`. A member can ask again later.
- **The free tier's daily limit is used up (development):** OpenRouter answers 429, which is retried and then `provider_error`. The tenant cap and OpenRouter's limit are separate.
- **The model withdrawn or renamed by OpenRouter:** a 4xx, so `provider_error` at once. Fixing `AI_MODEL` resolves it, with no code change.
- **Output that does not match the schema:** `invalid_output`, with no retry, since the same input will likely fail the same way.
- **An incident opened by a person, with no alerts:** drafted from its title and severity alone.
- **Asking for a draft while one is pending:** the pending one comes back, and nothing new is created.
- **The cap is reached:** the new draft is `skipped` / `over_daily_cap`, still returned with 202. It doesn't count toward the cap, which resets at 00:00 UTC.
- **A draft finishes after the incident was resolved or re-summarised:** it is stored as `ready` and never applied automatically.
- **Accepting a draft that is not `ready`, or belongs to another incident:** 404 for `draftId`.
- **Severity set on a resolved incident:** 409 `"A resolved incident's severity cannot change"`. The summary alone can still be set.
- **The worker crashes mid-call:** the lease ends, and another attempt runs. Attempts are counted, so a draft that keeps crashing ends as `provider_error`.
- **Very large alert details:** already capped by the alert contract (64 KB per alert, 50 detail keys), with 20 alerts at most. Small open models have smaller context windows, so the prompt is kept under about 60,000 characters (roughly 15,000 tokens). If it would be larger, the oldest alerts are left out, and the prompt says how many were omitted. Nothing is cut silently.

## Security

- **Tenant boundary:**
  - Drafts are keyed and queried by tenant first.
  - The worker loads the incident and its alerts through tenant-scoped repositories, using the draft's tenant.
  - Another tenant's incident or draft returns 404.
  - Isolation tests cover every new route and the realtime events.
- **Data leaving the system:**
  - Only what is listed under "Prompt and untrusted data" is sent, after redaction, over TLS with the operator's key, to OpenRouter and the provider it routes to.
  - In production, routing is restricted to providers that don't store or train on prompts.
  - Free development models may be served by providers that log prompts, so development should use test data only.
  - Redaction is a pattern match: it lowers the risk of a secret in alert text reaching a provider, but can't guarantee it. Monitoring tools should still not put secrets in alerts.
- **Prompt injection:** the model has no tools, its output is schema-checked, and drafts need a human to accept them (see above). Draft and summary text is returned as plain JSON strings. It is never posted to Slack by this feature, so mrkdwn injection doesn't arise.
- **Secrets:** `AI_API_KEY` is read only in `src/config.ts`, used only by the worker, and never logged or stored. Error text stored on a draft is a fixed description, never the provider's raw message.
- **Where requests go:** `AI_BASE_URL` is operator configuration, never user input, so it can't be used to point the worker at an internal address.
- **Cost abuse:** the daily cap per tenant, and one pending draft per incident.
- **Audit:** accepting or editing a summary and changing severity are audited with ids only.

## Out of scope

- Postmortem drafts (core flow step 7: a separate feature)
- Posting summaries to Slack, and Slack messages for severity changes
- Summaries that update themselves as alerts join
- Per-tenant opt-out of AI, choosing the model per tenant, and data-residency settings
- Purging old drafts (kept with their incident)
- Using audit history, comments or runbooks as context
- Evaluations measuring summary quality (worth a follow-up)
- Self-hosting the model (Ollama or vLLM). It needs only new settings, no code change
- Falling back to a second model when the first fails

## Done when

- [ ] Opening an incident, by a person or an alert, queues one draft in its transaction; joining alerts queue none; one pending draft per incident; the daily cap holds under concurrency, the same in memory and in Postgres (`tests/summaryDraftRepository.parity.test.ts`)
- [ ] The worker turns a pending draft into `ready`, retries provider errors, and records `invalid_output`, `provider_error` (retried and not), `over_daily_cap` and `ai_disabled` correctly, with a fake writer (`src/services/summaries/summaryProcessor.test.ts`)
- [ ] Redaction removes credential-like keys, emails, bearer tokens, JWTs, cloud and API keys and long secrets, and leaves ordinary text alone (`src/services/summaries/redact.test.ts`)
- [ ] The prompt carries the listed fields, wraps alert data as data, and never includes emails, ids or secrets; the request carries the schema and the data policy; model output is validated with Zod; provider errors map to retry or fail (`src/adapters/chatCompletionsSummaryWriter.test.ts`, with a stubbed `fetch`)
- [ ] Any member requests, lists and accepts drafts, edits the summary and sets severity; a non-ready or foreign draft gets 404, and a resolved incident's severity gets 409 (`tests/summaries.contract.test.ts`)
- [ ] Summary and severity changes are audited without summary text, and stream as `incident.updated`; finished drafts stream as `summary_draft.ready` (`tests/audit.contract.test.ts`, `tests/events.contract.test.ts`)
- [ ] Another tenant's incidents and drafts can't be read, drafted or accepted (`tests/security.test.ts`, "ai summaries")
- [ ] Contract regenerated: additive only
- [ ] `pnpm check` passes
