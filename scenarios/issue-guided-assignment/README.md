# GitHub Issue Guided Assignment Scenario

This GitHub Actions-only scenario proves the `issue` + `guided` + `assignment`
turn. It checks assignment admission, lifecycle worktree and session preparation,
one deterministic waiting acknowledgment, one private waiting response, and the
absence of an assignment response or automatic implementation. It runs against
the deterministic mock provider on pull requests and the live provider through
workflow dispatch.

The scenario creates one uniquely named disposable issue in
`tanaabased/big-test-bucket` and removes its generated SSH key during cleanup.

## Setup

```bash
# should prepare the selected notification model and isolated profile
openclaw-notification-setup prepare \
  --model "$NOTIFICATION_MODEL" \
  --scenario guided-assignment \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE"
```

```bash
# should trust the github host key for the prepared ssh identity
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should prepare guided notification and approved actor workspaces
mkdir "$TMPDIR/agent-system-notifications"
mkdir "$TMPDIR/agent-system-notification-actor"
cp "$GITHUB_WORKSPACE/fixtures/github-notifications/agent.yaml" "$TMPDIR/agent-system-notifications/agent.yaml"
perl -0pi -e 's/notifications:\n/notifications:\n    initial-mode: guided\n/' "$TMPDIR/agent-system-notifications/agent.yaml"
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
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method POST /user/keys -f "title=agent-system-guided-assignment-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS" -f "key=$(cat "$HOME/.ssh/big-test-bucket-ssh.pub")" --jq .id > "$TMPDIR/notification-ssh.key-id"

# should install the approved github actor through agent system
cd "$TMPDIR/agent-system-notification-actor"
openclaw agent-system credentials set op --from-env
openclaw agent-system install
```

## Testing

```bash
# should prepare one guided issue assignment without automatic work
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/big-test-bucket \
  --title "guided assignment fixture $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body "Do not create guided-assignment-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt until an operator gives explicit direction." \
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
```

```bash
# should expose the prepared lifecycle owned issue worktree
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
openclaw agent-system notifications wait \
  --agent notification-data \
  --repository tanaabased/big-test-bucket \
  --kind issue \
  --number "$issue_number" \
  --for worktree-ready \
  --timeout 30 \
  --json | jq -e --argjson number "$issue_number" '.status == "completed" and (.observation.items[0] | .lifecycleId == "issue" and .number == $number and .disposition == "approved" and .stage == "prepared" and .worktree == "ready")'
```

```bash
# should remain waiting after another notification reconciliation
cd "$TMPDIR/agent-system-notifications"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
refresh_result="$(
  openclaw-github-notifications refresh-completed \
    --agent notification-data \
    --repository tanaabased/big-test-bucket \
    --kind issue \
    --number "$issue_number" \
    --timeout 180
)"
jq -se 'length == 1 and (.[0] | .status == "completed" and .code == "github-notification-poll-complete")' <<< "$refresh_result"
```

```bash
# should publish one waiting acknowledgment and no assignment response
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
comments="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '.[] | select(.user.login == "tanaabot") | {body, id}')"
acknowledgment_count="$(jq -sc '[.[] | select(.body | contains("agent-system-github-publication:initial-acknowledgment"))] | length' <<< "$comments")"
response_count="$(jq -sc '[.[] | select(.body | contains("agent-system-github-publication:assignment-response"))] | length' <<< "$comments")"
test "$acknowledgment_count" -eq 1
test "$response_count" -eq 0
jq -rsc '.[] | select(.body | contains("agent-system-github-publication:initial-acknowledgment")) | .body' <<< "$comments" | grep -Eiq 'wait|ready|standing by'
```

```bash
# should expose bounded evidence for the selected notification model
openclaw-notification-setup evidence \
  --model "$NOTIFICATION_MODEL" \
  --scenario guided-assignment \
  --expected-evidence "$GITHUB_WORKSPACE/scenarios/issue-guided-assignment/expected-evidence.json"
```

```bash
# should leave the guided assignment worktree unchanged
cd "$TMPDIR/agent-system-notifications"
worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
worktree_path="$(jq -re 'select(length == 1) | .[0].path' <<< "$worktrees")"
fixture_path="$worktree_path/guided-assignment-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.txt"
test ! -e "$fixture_path"
cd "$worktree_path"
status="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- status --porcelain)"
test -z "$status"
```

## Cleanup

```bash
# should remove only the generated tanaabot public key
if test -s "$TMPDIR/notification-ssh.key-id"; then
  cd "$TMPDIR/agent-system-notifications"
  key_id="$(cat "$TMPDIR/notification-ssh.key-id")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method DELETE "/user/keys/$key_id"
fi

# should close the remote issue fixture
if test -s "$TMPDIR/approved-issue-number"; then
  cd "$TMPDIR/agent-system-notification-actor"
  agent_login="$(cat "$TMPDIR/notification-agent-login")"
  approved_issue="$(cat "$TMPDIR/approved-issue-number")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue edit "$approved_issue" --repo tanaabased/big-test-bucket --remove-assignee "$agent_login"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$approved_issue" --repo tanaabased/big-test-bucket
fi

# should stop the background gateway cleanly
openclaw-gateway stop
```

```bash
# should stop the local model provider cleanly
openclaw-notification-setup stop --model "$NOTIFICATION_MODEL"
```
