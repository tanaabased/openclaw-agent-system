#!/usr/bin/env bash

set -euo pipefail

agent_id=''

usage() {
  echo "Usage: assert-agent-system-notification-refresh-completed.sh --agent <id>" >&2
}

while (($# > 0)); do
  if (($# < 2)); then
    usage
    exit 2
  fi
  case "$1" in
    --agent)
      agent_id="${2:-}"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$agent_id" ]]; then
  usage
  exit 2
fi

if output="$(openclaw agent-system notifications refresh --agent "$agent_id" --json)"; then
  status=0
else
  status="$?"
fi

if ((status != 0)); then
  echo "Notification refresh command failed for agent $agent_id." >&2
  if [[ -n "$output" ]]; then
    printf '%s\n' "$output" >&2
  fi
  "$GITHUB_WORKSPACE/scripts/gateway-process.sh" diagnostics
  exit "$status"
fi

if ! jq -e \
  'type == "object" and .status == "completed" and .code == "github-notification-poll-complete"' \
  <<< "$output" > /dev/null; then
  echo "Notification refresh did not complete a GitHub poll for agent $agent_id." >&2
  printf '%s\n' "$output" >&2
  "$GITHUB_WORKSPACE/scripts/gateway-process.sh" diagnostics
  exit 1
fi

printf '%s\n' "$output"
