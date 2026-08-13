#!/usr/bin/env bash

set -euo pipefail

agent_id=''
timeout_seconds=90

usage() {
  echo "Usage: assert-agent-system-notification-refresh-completed.sh --agent <id> [--timeout <seconds>]" >&2
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
    --timeout)
      timeout_seconds="${2:-}"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$agent_id" ]] || [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  usage
  exit 2
fi

deadline=$((SECONDS + timeout_seconds))

while true; do
  if output="$(openclaw agent-system notifications refresh --agent "$agent_id" --json)"; then
    status=0
  else
    status="$?"
  fi

  if ((status == 0)) && jq -e \
    'type == "object" and .status == "completed" and .code == "github-notification-poll-complete"' \
    <<< "$output" > /dev/null 2>&1; then
    printf '%s\n' "$output"
    exit 0
  fi

  if jq -e \
    'type == "object" and .status == "skipped" and .code == "github-notification-backoff-active"' \
    <<< "$output" > /dev/null 2>&1; then
    if ((SECONDS >= deadline)); then
      echo "Notification refresh backoff remained active for $timeout_seconds seconds for agent $agent_id." >&2
      printf '%s\n' "$output" >&2
      "$GITHUB_WORKSPACE/scripts/gateway-process.sh" diagnostics
      exit 1
    fi
    sleep 2
    continue
  fi

  if ((status != 0)); then
    echo "Notification refresh command failed for agent $agent_id." >&2
    if [[ -n "$output" ]]; then
      printf '%s\n' "$output" >&2
    fi
    "$GITHUB_WORKSPACE/scripts/gateway-process.sh" diagnostics
    exit "$status"
  fi

  echo "Notification refresh did not complete a GitHub poll for agent $agent_id." >&2
  printf '%s\n' "$output" >&2
  "$GITHUB_WORKSPACE/scripts/gateway-process.sh" diagnostics
  exit 1
done
