# OpenClaw Notification Intake Example

Activate notification intake, start three independent issue assessments before any result completes, retain all three plans, and verify that a repeat scan preserves the same chats, worktrees, and assessment turns.

## What Belongs Here

- Native channel readiness and a safe intake baseline before fixture assignment.
- Concurrent admission with distinct verified native owners and complete retained assessments.
- One repeat scan proving that admission does not duplicate chats, checkouts, or turns.

## What Does Not Belong Here

- Assessment presentation and ordinary issue feedback: [issue planning](../openclaw-notifications-issue/README.md). Implementation and PR feedback: [PR delivery](../openclaw-notifications-pr-delivery/README.md).
- Restart recovery: [assessment recovery](../openclaw-notifications-assessment-recovery/README.md). Unassigned-issue feedback: [reactivation](../openclaw-notifications-reactivation/README.md). Coordinator/tracking reset: [reset](../openclaw-notifications-reset/README.md). Resource reconciliation: [retirement](../openclaw-notifications-retirement/README.md).
- Scheduler-control variants, unavailable-assignment recovery, and detailed debug-card presentation.

## Notes

- Strict AIMock holds each assessment behind a per-receipt release barrier. The test releases all three only after verifying their native starts; model judgment is not under test.
- V3 object identities preserve supplied names and node IDs through installation and intake. Only Tanaabot receives the three disposable assignments.
- Scoped refreshes and a 24-hour schedule bound discovery. The job owns its workspaces, issues, native state, and SSH registration; cleanup stops the Gateway before changing external fixtures.
- Pending relocation: native/manifest pause and resume, unavailable-issue retention, and stage-specific debug-card checks remain in the executable body.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
touch "$TMPDIR/notification-assessments-held"
openclaw-aimock prepare --scenario openclaw-notifications-intake
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should select shared installation cleanup grace
install -d -m 700 "$XDG_CONFIG_HOME/tanaab/agent-system"
cp "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/config.yaml" "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"
chmod 600 "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"

# should prepare the agent with provider-verified identity pins
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/keys" "$HOME/.ssh"
GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id > "$TMPDIR/notification-owner-node"
GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id' > "$TMPDIR/notification-actor-node"
owner_node=$(cat "$TMPDIR/notification-owner-node")
actor_node=$(cat "$TMPDIR/notification-actor-node")
receiver_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id')
test -n "$owner_node"
test -n "$actor_node"
test -n "$receiver_node"
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__RECEIVER_NODE_ID__|$receiver_node|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should boot with retained legacy channel configuration
openclaw config set channels.agent-system-github '{"accounts":{"retired-agent":{"enabled":false}}}' --strict-json
openclaw config set plugins.entries.agent-system.config.githubNotifications '{"maxCommentCharacters":8000}' --strict-json
OPENCLAW_LOG_LEVEL=info openclaw-gateway start
openclaw config get channels.agent-system-github --json | jq -e '.accounts["retired-agent"].enabled == false'

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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
openclaw agent-system install --yes --json | tee "$TMPDIR/notification-install.json" | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and ([.warnings[] | select(.code == "github-notification-runtime-unsupported")] | length) == 1'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == true)'
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
touch "$TMPDIR/notification-activation-ready"
```

## Testing

```bash
# should expose the install-managed account through the native channel status interface
set -o pipefail
test -f "$TMPDIR/notification-activation-ready"
openclaw gateway call channels.status --json | tee "$TMPDIR/intake-channel-status.json"
jq -e '.channelAccounts["agent-system-github"] | any(.accountId == "intake-tanaabot" and .enabled == true and .configured == true and .mode == "readiness" and .statusState == "degraded" and .lifecycle == "ready" and .running == true and (.lastError | contains("review requests")))' "$TMPDIR/intake-channel-status.json"
openclaw config get channels.agent-system-github --json | jq -e '.accounts["retired-agent"].enabled == false and .accounts["intake-tanaabot"].enabled == true'

