# OpenClaw Claim Dispatch Trial

Exercise two-pass claiming through one isolated OpenClaw Gateway using the packed candidate. The first native intake occurrence must leave a visible claim without creating a worktree or issue session. A later occurrence must create one ordinary issue session, start its assessment, and update that same claim only after native creation is verified. Restart and repeat intake must retain the same owner, worktree and assessment turn.

The separate `shared-github-claim` trial covers competing instance stores. This scenario proves the connection to real native dispatch on one Gateway; it does not claim two-host or native Codex desktop coverage. Strict AIMock supplies model responses while GitHub, Git, Gateway sessions and Agent System tools remain real. Only Tanaabot is assigned work, in `tanaabased/big-test-bucket`. Cleanup closes the issue but preserves its winning comment for inspection.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
touch "$TMPDIR/notification-assessments-held"
openclaw-aimock prepare --scenario openclaw-intake
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should prepare the agent with provider-verified identity pins
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot/keys" "$HOME/.ssh"
GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id > "$TMPDIR/notification-owner-node"
GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id' > "$TMPDIR/notification-actor-node"
owner_node=$(cat "$TMPDIR/notification-owner-node")
actor_node=$(cat "$TMPDIR/notification-actor-node")
receiver_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id')
test -n "$owner_node"
test -n "$actor_node"
test -n "$receiver_node"
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__RECEIVER_NODE_ID__|$receiver_node|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should start the isolated gateway
OPENCLAW_LOG_LEVEL=info openclaw-gateway start

# should install emori in its fixture workspace
set -o pipefail
registration_diagnostics() {
  registration_status=$?
  if test "$registration_status" -ne 0; then
    node --import tsx "$GITHUB_WORKSPACE/scripts/registration-evidence.ts" emori || true
  fi
  exit "$registration_status"
}
trap registration_diagnostics EXIT
cd "$GITHUB_WORKSPACE/examples/openclaw-claim/emori"
openclaw agent-system install --json | jq -e 'any(.outcomes[]; .component == "agent" and .status == "created")'

# should install tanaabot and activate native intake with explicit dispatch enrollment
set -o pipefail
activation_diagnostics() {
  activation_status=$?
  if test "$activation_status" -ne 0; then
    node --import tsx "$GITHUB_WORKSPACE/scripts/registration-evidence.ts" tanaabot || true
    gateway_log=$(openclaw-gateway log-path) || true
    gateway_redactor="$(dirname "$(command -v openclaw-gateway)")/lib/redact-stream.mjs"
    openclaw config get gateway --json | jq -c '{reloadMode: (.reload.mode // "hybrid")}' || true
    tail -n 300 "$gateway_log" | node "$gateway_redactor" || true
    cat "$TMPDIR/notification-install.json" || true
    openclaw agent-system automations list --json || true
  fi
  exit "$activation_status"
}
trap activation_diagnostics EXIT
cd "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot"
openclaw agent-system install --yes --json | tee "$TMPDIR/notification-install.json" | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and ([.warnings[] | select(.code == "github-notification-runtime-unsupported")] | length) == 1'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == true)'
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
touch "$TMPDIR/notification-activation-ready"
```

## Testing

```bash
# should assign one disposable issue after the safe baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-claim/emori"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System native claim flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-claim/issue.md" > "$TMPDIR/notification-issue-1.json"
cp "$TMPDIR/notification-issue-1.json" "$TMPDIR/notification-issue.json"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should register a visible claim without preparing native work on the first occurrence
cd "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es '[.[].records[]] | length == 1 and all(.[]; .request == null and .threadId == null and .worktree == null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system tool worktree -- list | jq -e 'length == 0'
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e '[.[] | select(.user.login == "tanaabot" and (.body | startswith("Assignment claim registered on ")))] | if length == 1 then .[0] else error("one pending claim required") end' > "$TMPDIR/claim-before.json"

# should create one ordinary session on a later occurrence before accepting the same claim
cd "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one native owner required") end | select(.sessionCreation.verified == true and .claimAccepted == true and .assessmentTurn.status == "accepted" and .result == null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/claim-native-owner.json"
conversation=$(jq -er .threadId "$TMPDIR/claim-native-owner.json")
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.parentSessionKey == "agent:claim-tanaabot:main" and .session.spawnDepth == 0 and .session.spawnedBy == null'
openclaw agent-system tool worktree -- list | tee "$TMPDIR/claim-worktree.json" | jq -e 'length == 1'
comment=$(jq -er .id "$TMPDIR/claim-before.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/comments/$comment" | jq -e --argjson id "$comment" '.id == $id and .user.login == "tanaabot" and (.body | startswith("Assignment accepted on "))'

# should complete a real assessment turn in the claimed session
cd "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot"
receipt=$(jq -er .id "$TMPDIR/claim-native-owner.json")
touch "$TMPDIR/notification-assessment-released-$receipt"
assessment_run=$(jq -er .assessmentTurn.runId "$TMPDIR/claim-native-owner.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$assessment_run" 300000
jq -es '[.[].records[]] | length == 1 and all(.[]; .result.outcome == "plan-ready" and .resultTurnId == .assessmentTurn.runId)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json

# should preserve the native session and assessment across restart and repeat intake
openclaw-gateway restart
cd "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one native owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/claim-native-after.json"
jq -e --slurp '.[0] as $before | .[1] as $after | $after.result.outcome == "plan-ready" and $after.claimAccepted == true and ($before | {id,threadId,worktree,claimId,run:.assessmentTurn.runId}) == ($after | {id,threadId,worktree,claimId,run:.assessmentTurn.runId})' "$TMPDIR/claim-native-owner.json" "$TMPDIR/claim-native-after.json"
openclaw agent-system tool worktree -- list | jq -S 'sort_by(.path)' > "$TMPDIR/claim-worktree-after.json"
jq -S 'sort_by(.path)' "$TMPDIR/claim-worktree.json" | diff - "$TMPDIR/claim-worktree-after.json"
openclaw gateway call sessions.list --params '{"agentId":"claim-tanaabot","limit":100}' --json | jq -e '.hasMore == false and ([.sessions[] | select(.key | startswith("agent:claim-tanaabot:dashboard:agent-system-issue-"))] | length) == 1'
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0'
```

## Cleanup

Cleanup requires a terminal Gateway stop before changing external fixtures. Every wait reports its receipt and remains bounded.

```bash
# should stop the isolated gateway before changing external fixture state
openclaw-gateway stop --timeout 340
touch "$TMPDIR/notification-gateway-stopped"

# should close only the disposable issues created by this run
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-claim/emori"
for slot in 1; do
  if test -s "$TMPDIR/notification-issue-$slot.json"; then
    number=$(jq -er .number "$TMPDIR/notification-issue-$slot.json")
    openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
  fi
done

# should remove only this run's ssh authentication key
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot"
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
