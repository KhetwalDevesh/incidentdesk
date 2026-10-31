# IncidentDesk

A multi-tenant incident management API, built to practise AI-assisted development with Claude Code. Rules, contracts and enforcement exist from the first commit.

**Status:** Phase 1. The API has an in-memory repository and development tokens, so it is not production-ready. See the [roadmap](docs/spec.md#roadmap).

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm check
pnpm dev
```

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
