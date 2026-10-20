# OpenClaw PR Delivery and Feedback Example

Assign one disposable issue, retain its plan, and use an authenticated operator follow-up to implement it and deliver a linked PR in the same chat and worktree. Implement one approved PR conversation comment in the existing implementation stage, after incorporating a disposable collaborator commit, then verify the same PR head, exact publication, and no duplicate reply after another scan. Issue-comment coverage belongs to `openclaw-issue`; installed review-thread coverage is deferred to the OpenClaw review flow.

Each manual refresh admits only this example’s issue, then asks the existing native coordinator to advance retained work. The 24-hour recurring interval keeps scheduled discovery outside the bounded CI run; the examples still run in parallel.

Strict AIMock supplies judgment and text; GitHub, native scheduling, dispatch, managed Git, and retained receipts remain real. Native tool context establishes operator identity; transcript receipts bind the exact input without requiring a duplicated owner flag in history. Operator messages use the public Gateway SDK with `operator.admin`; the enrolled dispatch device keeps `operator.read` and `operator.write`. EMORI creates the issue and posts the feedback comment. Only Tanaabot receives issue and PR assignments; EMORI has a production OpenClaw instance. CI owns the disposable workspaces, issue, PR, branch, and SSH key and cleans up only those resources.

An operator follow-up implements the retained plan and publishes its linked PR in the same turn. A second follow-up adds a commit and updates the existing PR title and body while retaining its announcement. A final follow-up recovers the saved plan and complete PR card despite uncommitted edits, before approved PR feedback is implemented. The feedback run retains its pushed repair and answer, then ends before publication; an explicit native operator input resumes only the reply. Controlled component coverage separately exercises an aborted handler. Mode changes, interrupted decisions, and clarification/resumption are covered by `openclaw-progression`.

The provider fixture delays only the registered PR’s incremental comment read beyond the installed discovery deadline. Three bounded checks must retain an empty PR read checkpoint and a named obstacle; coordinator recovery then consumes the real GitHub comment once. Detailed timing and pagination permutations remain in source tests.

This scenario retains one coordinator key. Replacement-key recovery has component coverage for assessment and implementation: the current coordinator resumes the same issue, preserves its original creation evidence, and sends no duplicate turns after restart. Native replacement verification must also confirm that the automation resolves the replacement key; do not edit private journals to simulate that result.

The strict fixture reconciles a retained PR when GitHub’s closing-issue association is delayed, with three bounded prepare/publish passes on the same delivery. It never creates a replacement PR or skips the linkage assertion.

Failed agent installation or intake activation reports allowlisted saved configuration, Gateway configuration revisions, and the running agent list. Successful steps make no extra diagnostic requests. These observations do not retry installation or change reload behavior.

A failed activation preserves its original exit status and reports the install result with registration evidence, automation state, configured reload mode, and a redacted Gateway log tail before cleanup. Later tests require successful activation; diagnostics never retry or repair setup.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-pr
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should prepare the agent with provider-verified identity pins
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot/keys" "$HOME/.ssh"
GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id > "$TMPDIR/notification-owner-node"
GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id' > "$TMPDIR/notification-actor-node"
GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id' > "$TMPDIR/notification-assignee-node"
assignee_node=$(cat "$TMPDIR/notification-assignee-node")
owner_node=$(cat "$TMPDIR/notification-owner-node")
actor_node=$(cat "$TMPDIR/notification-actor-node")
test -n "$owner_node"
test -n "$actor_node"
test -n "$assignee_node"
sed -e "s|__ASSIGNEE_NODE_ID__|$assignee_node|g" -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should start the isolated gateway with a controlled forwarding github provider
mkdir -p "$TMPDIR/pr-provider"
node --input-type=module -e 'import assert from "node:assert/strict"; import {writeFileSync} from "node:fs"; assert.equal(process.env.GITHUB_ACTIONS,"true"); writeFileSync(process.env.TMPDIR+"/pr-provider/control.json",JSON.stringify({ci:true,executable:process.argv[1],paused:false}));' "$(command -v gh)"
cp "$GITHUB_WORKSPACE/examples/openclaw-pr/provider-fixture.mjs" "$TMPDIR/pr-provider/gh"
chmod 755 "$TMPDIR/pr-provider/gh"
# preserve the fixture ahead of system gh when openclaw bootstraps its cli path
PATH="$TMPDIR/pr-provider:$PATH" OPENCLAW_PATH_BOOTSTRAPPED=1 OPENCLAW_LOG_LEVEL=info openclaw-gateway start

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
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot"
openclaw agent-system install --yes --json | tee "$TMPDIR/notification-install.json" | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and ([.warnings[] | select(.code == "github-notification-runtime-unsupported")] | length) == 1'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == true)'
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
touch "$TMPDIR/notification-activation-ready"

