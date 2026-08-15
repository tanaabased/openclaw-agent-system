#!/usr/bin/env bash

set -euo pipefail

creator_agent=''
repository=''
title=''
body=''
assignee=''
issue_number_path=''

usage() {
  echo "Usage: create-and-assign-github-issue.sh --creator-agent <id> --repository <owner/repo> --title <title> --body <body> --assignee <login> --issue-number-path <path>" >&2
}

while (($# > 0)); do
  if (($# < 2)); then
    usage
    exit 2
  fi
  case "$1" in
    --creator-agent)
      creator_agent="${2:-}"
      shift 2
      ;;
    --repository)
      repository="${2:-}"
      shift 2
      ;;
    --title)
      title="${2:-}"
      shift 2
      ;;
    --body)
      body="${2:-}"
      shift 2
      ;;
    --assignee)
      assignee="${2:-}"
      shift 2
      ;;
    --issue-number-path)
      issue_number_path="${2:-}"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$creator_agent" || -z "$repository" || -z "$title" || -z "$body" || -z "$assignee" || -z "$issue_number_path" ]]; then
  usage
  exit 2
fi

issue_url="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent "$creator_agent" -- issue create --repo "$repository" --title "$title" --body "$body")"
issue_number="$(printf '%s\n' "$issue_url" | tail -n 1 | sed 's#.*/##')"
if [[ ! "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "GitHub issue creation returned an invalid issue URL: $issue_url" >&2
  exit 1
fi
printf '%s\n' "$issue_number" > "$issue_number_path"

OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent "$creator_agent" -- issue edit "$issue_number" --repo "$repository" --add-assignee "$assignee"
