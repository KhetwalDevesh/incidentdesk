# Learning guide

Go through this in order. Each part explains what a piece does, why it exists, and gives you a quick experiment.

Start with:

```bash
cd ~/Documents/learning/incidentdesk
pnpm install
pnpm check
```

## The big idea

There are three levels of control. Moving a rule down makes it stronger.

| Level | Where | Strength |
|---|---|---|
| Guidance | `CLAUDE.md`, `.claude/rules/`, skills | Claude reads it and usually follows it |
| Local enforcement | Hooks, permission rules | Claude Code applies it every time |
| Project enforcement | Tests, `pnpm enforce`, CI | Applies to every person and every tool |

Ask of every rule: "What happens if this gets ignored?" If the answer is serious, it needs enforcement, not stronger wording.

## Part 1: The application

Read one request end to end, in this order:

1. `src/contract/incidents.ts`: the API shape
2. `src/routes/incidents.ts`: parses, calls the service, maps
3. `src/services/incidents/incidentService.ts`: role check and business logic
4. `src/domain/incidents/types.ts`: the ports
5. `src/repository/incidents/inMemoryIncidentRepository.ts`: storage
6. `src/mappers/incidents.ts`: the response allowlist
7. `src/containers/index.ts`: wiring

Then read `docs/architecture.md`.

**Try it:** copy `.env.example` to `.env`, run `pnpm db:up`, `pnpm db:migrate` and `pnpm dev`, then in another terminal:

```bash
signup() {
  curl -s -X POST localhost:3000/v1/auth/signup -H 'Content-Type: application/json' \
    -d "{\"tenantName\":\"$1\",\"email\":\"$2\",\"password\":\"correct horse battery\"}" |
    sed -E 's/.*"accessToken":"([^"]+)".*/\1/'
}
ACME=$(signup Acme ada@example.com)
GLOBEX=$(signup Globex linus@example.com)

curl -i -X POST localhost:3000/v1/incidents \
  -H "Authorization: Bearer $ACME" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Checkout is down","severity":"sev1"}'

curl -i localhost:3000/v1/incidents -H "Authorization: Bearer $GLOBEX"
```

The second tenant sees no incidents.

## Part 2: Rules for Claude

| File | Learn | When it loads |
|---|---|---|
| `CLAUDE.md` | Commands, architecture, gotchas | Every session |
| `.claude/rules/api.md` | API do and don't | Working in matching paths |
| `.claude/rules/architecture.md` | Layer rules | Same |
| `.claude/rules/security.md` | Tenant, auth, secrets | Same |
| `.claude/rules/database.md` | Migration rules | Same |
| `.claude/rules/testing.md` | Tests that cannot be faked | Same |
| `.claude/rules/ai-features.md` | Prompt injection, human approval | Same |
| `.claude/rules/features.md` | Spec quality | Same |
| `CLAUDE.local.md` | Your private notes, gitignored | Every session of yours |

Notice that `CLAUDE.md` is short. It holds what applies everywhere, and the `paths:` filter in each rule loads the rest only when needed.

**Try it:** start `claude` here, run `/context`, then ask Claude to read a route file. Run `/context` again and look for the rules it loaded.

## Part 3: Enforcement

### Permissions: `.claude/settings.json`

- `allow`: runs without asking
- `ask`: asks each time
- `deny`: always blocked, in every permission mode

**Try it:** create a `.env` file, then ask Claude to read it. It should refuse. Deny rules match tool calls, so they will not stop a script that opens the file.

### Hooks: `.claude/hooks/`

| Hook | When | What it does |
|---|---|---|
| `protect-migrations.sh` | Before an edit | Exit 2 blocks changes to existing migrations |
| `format-file.sh` | After an edit | Formats the file |
| `verify-before-stop.sh` | Before Claude stops | Sends Claude back if `pnpm check` fails |

**Try it:** ask Claude to add `export const x: number = "y"` to a file and finish. Watch the Stop hook send it back.

### Project rule checks: `scripts/enforce-rules.ts`

This turns rules into code, with self-tests in `scripts/enforce-rules.test.ts`.

