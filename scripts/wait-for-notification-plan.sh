#!/usr/bin/env bash

set -euo pipefail

actor_agent=''
item_number=''
notification_agent=''
repository=''
session_key=''

while test "$#" -gt 0; do
  case "$1" in
    --actor-agent)
      actor_agent="$2"
      shift 2
      ;;
    --item-number)
      item_number="$2"
      shift 2
      ;;
    --notification-agent)
      notification_agent="$2"
      shift 2
      ;;
    --repository)
      repository="$2"
      shift 2
      ;;
    --session-key)
      session_key="$2"
      shift 2
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if test -z "$actor_agent" || test -z "$item_number" || test -z "$notification_agent" || test -z "$repository" || test -z "$session_key"; then
  printf 'all notification plan wait arguments are required\n' >&2
  exit 2
fi

params="$(jq -cn --arg sessionKey "$session_key" '{sessionKey:$sessionKey,limit:20,maxChars:120000}')"
timeout_seconds=300
timeout_command='timeout'
if ! command -v "$timeout_command" > /dev/null 2>&1; then
  timeout_command='gtimeout'
fi
if ! command -v "$timeout_command" > /dev/null 2>&1; then
  printf 'a gnu timeout command is required\n' >&2
  exit 1
fi
deadline=$((SECONDS + timeout_seconds))
history=''
doctor=''

print_history_summary() {
  if test -n "$history"; then
    printf '%s\n' "$history" | jq -c '
      [.messages[]? | select(.role == "assistant")] as $assistant
      | [$assistant[]? | .. | strings] | join("\n") as $text
      | {
          assistantMessages: ($assistant | length),
          hasAssessment: ($text | contains("## Assessment")),
          hasBlockers: ($text | contains("## Blockers")),
          hasPlan: ($text | contains("## Plan"))
        }
    ' >&2 || true
  fi
}

print_doctor_summary() {
  if test -n "$doctor"; then
    printf '%s\n' "$doctor" | jq -c '
      {
        status,
        notificationFindings: [
          .findings[]?
          | select(.component == "github-notifications")
          | {code, status}
        ]
      }
    ' >&2 || true
  fi
}

fail_with_diagnostics() {
  printf '%s\n' "$1" >&2
  print_history_summary
  print_doctor_summary
  "$GITHUB_WORKSPACE/scripts/gateway-process.sh" diagnostics
  exit 1
}

while ((SECONDS < deadline)); do
  remaining_seconds=$((deadline - SECONDS))
  command_timeout="$remaining_seconds"
  if ((command_timeout > 10)); then
    command_timeout=10
  fi
  history="$("$timeout_command" --kill-after=5 "$command_timeout" openclaw gateway call chat.history --params "$params" --json --timeout 5000 2>/dev/null || true)"
  if printf '%s\n' "$history" | jq -e '[.messages[]? | select(.role == "assistant") | .. | strings] | join("\n") | contains("## Assessment") and contains("## Blockers") and contains("## Plan")' >/dev/null 2>&1; then
    comments="$(OPENCLAW_LOG_LEVEL=error "$timeout_command" --kill-after=5 "$command_timeout" openclaw agent-system tool gh --agent "$actor_agent" -- api "repos/$repository/issues/$item_number/comments" --jq '[.[] | select(.body | contains("agent-system-github-publication:initial-acknowledgment"))] | length' 2>/dev/null || true)"
    if test "$comments" = '1'; then
      exit 0
    fi
  fi
  doctor="$(OPENCLAW_LOG_LEVEL=error "$timeout_command" --kill-after=5 "$command_timeout" openclaw agent-system doctor --agent "$notification_agent" --json 2>/dev/null || true)"
  if test -n "$doctor" && printf '%s\n' "$doctor" | jq -e '
    any(
      .findings[]?;
      .component == "github-notifications"
        and (
          .code == "github-notification-planning-response-invalid"
          or .code == "github-notification-planning-response-missing"
          or .code == "github-notification-acknowledgment-not-confirmed"
          or .code == "github-notification-acknowledgment-publication-failed"
        )
    )
  ' >/dev/null 2>&1; then
    fail_with_diagnostics 'notification planning reached a terminal failure'
  fi
  sleep 2
done

doctor="$(OPENCLAW_LOG_LEVEL=error "$timeout_command" --kill-after=5 10 openclaw agent-system doctor --agent "$notification_agent" --json 2>/dev/null || true)"
fail_with_diagnostics "notification planning did not complete within $timeout_seconds seconds"
