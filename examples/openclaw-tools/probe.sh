#!/bin/sh
set -eu

case "$1" in
  setup | automation) phase="$1" ;;
  *) exit 2 ;;
esac

test -n "$AGENT_SYSTEM_EXEC_AUTHORITY"
test -z "${GH_TOKEN_TANAABOT:-}"
test -z "${GH_TOKEN:-}"
git var GIT_AUTHOR_IDENT > "$phase.git"
gh api user --jq .login > "$phase.github"
printf 'completed\n' >> "$phase.runs"
touch "$phase.complete"
