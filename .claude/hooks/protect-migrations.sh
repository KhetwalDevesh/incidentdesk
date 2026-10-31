#!/bin/bash
# PreToolUse: applied migrations are immutable. New migration files are allowed.
file_path=$(jq -r '.tool_input.file_path // empty')

if [[ "$file_path" == */db/migrations/*.sql && -f "$file_path" ]]; then
	echo "Blocked: $file_path is an existing migration. Add a new one with /new-migration." >&2
	exit 2
fi

exit 0
