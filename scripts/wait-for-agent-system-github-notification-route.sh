#!/usr/bin/env bash

set -euo pipefail

expected_state="${1:-}"
account_id="${2:-}"
timeout_seconds="${3:-90}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: wait-for-agent-system-github-notification-route.sh <present|absent> <account-id> [timeout-seconds]" >&2
}

if [[ "$expected_state" != "present" && "$expected_state" != "absent" ]]; then
  usage
  exit 2
fi
if [[ -z "$account_id" ]]; then
  usage
  exit 2
fi
if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "Timeout must be a positive integer: $timeout_seconds" >&2
  exit 2
fi

deadline=$((SECONDS + timeout_seconds))
status_output=''
while true; do
  if status_output="$(openclaw channels status --channel agent-system-github --json 2>&1)"; then
    if [[ "$expected_state" == "present" ]]; then
      if jq -e --arg accountId "$account_id" \
        '(.channelAccounts["agent-system-github"] // []) | any(.accountId == $accountId and .configured == true and .enabled == true)' \
        <<< "$status_output" > /dev/null; then
        exit 0
      fi
    elif jq -e --arg accountId "$account_id" \
      '(.channelAccounts["agent-system-github"] // []) | all(.accountId != $accountId)' \
      <<< "$status_output" > /dev/null; then
      exit 0
    fi
  fi

  if ((SECONDS >= deadline)); then
    echo "GitHub notification route $account_id did not become $expected_state within $timeout_seconds seconds." >&2
    if [[ -n "$status_output" ]]; then
      printf '%s\n' "$status_output" >&2
    fi
    "$script_dir/gateway-process.sh" diagnostics
    exit 1
  fi
  sleep 1
done
