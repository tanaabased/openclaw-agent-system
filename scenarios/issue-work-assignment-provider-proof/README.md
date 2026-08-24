# GitHub Issue Work Assignment Provider Proof

This GitHub Actions-only scenario proves that the installed OpenClaw Gateway can
complete the `issue` + `work` + `assignment` turn with a deterministic AIMock
provider and no live OpenAI credential. The mock fixes only the model responses:
OpenClaw still builds the trusted prompt, executes the real
`agent_system_github_reply` tool, and returns the private report, while Agent
System still owns the worktree, lifecycle, authorization, and GitHub publication.

The workflow runs this proof twice in isolated jobs. Each run compares its
normalized provider journal with `expected-evidence.json`; the two jobs therefore
have one identical, bounded evidence contract despite different disposable issue
numbers and GitHub timestamps.

The scenario creates one uniquely named disposable issue in
`tanaabased/big-test-bucket` and removes its generated SSH key during cleanup.

## Setup

```bash
# should keep live model credentials and the proof harness outside the runtime package
if env | grep -q '^OPENAI_API_KEY='; then
  exit 1
fi
if tar -tzf "$AGENT_SYSTEM_PACKAGE" | grep -Eq 'scripts/github-notification-model-proof|scenarios/issue-work-assignment-provider-proof'; then
  exit 1
fi
```

```bash
# should start the strict local model provider
node --import tsx "$GITHUB_WORKSPACE/scripts/github-notification-model-proof-server.ts" --host 127.0.0.1 --port 4010 > "$TMPDIR/notification-model-proof.url" 2> "$TMPDIR/notification-model-proof.log" &
printf '%s\n' "$!" > "$TMPDIR/notification-model-proof.pid"
provider_ready=''
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:4010/ready > /dev/null; then
    provider_ready=1
    break
  fi
  sleep 1
done
if test -z "$provider_ready"; then
  cat "$TMPDIR/notification-model-proof.log" >&2
  exit 1
fi
test "$(cat "$TMPDIR/notification-model-proof.url")" = 'http://127.0.0.1:4010'
```

```bash
# should configure the default profile with the local aimock model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE" \
  --needs-secret-service \
  --needs-ssh-key \
  --yolo
openclaw config set models.mode replace
openclaw config set models.providers.aimock '{"baseUrl":"http://127.0.0.1:4010","apiKey":"test","api":"openai-responses","request":{"allowPrivateNetwork":true},"models":[{"id":"gpt-5.5","name":"gpt-5.5","api":"openai-responses","reasoning":true,"input":["text","image"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":128000,"maxTokens":4096}]}' --strict-json
openclaw models set aimock/gpt-5.5
openclaw config set agents.defaults.models '{"aimock/gpt-5.5":{"params":{"transport":"sse"}}}' --strict-json --merge
openclaw config validate --json | jq -e '.valid == true'
```

```bash
# should trust the github host key for the prepared ssh identity
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"
```

```bash
# should prepare notification and approved actor workspaces
mkdir "$TMPDIR/agent-system-notifications"
mkdir "$TMPDIR/agent-system-notification-actor"
cp "$GITHUB_WORKSPACE/fixtures/github-notifications/agent.yaml" "$TMPDIR/agent-system-notifications/agent.yaml"
cp "$GITHUB_WORKSPACE/fixtures/github-notifications/actor-agent.yaml" "$TMPDIR/agent-system-notification-actor/agent.yaml"
printf '%s' 'tanaabot' > "$TMPDIR/notification-agent-login"
```

```bash
# should start the default gateway before routing installation
OPENCLAW_NO_RESPAWN=1 openclaw-gateway start
```

```bash
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
```

```bash
# should register only the generated public key for tanaabot
cd "$TMPDIR/agent-system-notifications"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method POST /user/keys -f "title=agent-system-provider-proof-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$NOTIFICATION_PROOF_REPEAT-$RUNNER_OS" -f "key=$(cat "$HOME/.ssh/big-test-bucket-ssh.pub")" --jq .id > "$TMPDIR/notification-ssh.key-id"
```

```bash
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
```

