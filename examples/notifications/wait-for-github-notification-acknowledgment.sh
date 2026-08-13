#!/usr/bin/env bash

set -euo pipefail

reader_agent=''
repository=''
issue_number=''
author=''
timeout_seconds=240

usage() {
  echo "Usage: wait-for-github-notification-acknowledgment.sh --reader-agent <id> --repository <owner/repo> --issue <number> --author <login> [--timeout <seconds>]" >&2
}

while (($# > 0)); do
  if (($# < 2)); then
    usage
    exit 2
  fi
  case "$1" in
    --reader-agent)
      reader_agent="${2:-}"
      shift 2
      ;;
    --repository)
      repository="${2:-}"
      shift 2
      ;;
    --issue)
      issue_number="${2:-}"
      shift 2
      ;;
    --author)
      author="${2:-}"
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

if [[ -z "$reader_agent" || -z "$repository" || -z "$author" || ! "$issue_number" =~ ^[1-9][0-9]*$ || ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  usage
  exit 2
fi

deadline=$((SECONDS + timeout_seconds))
while true; do
  comments="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent "$reader_agent" -- api "repos/$repository/issues/$issue_number/comments" --jq '[.[] | {author:.user.login,body}]')"
  if jq -e --arg author "$author" '
    length == 1 and
    .[0].author == $author and
    (.[0].body | test("\n\n<!-- agent-system-github-assignment-ack:[a-f0-9]{32} -->$")) and
    ((.[0].body | split("\n\n<!--")[0]) as $text |
      ($text | length) > 0 and
      ($text | length) <= 200 and
      ($text | test("[\\r\\n]")) == false and
      ($text | test("https?://|www\\.|@[A-Za-z0-9]|[`<>\\[\\]{}|]"; "i")) == false)
  ' <<< "$comments" > /dev/null; then
    printf '%s\n' "$comments"
    exit 0
  fi
  if ((SECONDS >= deadline)); then
    echo "GitHub acknowledgment did not reach its safe exactly-once shape within $timeout_seconds seconds." >&2
    printf '%s\n' "$comments" >&2
    "$GITHUB_WORKSPACE/scripts/gateway-process.sh" diagnostics
    exit 1
  fi
  sleep 2
done
