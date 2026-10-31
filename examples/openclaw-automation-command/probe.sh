#!/bin/sh
set -eu
test -n "$AGENT_SYSTEM_EXEC_AUTHORITY"
git var GIT_AUTHOR_IDENT > identity.git
openclaw agent-system install --json
openclaw agent-system doctor --json
printf 'completed\n' >> identity.runs
