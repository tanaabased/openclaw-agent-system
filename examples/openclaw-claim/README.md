# OpenClaw Claim Dispatch Trial

Exercise two-pass claiming through two isolated OpenClaw installations on one fresh Actions runner using the packed candidate. Each has its own Gateway, private state, generated instance identity, agent workspace and managed worktree root. Concurrent first occurrences must leave visible claims without preparing native work. On later occurrences, only the winning installation may create an ordinary issue session and assessment turn. Restarting both and repeating intake must preserve that single owner.

Strict AIMock supplies model responses through one shared model fixture; GitHub, Git, both Gateways and Agent System tools remain real. This proves two installations on one runner, not two physical hosts or native Codex desktop transport. Only Tanaabot is assigned work, in `tanaabased/big-test-bucket`. Cleanup closes the issue and retains its winning comment. The workflow prints a bounded evidence record with both instance identities and the winning native receipts.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
test ! -e "$TMPDIR/claim-stage-failed"
trap 'touch "$TMPDIR/claim-stage-failed"' ERR
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
touch "$TMPDIR/notification-assessments-held"
openclaw-aimock prepare --scenario openclaw-intake
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should prepare the agent with provider-verified identity pins
test ! -e "$TMPDIR/claim-stage-failed"
trap 'touch "$TMPDIR/claim-stage-failed"' ERR
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
test ! -e "$TMPDIR/claim-stage-failed"
trap 'touch "$TMPDIR/claim-stage-failed"' ERR
OPENCLAW_LOG_LEVEL=info openclaw-gateway start

# should install emori in its fixture workspace
test ! -e "$TMPDIR/claim-stage-failed"
trap 'touch "$TMPDIR/claim-stage-failed"' ERR
set -o pipefail
registration_diagnostics() {
  registration_status=$?
  if test "$registration_status" -ne 0; then
    node --import "$GITHUB_WORKSPACE/node_modules/tsx/dist/loader.mjs" "$GITHUB_WORKSPACE/scripts/registration-evidence.ts" emori || true
  fi
  exit "$registration_status"
}
trap registration_diagnostics EXIT
cd "$GITHUB_WORKSPACE/examples/openclaw-claim/emori"
openclaw agent-system install --json | jq -e 'any(.outcomes[]; .component == "agent" and .status == "created")'

