#!/usr/bin/env bash

set -euo pipefail

creator_agent=''
repository=''
title=''
body=''
assignee=''
branch=''
branch_path=''
pull_request_number_path=''

usage() {
  echo "Usage: create-and-assign-github-pull-request.sh --creator-agent <id> --repository <owner/repo> --title <title> --body <body> --assignee <login> --branch <name> --branch-path <path> --pull-request-number-path <path>" >&2
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
    --branch)
      branch="${2:-}"
      shift 2
      ;;
    --branch-path)
      branch_path="${2:-}"
      shift 2
      ;;
    --pull-request-number-path)
      pull_request_number_path="${2:-}"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$creator_agent" || -z "$repository" || -z "$title" || -z "$body" || -z "$assignee" || -z "$branch" || -z "$branch_path" || -z "$pull_request_number_path" ]]; then
  usage
  exit 2
fi
if [[ ! "$branch" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "Pull-request branch is invalid: $branch" >&2
  exit 2
fi

printf '%s\n' "$branch" > "$branch_path"
default_branch="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent "$creator_agent" -- repo view "$repository" --json defaultBranchRef --jq .defaultBranchRef.name)"
base_sha="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent "$creator_agent" -- api "repos/$repository/git/ref/heads/$default_branch" --jq .object.sha)"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent "$creator_agent" -- api --method POST "repos/$repository/git/refs" -f "ref=refs/heads/$branch" -f "sha=$base_sha" --jq .ref > /dev/null

fixture_path=".agent-system-notification-fixtures/$branch.txt"
fixture_content="$(printf 'direct pull-request notification fixture for %s\n' "$branch" | base64 | tr -d '\n')"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent "$creator_agent" -- api --method PUT "repos/$repository/contents/$fixture_path" -f "message=$title" -f "content=$fixture_content" -f "branch=$branch" --jq .commit.sha > /dev/null

pull_request_url="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent "$creator_agent" -- pr create --repo "$repository" --base "$default_branch" --head "$branch" --title "$title" --body "$body")"
pull_request_number="$(printf '%s\n' "$pull_request_url" | tail -n 1 | sed 's#.*/##')"
if [[ ! "$pull_request_number" =~ ^[0-9]+$ ]]; then
  echo "GitHub pull-request creation returned an invalid URL: $pull_request_url" >&2
  exit 1
fi
printf '%s\n' "$pull_request_number" > "$pull_request_number_path"

OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent "$creator_agent" -- pr edit "$pull_request_number" --repo "$repository" --add-assignee "$assignee"
