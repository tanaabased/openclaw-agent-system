#!/bin/sh
phase=$1
printf 'worktree %s: %s failed (exit %s)\n' "$phase" "$2" "$3"
if test -s "$TMPDIR/worktree-$phase.failed-step"; then
  printf 'probe failed at: '
  cat "$TMPDIR/worktree-$phase.failed-step"
elif test -s "$TMPDIR/worktree-$phase.receipt"; then
  echo 'probe wrote its verification receipt'
elif grep -Fxq "$phase" "$TMPDIR/worktree-probe-invocations" 2>/dev/null; then
  echo 'probe started without a receipt or recorded failure'
else
  echo 'no probe invocation recorded'
fi
curl -fsS --max-time 3 http://127.0.0.1:4010/proof/evidence |
  jq '{strictMissCount, finalResponseCount, execResponses: [.tools[]? | select(.name == "exec") | .callResponseCount]}'
# The mock returns HTTP 500 with structured diagnostics for an unmatched request.
curl -sS --max-time 3 http://127.0.0.1:4010/proof/diagnostics |
  jq --arg call "call_worktree_$phase" '{requests: [.requests[]? |
    {status, matched, systemPrompt: .checks.systemPrompt, expectedCall: $call,
     resultMarker: .checks.resultMarkers[$call]}]}'