```

## Testing

```bash
# should assign one disposable issue from emori to tanaabot after the safe intake baseline
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/emori"
openclaw agent-system tool gh -- api repos/tanaabased/big-test-bucket | jq '{id,node_id}' > "$TMPDIR/notification-repository.json"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System pr flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-pr/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain a plan through the installed owning coordinator
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for plan-ready --refresh --timeout 600 --json | tee "$TMPDIR/notification-plan.json" | jq -e '.status == "completed" and (.observation.items | length) == 1 and .observation.items[0].workflow.phase == "plan-ready"'
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.parentSessionKey == "agent:notifications-tanaabot:main" and .session.spawnDepth == 0 and .session.spawnedBy == null'
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
jq -e --arg conversation "$conversation" --arg issue "$(jq -er .node_id "$TMPDIR/notification-issue.json")" --arg repository "$(jq -er .node_id "$TMPDIR/notification-repository.json")" '.result.outcome == "plan-ready" and (.result.fullAssessment | length > 0) and (.result.plan | length > 0) and .stageReceipt.binding.threadId == $conversation and .stageReceipt.binding.subjectId == $issue and .stageReceipt.binding.repositoryId == $repository and .stageReceipt.binding.worktree == .worktree and .stageReceipt.binding.turnId == .assessmentTurn.runId and .resultTurnId == .assessmentTurn.runId and .sessionCreation.verified == true' "$TMPDIR/notification-dispatch-before.json"
openclaw agent-system tool worktree -- list | jq -e --arg path "$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")" 'length == 1 and .[0].path == $path'

# should implement the approved plan and publish its linked pr
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-before.json")
receipt=$(jq -er .id "$TMPDIR/notification-dispatch-before.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"notifications-tanaabot",sessionId:$session,message:("Operator request for managed issue " + $receipt + ": Implement the retained plan and publish its pull request."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-publish"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-publish"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-publish" 300000
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-delivery.json"
jq -e --slurp '.[1].progression.workOwner == "issue" and .[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].result == .[1].result and .[1].progression.stage == "implementation" and .[1].progression.via == "operator" and .[1].work.caller.runId == "notification-publish" and .[1].work.result.outcome == "done" and .[1].work.delivery.reconciled == true and .[1].work.delivery.binding.sessionId == .[1].sessionCreation.sessionId and .[1].work.delivery.binding.issueId == .[1].stageReceipt.binding.subjectId' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-delivery.json"
# should derive completion from receipts without a separate delivery wakeup
jq -e '.work.deliveryTurn == null and .work.delivery.announcement.receipt.nodeId != null' "$TMPDIR/notification-delivery.json"
openclaw agent-system notifications status --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")" --json | jq -e '.items[0].workflow.phase == "complete"'

# should verify the actual pull request issue link and recipients before recovering presentation
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot"
pr=$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- pr view "$pr" --repo tanaabased/big-test-bucket --json number,state,headRefOid,assignees,closingIssuesReferences | tee "$TMPDIR/notification-pr.json" | jq -e --arg head "$(jq -er .work.delivery.binding.head "$TMPDIR/notification-delivery.json")" --argjson issue "$(jq -er .number "$TMPDIR/notification-issue.json")" '.state == "OPEN" and .headRefOid == $head and (.assignees | length) == 1 and .assignees[0].login == "tanaabot" and any(.closingIssuesReferences[]; .number == $issue)'
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/pulls/$pr/requested_reviewers" | jq -e '(.users | length) == 0 and (.teams | length) == 0'
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200,inputRunIds:["notification-publish"]}')" --json > "$TMPDIR/notification-published-history.json"
jq -e '.work.delivery.presentation == null' "$TMPDIR/notification-delivery.json"
jq -e 'any(.messages[]; .role == "user" and .__openclaw.senderIsOwner == true and .idempotencyKey == "notification-publish:user")' "$TMPDIR/notification-published-history.json"

