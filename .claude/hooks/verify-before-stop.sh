#!/bin/bash
# Stop: Claude cannot finish while the project is broken. Skipped when nothing changed.
cd "$CLAUDE_PROJECT_DIR" || exit 0

if [[ -z $(git status --porcelain -- src tests scripts) ]]; then
	exit 0
fi

if ! output=$(pnpm check 2>&1); then
	echo "pnpm check failed. Fix the cause before finishing:" >&2
	echo "$output" | tail -40 >&2
	exit 2
fi

exit 0
