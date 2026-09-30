#!/bin/sh
set -eu
mode="$1"
printf '%s\n' "$PPID" > "$mode.runner"
printf '%s\n' "$AGENT_SYSTEM_EXEC_AUTHORITY" > "$mode.authority"
test -z "${GH_TOKEN:-}"
test -z "${AUTOMATION_GITHUB_TOKEN:-}"
printf 'started\n' > "$mode.stage"
case "$mode" in
  identity)
    printf 'git\n' > "$mode.stage"
    git var GIT_AUTHOR_IDENT > identity.git
    printf 'github\n' > "$mode.stage"
    gh api user --jq .login > identity.github
    ;;
  containment)
    printf 'agent-selection\n' > "$mode.stage"
    if openclaw agent-system tool gh --agent automation-other -- api user > cross-agent.stdout 2> cross-agent.stderr; then exit 1; fi
    grep -F invalid_arguments cross-agent.stderr
    printf 'workspace\n' > "$mode.stage"
    if (cd "$TMPDIR/automation-other" && gh api user) > cross-workspace.stdout 2> cross-workspace.stderr; then exit 1; fi
    grep -F agent_not_resolved cross-workspace.stderr
    ;;
  policy)
    if gh release create never-publish --repo tanaabased/big-test-bucket > policy.stdout 2> policy.stderr; then exit 1; fi
    grep -F approval_denied policy.stderr
    ;;
  missing)
    if gh api user > missing.stdout 2> missing.stderr; then exit 1; fi
    grep -F credential_unavailable missing.stderr
    ;;
  timeout|cancel)
    git ls-remote ssh://automation-fixture.invalid/repository
    ;;
  *) exit 1 ;;
esac
printf 'done\n' > "$mode.stage"
printf 'done\n' > "$mode.done"
