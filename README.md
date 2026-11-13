# IncidentDesk

A multi-tenant incident management API, built to practise AI-assisted development with Claude Code. Rules, contracts and enforcement exist from the first commit.

**Status:** Phase 2 in progress. Incidents and accounts are stored in Postgres, and the API issues its own JWTs. Login has no rate limiting yet, so it is not production-ready. See the [roadmap](docs/spec.md#roadmap).

## Quick start

Needs Node 22, pnpm and Docker.

```bash
pnpm install
cp .env.example .env
pnpm db:up        # Postgres 17 in Docker, on port 54329
pnpm db:migrate   # apply db/migrations
pnpm check        # the parity tests use the incidentdesk_test database
pnpm dev
```

`pnpm db:down` stops Postgres and keeps its data volume.

## Layout

| Path | Contents |
|---|---|
| `CLAUDE.md` | Instructions for every Claude session |
| `.claude/` | Rules, agents, skills, hooks and permissions |
| `docs/LEARNING-GUIDE.md` | Walkthrough of the whole setup |
| `docs/spec.md` | Product scope and roadmap |
| `docs/features/` | Feature specs |
| `docs/adr/` | Architecture decisions |
| `src/contract/` | API source of truth |
| `contracts/openapi.yaml` | Generated API description |
| `scripts/` | Rule checks and contract generation |
