#!/bin/sh
set -eu

root=$(cd "$(dirname "$0")/../../.." && pwd -P)
runtime="$1"
case "$runtime" in
  codex)
    expected='Runtime Codex <runtime-codex@example.invalid>'
    peer=openclaw
    test -n "$CODEX_HOME"
    test -n "$CODEX_THREAD_ID"
    ;;
  openclaw)
    expected='Runtime OpenClaw <runtime-openclaw@example.invalid>'
    peer=codex
    test -n "$AGENT_SYSTEM_EXEC_AUTHORITY"
    test -n "$AGENT_SYSTEM_EXEC_CAPABILITY"
    ;;
  *) exit 1 ;;
esac

git var GIT_AUTHOR_IDENT > "$root/$runtime/identity.txt"
grep -F "$expected" "$root/$runtime/identity.txt"

if (cd "$root/$peer" && git var GIT_AUTHOR_IDENT) > "$root/$runtime/cross-agent.stdout" 2> "$root/$runtime/cross-agent.stderr"; then
  printf '%s\n' 'a runtime descendant switched agent identity' >&2
  exit 1
fi
test ! -s "$root/$runtime/cross-agent.stdout"
grep -F 'code=agent_not_resolved' "$root/$runtime/cross-agent.stderr"

if env CI=1 NONINTERACTIVE=on openclaw as install --non-interactive --json > "$root/$runtime/operator.stdout" 2> "$root/$runtime/operator.stderr"; then
  printf '%s\n' 'a runtime descendant executed an operator install' >&2
  exit 1
fi
test ! -s "$root/$runtime/operator.stdout"
grep -F 'code=operator-command-denied' "$root/$runtime/operator.stderr"
test ! -e "$TMPDIR/agent-system-approval-check"
test ! -e "$TMPDIR/agent-system-approval-apply"
printf '%s\n' verified > "$root/$runtime/receipt.txt"
printf '%s\n' runtime-boundary-verified
