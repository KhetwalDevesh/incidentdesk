# AI postmortems

Status: Done

Phase 5, core flow step 7: "AI drafts a postmortem for a person to edit." This is the last Phase 5 item. It builds on `docs/features/ai-summaries.md` and reuses its model adapter, redaction, untrusted-data prompt and background draft queue.

Decided by the user:

| Question | Decision |
|---|---|
| When a draft is made | Automatically when an incident is resolved, in the background. Any member can also ask for a fresh draft later |
| What the model reads | The incident (title, severity, opening, acknowledging and resolving times), its accepted summary, its 20 most recent alerts, and its audit timeline as actions and times. People appear as roles, never names, emails or ids |
| Draft to final | Each incident has one postmortem document. Any member can accept a draft into it, edit it, and publish it. A published postmortem stays editable, and who changed it, and when, is recorded |
| Cost | Shares the summaries' daily cap: one AI budget per tenant per UTC day (`AI_DAILY_DRAFT_CAP`), counting summary and postmortem drafts together |

## Goal

After an incident, writing the postmortem is the step teams most often skip, because starting from a blank page is slow. The model drafts a first version from the facts IncidentDesk already holds. A person corrects it and publishes it. The draft is never the record: a person always decides what the postmortem says.

## User flow

1. Grace resolves the checkout incident. The worker queues a postmortem draft.
2. Seconds later the draft is ready, in seven sections:
   - **summary**: what happened;
   - **impact**: who was affected and for how long;
   - **timeline**: when it opened, was acknowledged, reassigned, its severity changed and resolved;
   - **suspected cause**: clearly marked as a hypothesis;
   - **what went well**;
   - **what went wrong**;
   - **action items**.

   Clients get `postmortem_draft.ready`.
3. Grace accepts it. The draft's sections become the postmortem's Markdown text, which she edits: she corrects the cause and adds two action items.
4. Alan reads it the next day, tightens the impact section, and publishes it. Everyone gets `postmortem.updated`.
5. A week later an admin adds a follow-up note. The postmortem stays published, and records that the admin made the last change.

## Drafts

They work exactly like summary drafts (`docs/features/ai-summaries.md`, "Drafts"):

- **States:** `pending`, `ready`, `failed` (`provider_error`, `invalid_output`) or `skipped` (`over_daily_cap`, `ai_disabled`).
- **One pending draft per incident.** Asking again while one is pending returns it.
- **Queued in the resolving change.** Resolving an incident queues a draft in the same transaction. No other change queues one.
- **Only for resolved incidents.** Asking for a draft for an unresolved incident gets 409. A postmortem describes an incident that is over.
- **The daily cap** counts summary and postmortem drafts together, per tenant, per UTC day, under the same per-tenant lock, so neither kind can pass the cap while the other is being created.

A ready draft's `content` has:

| Section | Shape | Limits |
|---|---|---|
| `summary` | text | 1 to 1,000 characters |
| `impact` | text | 1 to 1,000 characters |
| `timeline` | list of `{ at, event }`, with `at` an ISO timestamp | 1 to 30 entries; `event` up to 200 characters |
| `suspectedCause` | text, written as a hypothesis | 1 to 1,500 characters |
| `wentWell` | list of text | 0 to 10 items, each up to 300 characters |
| `wentWrong` | list of text | 0 to 10 items, each up to 300 characters |
| `actionItems` | list of text | 0 to 10 items, each up to 300 characters |

The model must return exactly this shape. It is checked with Zod, limits included, and anything else marks the draft `invalid_output`.

## The postmortem document

- **One per incident**, created the first time a member saves one.
- **`body`** is Markdown, 1 to 20,000 characters, written by hand or started from a draft.
- **Accepting a draft** turns its sections into Markdown on the server, with one heading per section and the timeline as a list. That text is filled in as the body before the member's own edits. The `draftId` is recorded.
- **`state`** is `draft` until a member publishes it, then `published`. Publishing again changes nothing. Editing a published postmortem keeps it published.
- **What is recorded:** `updatedBy`/`updatedAt` for the last edit, `publishedBy`/`publishedAt` for publishing, and `draftId` for the draft it came from, if any.

## The model call

The same as summaries (`docs/features/ai-summaries.md`, "The AI call"), with three differences:

