# OpenClaw Issue-to-Pull-Request End-to-End Example

Assign one disposable issue in `tanaabased/big-test-bucket`, admit it through the installed V2 automation, and retain one plan in its native issue conversation and managed worktree. Public notification commands drive and observe the flow. A repeat scan must preserve the same admission, conversation, worktree, assessment input, and result receipt.

Strict AIMock supplies routing judgment and assessment text. GitHub authorization, assignment events, native scheduling, session dispatch, managed Git execution, and result retention remain real. This tests the system's assignment-to-plan plumbing; it does not evaluate model judgment or the assessment skill's editorial quality. An authenticated operator follow-up then requests implementation and a linked PR in the same chat. The fixture supplies tool calls; only native owner/input evidence authorizes them. The two simulated operator messages use the public Gateway SDK with `operator.admin` so OpenClaw records owner authority. This scope belongs only to the CI operator connection; the enrolled dispatch device retains `operator.read` and `operator.write`.

Native history assertions cover entry cards with debug off and retained instruction cards with debug on after restart. Strict AIMock requires hidden initial context and fresh explicit context on the later turn; user/assistant presentation must omit those facts. These checks are CI-only and do not establish live-model judgment.

Feedback and review requests are deliberately enabled: their warnings must not prevent assignment-to-plan execution.

CI supplies the existing EMORI and Tanaabot tokens. EMORI creates and assigns the issue to Tanaabot; only Tanaabot enables notifications. This keeps real EMORI automation from receiving test assignments. Both checked-in agent workspaces run in place, with runtime identity pins from GitHub. Installation enrolls dispatch explicitly and registers one disposable SSH authentication key; cleanup closes only this test's issue and PR, removes its branch, and removes only that public key. Everything runs on a fresh Ubuntu runner.

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

# should boot with retained legacy channel configuration
openclaw config set channels.agent-system-github '{"accounts":{"retired-agent":{"enabled":false}}}' --strict-json
openclaw config set plugins.entries.agent-system.config.githubNotifications '{"maxCommentCharacters":8000}' --strict-json
openclaw-gateway start
openclaw config get channels.agent-system-github --json | jq -e '.accounts["retired-agent"].enabled == false'

# should activate native intake with explicit dispatch enrollment
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/emori"
openclaw agent-system install --json | jq -e 'any(.outcomes[]; .component == "agent" and .status == "created")'
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot"
openclaw agent-system install --yes --json | tee "$TMPDIR/notification-install.json" | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and ([.warnings[] | select(.code == "github-notification-runtime-unsupported")] | length) == 2'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == true)'
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

