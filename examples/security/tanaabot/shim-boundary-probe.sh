#!/bin/sh

set -eu

active_identity=$(git var GIT_AUTHOR_IDENT)
printf '%s\n' "$active_identity" >"$TMPDIR/agent-system-active-agent-result.txt"

sh ../setup-boundary-probe.sh codex

cd ../emori
cross_identity=$(git var GIT_AUTHOR_IDENT)
printf '%s\n' "$cross_identity" >"$TMPDIR/agent-system-cross-agent-result.txt"
