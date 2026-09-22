# GitHub Issue Work Concurrency Scenario

This GitHub Actions-only strict AIMock scenario submits three real assignments
against a durable limit of two. A starts first; B must acquire a separate session
while C remains queued during the next one-minute poll. No execution lease is
fabricated. A scenario-owned release file controls the provider barrier, not
model-authored instructions.

Notification workflows share a CI account lock, and this background-poll scenario
runs after sibling scenarios have cleaned up. That keeps other jobs' assignments
out of its strict provider fixture without serializing the two admitted turns.

The assertions inspect the installed Gateway, redacted scheduler status, and
file-backed candidate and conversation records. They stop at the installed
capacity boundary: A and B are active while C remains durably queued without a
session. Queue draining and automatic implementation remain deterministic direct
test contracts rather than an attempt to race the next background poll.

## Setup

```bash
# should prepare the selected notification model and isolated profile
openclaw-notification-setup prepare \
  --model "$NOTIFICATION_MODEL" \
  --scenario concurrency \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE"
```

```bash
# should trust the github host key for the prepared ssh identity
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should prepare notification and approved actor workspaces
mkdir "$TMPDIR/agent-system-notifications"
mkdir "$TMPDIR/agent-system-notification-actor"
sed 's/interval-minutes: 60/interval-minutes: 1/' "$GITHUB_WORKSPACE/fixtures/github-notifications/agent.yaml" > "$TMPDIR/agent-system-notifications/agent.yaml"
mkdir "$TMPDIR/notification-concurrency"
cp "$GITHUB_WORKSPACE/fixtures/github-notifications/actor-agent.yaml" "$TMPDIR/agent-system-notification-actor/agent.yaml"
printf '%s' 'tanaabot' > "$TMPDIR/notification-agent-login"

# should authorize the fixture actor for native owner-only session tools
openclaw config set commands.ownerAllowFrom '["U_kgDOEUqvpg"]' --strict-json

# should require normal install to repair missing hook consent
openclaw config unset plugins.entries.agent-system.hooks.allowConversationAccess

# should leave gateway headroom above the agent-system scheduler ceiling
openclaw config set agents.defaults.maxConcurrent 4 --strict-json

# should start the default gateway before routing installation
OPENCLAW_NO_RESPAWN=1 openclaw-gateway start

# should make existing custom groups available for assignment setup
openclaw gateway call sessions.groups.put --params '{"names":["Reading","Active Work"]}' --json | jq -e '.ok == true'

# should install the route and establish the first baseline synchronously
cd "$TMPDIR/agent-system-notifications"
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "updated")'
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-notification-baseline-established")'
openclaw plugins inspect agent-system --runtime --json | jq -e '.policy.allowConversationAccess == true and any(.typedHooks[]; .name == "before_prompt_build")'
openclaw agent-system doctor --json | jq -e '.findings[] | select(.component == "git" and .code == "git-worktrees-root-ready")'
openclaw-github-notifications wait-route \
  --route-state present \
  --account-id notification-data

# should register only the generated public key for tanaabot
cd "$TMPDIR/agent-system-notifications"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method POST /user/keys -f "title=agent-system-assignment-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS" -f "key=$(cat "$HOME/.ssh/big-test-bucket-ssh.pub")" --jq .id > "$TMPDIR/notification-ssh.key-id"

# should install the approved github actor through agent system
cd "$TMPDIR/agent-system-notification-actor"
openclaw agent-system install
```

## Testing

```bash
# should start the first real assignment and hold its model turn open
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/big-test-bucket \
  --title "concurrent assignment a $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
  --body 'Assess the bounded concurrency fixture without changing repository files.' \
  --assignee "$agent_login" \
  --issue-number-path "$TMPDIR/notification-concurrency/a"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api /repos/tanaabased/big-test-bucket --jq .node_id > "$TMPDIR/notification-concurrency/repository"
cd "$GITHUB_WORKSPACE"
node --import tsx "$GITHUB_WORKSPACE/scenarios/issue-work-concurrency/assert-state.ts" entered
touch "$TMPDIR/notification-concurrency/entered-verified"
```

```bash
# should admit one later session and leave the third assignment durably queued
test -f "$TMPDIR/notification-concurrency/entered-verified"
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
for label in b c; do
  openclaw-github-issue create-and-assign \
    --creator-agent notification-actor \
    --repository tanaabased/big-test-bucket \
    --title "concurrent assignment $label $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $RUNNER_OS" \
    --body 'Assess the bounded concurrency fixture without changing repository files.' \
    --assignee "$agent_login" \
    --issue-number-path "$TMPDIR/notification-concurrency/$label"
done
cd "$GITHUB_WORKSPACE"
node --import tsx "$GITHUB_WORKSPACE/scenarios/issue-work-concurrency/assert-state.ts" limited
```

## Cleanup

```bash
# should stop the gateway before releasing the held provider turns
openclaw-gateway stop
if test -d "$TMPDIR/notification-concurrency"; then
  printf '%s' released > "$TMPDIR/notification-concurrency/release"
fi

# should close only the three generated issue fixtures
if test -d "$TMPDIR/agent-system-notification-actor"; then
  cd "$TMPDIR/agent-system-notification-actor"
  for label in a b c; do
    if test -f "$TMPDIR/notification-concurrency/$label"; then
      issue_number="$(cat "$TMPDIR/notification-concurrency/$label")"
      OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue edit "$issue_number" --repo tanaabased/big-test-bucket --remove-assignee tanaabot
      OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$issue_number" --repo tanaabased/big-test-bucket
    fi
  done
fi

# should remove only the generated public key
if test -f "$TMPDIR/notification-ssh.key-id"; then
  cd "$TMPDIR/agent-system-notifications"
  key_id="$(cat "$TMPDIR/notification-ssh.key-id")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-data -- api --method DELETE "/user/keys/$key_id"
fi
```

```bash
# should stop the isolated model provider
openclaw-notification-setup stop --model "$NOTIFICATION_MODEL"
```
