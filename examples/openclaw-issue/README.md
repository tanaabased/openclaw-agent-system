# OpenClaw Issue Planning and Feedback Example

Assign one disposable issue, retain a plan in its native chat and managed worktree, then answer one approved issue comment in that same chat. Repeat scans preserve the original assessment and suppress duplicate conversations and replies. Implementation and PR delivery belong to `openclaw-pr`.

Each manual refresh admits only this example’s issue, then asks the existing native coordinator to advance retained work. The 24-hour recurring interval keeps scheduled discovery outside the bounded CI run; the examples still run in parallel.

Strict AIMock supplies judgment and text; GitHub, native scheduling, dispatch, managed Git, and retained receipts remain real. EMORI creates and assigns the issue to Tanaabot. Only Tanaabot receives test assignments; EMORI has a production OpenClaw instance. Both workspaces and the enrolled SSH key are disposable CI fixtures. Review-request warnings remain independent of supported planning and feedback.

A failed activation preserves its original exit status and reports the install result, configured and Gateway-visible agent registration, and automation state before cleanup. Later tests require successful activation; diagnostics never retry or repair setup.

Native history checks cover entry cards with debug off and retained instruction cards with debug on after restart. Strict AIMock requires hidden initial context and fresh explicit context on the later turn; visible messages must omit those facts.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-issue
openclaw config set skills.workshop.autonomous.mode off

# should prepare the agent with provider-verified identity pins
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot/keys" "$HOME/.ssh"
GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id > "$TMPDIR/notification-owner-node"
GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id' > "$TMPDIR/notification-actor-node"
owner_node=$(cat "$TMPDIR/notification-owner-node")
actor_node=$(cat "$TMPDIR/notification-actor-node")
test -n "$owner_node"
test -n "$actor_node"
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should boot with retained legacy channel configuration
openclaw config set channels.agent-system-github '{"accounts":{"retired-agent":{"enabled":false}}}' --strict-json
openclaw config set plugins.entries.agent-system.config.githubNotifications '{"maxCommentCharacters":8000}' --strict-json
openclaw-gateway start
openclaw config get channels.agent-system-github --json | jq -e '.accounts["retired-agent"].enabled == false'

# should activate native intake with explicit dispatch enrollment
set -o pipefail
activation_diagnostics() {
  activation_status=$?
  if test "$activation_status" -ne 0; then
    cat "$TMPDIR/notification-install.json" || true
    openclaw agents list --json | jq -c '{configured: any(.[]; .id == "notifications-tanaabot")}' || true
    openclaw gateway call agents.list --timeout 10000 --json | jq -c '{gateway: any(.agents[]; .id == "notifications-tanaabot")}' || true
    openclaw agent-system automations list --json || true
  fi
  exit "$activation_status"
}
trap activation_diagnostics EXIT
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/emori"
openclaw agent-system install --json | jq -e 'any(.outcomes[]; .component == "agent" and .status == "created")'
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
openclaw agent-system install --yes --json | tee "$TMPDIR/notification-install.json" | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and ([.warnings[] | select(.code == "github-notification-runtime-unsupported")] | length) == 1'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == true)'
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
touch "$TMPDIR/notification-activation-ready"

```

## Testing

```bash
# should expose the install-managed account through the native channel status interface
test -f "$TMPDIR/notification-activation-ready"
openclaw gateway call channels.status --json | jq -e '.channelAccounts["agent-system-github"] | any(.accountId == "notifications-tanaabot" and .enabled == true and .configured == true and .mode == "readiness" and .statusState == "degraded" and .lifecycle == "ready" and .running == true and (.lastError | contains("review requests")))'
openclaw config get channels.agent-system-github --json | jq -e '.accounts["retired-agent"].enabled == false and .accounts["notifications-tanaabot"].enabled == true'

# should assign one disposable issue from emori to tanaabot after the safe intake baseline
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/emori"
openclaw agent-system tool gh -- api repos/tanaabased/big-test-bucket | jq '{id,node_id}' > "$TMPDIR/notification-repository.json"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System issue flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-issue/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain a plan through the installed owning coordinator
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for plan-ready --refresh --timeout 600 --json | tee "$TMPDIR/notification-plan.json" | jq -e '.status == "completed" and (.observation.items | length) == 1 and .observation.items[0].workflow.phase == "plan-ready"'
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.parentSessionKey == "agent:notifications-tanaabot:main" and .session.spawnDepth == 0 and .session.spawnedBy == null'
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -e --arg conversation "$conversation" --arg issue "$(jq -er .node_id "$TMPDIR/notification-issue.json")" --arg repository "$(jq -er .node_id "$TMPDIR/notification-repository.json")" '.result.outcome == "plan-ready" and (.result.fullAssessment | length > 0) and (.result.plan | length > 0) and .stageReceipt.binding.threadId == $conversation and .stageReceipt.binding.subjectId == $issue and .stageReceipt.binding.repositoryId == $repository and .stageReceipt.binding.worktree == .worktree and .stageReceipt.binding.turnId == .assessmentTurn.runId and .resultTurnId == .assessmentTurn.runId and .sessionCreation.verified == true' "$TMPDIR/notification-dispatch-before.json"
openclaw agent-system tool worktree -- list | tee "$TMPDIR/notification-worktrees-before.json" | jq -e --arg path "$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")" 'length == 1 and .[0].path == $path'

