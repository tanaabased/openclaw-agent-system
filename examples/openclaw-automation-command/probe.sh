#!/bin/sh
set -eu
printf '%s\n' 'identity probe: checking descendant authority' >&2
test -n "$AGENT_SYSTEM_EXEC_AUTHORITY"
printf '%s\n' 'identity probe: reading managed git identity' >&2
git var GIT_AUTHOR_IDENT > identity.git
printf '%s\n' 'identity probe: running install' >&2
openclaw agent-system install --json
printf '%s\n' 'identity probe: running doctor' >&2
openclaw agent-system doctor --json
printf 'completed\n' >> identity.runs
