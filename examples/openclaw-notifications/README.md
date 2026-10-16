# OpenClaw Assignment-to-Plan End-to-End Example

Assign one disposable issue in `tanaabased/big-test-bucket`, admit it through the installed V2 automation, and retain one plan in its native issue conversation and managed worktree. Public notification commands drive and observe the flow. A repeat scan must preserve the same admission, conversation, worktree, assessment input, and result receipt.

Strict AIMock supplies routing judgment and assessment text. GitHub authorization, assignment events, native scheduling, session dispatch, managed Git execution, and result retention remain real. This tests the system's assignment-to-plan plumbing; it does not evaluate model judgment or the assessment skill's editorial quality. Implementation and publication are outside this Plan-mode example.

CI supplies the existing EMORI and Tanaabot tokens. EMORI creates and assigns the issue to Tanaabot; only Tanaabot enables notifications. This keeps real EMORI automation from receiving test assignments. Both checked-in agent workspaces run in place, with runtime identity pins from GitHub. Installation enrolls dispatch explicitly and registers one disposable SSH authentication key; cleanup closes only this test's issue and removes only that public key. Everything runs on a fresh Ubuntu runner.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-notifications

# should prepare the agent with provider-verified identity pins
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot/keys" "$HOME/.ssh"
GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id > "$TMPDIR/notification-owner-node"
GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id' > "$TMPDIR/notification-actor-node"
owner_node=$(cat "$TMPDIR/notification-owner-node")
actor_node=$(cat "$TMPDIR/notification-actor-node")
test -n "$owner_node"
test -n "$actor_node"
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should activate native intake with explicit dispatch enrollment
openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/emori"
openclaw agent-system install --json | jq -e 'any(.outcomes[]; .component == "agent" and .status == "created")'
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot"
openclaw agent-system install --yes --json | tee "$TMPDIR/notification-install.json" | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated")'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == true)'
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

```bash
# should assign one disposable issue from emori to tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/emori"
openclaw agent-system tool gh -- api repos/tanaabased/big-test-bucket | jq '{id,node_id}' > "$TMPDIR/notification-repository.json"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System notification flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-notifications/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain a plan through the installed owning automation
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts")
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" github-issue-assignment "$run_id"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for plan-ready --refresh --timeout 600 --json | tee "$TMPDIR/notification-plan.json" | jq -e '.status == "completed" and (.observation.items | length) == 1 and .observation.items[0].workflow.phase == "plan-ready"'
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.parentSessionKey == "agent:notifications-tanaabot:main" and .session.spawnDepth == 0 and .session.spawnedBy == null'
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call agent.wait --params "$(jq -nc --arg run "$run_id" '{runId:$run,timeoutMs:120000}')" --timeout 130000 --json | jq -e '.status == "ok"'
jq -e --arg conversation "$conversation" --arg issue "$(jq -er .node_id "$TMPDIR/notification-issue.json")" --arg repository "$(jq -er .node_id "$TMPDIR/notification-repository.json")" '.result.outcome == "plan-ready" and (.result.fullAssessment | length > 0) and (.result.plan | length > 0) and .stageReceipt.binding.threadId == $conversation and .stageReceipt.binding.subjectId == $issue and .stageReceipt.binding.repositoryId == $repository and .stageReceipt.binding.worktree == .worktree and .stageReceipt.binding.turnId == .assessmentTurn.runId and .resultTurnId == .assessmentTurn.runId and .sessionCreation.verified == true' "$TMPDIR/notification-dispatch-before.json"
openclaw agent-system tool worktree -- list | tee "$TMPDIR/notification-worktrees-before.json" | jq -e --arg path "$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")" 'length == 1 and .[0].path == $path'

# should preserve one conversation and assessment across another native scan
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts")
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" github-issue-assignment "$run_id"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications status --repository tanaabased/big-test-bucket --kind issue --number "$number" --json | tee "$TMPDIR/notification-status-after.json" | jq -e --arg conversation "$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")" '.status == "ready" and (.items | length) == 1 and .items[0].workflow.phase == "plan-ready" and .items[0].workflow.conversation == $conversation'
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-after.json"
jq -e --slurp '.[0].id == .[1].id and .[0].intakeId == .[1].intakeId and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].assessmentTurn.runId == .[1].assessmentTurn.runId and .[0].stageReceipt == .[1].stageReceipt and .[0].result == .[1].result and .[1].assessmentTurn.status == "completed"' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-dispatch-after.json"
openclaw agent-system tool worktree -- list | jq -S 'sort_by(.path)' > "$TMPDIR/notification-worktrees-after.json"
jq -S 'sort_by(.path)' "$TMPDIR/notification-worktrees-before.json" | diff - "$TMPDIR/notification-worktrees-after.json"
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-after.json")
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-after.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json | jq -e --arg run "$run_id" --arg session "$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-after.json")" '.sessionId == $session and .sessionInfo.hasActiveRun == false and ([.messages[] | select(.role == "user" and .idempotencyKey == ($run + ":user"))] | length) == 1 and ([.messages[] | select(.role == "assistant" and .__openclaw.runId == $run and .stopReason == "stop")] | length) == 1'
openclaw gateway call sessions.list --params '{"agentId":"notifications-tanaabot","limit":100}' --json | jq -e --arg key "$conversation" --arg session "$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-after.json")" '.hasMore == false and ([.sessions[] | select(.key | startswith("agent:notifications-tanaabot:dashboard:agent-system-issue-"))] | length) == 1 and any(.sessions[]; .key == $key and .sessionId == $session)'
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0 and any(.tools[]; .name == "agent_system_git" and .callResponseCount == 1)'
```

## Cleanup

```bash
# should close only the disposable issue created by this run
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/emori"
if test -s "$TMPDIR/notification-issue.json"; then
  number=$(jq -er .number "$TMPDIR/notification-issue.json")
  openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
fi

# should remove only this run's ssh authentication key
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot"
key_material=$(awk '{print $2}' keys/id_ed25519.pub)
key_id=$(openclaw agent-system tool gh -- api --paginate /user/keys --jq ".[] | select((.key | split(\" \")) | index(\"$key_material\")) | .id")
if test -n "$key_id"; then
  openclaw agent-system tool gh -- api --method DELETE "/user/keys/$key_id"
fi

# should report strict mock failures while stopping the isolated gateway and provider
cleanup_status=0
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics || cleanup_status=$?
openclaw-gateway stop --timeout 340 || cleanup_status=$?
openclaw-aimock stop || cleanup_status=$?
test "$cleanup_status" -eq 0
```