# should show ordered native entry cards without debug instructions or private facts
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json > "$TMPDIR/notification-entry-history.json"
jq -e '[.messages[] | select(.role == "user" or .role == "assistant") | (.content | if type == "string" then . else map(.text // "") | join("") end)] | join("\n") | (index("Issue assigned") < index("Model routing")) and contains("Assessment instructions") == false and contains("notification-hidden-initial-fact") == false and contains("Effective settings")' "$TMPDIR/notification-entry-history.json"

# should preserve one conversation and assessment across another native scan
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
number=$(jq -er .number "$TMPDIR/notification-issue.json")
if output=$(openclaw agent-system notifications status --repository tanaabased/big-test-bucket --kind issue --number "$number" --json); then exit 1; fi
printf '%s\n' "$output" | tee "$TMPDIR/notification-status-after.json" | jq -e --arg conversation "$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")" '.status == "degraded" and (has("diagnosticCode") | not) and (.warnings | length) == 1 and (.items | length) == 1 and .items[0].workflow.phase == "plan-ready" and .items[0].workflow.conversation == $conversation'
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-after.json"
jq -e --slurp '.[0].id == .[1].id and .[0].intakeId == .[1].intakeId and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].assessmentTurn.runId == .[1].assessmentTurn.runId and .[0].stageReceipt == .[1].stageReceipt and .[0].result == .[1].result and .[1].assessmentTurn.status == "completed"' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-dispatch-after.json"
openclaw agent-system tool worktree -- list | jq -S 'sort_by(.path)' > "$TMPDIR/notification-worktrees-after.json"
jq -S 'sort_by(.path)' "$TMPDIR/notification-worktrees-before.json" | diff - "$TMPDIR/notification-worktrees-after.json"
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-after.json")
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-after.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json | jq -e --arg run "$run_id" --arg session "$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-after.json")" '.sessionId == $session and .sessionInfo.hasActiveRun == false and ([.messages[] | select(.role == "user" and .idempotencyKey == ($run + ":user"))] | length) == 1 and ([.messages[] | select(.role == "assistant" and .__openclaw.runId == $run and .stopReason == "stop")] | length) == 1'
openclaw gateway call sessions.list --params '{"agentId":"notifications-tanaabot","limit":100}' --json | jq -e --arg key "$conversation" --arg session "$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-after.json")" '.hasMore == false and ([.sessions[] | select(.key | startswith("agent:notifications-tanaabot:dashboard:agent-system-issue-"))] | length) == 1 and any(.sessions[]; .key == $key and .sessionId == $session)'
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0 and any(.tools[]; .name == "agent_system_git" and .callResponseCount == 1)'

