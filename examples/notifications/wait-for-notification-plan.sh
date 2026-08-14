#!/usr/bin/env bash

set -euo pipefail

actor_agent=''
issue_number=''
notification_agent=''
repository=''
session_key=''

while test "$#" -gt 0; do
  case "$1" in
    --actor-agent)
      actor_agent="$2"
      shift 2
      ;;
    --issue-number)
      issue_number="$2"
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

if test -z "$actor_agent" || test -z "$issue_number" || test -z "$notification_agent" || test -z "$repository" || test -z "$session_key"; then
  printf 'all notification plan wait arguments are required\n' >&2
  exit 2
fi

params="$(jq -cn --arg sessionKey "$session_key" '{sessionKey:$sessionKey,limit:20,maxChars:120000}')"
timeout_seconds=300
deadline=$((SECONDS + timeout_seconds))
history=''
while ((SECONDS < deadline)); do
  remaining_seconds=$((deadline - SECONDS))
  command_timeout="$remaining_seconds"
  if ((command_timeout > 10)); then
    command_timeout=10
  fi
  history="$(timeout --kill-after=5 "$command_timeout" openclaw gateway call chat.history --params "$params" --json --timeout 5000 2>/dev/null || true)"
  if printf '%s\n' "$history" | jq -e '[.messages[]? | select(.role == "assistant") | .. | strings] | join("\n") | contains("ASSESSMENT:") and contains("BLOCKERS:") and contains("PLAN:")' >/dev/null 2>&1; then
    comments="$(OPENCLAW_LOG_LEVEL=error timeout --kill-after=5 "$command_timeout" openclaw agent-system tool gh --agent "$actor_agent" -- api "repos/$repository/issues/$issue_number/comments" --jq '[.[] | select(.body | contains("agent-system-github-publication:initial-acknowledgment"))] | length' 2>/dev/null || true)"
    if test "$comments" = '1'; then
      exit 0
    fi
  fi
  sleep 2
done

printf 'notification planning did not complete within %s seconds\n' "$timeout_seconds" >&2
if test -n "$history"; then
  printf '%s\n' "$history" | jq -c '
    [.messages[]? | select(.role == "assistant")] as $assistant
    | [$assistant[]? | .. | strings] | join("\n") as $text
    | {
        assistantMessages: ($assistant | length),
        hasAssessment: ($text | contains("ASSESSMENT:")),
        hasBlockers: ($text | contains("BLOCKERS:")),
        hasPlan: ($text | contains("PLAN:"))
      }
  ' >&2 || true
fi
doctor="$(OPENCLAW_LOG_LEVEL=error timeout --kill-after=5 10 openclaw agent-system doctor --agent "$notification_agent" --json 2>/dev/null || true)"
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
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" diagnostics
exit 1