# should install tanaabot and activate native intake with explicit dispatch enrollment
test ! -e "$TMPDIR/claim-stage-failed"
trap 'touch "$TMPDIR/claim-stage-failed"' ERR
set -o pipefail
activation_diagnostics() {
  activation_status=$?
  if test "$activation_status" -ne 0; then
    node --import "$GITHUB_WORKSPACE/node_modules/tsx/dist/loader.mjs" "$GITHUB_WORKSPACE/scripts/registration-evidence.ts" tanaabot || true
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

# should prepare a second installation without copying private identity or dispatch state
test ! -e "$TMPDIR/claim-stage-failed"
trap 'touch "$TMPDIR/claim-stage-failed"' ERR
declare -px OPENCLAW_PROFILE OPENCLAW_CONFIG_PATH OPENCLAW_STATE_DIR OPENCLAW_WORKSPACE SETUP_OPENCLAW_STATE_DIR XDG_CONFIG_HOME DBUS_SESSION_BUS_ADDRESS > "$TMPDIR/claim-primary.env"
printf '%s\n' "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot" > "$TMPDIR/claim-primary.workspace"
set -o pipefail
openclaw config get models --json | jq -e '.providers.aimock.apiKey = "test"' > "$TMPDIR/claim-models.json"
mkdir -p "$TMPDIR/claim-secondary/tanaabot/keys"
# separate workspaces are part of the two-installation contract
cp "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot/agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot/IDENTITY.md" "$TMPDIR/claim-secondary/tanaabot/"
cp "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot/keys/"id_ed25519* "$TMPDIR/claim-secondary/tanaabot/keys/"
printf '%s\n' "$TMPDIR/claim-secondary/tanaabot" > "$TMPDIR/claim-secondary.workspace"
env -u DBUS_SESSION_BUS_ADDRESS XDG_CONFIG_HOME="$TMPDIR/claim-secondary/config" GITHUB_ENV="$TMPDIR/claim-secondary.env" GITHUB_OUTPUT=/dev/null openclaw-setup --profile claim-secondary --workspace "$TMPDIR/claim-secondary/main" --state-dir "$TMPDIR/claim-secondary/runtime" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --yolo
printf 'XDG_CONFIG_HOME=%q\n' "$TMPDIR/claim-secondary/config" >> "$TMPDIR/claim-secondary.env"
set -a
source "$TMPDIR/claim-secondary.env"
set +a
openclaw config set gateway.port 18891 --strict-json
openclaw config set models "$(cat "$TMPDIR/claim-models.json")" --strict-json
openclaw models set aimock/gpt-5.5
openclaw config set agents.defaults.models '{"aimock/gpt-5.5":{"params":{"transport":"sse"}}}' --strict-json --merge
openclaw config set skills.workshop.autonomous.mode off
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json
OPENCLAW_LOG_LEVEL=info openclaw-gateway start

# should activate independent intake before the shared assignment exists
test ! -e "$TMPDIR/claim-stage-failed"
trap 'touch "$TMPDIR/claim-stage-failed"' ERR
set -o pipefail
set -a
source "$TMPDIR/claim-secondary.env"
set +a
cd "$(cat "$TMPDIR/claim-secondary.workspace")"
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated")'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == true)'
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

```bash
# should assign one disposable issue after both safe baselines
test ! -e "$TMPDIR/claim-stage-failed"
trap 'touch "$TMPDIR/claim-stage-failed"' ERR
source "$TMPDIR/claim-primary.env"
cd "$GITHUB_WORKSPACE/examples/openclaw-claim/emori"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System dual native claim flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-claim/issue.md" > "$TMPDIR/notification-issue-1.json"
cp "$TMPDIR/notification-issue-1.json" "$TMPDIR/notification-issue.json"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should run both first occurrences without preparing native work
test ! -e "$TMPDIR/claim-stage-failed"
trap 'touch "$TMPDIR/claim-stage-failed"' ERR
number=$(jq -er .number "$TMPDIR/notification-issue.json")
for instance in primary secondary; do
  (
    set -eo pipefail
    set -a
    source "$TMPDIR/claim-$instance.env"
    set +a
    cd "$(cat "$TMPDIR/claim-$instance.workspace")"
    run_id=$(node --import "$GITHUB_WORKSPACE/node_modules/tsx/dist/loader.mjs" "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
    node --import "$GITHUB_WORKSPACE/node_modules/tsx/dist/loader.mjs" "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
    jq -es '[.[].records[]] | length == 1 and all(.[]; .request == null and .threadId == null and .worktree == null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
    openclaw agent-system tool worktree -- list | jq -e 'length == 0'
    jq '{instanceId,displayName}' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-instance/assignment-claims.json" > "$TMPDIR/claim-$instance.identity.json"
  ) > "$TMPDIR/claim-$instance-first.log" 2>&1 &
  printf '%s\n' "$!" > "$TMPDIR/claim-$instance.pid"
done
status=0
for instance in primary secondary; do
  wait "$(cat "$TMPDIR/claim-$instance.pid")" || status=$?
  cat "$TMPDIR/claim-$instance-first.log"
done
test "$status" -eq 0
jq -es 'length == 2 and (map(.instanceId) | unique | length) == 2' "$TMPDIR/claim-primary.identity.json" "$TMPDIR/claim-secondary.identity.json"
source "$TMPDIR/claim-primary.env"
cd "$(cat "$TMPDIR/claim-primary.workspace")"
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e '[.[] | select(.user.login == "tanaabot" and (.body | startswith("Assignment claim registered on ")))] | select(length >= 1 and length <= 2)' > "$TMPDIR/claim-before.json"

# should let only one installation prepare native work on later occurrences
test ! -e "$TMPDIR/claim-stage-failed"
trap 'touch "$TMPDIR/claim-stage-failed"' ERR
number=$(jq -er .number "$TMPDIR/notification-issue.json")
for instance in primary secondary; do
  (
    set -eo pipefail
    set -a
    source "$TMPDIR/claim-$instance.env"
    set +a
    cd "$(cat "$TMPDIR/claim-$instance.workspace")"
    run_id=$(node --import "$GITHUB_WORKSPACE/node_modules/tsx/dist/loader.mjs" "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
    node --import "$GITHUB_WORKSPACE/node_modules/tsx/dist/loader.mjs" "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
    jq -es --arg instance "$instance" '[.[].records[]] | if length == 1 then .[0] + {instance:$instance} else error("one admitted record per installation required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/claim-$instance-record.json"
    openclaw agent-system tool worktree -- list > "$TMPDIR/claim-$instance-worktree.json"
  ) > "$TMPDIR/claim-$instance-second.log" 2>&1 &
  printf '%s\n' "$!" > "$TMPDIR/claim-$instance.pid"
done
status=0
for instance in primary secondary; do
  wait "$(cat "$TMPDIR/claim-$instance.pid")" || status=$?
  cat "$TMPDIR/claim-$instance-second.log"
done
test "$status" -eq 0
jq -es 'map(select(.sessionCreation.verified == true and .claimAccepted == true and .assessmentTurn.status == "accepted" and .result == null)) | if length == 1 then .[0] else error("exactly one native owner required") end' "$TMPDIR/claim-primary-record.json" "$TMPDIR/claim-secondary-record.json" > "$TMPDIR/claim-native-owner.json"
jq -es 'map(select(.sessionCreation.verified != true)) | length == 1 and all(.[]; .request == null and .threadId == null and .worktree == null and .assessmentTurn == null)' "$TMPDIR/claim-primary-record.json" "$TMPDIR/claim-secondary-record.json"
for instance in primary secondary; do
  jq -e --slurpfile record "$TMPDIR/claim-$instance-record.json" 'length == (if $record[0].sessionCreation.verified == true then 1 else 0 end)' "$TMPDIR/claim-$instance-worktree.json"
done
winner=$(jq -er .instance "$TMPDIR/claim-native-owner.json")
set -a
source "$TMPDIR/claim-$winner.env"
set +a
cd "$(cat "$TMPDIR/claim-$winner.workspace")"
conversation=$(jq -er .threadId "$TMPDIR/claim-native-owner.json")
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.parentSessionKey == "agent:claim-tanaabot:main" and .session.spawnDepth == 0 and .session.spawnedBy == null'
comment=$(jq -er 'map(.id) | min' "$TMPDIR/claim-before.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --argjson id "$comment" '[.[] | select(.body | contains("<!-- agent-system-claim:v1"))] | if length == 1 and .[0].id == $id and .[0].user.login == "tanaabot" and (.[0].body | startswith("Assignment accepted on ")) then .[0] else error("only the accepted earliest claim may remain") end' > "$TMPDIR/claim-accepted.json"
jq -e --slurpfile owner "$TMPDIR/claim-native-owner.json" --slurpfile identity "$TMPDIR/claim-$winner.identity.json" '.id == $owner[0].claimId and (.body | contains($identity[0].instanceId))' "$TMPDIR/claim-accepted.json"

# should complete a real assessment turn only in the winning session
test ! -e "$TMPDIR/claim-stage-failed"
trap 'touch "$TMPDIR/claim-stage-failed"' ERR
winner=$(jq -er .instance "$TMPDIR/claim-native-owner.json")
set -a
source "$TMPDIR/claim-$winner.env"
set +a
cd "$(cat "$TMPDIR/claim-$winner.workspace")"
receipt=$(jq -er .id "$TMPDIR/claim-native-owner.json")
touch "$TMPDIR/notification-assessment-released-$receipt"
assessment_run=$(jq -er .assessmentTurn.runId "$TMPDIR/claim-native-owner.json")
node --import "$GITHUB_WORKSPACE/node_modules/tsx/dist/loader.mjs" "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$assessment_run" 300000
jq -es '[.[].records[]] | length == 1 and all(.[]; .result.outcome == "plan-ready" and .resultTurnId == .assessmentTurn.runId)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json

# should preserve the sole native owner after restarting both installations
test ! -e "$TMPDIR/claim-stage-failed"
trap 'touch "$TMPDIR/claim-stage-failed"' ERR
number=$(jq -er .number "$TMPDIR/notification-issue.json")
for instance in primary secondary; do
  (
    set -eo pipefail
    set -a
    source "$TMPDIR/claim-$instance.env"
    set +a
    openclaw-gateway restart
    jq '{instanceId,displayName}' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-instance/assignment-claims.json" | diff - "$TMPDIR/claim-$instance.identity.json"
    cd "$(cat "$TMPDIR/claim-$instance.workspace")"
    run_id=$(node --import "$GITHUB_WORKSPACE/node_modules/tsx/dist/loader.mjs" "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
    node --import "$GITHUB_WORKSPACE/node_modules/tsx/dist/loader.mjs" "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
    jq -es --arg instance "$instance" '[.[].records[]] | if length == 1 then .[0] + {instance:$instance} else error("one retained record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/claim-$instance-after.json"
    openclaw agent-system tool worktree -- list | jq -S 'sort_by(.path)' > "$TMPDIR/claim-$instance-worktree-after.json"
    jq -S 'sort_by(.path)' "$TMPDIR/claim-$instance-worktree.json" | diff - "$TMPDIR/claim-$instance-worktree-after.json"
    openclaw gateway call sessions.list --params '{"agentId":"claim-tanaabot","limit":100}' --json | jq -e 'select(.hasMore == false) | [.sessions[] | select(.key | startswith("agent:claim-tanaabot:dashboard:agent-system-issue-"))]' > "$TMPDIR/claim-$instance-sessions.json"
  ) > "$TMPDIR/claim-$instance-restart.log" 2>&1 &
  printf '%s\n' "$!" > "$TMPDIR/claim-$instance.pid"
done
status=0
for instance in primary secondary; do
  wait "$(cat "$TMPDIR/claim-$instance.pid")" || status=$?
  cat "$TMPDIR/claim-$instance-restart.log"
done
test "$status" -eq 0
jq -es 'map(select(.sessionCreation.verified == true)) | if length == 1 then .[0] else error("one retained owner required") end' "$TMPDIR/claim-primary-after.json" "$TMPDIR/claim-secondary-after.json" > "$TMPDIR/claim-native-after.json"
jq -e --slurp '.[0] as $before | .[1] as $after | $after.result.outcome == "plan-ready" and $after.claimAccepted == true and ($before | {instance,id,threadId,worktree,claimId,sessionId:.sessionCreation.sessionId,run:.assessmentTurn.runId}) == ($after | {instance,id,threadId,worktree,claimId,sessionId:.sessionCreation.sessionId,run:.assessmentTurn.runId})' "$TMPDIR/claim-native-owner.json" "$TMPDIR/claim-native-after.json"
jq -es 'map(select(.sessionCreation.verified != true)) | length == 1 and all(.[]; .request == null and .threadId == null and .worktree == null and .assessmentTurn == null)' "$TMPDIR/claim-primary-after.json" "$TMPDIR/claim-secondary-after.json"
jq -es 'map(length) | add == 1' "$TMPDIR/claim-primary-sessions.json" "$TMPDIR/claim-secondary-sessions.json"
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0'
jq -n --slurpfile primary "$TMPDIR/claim-primary.identity.json" --slurpfile secondary "$TMPDIR/claim-secondary.identity.json" --slurpfile owner "$TMPDIR/claim-native-after.json" --slurpfile claim "$TMPDIR/claim-accepted.json" --slurpfile issue "$TMPDIR/notification-issue.json" '{scope:"two isolated installations on one Actions runner",issue:$issue[0].html_url,claim:$claim[0].html_url,instances:{primary:$primary[0],secondary:$secondary[0]},winner:($owner[0]|{instance,id,threadId,worktree,claimId,sessionId:.sessionCreation.sessionId,assessmentRunId:.assessmentTurn.runId,resultTurnId,resultOutcome:.result.outcome}),nativeSessions:1,managedWorktrees:1,restartPreserved:true}' > "$TMPDIR/claim-evidence.json"
```

## Cleanup

A failed setup or test blocks dependent steps while cleanup still runs. Stop both Gateways before changing the shared fixture or its SSH key. Every wait is bounded. The winning claim remains on the closed issue.

```bash
# should stop both isolated gateways before changing external fixture state
status=0
for instance in primary secondary; do
  if test -f "$TMPDIR/claim-$instance.env"; then
    (
      set -a
      source "$TMPDIR/claim-$instance.env"
      set +a
      openclaw-gateway stop --timeout 340
    ) || status=$?
  else
    openclaw-gateway stop --timeout 340 || status=$?
  fi
done
test "$status" -eq 0
touch "$TMPDIR/notification-gateway-stopped"

# should close only the disposable issue created by this run
test -f "$TMPDIR/notification-gateway-stopped"
if test -s "$TMPDIR/notification-issue-1.json"; then
  source "$TMPDIR/claim-primary.env"
  cd "$GITHUB_WORKSPACE/examples/openclaw-claim/emori"
  number=$(jq -er .number "$TMPDIR/notification-issue-1.json")
  openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
fi

# should remove only this runs ssh authentication key
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-claim/tanaabot"
key_material=$(awk '{print $2}' keys/id_ed25519.pub)
key_id=$(openclaw agent-system tool gh -- api --paginate /user/keys --jq ".[] | select((.key | split(\" \")) | index(\"$key_material\")) | .id")
if test -n "$key_id"; then
  openclaw agent-system tool gh -- api --method DELETE "/user/keys/$key_id"
fi

# should report strict mock failures while stopping the provider
cleanup_status=0
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics || cleanup_status=$?
openclaw-aimock stop || cleanup_status=$?
test "$cleanup_status" -eq 0
```