| Check | Stops |
|---|---|
| 1 | Reading `process.env` outside `src/config.ts` |
| 2 | Services importing outer layers |
| 3 | The contract importing application code |
| 4 | Routes reading `tenantId` from client input |
| 5 | New escape hatches such as `as unknown as` |

Check 5 is a ratchet: `scripts/escape-hatch-baseline.json` can only go down. Existing exceptions are tolerated, new ones fail, and removing one forces the number lower.

**Try it:** add `process.env.FOO` to a service, then run `pnpm enforce`. Remove it afterwards.

### Git hooks and CI

- `.husky/pre-commit`: fast checks before each commit
- `.github/workflows/ci.yml`: separate `quality`, `policy` and `tests` jobs, plus one `gate` job to make the required status check
- `.github/workflows/claude-review.yml`: `claude -p` reviewing PRs, off by default because it uses API credits

### API contract

Zod schemas generate `contracts/openapi.yaml`. Read `docs/adr/0001-zod-is-the-contract-source.md` for why.

**Try it:** add a field to `IncidentSchema`, then run `pnpm check`. Follow the failures: TypeScript flags the mapper, and `contract:check` flags the stale file.

## Part 4: Agents and skills

### Skills: `.claude/skills/`

| Skill | Started by | Purpose |
|---|---|---|
| `new-endpoint` | You or Claude | The ten steps for an API change |
| `new-migration` | You or Claude | Safe schema changes |
| `new-feature` | Only you | Idea to reviewed spec |
| `release` | Only you | Version and tag, without pushing |

`disable-model-invocation: true` keeps Claude from starting a skill on its own.

### Subagents: `.claude/agents/`

| Agent | Can edit | Purpose |
|---|---|---|
| `api-builder` | Yes | Implements an approved spec |
| `test-writer` | Tests only, by instruction | Writes tests from the spec |
| `security-reviewer` | No | Traces changes for security flaws |
| `contract-checker` | No | Decides `SAFE` or `BREAKING` |

Read-only reviewers are the strongest pattern here. They have fresh context and cannot "fix" what they find. `test-writer`'s limit is only an instruction, so its edits still need review.

### Practice: build one feature

`docs/features/acknowledge-incident.md` is ready. Run this in Claude Code:

1. `/plan Implement @docs/features/acknowledge-incident.md. Ask if anything is unclear.`
2. Review the plan, then approve it.
3. `Use the test-writer agent to write tests from the spec.`
4. `Use the api-builder agent to make them pass.`
5. `Use the contract-checker agent on this diff.`
6. `Use the security-reviewer agent on this diff.`
7. Run `/code-review`, and read the whole diff yourself.

### Parallel work

Git worktrees give each session its own checkout, so two features can progress without conflict. Use this once the dashboard exists.

### MCP: `.mcp.json`

MCP connects Claude to outside tools. GitHub is configured, and needs a `GITHUB_MCP_TOKEN` environment variable. Use a token limited to this repository, and keep it out of committed files. Add Postgres in Phase 2, with a read-only development role.

## Part 5: Where these patterns come from

| Pattern | What to look at | Problem it solves |
|---|---|---|
| Golden reference slice | `incidents` | Claude copies existing code, so give it one excellent example |
| Path-scoped rules | `.claude/rules/` | Keeps `CLAUDE.md` small |
| Rule states the reason | `.claude/rules/testing.md` | A reason lets Claude handle cases the rule did not list |
| Rule names its enforcement | `.claude/rules/architecture.md` | Shows which rules are guaranteed |
| Shared contract | `src/contract/` | One definition for validation, tests and docs |
| Checks with self-tests | `scripts/enforce-rules.test.ts` | A broken check would otherwise pass silently |
| Shrink-only exceptions | Check 5 | Legacy can only get better |
| Required gate job | `ci.yml` | One stable required status check |
| Forbidden fixes | `.claude/rules/testing.md` | Blocks fake green tests |

## Next step

Start Phase 2 by running `/new-feature real authentication`.

## Keep growing the rules

Add a rule only after a real mistake. If you correct Claude twice, write it down. If it ignores a rule that matters, move it to a hook, check or test. Delete rules that stop being useful.
