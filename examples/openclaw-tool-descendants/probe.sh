#!/bin/sh
set -eu

case "$1" in
  setup)
    phase=setup
    git_command=git
    github_command=gh
    ;;
  automation)
    phase=automation
    git_command=agent-system-git
    github_command=agent-system-gh
    ;;
  *) exit 2 ;;
esac

test -n "$AGENT_SYSTEM_EXEC_AUTHORITY"
test -z "${GH_TOKEN_TANAABOT:-}"
test -z "${GH_TOKEN:-}"
"$git_command" var GIT_AUTHOR_IDENT > "$phase.git"
"$github_command" api user --jq .login > "$phase.github"
printf 'completed\n' >> "$phase.runs"
touch "$phase.complete"