- **Output:** up to 8,000 tokens, and a 100-second timeout (under the worker's 120-second lease). Raised from 2,000 tokens during implementation: in a live check, free reasoning models on `openrouter/free` were cut off at 2,000 three times out of three. At 8,000 they gave a valid draft three times out of three, in 14 to 27 seconds, using up to about 7,000 tokens. Only tokens used are billed.
- **Schema:** its own JSON schema (`incident_postmortem`), with the sections above.
- **Prompt:** its own fixed system prompt, asking for facts only from the data. The suspected cause must be phrased as a hypothesis, and action items must not name people.

Everything else is shared:

- **Provider:** OpenRouter through the OpenAI-compatible API, with the free `openrouter/free` router in development and production (decided by the user; see `docs/features/ai-summaries.md` for what that means for data, limits and reliability).
- **Behaviour:** the 60-second timeout, retries after 10 seconds then 1 minute (3 attempts in all), and skipping as `ai_disabled` without a key.

### Prompt and untrusted data

Everything in the data block is untrusted, fenced inside `<incident_data>` tags, and redacted as for summaries.

- **The incident:** title, severity, and when it opened, was acknowledged and was resolved.
- **Its accepted summary**, if one has been set.
- **Its 20 most recent alerts:** title, severity, status, time and details, redacted.
- **Its timeline:** up to 50 audit entries, oldest first. Each is reduced to a time, an action and a role:
  - the **action** in words: "opened", "assigned", "reassigned", "acknowledged", "severity changed from sev2 to sev1", "summary set", "alert grouped", "resolved";
  - the **role**: "a member", "the assignee" (when the actor was assigned at that moment), "an alert source" or "the system".
- **Never sent:** member ids, emails or names; tenant names; source names; ids of any kind; secrets; the audit log's request ids.
- **Size:** the prompt is kept under 60,000 characters. Older alerts are left out first, then older timeline entries, and the data says how many of each were omitted.

## How it runs

- **Same worker loop, same pattern.** The worker claims pending postmortem drafts with `FOR UPDATE SKIP LOCKED`, alongside summary drafts, and stores the result.
- **Ingestion never waits on the AI,** and resolving never waits on it either: the draft is only queued in the resolving transaction.

## Permissions

| Action | Responder | Admin |
|---|---|---|
| Read an incident's postmortem and its drafts | Yes | Yes |
| Ask for a fresh postmortem draft | Yes | Yes |
| Save the postmortem (by hand or from a draft) | Yes | Yes |
| Publish it | Yes | Yes |

## API changes

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/v1/incidents/{id}/postmortem-drafts` | 202 draft (new, pending, or skipped over the cap) | 401, 404, 409 (not resolved), 422 |
| GET | `/v1/incidents/{id}/postmortem-drafts` | 200 `{ items, total, limit, offset }`, newest first | 401, 404, 422 |
| GET | `/v1/incidents/{id}/postmortem` | 200 postmortem | 401, 404 (incident, or no postmortem yet), 422 |
| PUT | `/v1/incidents/{id}/postmortem` | 200 postmortem | 401, 404 (incident or draft), 409 (not resolved), 422 |
| POST | `/v1/incidents/{id}/postmortem/publish` | 200 postmortem | 401, 404 (no postmortem yet), 422 |

- **Draft response (strict):** `{ id, incidentId, state, content, model, failureReason, requestedBy, createdAt, completedAt }`.
  - `content` is `null` unless the draft is `ready`.
  - `model` labels the draft as an AI suggestion from that model.
- **Saving:** `PUT …/postmortem` takes `{ "body": "Markdown, 1–20,000 characters" }` or `{ "draftId": "uuid" }`, or both.
  - With only `draftId`, the body is the draft rendered as Markdown.
  - With both, the given body is saved, and the draft is recorded as its source.
  - `draftId` must be a `ready` draft of this incident.
- **Postmortem response (strict):** `{ incidentId, body, state, draftId, updatedAt, updatedBy, publishedAt, publishedBy }`.
- **Realtime (`GET /v1/events`) gains two events:**
  - `postmortem_draft.ready` (`{ incidentId, draft }`), when a draft becomes `ready`, `failed` or `skipped`;
  - `postmortem.updated` (`{ postmortem }`), when it is saved or published.

  Both are additive.
- **The incident response is unchanged.** Clients read the postmortem from its own route.

## Data changes

Migration `0019_create_postmortems.sql`:

- **`incident_postmortem_drafts`:** the same shape and indexes as `incident_summary_drafts`, with `content jsonb` in place of the summary columns.
  - `tenant_id` is text.
  - A partial unique index gives one pending draft per incident.
  - CHECKs tie `ready` to `content` and `model`.
- **`incident_postmortems`** `(tenant_id text, incident_id, body, state, draft_id, updated_by, updated_at, published_by, published_at)`.
  - Primary key `(tenant_id, incident_id)`.
  - A CHECK ties `published` to `published_at` and `published_by`.
- **Audit actions:**
  - `postmortem.saved` (`{ source: "draft" | "manual", draftId }`);
  - `postmortem.published` (`{}`).

  Both have the incident as resource. Never the body text.
- **The daily cap's lock key** becomes shared by both kinds of draft (`ai_drafts:<tenant>`), and the cap counts both tables.
- **Built as:** `src/repository/ai/postgresDraftBudget.ts` (the lock, and a count over both tables) and its in-memory twin `InMemoryDraftBudget`, shared by both draft stores.
- **The timeline is read** in pages of 100, up to 500 audit entries. Runs of grouped alerts collapse into one step with a count ("3 alerts grouped into the incident"), so a long alert storm can't push the resolution out of the 50 steps kept.

Code:

- **Domain:** `PostmortemDraftRepository` and `PostmortemRepository` ports, with the draft states and outcomes shared with summaries.
- **Repository:** Postgres, plus in-memory twins and a parity test. Resolving queues the draft inside the incident repository's `update`, like deliveries and audit entries.
- **Services:**
  - `postmortemPrompt.ts` (pure): the timeline reduction and the prompt;
  - `postmortemMarkdown.ts` (pure): draft to Markdown;
  - a `postmortemProcessor`, sharing the summary processor's retry and validation helpers;
  - `postmortemService`.
- **Adapter:** the existing `chatCompletionsSummaryWriter`, given each prompt's own output-token limit. There's no new adapter and no new dependency.
- **Worker:** one more loop.

## Edge cases and failures

- **Asking for a draft before the incident is resolved:** 409 `"Postmortems are for resolved incidents"`.
- **Saving a postmortem for an unresolved incident:** 409. There is no way to reopen an incident, so a resolved one stays resolved.
- **A draft finishes after a member already saved or published the postmortem:** it is stored as `ready`, and never applied automatically.
- **Accepting a draft that isn't `ready`, or belongs to another incident:** 404 for `draftId`.
- **`PUT` with neither `body` nor `draftId`:** 422.
- **Publishing before anything was saved:** 404 `"No postmortem yet"`.
- **Two members saving at once:** the last write wins, and both saves are audited. Concurrent editing is out of scope.
- **The model invents a timeline event:** its output can't be checked against the facts by code. The draft is labelled as AI-written, and a person reviews it before publishing.
- **A very long incident** (many alerts, a long timeline): older alerts, then older timeline entries, are left out, and the data says how many.
- **The cap is reached:** the draft comes back `skipped` / `over_daily_cap`, and the postmortem can still be written by hand.
- **No key configured:** drafts are `skipped` / `ai_disabled`.

## Security

- **Tenant boundary:**
  - Drafts, postmortems and prompts are tenant-scoped.
  - The worker reads the incident, alerts and audit timeline with the draft's own tenant.
  - Another tenant's incident, draft or postmortem gives 404.
  - Isolation tests cover every route and event.
- **Data sent:**
  - Only what is listed under "Prompt and untrusted data", redacted, to the configured provider.
  - The timeline reduction removes every person and every id, and the prompt test proves it.
  - The accepted summary is redacted like alert text, since it may quote alert content.
- **Prompt injection:** the model has no tools, its output is schema-checked, and a draft changes nothing until a person accepts it. The postmortem body is stored and returned as plain text. Rendering it safely is the client's job, and the API never renders it.
- **Never logged:** prompts, model output and postmortem bodies. Errors are logged with the draft id only.
- **Audit:** saving and publishing are audited by id, without body text.

## Out of scope

- Exporting (PDF, Markdown download) or sharing postmortems outside the tenant
- Comments, review workflows and concurrent editing
- Tracking action items as tasks, and linking to ticketing tools
- Per-tenant postmortem templates
- Posting postmortems to Slack
- Reopening incidents
- An evaluation of draft quality

## Done when

- [x] Resolving queues one postmortem draft in its transaction; one pending draft per incident; summary and postmortem drafts share the daily cap under concurrency, the same in memory and in Postgres (`tests/postmortemRepository.parity.test.ts`)
- [x] The timeline reduction turns audit entries into actions, times and roles with no ids, emails or names; the prompt fences everything as data and leaves out the oldest alerts and timeline entries, with counts (`src/services/postmortems/postmortemPrompt.test.ts`)
- [x] A ready draft renders to the documented Markdown (`src/services/postmortems/postmortemMarkdown.test.ts`)
- [x] The worker produces `ready`, `invalid_output`, `provider_error` with retries, and `ai_disabled` drafts, with a fake writer (`src/services/postmortems/postmortemProcessor.test.ts`)
- [x] Any member requests, lists, saves (by hand, from a draft, or both), reads and publishes; unresolved gets 409, a non-ready or foreign draft 404, an empty save 422 (`tests/postmortems.contract.test.ts`)
- [x] Saving and publishing are audited without body text, and stream as `postmortem.updated`; finished drafts stream as `postmortem_draft.ready` (`tests/audit.contract.test.ts`, `tests/events.contract.test.ts`)
- [x] Another tenant can't read, draft, save or publish, and no prompt carries another tenant's data, ids, emails or names (`tests/security.test.ts`, "ai postmortems")
- [x] Contract regenerated: additive only
- [x] `pnpm check` passes