# should pause and resume the same scheduler job through native and manifest controls
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
openclaw agent-system automations list --json > "$TMPDIR/intake-before-pause.json"
native=$(jq -er '.jobs[] | select(.id == "github-issue-assignment") | .nativeId' "$TMPDIR/intake-before-pause.json")
openclaw cron edit "$native" --disable --json | jq -e '.enabled == false'
openclaw cron edit "$native" --enable --json | jq -e '.enabled == true'
cp agent.yaml "$TMPDIR/intake-active-agent.yaml"
sed 's/  issue-assignment:/  issue-assignment:\n    paused: true/' "$TMPDIR/intake-active-agent.yaml" > agent.yaml
openclaw agent-system install --yes --json | jq -e 'all(.outcomes[]; .code != "session-dispatch-enrolled")'
openclaw agent-system automations list --json | jq -e --arg id "$native" 'any(.jobs[]; .id == "github-issue-assignment" and .nativeId == $id and .nativeEnabled == false)'
openclaw config get channels.agent-system-github --json | jq -e '.accounts["intake-tanaabot"].enabled == true'
cp "$TMPDIR/intake-active-agent.yaml" agent.yaml
openclaw agent-system install --yes --json | jq -e 'all(.outcomes[]; .code != "session-dispatch-enrolled")'
openclaw agent-system automations list --json | jq -e --arg id "$native" 'any(.jobs[]; .id == "github-issue-assignment" and .nativeId == $id and .nativeEnabled == true)'
jq -S '[.jobs[] | {id, nativeId, routing}]' "$TMPDIR/intake-before-pause.json" > "$TMPDIR/intake-identities-before.json"
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id, nativeId, routing}]' | diff - "$TMPDIR/intake-identities-before.json"

# should retain an unavailable issue without blocking later assignments
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
openclaw agent-system notifications refresh --repository tanaabased/big-test-bucket --kind issue --number 2147483647 --json | jq -e '.status == "completed" and .admitted == 0'
jq -es '[.[].deferred[]?] | any(.[]; (.candidate | fromjson).number == 2147483647 and .code == "intake-github-permission")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-intake-v2/"github-intake-*.json

# should assign three disposable issues from emori to tanaabot after the safe intake baseline
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/emori"
openclaw agent-system tool gh -- api repos/tanaabased/big-test-bucket | jq '{id,node_id}' > "$TMPDIR/notification-repository.json"
for slot in 1 2 3; do
  openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System intake flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$slot" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/issue.md" | tee "$TMPDIR/notification-issue-$slot.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
  number=$(jq -er .number "$TMPDIR/notification-issue-$slot.json")
  openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'
done
cp "$TMPDIR/notification-issue-1.json" "$TMPDIR/notification-issue.json"

# should start three native assessments in one automation run before any plan completes
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
printf '\ndebug: true\n' >> agent.yaml
for slot in 1 2 3; do
  number=$(jq -er .number "$TMPDIR/notification-issue-$slot.json")
  openclaw agent-system notifications refresh --repository tanaabased/big-test-bucket --kind issue --number "$number" --json | jq -e '.status == "completed"'
done
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es '[.[].records[]] | length == 3 and ([.[].threadId] | unique | length) == 3 and all(.[]; .sessionCreation.verified == true and .assessmentTurn.status == "accepted" and .result == null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
jq -es '[.[].records[]]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-started.json"
for conversation in $(jq -r '.[].threadId' "$TMPDIR/notification-started.json"); do
  openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.parentSessionKey == "agent:intake-tanaabot:main" and .session.spawnDepth == 0 and .session.spawnedBy == null'
done

# should release all held responses together after the three native starts and retain every plan
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
for receipt in $(jq -r '.[].id' "$TMPDIR/notification-started.json"); do
  touch "$TMPDIR/notification-assessment-released-$receipt"