```bash
# should expose the install-managed account through the native channel status interface
openclaw gateway call channels.status --json | jq -e '.channelAccounts["agent-system-github"] | any(.accountId == "notifications-tanaabot" and .enabled == true and .configured == true and .mode == "readiness" and .statusState == "degraded" and .lifecycle == "ready" and .running == true and (.lastError | contains("feedback")) and (.lastError | contains("review requests")))'
openclaw config get channels.agent-system-github --json | jq -e '.accounts["retired-agent"].enabled == false and .accounts["notifications-tanaabot"].enabled == true'

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
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -e --arg conversation "$conversation" --arg issue "$(jq -er .node_id "$TMPDIR/notification-issue.json")" --arg repository "$(jq -er .node_id "$TMPDIR/notification-repository.json")" '.result.outcome == "plan-ready" and (.result.fullAssessment | length > 0) and (.result.plan | length > 0) and .stageReceipt.binding.threadId == $conversation and .stageReceipt.binding.subjectId == $issue and .stageReceipt.binding.repositoryId == $repository and .stageReceipt.binding.worktree == .worktree and .stageReceipt.binding.turnId == .assessmentTurn.runId and .resultTurnId == .assessmentTurn.runId and .sessionCreation.verified == true' "$TMPDIR/notification-dispatch-before.json"
openclaw agent-system tool worktree -- list | tee "$TMPDIR/notification-worktrees-before.json" | jq -e --arg path "$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")" 'length == 1 and .[0].path == $path'

# should show ordered native entry cards without debug instructions or private facts
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json > "$TMPDIR/notification-entry-history.json"
jq -e '[.messages[] | select(.role == "user" or .role == "assistant") | (.content | if type == "string" then . else map(.text // "") | join("") end)] | join("\n") | (index("Issue assigned") < index("Model routing")) and contains("Assessment instructions") == false and contains("notification-hidden-initial-fact") == false and contains("Effective settings")' "$TMPDIR/notification-entry-history.json"

# should preserve one conversation and assessment across another native scan
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts")
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" github-issue-assignment "$run_id"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
if output=$(openclaw agent-system notifications status --repository tanaabased/big-test-bucket --kind issue --number "$number" --json); then exit 1; fi
printf '%s\n' "$output" | tee "$TMPDIR/notification-status-after.json" | jq -e --arg conversation "$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")" '.status == "degraded" and (has("diagnosticCode") | not) and (.warnings | length) == 2 and (.items | length) == 1 and .items[0].workflow.phase == "plan-ready" and .items[0].workflow.conversation == $conversation'
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-after.json"
jq -e --slurp '.[0].id == .[1].id and .[0].intakeId == .[1].intakeId and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].assessmentTurn.runId == .[1].assessmentTurn.runId and .[0].stageReceipt == .[1].stageReceipt and .[0].result == .[1].result and .[1].assessmentTurn.status == "completed"' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-dispatch-after.json"
openclaw agent-system tool worktree -- list | jq -S 'sort_by(.path)' > "$TMPDIR/notification-worktrees-after.json"
jq -S 'sort_by(.path)' "$TMPDIR/notification-worktrees-before.json" | diff - "$TMPDIR/notification-worktrees-after.json"
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-after.json")
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-after.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json | jq -e --arg run "$run_id" --arg session "$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-after.json")" '.sessionId == $session and .sessionInfo.hasActiveRun == false and ([.messages[] | select(.role == "user" and .idempotencyKey == ($run + ":user"))] | length) == 1 and ([.messages[] | select(.role == "assistant" and .__openclaw.runId == $run and .stopReason == "stop")] | length) == 1'
openclaw gateway call sessions.list --params '{"agentId":"notifications-tanaabot","limit":100}' --json | jq -e --arg key "$conversation" --arg session "$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-after.json")" '.hasMore == false and ([.sessions[] | select(.key | startswith("agent:notifications-tanaabot:dashboard:agent-system-issue-"))] | length) == 1 and any(.sessions[]; .key == $key and .sessionId == $session)'
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0 and any(.tools[]; .name == "agent_system_git" and .callResponseCount == 1)'

# should warn once for native projection drift and keep identical checks model free
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot"
native=$(openclaw agent-system automations list --json | jq -er '.jobs[] | select(.id == "github-issue-assignment") | .nativeId')
openclaw cron edit "$native" --thinking high --json | jq -e '.payload.thinking == "high"'
openclaw cron run "$native" --wait --wait-timeout 5m --json | jq -e '.completionStatus == "succeeded"'
jq -es 'any(.[]; .intakeReport.response | contains("automation-sync-required") and contains("Agent System Install"))' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -er .requestCount > "$TMPDIR/notification-drift-model-count"
if openclaw cron run "$native" --wait --wait-timeout 5m --json > "$TMPDIR/notification-drift-repeat.json"; then exit 1; fi
jq -e '.status == "skipped"' "$TMPDIR/notification-drift-repeat.json"
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -er .requestCount | diff - "$TMPDIR/notification-drift-model-count"

# should reconcile explicitly show recovery once and then keep healthy checks model free
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .component == "automations" and .status == "updated")'
openclaw cron run "$native" --wait --wait-timeout 5m --json | jq -e '.completionStatus == "succeeded"'
jq -es 'any(.[]; .intakeReport.response | contains("Intake resumed"))' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
coordinator=$(jq -er .sourceThreadId "$TMPDIR/notification-dispatch-after.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$coordinator" '{sessionKey:$key,limit:200}')" --json > "$TMPDIR/notification-intake-history.json"
jq -e '[.messages[] | select(.role == "assistant") | (.content | if type == "string" then . else map(.text // "") | join("") end)] | join("\n") | contains("automation-sync-required") and contains("Intake resumed") and contains("/chat?session=")' "$TMPDIR/notification-intake-history.json"
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -er .requestCount > "$TMPDIR/notification-healthy-model-count"
if openclaw cron run "$native" --wait --wait-timeout 5m --json > "$TMPDIR/notification-quiet-repeat.json"; then exit 1; fi
jq -e '.status == "skipped"' "$TMPDIR/notification-quiet-repeat.json"
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -er .requestCount | diff - "$TMPDIR/notification-healthy-model-count"

# should recover the same issue after restart with fresh private facts and debug instructions
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot"
sed -i '1a debug: true' agent.yaml
number=$(jq -er .number "$TMPDIR/notification-issue.json")
cp "$GITHUB_WORKSPACE/examples/openclaw-notifications/issue.md" "$TMPDIR/notification-later-issue.md"
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

# should publish the requested implementation from an authenticated operator followup in the same chat
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-after.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-after.json")
receipt=$(jq -er .id "$TMPDIR/notification-dispatch-after.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"notifications-tanaabot",sessionId:$session,message:("Operator request for managed issue " + $receipt + ": Implement the retained plan and open a linked pull request."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-publish"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-publish"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-publish" 300000
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-delivery.json"
jq -e --slurp '.[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].result == .[1].result and .[1].work.implementation.runId == "notification-publish" and .[1].work.publication.runId == "notification-publish" and .[1].work.result.outcome == "done" and .[1].work.delivery.reconciled == true and .[1].work.delivery.binding.sessionId == .[1].sessionCreation.sessionId and .[1].work.delivery.binding.issueId == .[1].stageReceipt.binding.subjectId' "$TMPDIR/notification-dispatch-after.json" "$TMPDIR/notification-delivery.json"

# should verify the actual pull request issue link recipients and visible quoted card
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot"
pr=$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- pr view "$pr" --repo tanaabased/big-test-bucket --json number,state,headRefOid,assignees,closingIssuesReferences | tee "$TMPDIR/notification-pr.json" | jq -e --arg head "$(jq -er .work.delivery.binding.head "$TMPDIR/notification-delivery.json")" --argjson issue "$(jq -er .number "$TMPDIR/notification-issue.json")" '.state == "OPEN" and .headRefOid == $head and any(.assignees[]; .login == "emoriwan") and any(.closingIssuesReferences[]; .number == $issue)'
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/pulls/$pr/requested_reviewers" | jq -e 'any(.users[]; .login == "emoriwan")'
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200,inputRunIds:["notification-publish"]}')" --json > "$TMPDIR/notification-published-history.json"
jq -e --arg card "$(jq -er .work.delivery.presentation "$TMPDIR/notification-delivery.json")" 'any(.messages[]; .role == "user" and .__openclaw.senderIsOwner == true and .idempotencyKey == "notification-publish:user") and any(.messages[]; .role == "assistant" and .__openclaw.runId == "notification-publish" and .stopReason == "stop" and ((.content | if type == "string" then . else map(.text // "") | join("") end) | contains($card))) and ($card | startswith("> ## 🔀")) and ($card | contains("Comment flow") | not)' "$TMPDIR/notification-published-history.json"

# should reconcile the same pull request after another explicit operator request
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-delivery.json")
receipt=$(jq -er .id "$TMPDIR/notification-delivery.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"notifications-tanaabot",sessionId:$session,message:("Operator request for managed issue " + $receipt + ": Reconcile the existing PR and show its card again."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-retry"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-retry"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-retry" 300000
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot"
branch=$(jq -er .work.delivery.binding.branch "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- pr list --repo tanaabased/big-test-bucket --head "$branch" --state all --json number | jq -e --argjson pr "$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")" 'length == 1 and .[0].number == $pr'
jq -es --arg id "$receipt" --arg pr "$(jq -er .work.delivery.pullRequest.pullRequestNodeId "$TMPDIR/notification-delivery.json")" '[.[].records[] | select(.id == $id)] | length == 1 and .[0].work.delivery.pullRequest.pullRequestNodeId == $pr and .[0].work.delivery.reconciled == true' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0'

```