```bash
# should prepare one approved issue assignment and deterministic planning turn
cd "$TMPDIR/agent-system-notification-actor"
agent_login="$(cat "$TMPDIR/notification-agent-login")"
openclaw-github-issue create-and-assign \
  --creator-agent notification-actor \
  --repository tanaabased/big-test-bucket \
  --title "prove deterministic notification provider $GITHUB_RUN_ID $GITHUB_RUN_ATTEMPT $NOTIFICATION_PROOF_REPEAT $RUNNER_OS" \
  --body 'Prove that the installed notification lifecycle can publish one deterministic assignment response without a live model credential.' \
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
    --timeout 240
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
  --json | jq -e --argjson number "$issue_number" '.status == "completed" and .code == "github-notification-worktree-ready" and (.observation.items[0] | .repository == "tanaabased/big-test-bucket" and .itemType == "issue" and .lifecycleId == "issue" and .number == $number and .disposition == "approved" and .reasonCode == "assignment-approved" and .stage == "prepared" and .worktree == "ready")'
```

```bash
# should publish exactly one bounded assignment acknowledgment
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
acknowledgments="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:initial-acknowledgment"))) | {body, id}')"
acknowledgment="$(jq -sce 'select(length == 1) | .[0]' <<< "$acknowledgments")"
jq -e '.id | type == "number" and . > 0' <<< "$acknowledgment"
jq -e '.body | split("\n\n") | length == 2 and (.[0] | length > 0 and length <= 200) and (.[1] | contains("agent-system-github-publication:initial-acknowledgment"))' <<< "$acknowledgment"
```

```bash
# should publish the fixed reply candidate through the real assignment envelope
cd "$TMPDIR/agent-system-notification-actor"
issue_number="$(cat "$TMPDIR/approved-issue-number")"
responses="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- api --paginate "/repos/tanaabased/big-test-bucket/issues/$issue_number/comments" --jq '.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:assignment-response"))) | {body, id}')"
response="$(jq -sce 'select(length == 1) | .[0]' <<< "$responses")"
expected="This issue needs a deterministic notification test that keeps the real OpenClaw and GitHub lifecycle while removing live model variability. I'm going to prove the assignment turn with a fixed mock tool call and response, repeat the evidence in isolation, and document the supported boundary to resolve the issue."
jq -e '.id | type == "number" and . > 0' <<< "$response"
jq -e --arg expected "$expected" '.body | split("\n\n") as $parts | ($parts | length) == 2 and $parts[0] == $expected and ($parts[1] | contains("agent-system-github-publication:assignment-response"))' <<< "$response"
```

```bash
# should expose the exact bounded provider proof evidence
curl --fail --silent --show-error http://127.0.0.1:4010/proof/evidence | tee "$TMPDIR/notification-provider-proof-evidence.json"
jq -e '.schemaVersion == 1 and .provider == "aimock" and .model == "aimock/gpt-5.5" and .requestCount == 2 and .responsesApiRequestCount == 2 and .assignmentPromptRequestCount == 2 and .replyToolProjectionRequestCount == 2 and .replyToolCallResponseCount == 1 and .replyToolResultRequestCount == 1 and .finalResponseCount == 1 and .successfulFixtureResponseCount == 2 and .strictMissCount == 0' "$TMPDIR/notification-provider-proof-evidence.json"
cmp "$GITHUB_WORKSPACE/scenarios/issue-work-assignment-provider-proof/expected-evidence.json" "$TMPDIR/notification-provider-proof-evidence.json"
```

```bash
# should leave the planning only assignment worktree unchanged
cd "$TMPDIR/agent-system-notifications"
worktrees="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list)"
worktree_path="$(jq -re 'select(length == 1) | .[0].path' <<< "$worktrees")"
cd "$worktree_path"
status="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool git --agent notification-data -- status --porcelain)"
test -z "$status"
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
```

```bash
# should close the remote issue fixture
if test -d "$TMPDIR/agent-system-notification-actor"; then
  cd "$TMPDIR/agent-system-notification-actor"
  agent_login="$(cat "$TMPDIR/notification-agent-login")"
  if test -f "$TMPDIR/approved-issue-number"; then
    approved_issue="$(cat "$TMPDIR/approved-issue-number")"
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue edit "$approved_issue" --repo tanaabased/big-test-bucket --remove-assignee "$agent_login"
    OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh --agent notification-actor -- issue close "$approved_issue" --repo tanaabased/big-test-bucket
  fi
fi
```

```bash
# should stop the background gateway cleanly
openclaw-gateway stop
```

```bash
# should stop the local model provider cleanly
if test -f "$TMPDIR/notification-model-proof.pid"; then
  provider_pid="$(cat "$TMPDIR/notification-model-proof.pid")"
  kill -TERM "$provider_pid" 2> /dev/null || true
  for attempt in $(seq 1 30); do
    if ! kill -0 "$provider_pid" 2> /dev/null; then
      break
    fi
    sleep 1
  done
  ! kill -0 "$provider_pid" 2> /dev/null
fi
```