# should publish one issue announcement with a retained receipt and verified ready state
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-announcements.json"
jq -e --slurpfile delivery "$TMPDIR/notification-delivery.json" '[.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:pull-request-handoff:")))] | length == 1 and .[0].node_id == $delivery[0].work.delivery.announcement.receipt.nodeId and (.[0].body | contains($delivery[0].work.delivery.announcement.publicText)) and (.[0].body | contains("Ready for review."))' "$TMPDIR/notification-announcements.json"

# should update the existing pr after a follow-up commit without another announcement
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-delivery.json")
receipt=$(jq -er .id "$TMPDIR/notification-delivery.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"notifications-tanaabot",sessionId:$session,message:("Operator request for managed issue " + $receipt + ": Add a follow-up commit and update the existing PR title and body."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-update"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-update"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-update" 300000
jq -es --arg id "$receipt" '[.[].records[] | select(.id == $id)] | .[0]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-updated.json"
jq -e --slurp '.[0].progression == .[1].progression and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].work.delivery.id == .[1].work.delivery.id and .[0].work.delivery.pullRequest == .[1].work.delivery.pullRequest and .[0].work.delivery.announcement == .[1].work.delivery.announcement and .[0].work.delivery.binding.head != .[1].work.delivery.binding.head and .[1].work.delivery.binding.head == .[1].work.delivery.pushedHead and .[1].work.delivery.reconciled == true and .[1].work.delivery.contentUpdate == null' "$TMPDIR/notification-delivery.json" "$TMPDIR/notification-updated.json"
pr=$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-updated.json")
openclaw agent-system tool gh -- pr view "$pr" --repo tanaabased/big-test-bucket --json number,title,body,headRefOid,closingIssuesReferences | jq -e --slurpfile delivery "$TMPDIR/notification-updated.json" --argjson issue "$(jq -er .number "$TMPDIR/notification-issue.json")" '.number == $delivery[0].work.delivery.pullRequest.pullRequestNumber and .headRefOid == $delivery[0].work.delivery.pushedHead and .title == "Document disposable notification fixture cleanup and verification" and (.body | contains("verifying the retained delivery after follow-up commits")) and any(.closingIssuesReferences[]; .number == $issue)'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-announcements.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'

# should recover the saved plan and complete card for the same pull request despite later uncommitted edits
test -f "$TMPDIR/notification-activation-ready"
worktree=$(jq -er .worktree "$TMPDIR/notification-delivery.json")
printf '%s\n' 'Uncommitted follow-up work.' >> "$worktree/README.md"
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-delivery.json")
receipt=$(jq -er .id "$TMPDIR/notification-delivery.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"notifications-tanaabot",sessionId:$session,message:("Operator request for managed issue " + $receipt + ": Show the saved plan and existing PR card again."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-retry"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-retry"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-retry" 300000
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot"
branch=$(jq -er .work.delivery.binding.branch "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- pr list --repo tanaabased/big-test-bucket --head "$branch" --state all --json number | jq -e --argjson pr "$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")" 'length == 1 and .[0].number == $pr'
jq -es --arg id "$receipt" --arg pr "$(jq -er .work.delivery.pullRequest.pullRequestNodeId "$TMPDIR/notification-delivery.json")" '[.[].records[] | select(.id == $id)] | length == 1 and .[0].work.delivery.pullRequest.pullRequestNodeId == $pr and .[0].work.delivery.reconciled == true' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
jq -es --arg id "$receipt" '[.[].records[] | select(.id == $id)] | .[0]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-recovered.json"
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200,inputRunIds:["notification-retry"]}')" --json > "$TMPDIR/notification-recovered-history.json"
jq -e --arg card "$(jq -er .work.delivery.presentation "$TMPDIR/notification-recovered.json")" 'any(.messages[]; .role == "assistant" and .__openclaw.runId == "notification-retry" and .stopReason == "stop" and ((.content | if type == "string" then . else map(.text // "") | join("") end) | contains($card))) and ($card | startswith("> ## 🔀")) and ($card | contains("originating item or review thread"))' "$TMPDIR/notification-recovered-history.json"
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e --arg session "$session_id" --arg cwd "$(jq -er .worktree "$TMPDIR/notification-delivery.json")" '.session.sessionId == $session and .session.spawnedCwd == $cwd'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-announcements.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0'

# should implement one approved pr comment in the owning issue chat
set -o pipefail
feedback_diagnostics() {
  feedback_status=$?
  if test "$feedback_status" -ne 0; then
    jq -es '[.[].records[] | {id,phase,feedbackCode:.feedback.code,discoveryPending:.feedback.discoveryPending,stalls:.feedback.discoveryStalls,checkpoints:(.feedback.discovery // {} | with_entries(.value |= {startedAt,reads:(.reads | keys)}))}]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json >&2 || true
    if test -f "$TMPDIR/pr-provider/reads.jsonl"; then
      tail -n 12 "$TMPDIR/pr-provider/reads.jsonl" >&2
    else
      echo 'the controlled pr comment read was not reached' >&2
    fi
  fi
  exit "$feedback_status"
}
trap feedback_diagnostics EXIT
test -f "$TMPDIR/notification-activation-ready"
worktree=$(jq -er .worktree "$TMPDIR/notification-delivery.json")
# remove only the uncommitted readme line created by the preceding scenario
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; const p=process.argv[1]; const text=readFileSync(p,"utf8"); const suffix="Uncommitted follow-up work.\n"; if(!text.endsWith(suffix)) throw new Error("fixture line missing"); writeFileSync(p,text.slice(0,-suffix.length));' "$worktree/README.md"
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/emori"
number=$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")
branch=$(jq -er .work.delivery.binding.branch "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- api --method PUT "repos/tanaabased/big-test-bucket/contents/collaborator-$number.txt" -f message="preserve disposable collaborator evidence" -f branch="$branch" -f content=Q29sbGFib3JhdG9yIHdvcmsuCg== > "$TMPDIR/notification-collaborator.json"
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot add a note that feedback changes stay on the original PR, check it, and push the change.' > "$TMPDIR/notification-feedback-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot"
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; const p=process.env.TMPDIR+"/pr-provider/control.json"; const control=JSON.parse(readFileSync(p,"utf8")); control.endpoint="repos/tanaabased/big-test-bucket/issues/"+process.argv[1]+"/comments"; control.paused=true; writeFileSync(p,JSON.stringify(control));' "$number"
for poll in 1 2 3; do
  PATH="$TMPDIR/pr-provider:$PATH" OPENCLAW_PATH_BOOTSTRAPPED=1 openclaw agent-system notifications refresh --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")" --json | jq -e '.status == "completed"'
done
jq -s -e 'length == 3 and all(.[]; .paused and .operation == "comments:1")' "$TMPDIR/pr-provider/reads.jsonl"
jq -es --arg pr "$(jq -er .work.delivery.pullRequest.pullRequestNodeId "$TMPDIR/notification-delivery.json")" 'all(.[].records[]; .feedback.discoveryPending and .feedback.code == "feedback-discovery-no-progress" and .feedback.discoveryStalls[$pr].operation == "comments:1" and (.feedback.discovery[$pr].reads | length) == 0 and (.feedback.events | length) == 0)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; const p=process.env.TMPDIR+"/pr-provider/control.json"; const control=JSON.parse(readFileSync(p,"utf8")); control.paused=false; writeFileSync(p,JSON.stringify(control));'
run_id=$(openclaw agent-system automations run github-issue-assignment --json | jq -er 'select(.status == "queued") | .runId')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" github-issue-assignment "$run_id"
jq -es '[.[].records[] | {id,phase,blocker,feedbackCode:.feedback.code,discoveryPending:.feedback.discoveryPending,events:[.feedback.events[]? | {sourceId,phase,code,policyHeld,turnStatus:.turn.status}]}]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
jq -es 'all(.[].records[]; .work.turn.status == "completed")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
feedback_run=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-feedback-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source and .turn != null)] | if length == 1 then .[0].turn.runId else error("one feedback turn required; inspect retained dispatch feedback state") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 300000
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback-retained.json"
jq -e '.feedback.events[0].phase == "responded" and .feedback.events[0].receipt == null and .feedback.events[0].work.head == .feedback.events[0].workDelivery.pushedHead' "$TMPDIR/notification-feedback-retained.json"
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-feedback-retained.json")
receipt=$(jq -er .id "$TMPDIR/notification-feedback-retained.json")
event_id=$(jq -er .feedback.events[0].id "$TMPDIR/notification-feedback-retained.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" --arg event "$event_id" '{sessionKey:$key,agentId:"notifications-tanaabot",sessionId:$session,message:("Resume the retained feedback reply only. Use operation context, id " + $receipt + ", eventId " + $event + ". Do not repeat the pushed repair."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-feedback-resume"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-feedback-resume"'
feedback_run=notification-feedback-resume
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 300000
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json | jq --arg run "$feedback_run" '. + {requestedRunId:$run}' > "$TMPDIR/notification-feedback-history.json"
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback.json"
jq -e --slurpfile before "$TMPDIR/notification-feedback-retained.json" '.feedback.events[0].ownerResumptions[0].previousTurn.runId == $before[0].feedback.events[0].turn.runId and .feedback.events[0].work == $before[0].feedback.events[0].work and .work.delivery == $before[0].work.delivery and .feedback.events[0].result.privateText == $before[0].feedback.events[0].result.privateText' "$TMPDIR/notification-feedback.json"
jq -e --slurp '.[1].progression.workOwner == .[1].feedback.events[0].id and .[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].result == .[1].result and .[0].work.result == .[1].work.result and .[0].work.delivery.pullRequest == .[1].work.delivery.pullRequest and .[0].work.delivery.announcement == .[1].work.delivery.announcement and .[0].work.delivery.pushedHead != .[1].work.delivery.pushedHead and (.[1].feedback.events | length) == 1 and all(.[1].feedback.events[]; .phase == "published" and .work.result.outcome == "done" and .work.head == .workDelivery.pushedHead and .itemType == "pull-request" and .receipt.nodeId != null and (.result.privateText | length > 0) and (.result.publicText | length > 0) and .composition.skill.path != null)' "$TMPDIR/notification-recovered.json" "$TMPDIR/notification-feedback.json"
openclaw agent-system tool gh -- pr view "$number" --repo tanaabased/big-test-bucket --json headRefOid | jq -e --arg head "$(jq -er .feedback.events[0].work.head "$TMPDIR/notification-feedback.json")" '.headRefOid == $head'
git -C "$worktree" show HEAD | grep -F 'Keep feedback changes on the original PR.'
git -C "$worktree" merge-base --is-ancestor "$(jq -er .commit.sha "$TMPDIR/notification-collaborator.json")" HEAD
git -C "$worktree" show "HEAD:collaborator-$number.txt" | grep -F 'Collaborator work.'
openclaw agent-system tool gh -- pr list --repo tanaabased/big-test-bucket --head "$(jq -er .work.delivery.binding.branch "$TMPDIR/notification-feedback.json")" --state all --json number | jq -e --argjson pr "$number" 'length == 1 and .[0].number == $pr'

# should verify the exact response and suppress another reply on a repeat scan
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot"
number=$(jq -er .feedback.events[0].number "$TMPDIR/notification-feedback.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-feedback-replies.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("feedback"); const replies=read("feedback-replies"); const history=read("feedback-history"); assert.equal(record.feedback.events.length,1); const event=record.feedback.events[0]; assert.equal(event.itemType,"pull-request"); assert.equal(JSON.parse(event.source).nodeId,read("feedback-source").node_id); assert.equal(history.requestedRunId,event.turn.runId); const found=replies.filter(c=>c.node_id===event.receipt.nodeId); assert.equal(found.length,1); assert.equal(found[0].user.login,"tanaabot"); assert.ok(found[0].body.includes(event.result.publicText)); const answer=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===event.turn.runId && m.stopReason==="stop"); assert.equal(answer.length,1); const text=typeof answer[0].content==="string"?answer[0].content:answer[0].content.map(c=>c.text??"").join(""); assert.ok(text.includes(event.result.privateText)); assert.ok(text.includes(event.result.publicText)); assert.ok(text.includes("[Reply ↗]("+found[0].html_url+") from [@tanaabot](https://github.com/tanaabot)")); assert.ok(!text.includes("Reply published")); assert.equal(replies.filter(c=>c.user.login==="tanaabot").length,1);'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es '[.[].records[]] | length == 1 and (.[0].feedback.events | length) == 1 and all(.[0].feedback.events[]; .turn.status == "completed" and .phase == "published")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-feedback-replies.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'
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
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot"
if test -s "$TMPDIR/notification-dispatch-before.json"; then
  receipt=$(jq -er .id "$TMPDIR/notification-dispatch-before.json")
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
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/emori"
if test -s "$TMPDIR/notification-issue.json"; then
  number=$(jq -er .number "$TMPDIR/notification-issue.json")
  openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
fi

# should remove only this run's ssh authentication key
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-pr/tanaabot"
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
