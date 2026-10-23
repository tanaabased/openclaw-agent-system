#!/bin/sh
set -eu
test -n "$AGENT_SYSTEM_EXEC_AUTHORITY"
git var GIT_AUTHOR_IDENT > identity.git
printf 'completed\n' >> identity.runs
