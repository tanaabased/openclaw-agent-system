# GitHub Issue Work Retirement Scenario

This GitHub Actions-only scenario proves assignment retirement for an `issue` + `work`
lifecycle. Its setup establishes a planned assignment and verifies that its
worktree checkpoint survives a Gateway restart. Its assertions cover both
incomplete-work retention and completed-work cleanup.

The scenario creates two disposable issues in `tanaabased/big-test-bucket` and
removes its generated SSH key, issues, pull request, and branch during cleanup.

## Setup

```bash
# should prepare the selected notification model and isolated profile
openclaw-notification-setup prepare \
  --model "$NOTIFICATION_MODEL" \
  --scenario retirement \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE"

# should trust the github host key for the prepared ssh identity
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should prepare notification and approved actor workspaces
mkdir "$TMPDIR/agent-system-notifications"
mkdir "$TMPDIR/agent-system-notification-actor"
cp "$GITHUB_WORKSPACE/fixtures/github-notifications/agent.yaml" "$TMPDIR/agent-system-notifications/agent.yaml"
cp "$GITHUB_WORKSPACE/fixtures/github-notifications/actor-agent.yaml" "$TMPDIR/agent-system-notification-actor/agent.yaml"
printf '%s' 'tanaabot' > "$TMPDIR/notification-agent-login"

# should start the default gateway before routing installation
OPENCLAW_NO_RESPAWN=1 openclaw-gateway start

# should install the route and establish the first baseline synchronously
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system credentials set op --from-env
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "updated")'
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-notification-baseline-established")'
openclaw-github-notifications wait-route \
  --route-state present \
  --account-id notification-data

# should register only the generated public key for tanaabot
cd "$TMPDIR/agent-system-notifications"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method POST /user/keys -f "title=agent-system-retirement-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS" -f "key=$(cat "$HOME/.ssh/big-test-bucket-ssh.pub")" --jq .id > "$TMPDIR/notification-ssh.key-id"

# should install the approved github actor through agent system
cd "$TMPDIR/agent-system-notification-actor"
openclaw agent-system credentials set op --from-env
openclaw agent-system install

# should prepare one planned issue for retirement
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/big-test-bucket \
  --title "add retirement fixture $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body "Create retirement-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt at the repository root with the exact contents: retirement fixture ready." \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/approved-issue-number"
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
refresh_result="$(
  openclaw-github-notifications refresh-completed \
    --agent notification-data \
    --repository tanaabased/big-test-bucket \
    --kind issue \
    --number "$issue_number" \
    --timeout 420
)"
jq -se 'length == 1 and (.[0] | .status == "completed" and .code == "github-notification-poll-complete")' <<< "$refresh_result"

# should preserve the durable issue worktree checkpoint across gateway restart
OPENCLAW_NO_RESPAWN=1 openclaw-gateway restart
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$issue_number" \
  --for worktree-ready \
  --timeout 30 \
  --json | jq -e '.status == "completed" and .code == "github-notification-worktree-ready" and .observation.items[0].stage == "prepared" and .observation.items[0].worktree == "ready"'
worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
incomplete_branch="$(jq -re 'select(length == 1) | .[0].branch' <<< "$worktrees")"
printf '%s' "$incomplete_branch" > "$TMPDIR/incomplete-worktree-branch"
```

## Testing