# should answer one approved issue comment in the owning issue chat
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot explain the retained plan.' > "$TMPDIR/notification-feedback-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
feedback_run=$(jq -ers '[.[].records[].feedback.events[] | select(.turn != null and .turn.status != "completed")] | if length == 1 then .[0].turn.runId else error("one feedback turn required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 300000
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-after.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json | jq --arg run "$feedback_run" '. + {requestedRunId:$run}' > "$TMPDIR/notification-feedback-history.json"
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback.json"
jq -e --slurp '.[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].result == .[1].result and .[1].work == null and (.[1].feedback.events | length) == 1 and all(.[1].feedback.events[]; .phase == "published" and .itemType == "issue" and .receipt.nodeId != null and (.result.privateText | length > 0) and (.result.publicText | length > 0) and .composition.skill.path != null)' "$TMPDIR/notification-dispatch-after.json" "$TMPDIR/notification-feedback.json"

# should verify the exact response and suppress another reply on a repeat scan
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
number=$(jq -er .feedback.events[0].number "$TMPDIR/notification-feedback.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-feedback-replies.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("feedback"); const replies=read("feedback-replies"); const history=read("feedback-history"); assert.equal(record.feedback.events.length,1); const event=record.feedback.events[0]; assert.equal(event.itemType,"issue"); assert.equal(JSON.parse(event.source).nodeId,read("feedback-source").node_id); assert.equal(history.requestedRunId,event.turn.runId); const found=replies.filter(c=>c.node_id===event.receipt.nodeId); assert.equal(found.length,1); assert.equal(found[0].user.login,"tanaabot"); assert.ok(found[0].body.includes(event.result.publicText)); const answer=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===event.turn.runId && m.stopReason==="stop"); assert.equal(answer.length,1); const text=typeof answer[0].content==="string"?answer[0].content:answer[0].content.map(c=>c.text??"").join(""); assert.ok(text.includes(event.result.privateText)); assert.ok(text.includes(event.result.publicText)); assert.ok(text.includes("Reply published")); assert.equal(replies.filter(c=>c.user.login==="tanaabot").length,1);'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es '[.[].records[]] | length == 1 and (.[0].feedback.events | length) == 1 and all(.[0].feedback.events[]; .turn.status == "completed" and .phase == "published")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-feedback-replies.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0'

# should warn once for native projection drift and keep identical checks model free
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
native=$(openclaw agent-system automations list --json | jq -er '.jobs[] | select(.id == "github-issue-assignment") | .nativeId')
openclaw cron edit "$native" --thinking high --json | jq -e '.payload.thinking == "high"'
openclaw cron run "$native" --wait --wait-timeout 5m --json | jq -e '.completionStatus == "succeeded"'
jq -es 'any(.[]; .intakeReport.response | contains("automation-sync-required") and contains("Agent System Install"))' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -er .requestCount > "$TMPDIR/notification-drift-model-count"
if openclaw cron run "$native" --wait --wait-timeout 5m --json > "$TMPDIR/notification-drift-repeat.json"; then exit 1; fi
jq -e '.status == "skipped"' "$TMPDIR/notification-drift-repeat.json"
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -er .requestCount | diff - "$TMPDIR/notification-drift-model-count"

# should reconcile explicitly and show recovery in the native intake chat
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .component == "automations" and .status == "updated")'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es 'any(.[]; .intakeReport.response | contains("Intake resumed"))' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
coordinator=$(jq -er .sourceThreadId "$TMPDIR/notification-dispatch-after.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$coordinator" '{sessionKey:$key,limit:200}')" --json > "$TMPDIR/notification-intake-history.json"
jq -e '[.messages[] | select(.role == "assistant") | (.content | if type == "string" then . else map(.text // "") | join("") end)] | join("\n") | contains("automation-sync-required") and contains("Intake resumed") and contains("/chat?session=")' "$TMPDIR/notification-intake-history.json"

# should recover the same issue after restart with fresh private facts and debug instructions
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
sed -i '1a debug: true' agent.yaml
number=$(jq -er .number "$TMPDIR/notification-issue.json")
cp "$GITHUB_WORKSPACE/examples/openclaw-issue/issue.md" "$TMPDIR/notification-later-issue.md"
printf '\nModel-only verification fact: notification-hidden-later-fact.\n' >> "$TMPDIR/notification-later-issue.md"
openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -F "body=@$TMPDIR/notification-later-issue.md" | jq -e '.state == "open"'
openclaw-gateway stop --timeout 340
openclaw-gateway start
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-after.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-after.json")
receipt=$(jq -er .id "$TMPDIR/notification-dispatch-after.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"notifications-tanaabot",sessionId:$session,message:("Refresh retained assessment for managed issue " + $receipt),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-refresh-context"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-refresh-context"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-refresh-context" 300000
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200,inputRunIds:["notification-refresh-context"]}')" --json | jq -e '[.messages[] | select(.role == "user" or .role == "assistant") | (.content | if type == "string" then . else map(.text // "") | join("") end)] | join("\n") | contains("Fresh issue context verified after restart") and contains("Assessment instructions") and contains("notification-hidden-initial-fact") == false and contains("notification-hidden-later-fact") == false'
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-after.json"

```

## Cleanup

The run waits up to five minutes for terminal completion and reports every wait receipt. Cleanup first stops the isolated Gateway; external fixture cleanup requires that stop to succeed so it cannot revoke an active publication's assignment or credentials.

```bash
# should stop the isolated gateway before changing external fixture state
openclaw-gateway stop --timeout 340
touch "$TMPDIR/notification-gateway-stopped"

# should close only the disposable issue created by this run
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/emori"
if test -s "$TMPDIR/notification-issue.json"; then
  number=$(jq -er .number "$TMPDIR/notification-issue.json")
  openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
fi

# should remove only this run's ssh authentication key
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
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
