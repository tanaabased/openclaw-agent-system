#!/bin/sh
set -eu
mode="$1"
printf '%s\n' "$PPID" > "$mode.runner"
printf '%s\n' "$AGENT_SYSTEM_EXEC_AUTHORITY" > "$mode.authority"
test -z "${GH_TOKEN:-}"
test -z "${AUTOMATION_GITHUB_TOKEN:-}"
case "$mode" in
  identity)
    git var GIT_AUTHOR_IDENT > identity.git
    gh api user --jq .login > identity.github
    if gh --agent other api user > cross-agent.stdout 2> cross-agent.stderr; then exit 1; fi
    mkdir -p other
    printf 'schema-version: 1\nagent:\n  id: other\n' > other/agent.yaml
    if (cd other && gh api user) > cross-workspace.stdout 2> cross-workspace.stderr; then exit 1; fi
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
printf 'done\n' > "$mode.done"
