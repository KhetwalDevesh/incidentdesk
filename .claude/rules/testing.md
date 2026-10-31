---
paths:
  - "tests/**"
  - "**/*.test.ts"
  - "scripts/**"
---

# Testing rules

## Do

- Test behaviour through the public surface: `app.request` for APIs, ports for services.
- Parse every success and error response with its contract schema in `tests/*.contract.test.ts`.
- Add a failing test first when fixing a bug.
- Add a self-test case for every new `scripts/enforce-rules.ts` check, including one that must pass.
- Use the in-memory repository in unit tests. Mock only external services.

## Don't

Each of these makes a failing test pass without fixing anything:

- Don't delete, skip or loosen an assertion to get green.
- Don't change expected values to match wrong output.
- Don't add retries or sleeps to hide a race. Find it.
- Don't mock the module under test.