done
for slot in 1 2 3; do
  number=$(jq -er .number "$TMPDIR/notification-issue-$slot.json")
  assessment_run=$(jq -er --arg source "https://github.com/tanaabased/big-test-bucket/issues/$number" '.[] | select((.context | fromjson).source == $source) | .assessmentTurn.runId' "$TMPDIR/notification-started.json")
  node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$assessment_run" 300000
done
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es '[.[].records[]] | length == 3 and all(.[]; .assessmentTurn.status == "completed" and .result.outcome == "plan-ready")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json

# should present stage-specific instructions through the shared debug card from the live manifest
for conversation in $(jq -r '.[].threadId' "$TMPDIR/notification-started.json"); do
  openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json | jq -e '[.messages[] | select(.role == "assistant") | (.content | if type == "string" then . else map(.text // "") | join("") end)] | any(.[]; contains("🔬 Debug") and contains("Assessment instructions") and contains("Skill"))'
done

# should retain complete results and native bindings for all three owners
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
for slot in 1 2 3; do
  issue=$(jq -er .node_id "$TMPDIR/notification-issue-$slot.json")
  repository=$(jq -er .node_id "$TMPDIR/notification-repository.json")
  jq -es --arg issue "$issue" --arg repository "$repository" '[.[].records[] | select(.stageReceipt.binding.subjectId == $issue)] | if length == 1 then .[0] else error("one issue owner required") end | .result.outcome == "plan-ready" and (.result.fullAssessment | length > 0) and (.result.plan | length > 0) and .stageReceipt.binding.threadId == .threadId and .stageReceipt.binding.repositoryId == $repository and .stageReceipt.binding.worktree == .worktree and .stageReceipt.binding.turnId == .assessmentTurn.runId and .resultTurnId == .assessmentTurn.runId and .sessionCreation.verified == true' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
done
openclaw agent-system tool worktree -- list | tee "$TMPDIR/notification-worktrees-before.json" | jq -e 'length == 3'

# should preserve all three native owners on a repeat intake scan
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
sed 's/debug: true/debug: false/' agent.yaml > "$TMPDIR/intake-debug-off.yaml"
mv "$TMPDIR/intake-debug-off.yaml" agent.yaml
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es '[.[].records[]]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-all-after.json"
jq -e --slurp '.[0] as $before | .[1] as $after | ($after | length) == 3 and all($after[]; .assessmentTurn.status == "completed" and .result.outcome == "plan-ready") and ([$before[] | {id,intakeId,threadId,worktree,run:.assessmentTurn.runId}] | sort_by(.id)) == ([$after[] | {id,intakeId,threadId,worktree,run:.assessmentTurn.runId}] | sort_by(.id))' "$TMPDIR/notification-started.json" "$TMPDIR/notification-all-after.json"
for conversation in $(jq -r '.[].threadId' "$TMPDIR/notification-all-after.json"); do
  run_id=$(jq -er --arg key "$conversation" '.[] | select(.threadId == $key) | .assessmentTurn.runId' "$TMPDIR/notification-all-after.json")
  openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json | jq -e --arg run "$run_id" '([.messages[] | select(.role == "user" and .idempotencyKey == ($run + ":user"))] | length) == 1'
done
openclaw agent-system tool worktree -- list | jq -S 'sort_by(.path)' > "$TMPDIR/notification-worktrees-after.json"
jq -S 'sort_by(.path)' "$TMPDIR/notification-worktrees-before.json" | diff - "$TMPDIR/notification-worktrees-after.json"
openclaw gateway call sessions.list --params '{"agentId":"intake-tanaabot","limit":100}' --json | jq -e '.hasMore == false and ([.sessions[] | select(.key | startswith("agent:intake-tanaabot:dashboard:agent-system-issue-"))] | length) == 3'
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/emori"
for slot in 1 2 3; do
  if test -s "$TMPDIR/notification-issue-$slot.json"; then
    number=$(jq -er .number "$TMPDIR/notification-issue-$slot.json")
    openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
  fi
done

# should remove only this run's ssh authentication key
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
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
