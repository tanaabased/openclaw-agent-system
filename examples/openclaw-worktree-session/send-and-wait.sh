#!/bin/sh
set -eu

params=$1
run_id=$(printf '%s\n' "$params" | jq -er '.idempotencyKey | strings | select(length > 0)')
send_exit=0
response=$(openclaw-fixture-gateway chat.send --params "$params" --json) || send_exit=$?
if printf '%s\n' "$response" | jq -es --arg id "$run_id" '
  length == 1 and (.[0] | .ok == false and (.runId == null or .runId == $id) and
    .error.type == "gateway_transport_error" and .error.kind == "timeout" and
    .error.requestDispatched != false)' >/dev/null; then
  echo "chat.send acknowledgement timed out. checking the original run $run_id" >&2
else
  printf '%s\n' "$response" | jq -es --arg expected "$run_id" -f "$GITHUB_WORKSPACE/scripts/assert-chat-send.jq"
  [ "$send_exit" -eq 0 ] || exit "$send_exit"
fi

exec node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id"
