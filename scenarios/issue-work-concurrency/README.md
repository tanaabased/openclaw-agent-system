# GitHub Issue Work Concurrency Scenario

This GitHub Actions-only strict AIMock scenario holds three real assignment
model turns at the provider boundary. A starts first; B and C must acquire
separate durable sessions and candidate records during the next one-minute
poll while A remains open. No execution lease is fabricated. A scenario-owned
release file controls the provider barrier, not model-authored instructions.

Notification workflows share a CI account lock, and this background-poll scenario
runs after sibling scenarios have cleaned up. That keeps other jobs' assignments
out of its strict provider fixture without serializing the three turns under test.

The assertions inspect the installed Gateway, file-backed candidate and
conversation records, and bounded GitHub publication receipts. After all three
sessions exist, releasing the barrier proves isolated candidates and exactly
one acknowledgment and assignment response per issue. Stop the Gateway before
a later poll can advance these planning-only fixtures into implementation.

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

# should allow three independent model turns in the isolated gateway
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
# should record two later sessions while the first assignment is still open
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
node --import tsx "$GITHUB_WORKSPACE/scenarios/issue-work-concurrency/assert-state.ts" open
touch "$TMPDIR/notification-concurrency/open-verified"
```

```bash
# should publish isolated candidates exactly once after releasing all three model turns
test -f "$TMPDIR/notification-concurrency/open-verified"
cd "$GITHUB_WORKSPACE"
printf '%s' released > "$TMPDIR/notification-concurrency/release"
node --import tsx "$GITHUB_WORKSPACE/scenarios/issue-work-concurrency/assert-state.ts" published
openclaw-gateway stop
cd "$TMPDIR/agent-system-notification-actor"
for label in a b c; do
  issue_number="$(cat "$TMPDIR/notification-concurrency/$label")"
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '.[] | select(.user.login == "tanaabot")' > "$TMPDIR/notification-concurrency/comments-$label.json"
  jq -se --arg number "$issue_number" '([.[] | select(.body | contains("agent-system-github-publication:initial-acknowledgment:"))] | length) == 1 and ([.[] | select(.body | contains("agent-system-github-publication:assignment-response:"))] | length) == 1 and ([.[] | select(.body | contains("agent-system-github-publication:assignment-response:")) | .body | contains("issue " + $number + ".")] | all)' "$TMPDIR/notification-concurrency/comments-$label.json"
done
```

```bash
# should expose six successful strict provider exchanges without unmatched requests
openclaw-notification-setup evidence \
  --model "$NOTIFICATION_MODEL" \
  --scenario concurrency \
  --expected-evidence "$GITHUB_WORKSPACE/scenarios/issue-work-concurrency/expected-evidence.json"
```

## Cleanup

```bash
# should release the scenario barrier before draining workers
if test -d "$TMPDIR/notification-concurrency"; then
  printf '%s' released > "$TMPDIR/notification-concurrency/release"
fi
openclaw-gateway stop

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
