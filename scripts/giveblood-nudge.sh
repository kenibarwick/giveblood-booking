#!/bin/bash
# giveblood-nudge wrapper — the cron scheduler runs .sh via bash; the tool itself is Node.
# Silent watchdog: prints nothing unless there is something to say.
exec node "$(dirname "$0")/giveblood-nudge.mjs" "$@"
