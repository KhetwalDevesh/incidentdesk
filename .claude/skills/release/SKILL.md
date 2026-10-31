---
name: release
description: Prepare a tagged release. Updates the version and changelog, then stops before pushing.
disable-model-invocation: true
---

1. Confirm the branch is `main` with a clean tree. If not, stop and ask.
2. Run `pnpm check`. If it fails, stop.
3. Summarize changes since the last tag in `CHANGELOG.md`, using user-facing language.
4. Bump the version in `package.json`, and commit.
5. Create a `v<version>` tag.
6. Show the commit and tag. Do not push. I push it myself.
