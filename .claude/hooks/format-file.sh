#!/bin/bash
# PostToolUse: format every edited file, so style never depends on the model remembering it.
file_path=$(jq -r '.tool_input.file_path // empty')

case "$file_path" in
*.ts | *.json)
	cd "$CLAUDE_PROJECT_DIR" && pnpm exec biome check --write --no-errors-on-unmatched "$file_path" >/dev/null 2>&1
	;;
esac

exit 0
