#!/bin/sh

set -eu

export OPENCLAW_LOG_LEVEL=error

active_identity=$(git var GIT_AUTHOR_IDENT)
printf '%s\n' "$active_identity" >"$TMPDIR/agent-system-active-agent-result.txt"

sh ../setup-boundary-probe.sh codex

cd ../emori
if cross_identity=$(git var GIT_AUTHOR_IDENT 2>"$TMPDIR/agent-system-cross-agent-error.txt"); then
  printf '%s\n' "$cross_identity" >"$TMPDIR/agent-system-cross-agent-result.txt"
  printf '%s\n' 'the helper switched to another agent identity' >&2
  exit 1
fi
grep -F 'code=agent_not_resolved' "$TMPDIR/agent-system-cross-agent-error.txt"
printf '%s\n' verified >"$TMPDIR/agent-system-cross-agent-denied.txt"
