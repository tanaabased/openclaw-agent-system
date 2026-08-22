# GitHub Issue Notification Intake Example

This macOS-only scenario runs the prepared Agent System package in the default
Gateway and proves the issue-assignment intake lifecycle plus one short comment
exchange. It establishes the polling baseline, rejects a self-authored assignment,
prepares an approved issue worktree, preserves the checkpoint across restart,
delivers one approved comment through the registered issue/Work/comment turn
contract, publishes one reply, and
retires the assignment without deleting the worktree.

Scenario setup creates and updates uniquely named issues in
`tanaabased/agent-system-test`.

## Setup

```bash
# should configure the default profile with the ci model
OPENCLAW_SETUP_WORKSPACE="$TMPDIR/main" \
OPENCLAW_SETUP_AGENT_SYSTEM_PLUGIN="$AGENT_SYSTEM_PACKAGE" \
OPENCLAW_SETUP_MODEL="openai/$OPENAI_MODEL" \
  openclaw-setup

# should prepare notification and approved-actor workspaces
mkdir "$TMPDIR/agent-system-notifications"
mkdir "$TMPDIR/agent-system-notification-actor"
cp "$GITHUB_WORKSPACE/examples/issue/agent.yaml" "$TMPDIR/agent-system-notifications/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/issue/actor-agent.yaml" "$TMPDIR/agent-system-notification-actor/agent.yaml"
printf '%s' 'tanaabot' > "$TMPDIR/notification-agent-login"

# should start the default gateway before routing installation
OPENCLAW_NO_RESPAWN=1 openclaw-gateway start

# should install the route and establish the first baseline synchronously
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system credentials set op --from-env
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "updated")'
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-notification-baseline-established")'
openclaw agent-system doctor --json | jq -e '.findings[] | select(.component == "git" and .code == "git-worktrees-root-ready")'
openclaw-github-notifications wait-route \
  --route-state present \
  --account-id notification-data

# should install the approved github actor through agent system
cd "$TMPDIR/agent-system-notification-actor"
openclaw agent-system credentials set op --from-env
openclaw agent-system install

```

## Testing

```bash
# should expose one ready empty notification baseline before assignment intake
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system notifications wait \
  --agent notification-data \
  --for baseline-ready \
  --timeout 30 \
  --json | jq -e '.status == "completed" and .code == "github-notification-baseline-ready" and .observation.status == "ready" and .observation.baseline.status == "ready" and (.observation.items | length) == 0'

# should create a self-authored assignment fixture
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-data \
  --repository tanaabased/agent-system-test \
  --title "agent system rejected notification $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body 'This self-authored assignment must not start local work.' \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/rejected-issue-number"

# should reject a self-authored issue before lifecycle resource preparation
cd "$TMPDIR/agent-system-notifications"
rejected_issue="$(cat "$TMPDIR/rejected-issue-number")"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/agent-system-test \
  --kind issue \
  --number "$rejected_issue" \
  --for assignment-rejected \
  --refresh \
  --timeout 180 \
  --json | jq -e --argjson number "$rejected_issue" '.status == "completed" and .code == "github-notification-assignment-rejected" and (.observation.items[0] | .itemType == "issue" and .number == $number and .disposition == "rejected" and .reasonCode == "assignment-actor-self" and .worktree == "pending" and (has("stage") | not))'

# should create an approved issue assignment fixture
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/agent-system-test \
  --title "agent system approved notification $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body 'Untrusted fixture content must not affect assignment classification.' \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/approved-issue-number"

# should classify the approved issue and prepare its lifecycle-owned worktree
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/agent-system-test \
  --kind issue \
  --number "$issue_number" \
  --for worktree-ready \
  --refresh \
  --timeout 180 \
  --json | jq -e --argjson number "$issue_number" '.status == "completed" and .code == "github-notification-worktree-ready" and (.observation.items[0] | .repository == "tanaabased/agent-system-test" and .itemType == "issue" and .lifecycleId == "issue" and .number == $number and .disposition == "approved" and .reasonCode == "assignment-approved" and .stage == "prepared" and .worktree == "ready")'

# should preserve the durable issue worktree checkpoint across gateway restart
OPENCLAW_NO_RESPAWN=1 openclaw-gateway restart
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/agent-system-test \
  --kind issue \
  --number "$issue_number" \
  --for worktree-ready \
  --timeout 30 \
  --json | jq -e '.status == "completed" and .code == "github-notification-worktree-ready" and .observation.items[0].stage == "prepared" and .observation.items[0].worktree == "ready"'

# should answer one approved issue comment through the registered turn contract
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
reply_token="ready-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue comment "$issue_number" --repo tanaabased/agent-system-test --body "@tanaabot Reply briefly with $reply_token. Do not inspect files or perform repository work."
cd "$TMPDIR/agent-system-notifications"
refresh_result="$(
  openclaw-github-notifications refresh-completed \
    --agent notification-data \
    --repository tanaabased/agent-system-test \
    --kind issue \
    --number "$issue_number" \
    --timeout 180
)"
jq -se 'length == 1 and (.[0] | .status == "completed" and .code == "github-notification-poll-complete")' <<< "$refresh_result"
cd "$TMPDIR/agent-system-notification-actor"
reply_id="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/agent-system-test/issues/$issue_number/comments" --jq ".[] | select(.user.login == \"tanaabot\" and (.body | contains(\"$reply_token\")) and (.body | contains(\"agent-system-github-publication:github-reply\"))) | .id")"
[[ "$reply_id" =~ ^[1-9][0-9]*$ ]]

# should retire an unassigned issue while retaining its managed worktree
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue edit "$issue_number" --repo tanaabased/agent-system-test --remove-assignee "$agent_login"
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/agent-system-test \
  --kind issue \
  --number "$issue_number" \
  --for retired \
  --refresh \
  --timeout 180 \
  --json | jq -e '.status == "completed" and .code == "github-notification-retired" and (.observation.items[0] | .disposition == "retired" and .reasonCode == "item-unassigned" and .stage == "retired" and .worktree == "ready")'
```

## Cleanup

```bash
# should close the remote issue fixtures without deleting local proof
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
if test -f "$TMPDIR/rejected-issue-number"; then
  rejected_issue="$(cat "$TMPDIR/rejected-issue-number")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue edit "$rejected_issue" --repo tanaabased/agent-system-test --remove-assignee "$agent_login"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$rejected_issue" --repo tanaabased/agent-system-test
fi
if test -f "$TMPDIR/approved-issue-number"; then
  approved_issue="$(cat "$TMPDIR/approved-issue-number")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$approved_issue" --repo tanaabased/agent-system-test
fi

# should stop the background gateway cleanly
openclaw-gateway stop
```
