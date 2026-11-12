# IncidentDesk product spec

IncidentDesk helps small engineering teams receive alerts, group them into incidents and resolve them with a clear record.

## Users

| Role | Can do |
|---|---|
| Viewer | Read incidents |
| Responder | Viewer actions, plus create, acknowledge and resolve incidents |
| Admin | Responder actions, plus manage members and webhook sources |

## Core flow

1. A monitoring tool sends an alert to a signed webhook.
2. A queue worker groups duplicate alerts into one incident.
3. AI drafts a summary and suggests a severity. A person confirms it.
4. The on-call engineer gets a Slack alert.
5. The engineer acknowledges, then resolves, the incident.
6. Every action is written to an audit log.
7. AI drafts a postmortem for a person to edit.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1. Foundation | Rules, contract, CI, golden reference slice | Done |
| 2. Core | Postgres, real auth, tenants, roles | In progress: Postgres done |
| 3. Pipeline | Signed webhooks, queue, grouping, audit log | Planned |
| 4. Team flow | On-call, Slack, dashboard, realtime status | Planned |
| 5. AI | Summaries, severity suggestions, postmortems | Planned |
| 6. Hardening | Load test, security review, AWS deployment | Planned |

## Out of scope

- Phone and SMS paging
- Billing
- Native mobile apps
- Automatic incident resolution by AI

## Non-functional requirements

- One tenant can never read or change another tenant's data.
- Alert ingestion stays available when the AI provider is down.
- Every request has an id that appears in its response and logs.