```bash
# should retire an incomplete unassigned issue while retaining its managed worktree
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue edit "$issue_number" --repo tanaabased/big-test-bucket --remove-assignee "$agent_login"
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$issue_number" \
  --for retired \
  --refresh \
  --timeout 180 \
  --json | jq -e '.status == "completed" and .code == "github-notification-retired" and (.observation.items[0] | .disposition == "retired" and .reasonCode == "item-unassigned" and .stage == "retired" and .worktree == "ready" and .cleanup.status == "skipped" and .cleanup.reasonCode == "github-notification-cleanup-implementation-incomplete")'

# should complete a second assignment before provider-verified retirement
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/big-test-bucket \
  --title "add completed retirement fixture $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body "Create completed-retirement-fixture-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt at the repository root with the exact contents: completed retirement fixture ready." \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/completed-issue-number"
cd "$TMPDIR/agent-system-notifications"
completed_issue_number="$(cat "$TMPDIR/completed-issue-number")"
for _ in 1 2; do
  openclaw-github-notifications refresh-completed \
    --agent notification-data \
    --repository tanaabased/big-test-bucket \
    --kind issue \
    --number "$completed_issue_number" \
    --timeout 420 | jq -se 'length == 1 and (.[0] | .status == "completed" and .code == "github-notification-poll-complete")'
done
worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
test "$(jq length <<< "$worktrees")" -eq 2
incomplete_branch="$(cat "$TMPDIR/incomplete-worktree-branch")"
completed_branch="$(jq -re --arg incomplete "$incomplete_branch" '[.[] | select(.branch != $incomplete)] | select(length == 1) | .[0].branch' <<< "$worktrees")"
printf '%s' "$completed_branch" > "$TMPDIR/completed-worktree-branch"

# should merge its completion pull request and retire the closed issue
cd "$TMPDIR/agent-system-notification-actor"
completed_branch="$(cat "$TMPDIR/completed-worktree-branch")"
pull_request="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr list --repo tanaabased/big-test-bucket --head "$completed_branch" --state open --json body,number,state --jq 'select(length == 1) | .[0]')"
pull_request_number="$(jq -re '.number' <<< "$pull_request")"
jq -e --argjson issue "$completed_issue_number" '.state == "OPEN" and (.body | contains("Closes #" + ($issue | tostring)))' <<< "$pull_request"
printf '%s' "$pull_request_number" > "$TMPDIR/completed-pull-request-number"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- pr merge "$pull_request_number" --repo tanaabased/big-test-bucket --squash

# should archive its unpinned session and remove only its clean worktree
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$completed_issue_number" \
  --for retired \
  --refresh \
  --timeout 180 \
  --json | jq -e '.status == "completed" and (.observation.items[0] | .reasonCode == "item-closed" and .stage == "retired" and .cleanup.status == "completed" and .cleanup.session == "archived" and .cleanup.worktree == "removed")'
worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
test "$(jq length <<< "$worktrees")" -eq 1
remaining_branch="$(jq -r '.[0].branch' <<< "$worktrees")"
test "$remaining_branch" = "$(cat "$TMPDIR/incomplete-worktree-branch")"
```

```bash
# should expose bounded evidence for the selected notification model
openclaw-notification-setup evidence \
  --model "$NOTIFICATION_MODEL" \
  --scenario retirement \
  --expected-evidence "$GITHUB_WORKSPACE/scenarios/issue-work-retirement/expected-evidence.json"
```

## Cleanup

```bash
# should remove only the generated tanaabot public key
if test -f "$TMPDIR/notification-ssh.key-id"; then
  cd "$TMPDIR/agent-system-notifications"
  key_id="$(cat "$TMPDIR/notification-ssh.key-id")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method DELETE "/user/keys/$key_id"
  remaining="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --paginate /user/keys --jq ".[] | select(.id == $key_id) | .id")"
  test -z "$remaining"
fi

# should close the remote issue fixture
if test -f "$TMPDIR/approved-issue-number"; then
  cd "$TMPDIR/agent-system-notification-actor"
  issue_number="$(cat "$TMPDIR/approved-issue-number")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$issue_number" --repo tanaabased/big-test-bucket
fi

if test -f "$TMPDIR/completed-issue-number"; then
  cd "$TMPDIR/agent-system-notification-actor"
  completed_issue_number="$(cat "$TMPDIR/completed-issue-number")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$completed_issue_number" --repo tanaabased/big-test-bucket
fi

# should remove only the completed scenario pull request and branch
if test -s "$TMPDIR/completed-worktree-branch"; then
  cd "$TMPDIR/agent-system-notifications"
  completed_branch="$(cat "$TMPDIR/completed-worktree-branch")"
  pull_request_number="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- pr list --repo tanaabased/big-test-bucket --head "$completed_branch" --state open --json number --jq '.[0].number // empty')"
  if test -n "$pull_request_number"; then
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- pr close "$pull_request_number" --repo tanaabased/big-test-bucket
  fi
  if OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --silent --method GET "/repos/tanaabased/big-test-bucket/git/ref/heads/$completed_branch"; then
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method DELETE "/repos/tanaabased/big-test-bucket/git/refs/heads/$completed_branch"
  fi
fi

# should stop the background gateway cleanly
openclaw-gateway stop
```

```bash
# should stop the selected notification model cleanly
openclaw-notification-setup stop --model "$NOTIFICATION_MODEL"
```