## Cleanup

The run waits up to five minutes for terminal completion and reports every wait receipt. Cleanup first stops the isolated Gateway; external fixture cleanup requires that stop to succeed so it cannot revoke an active publication's assignment or credentials.

```bash
# should stop the isolated gateway before changing external fixture state
openclaw-gateway stop --timeout 340
touch "$TMPDIR/notification-gateway-stopped"

# should close only this issue's delivery pull request and remove its disposable branch
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/tanaabot"
if test -s "$TMPDIR/notification-dispatch-after.json"; then
  receipt=$(jq -er .id "$TMPDIR/notification-dispatch-after.json")
  branch=$(jq -sr --arg id "$receipt" '[.[].records[] | select(.id == $id)] | .[0].work.delivery.binding.branch // empty' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
  if test -n "$branch"; then
    openclaw agent-system tool gh -- pr list --repo tanaabased/big-test-bucket --head "$branch" --state open --json number | jq -r 'if length <= 1 then .[].number else error("ambiguous fixture PR") end' > "$TMPDIR/notification-cleanup-pr"
    if test -s "$TMPDIR/notification-cleanup-pr"; then
      openclaw agent-system tool gh -- pr close "$(cat "$TMPDIR/notification-cleanup-pr")" --repo tanaabased/big-test-bucket
    fi
    openclaw agent-system tool gh -- api --method DELETE "repos/tanaabased/big-test-bucket/git/refs/heads/$branch"
  fi
fi

# should close only the disposable issue created by this run
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications/emori"
if test -s "$TMPDIR/notification-issue.json"; then
  number=$(jq -er .number "$TMPDIR/notification-issue.json")
  openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
fi

# should remove only this run's ssh authentication key
test -f "$TMPDIR/notification-gateway-stopped"
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
