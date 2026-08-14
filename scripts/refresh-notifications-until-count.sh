#!/usr/bin/env bash

set -euo pipefail

agent_id=''
field=''
minimum=''
timeout_seconds=180

usage() {
  echo "Usage: refresh-notifications-until-count.sh --agent <id> --field <approved|commentApproved|commentRejected|rejected|retired> --minimum <count> [--timeout <seconds>]" >&2
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
    --field)
      field="${2:-}"
      shift 2
      ;;
    --minimum)
      minimum="${2:-}"
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

if [[ -z "$agent_id" ]]; then
  usage
  exit 2
fi
case "$field" in
  approved | commentApproved | commentRejected | rejected | retired) ;;
  *)
    usage
    exit 2
    ;;
esac
if [[ ! "$minimum" =~ ^[0-9]+$ ]]; then
  echo "Minimum must be a non-negative integer: $minimum" >&2
  exit 2
fi
if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "Timeout must be a positive integer: $timeout_seconds" >&2
  exit 2
fi
timeout_command='timeout'
if ! command -v "$timeout_command" > /dev/null 2>&1; then
  timeout_command='gtimeout'
fi
if ! command -v "$timeout_command" > /dev/null 2>&1; then
  echo 'A GNU timeout command is required.' >&2
  exit 1
fi

deadline=$((SECONDS + timeout_seconds))
while true; do
  remaining_seconds=$((deadline - SECONDS))
  if ((remaining_seconds < 1)); then
    remaining_seconds=1
  fi
  if output="$("$timeout_command" --kill-after=10 "$remaining_seconds" openclaw agent-system notifications refresh --agent "$agent_id" --json)"; then
    if ! jq -e 'type == "object" and .status == "completed"' <<< "$output" > /dev/null; then
      echo "Notification refresh returned an unexpected result." >&2
      printf '%s\n' "$output" >&2
      exit 1
    fi
    if jq -e --arg field "$field" --argjson minimum "$minimum" \
      '(.[$field] // 0) >= $minimum' <<< "$output" > /dev/null; then
      printf '%s\n' "$output"
      exit 0
    fi
  else
    status="$?"
    echo "Notification refresh failed before $field reached $minimum." >&2
    if [[ -n "${output:-}" ]]; then
      printf '%s\n' "$output" >&2
    fi
    "$GITHUB_WORKSPACE/scripts/gateway-process.sh" diagnostics
    exit "$status"
  fi

  if ((SECONDS >= deadline)); then
    echo "Notification refresh did not report $field >= $minimum within $timeout_seconds seconds." >&2
    printf '%s\n' "$output" >&2
    "$GITHUB_WORKSPACE/scripts/gateway-process.sh" diagnostics
    exit 1
  fi
  sleep 2
done
