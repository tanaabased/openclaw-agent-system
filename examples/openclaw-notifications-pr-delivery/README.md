# OpenClaw Notification PR Delivery and Feedback Example

Assign one issue, retain its plan, implement an approved GitHub request, and deliver one linked PR in the same native chat and worktree. Then implement one ordinary approved PR conversation comment, update that same PR, publish its reply, and verify that another scan repeats no completed effect.

## What Belongs Here

- Authorized Plan-to-Work progression without an extra decision or delivery wake-up.
- Actual pushed changes, issue linkage, configured recipients, one issue announcement, and their durable delivery receipts.
- One PR feedback change preserving the original assessment, owner, checkout, PR, and announcement, with an exact source-bound reply and duplicate prevention.

## What Does Not Belong Here

- Planning-only feedback: [issue planning](../openclaw-notifications-issue-journey/README.md). Mode transitions and implementation clarification: [progression](../openclaw-notifications-progression/README.md).
- Reviewer customization, extra operator update journeys, dirty-worktree presentation recovery, collaborator-commit reconciliation, delayed discovery, and interrupted publication.
- Inline review-thread processing or replacement-coordinator recovery; neither is established by this scenario.

## Notes

- Strict AIMock supplies judgment and text; GitHub, native scheduling, dispatch, managed Git, and receipts remain real. EMORI creates fixtures and comments; only Tanaabot receives issue or PR assignments.
- Refreshes admit only this issue. Initial feedback allows three bounded coordinator passes because assessment reconciliation can consume a pass; the exact source revision must remain queued and eligible.
- Native operator messages use the public Gateway SDK with `operator.admin`; the enrolled dispatch device retains `operator.read` and `operator.write`. Transcript receipts bind the exact input.
- Pending relocation: the current body previews a newly configured compact reviewer without requesting review, updates the PR through an extra operator commit, and recovers the saved plan/card after uncommitted edits.
- Pending relocation: PR feedback currently adds a collaborator commit, stalls its incremental comment read beyond the discovery deadline for three checks, then interrupts reply publication after the pushed repair. Explicit operator input resumes only the reply. An ordinary uninterrupted feedback baseline still needs to be separated from these recovery conditions.
- The strict fixture reconciles delayed closing-issue linkage with at most three prepare/publish passes on the same delivery; linkage must be verified without creating a replacement PR.
- This fixture retains one coordinator key. Replacement-key, aborted-handler, and detailed discovery/pagination cases have source coverage; native replacement still requires evidence that the automation resolves the new key.
- Activation failures retain their exit status and report bounded registration/configuration evidence, automation state, and a redacted Gateway log tail. Diagnostics do not retry or repair installation.
- CI owns the disposable workspaces, issue, PR, branch, and SSH key; cleanup stops the Gateway before changing those external resources.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-notifications-pr-delivery
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should prepare the agent with provider-verified identity pins
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot/keys" "$HOME/.ssh"
GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id > "$TMPDIR/notification-owner-node"
GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id' > "$TMPDIR/notification-actor-node"
GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id' > "$TMPDIR/notification-assignee-node"
assignee_node=$(cat "$TMPDIR/notification-assignee-node")
owner_node=$(cat "$TMPDIR/notification-owner-node")
actor_node=$(cat "$TMPDIR/notification-actor-node")
test -n "$owner_node"
test -n "$actor_node"
test -n "$assignee_node"
sed -e "s|__ASSIGNEE_NODE_ID__|$assignee_node|g" -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should start the isolated gateway with a controlled forwarding github provider
mkdir -p "$TMPDIR/pr-provider"
node --input-type=module -e 'import assert from "node:assert/strict"; import {writeFileSync} from "node:fs"; assert.equal(process.env.GITHUB_ACTIONS,"true"); writeFileSync(process.env.TMPDIR+"/pr-provider/control.json",JSON.stringify({ci:true,executable:process.argv[1],paused:false}));' "$(command -v gh)"
cp "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/provider-fixture.mjs" "$TMPDIR/pr-provider/gh"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
openclaw agent-system install --yes --json | tee "$TMPDIR/notification-install.json" | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and ([.warnings[] | select(.code == "github-notification-runtime-unsupported")] | length) == 1'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == true)'
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
touch "$TMPDIR/notification-activation-ready"

```

## Testing

```bash
# should create an issue as emori and assign it as tanaabot after the safe intake baseline
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/emori"
openclaw agent-system tool gh -- api repos/tanaabased/big-test-bucket | jq '{id,node_id}' > "$TMPDIR/notification-repository.json"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System pr flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain a plan through the installed owning coordinator
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
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

# should implement approved github direction without an extra decision and publish its linked pr
set -o pipefail
feedback_checkpoint() {
  jq -cs --slurpfile receipt "$TMPDIR/notification-initial-source.json" --arg source "$(jq -r '.node_id // ""' "$TMPDIR/notification-initial-source.json")" '{source:($receipt[0] | {node_id,created_at,updated_at}),checkpoints:[.[] | {discoveryCheckedAt,discoveryCycleAt,discoveryProgress,records:[.records[] | {id,phase,blocker,assessmentTurn:(.assessmentTurn | {runId,status,consumedByEventId,replyEventId}),feedback:(.feedback | {code,startedAt,scannedTime,discoveryPending,admission,watermarks,activity,discovery:((.discovery // {}) | with_entries(.value |= {since,startedAt,reads:(.reads | to_entries | map({key,hasSource:(.value | contains($source))}))})),baselineHasSource:([.baseline[][]? | fromjson | select(.nodeId == $source)] | length),events:[.events[]? | {id,sourceId,revision,phase,code,policyHeld,turn}]} )}]}]}' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json >&2
}
feedback_diagnostics() {
  feedback_status=$?
  if test "$feedback_status" -ne 0; then
    feedback_checkpoint || true
  fi
  exit "$feedback_status"
}
trap feedback_diagnostics EXIT
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot Please implement the agreed plan and publish its pull request.' > "$TMPDIR/notification-initial-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
feedback_checkpoint
feedback_run=
for attempt in 1 2 3; do
  run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
  node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
  feedback_checkpoint
  feedback_run=$(jq -rs --slurpfile source "$TMPDIR/notification-initial-source.json" '[.[].records[].feedback.events[]? | select(.sourceId == $source[0].node_id and (.source | fromjson).updatedAt == $source[0].updated_at)] | if length == 1 then .[0].turn.runId // empty else error("one exact initial feedback revision required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
  if test -n "$feedback_run"; then
    break
  fi
  jq -es --slurpfile source "$TMPDIR/notification-initial-source.json" '[.[].records[] | select(.assessmentTurn.status == "completed" and .feedback.discoveryPending == false and .feedback.code == null and .feedback.activity.busy == false) | .feedback.events[]? | select(.sourceId == $source[0].node_id and (.source | fromjson).updatedAt == $source[0].updated_at)] | length == 1 and .[0].phase == "queued" and .[0].turn == null and .[0].code == null and .[0].policyHeld == null' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
done
test -n "$feedback_run"
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 300000
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-delivery.json"
jq -e --slurp '.[1].progression.workOwner == .[1].feedback.events[0].id and .[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].result == .[1].result and .[1].progression.stage == "implementation" and .[1].progression.via == "operator" and .[1].feedback.events[0].work.decision == null and .[1].feedback.events[0].work.result.outcome == "done" and .[1].feedback.events[0].phase == "published" and .[1].work.delivery.reconciled == true and .[1].work.delivery.binding.sessionId == .[1].sessionCreation.sessionId and .[1].work.delivery.binding.issueId == .[1].stageReceipt.binding.subjectId' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-delivery.json"

# should bind the initial implementation reply to its exact github source
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile saved "$TMPDIR/notification-delivery.json" --slurpfile source "$TMPDIR/notification-initial-source.json" '($saved[0].feedback.events[0]) as $event | ($event.source | fromjson).nodeId == $source[0].node_id and ([.[] | select(.node_id == $event.receipt.nodeId and .user.login == "tanaabot" and (.body | contains($event.result.publicText)))] | length) == 1'

# should derive completion from receipts without a separate delivery wakeup
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
jq -e '.work.deliveryTurn == null and .work.delivery.announcement.receipt.nodeId != null' "$TMPDIR/notification-delivery.json"
openclaw agent-system notifications status --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")" --json | jq -e '.items[0].workflow.phase == "complete"'

# should verify the actual pull request issue link and recipients before recovering presentation
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
pr=$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- pr view "$pr" --repo tanaabased/big-test-bucket --json number,state,headRefOid,assignees,closingIssuesReferences | tee "$TMPDIR/notification-pr.json" | jq -e --arg head "$(jq -er .work.delivery.binding.head "$TMPDIR/notification-delivery.json")" --argjson issue "$(jq -er .number "$TMPDIR/notification-issue.json")" '.state == "OPEN" and .headRefOid == $head and (.assignees | length) == 1 and .assignees[0].login == "tanaabot" and any(.closingIssuesReferences[]; .number == $issue)'
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/pulls/$pr/requested_reviewers" | jq -e '(.users | length) == 0 and (.teams | length) == 0'
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json > "$TMPDIR/notification-published-history.json"
jq -e '.work.delivery.presentation == null' "$TMPDIR/notification-delivery.json"
jq -e --arg run "$(jq -er .feedback.events[0].turn.runId "$TMPDIR/notification-delivery.json")" --arg text "$(jq -er .feedback.events[0].result.privateText "$TMPDIR/notification-delivery.json")" 'any(.messages[]; .role == "assistant" and .__openclaw.runId == $run and .stopReason == "stop" and ((.content | if type == "string" then . else map(.text // "") | join("") end) | contains($text)))' "$TMPDIR/notification-published-history.json"

# should publish one issue announcement with a retained receipt and verified ready state
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-announcements.json"
jq -e --slurpfile delivery "$TMPDIR/notification-delivery.json" '[.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:pull-request-handoff:")))] | length == 1 and .[0].node_id == $delivery[0].work.delivery.announcement.receipt.nodeId and (.[0].body | contains($delivery[0].work.delivery.announcement.publicText)) and (.[0].body | contains("Ready for review."))' "$TMPDIR/notification-announcements.json"

# should prepare delivery with a newly configured compact reviewer without requesting a review
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
cp agent.yaml "$TMPDIR/notification-pre-reviewer.yaml"
trap 'cp "$TMPDIR/notification-pre-reviewer.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot/agent.yaml"' EXIT
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; import {parseDocument} from "yaml"; const doc=parseDocument(readFileSync("agent.yaml","utf8")); doc.setIn(["github","issue-assignment","reviewers"],["@emoriwan"]); writeFileSync("agent.yaml",String(doc));'
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-delivery.json")
receipt=$(jq -er .id "$TMPDIR/notification-delivery.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"notifications-tanaabot",sessionId:$session,message:("Operator request for managed issue " + $receipt + ": Preview reviewer delivery without publishing."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-reviewer-preview"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-reviewer-preview"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-reviewer-preview" 300000
cp "$TMPDIR/notification-pre-reviewer.yaml" agent.yaml
trap - EXIT
pr=$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/pulls/$pr/requested_reviewers" --jq '.users' | jq -e 'length == 0'

# should update the existing pr after a follow-up commit without another announcement
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-delivery.json")
receipt=$(jq -er .id "$TMPDIR/notification-delivery.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"notifications-tanaabot",sessionId:$session,message:("Operator request for managed issue " + $receipt + ": Add a follow-up commit and update the existing PR title and body."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-update"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-update"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-update" 300000
jq -es --arg id "$receipt" '[.[].records[] | select(.id == $id)] | .[0]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-updated.json"
jq -e --slurp '.[0].progression.stage == .[1].progression.stage and .[0].progression.via == .[1].progression.via and .[0].feedback == .[1].feedback and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].work.delivery.id == .[1].work.delivery.id and .[0].work.delivery.pullRequest == .[1].work.delivery.pullRequest and .[0].work.delivery.announcement == .[1].work.delivery.announcement and .[0].work.delivery.binding.head != .[1].work.delivery.binding.head and .[1].work.delivery.binding.head == .[1].work.delivery.pushedHead and .[1].work.delivery.reconciled == true and .[1].work.delivery.contentUpdate == null' "$TMPDIR/notification-delivery.json" "$TMPDIR/notification-updated.json"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/emori"
number=$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")
branch=$(jq -er .work.delivery.binding.branch "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- api --method PUT "repos/tanaabased/big-test-bucket/contents/collaborator-$number.txt" -f message="preserve disposable collaborator evidence" -f branch="$branch" -f content=Q29sbGFib3JhdG9yIHdvcmsuCg== > "$TMPDIR/notification-collaborator.json"
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot add a note that feedback changes stay on the original PR, check it, and push the change.' > "$TMPDIR/notification-feedback-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; const p=process.env.TMPDIR+"/pr-provider/control.json"; const control=JSON.parse(readFileSync(p,"utf8")); control.endpoint="repos/tanaabased/big-test-bucket/issues/"+process.argv[1]+"/comments"; control.paused=true; writeFileSync(p,JSON.stringify(control));' "$number"
jq -s '[.[].records[] | {id, events:[.feedback.events[] | {id,sourceId}]}] | sort_by(.id)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback-before-stall.json"
for poll in 1 2 3; do
  PATH="$TMPDIR/pr-provider:$PATH" OPENCLAW_PATH_BOOTSTRAPPED=1 openclaw agent-system notifications refresh --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")" --json | jq -e '.status == "completed"'
done
jq -s -e 'length == 3 and all(.[]; .paused and .operation == "comments:1")' "$TMPDIR/pr-provider/reads.jsonl"
jq -es --arg pr "$(jq -er .work.delivery.pullRequest.pullRequestNodeId "$TMPDIR/notification-delivery.json")" --arg source "$(jq -er .node_id "$TMPDIR/notification-feedback-source.json")" 'all(.[].records[]; .feedback.discoveryPending and .feedback.code == "feedback-discovery-no-progress" and .feedback.discoveryStalls[$pr].operation == "comments:1" and (.feedback.discovery[$pr].reads | length) == 0 and all(.feedback.events[]; .sourceId != $source))' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
jq -es --slurpfile before "$TMPDIR/notification-feedback-before-stall.json" '([.[].records[] | {id, events:[.feedback.events[] | {id,sourceId}]}] | sort_by(.id)) == $before[0]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; const p=process.env.TMPDIR+"/pr-provider/control.json"; const control=JSON.parse(readFileSync(p,"utf8")); control.paused=false; writeFileSync(p,JSON.stringify(control));'
run_id=$(openclaw agent-system automations run github-issue-assignment --json | jq -er 'select(.status == "queued") | .runId')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" github-issue-assignment "$run_id"
jq -es '[.[].records[] | {id,phase,blocker,feedbackCode:.feedback.code,discoveryPending:.feedback.discoveryPending,events:[.feedback.events[]? | {sourceId,phase,code,policyHeld,turnStatus:.turn.status}]}]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
jq -es 'all(.[].records[]; .work.turn.status == "completed")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
feedback_run=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-feedback-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source and .turn != null)] | if length == 1 then .[0].turn.runId else error("one feedback turn required; inspect retained dispatch feedback state") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 300000
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback-retained.json"
jq -e '.feedback.events[1].phase == "responded" and .feedback.events[1].receipt == null and .feedback.events[1].work.head == .feedback.events[1].workDelivery.pushedHead' "$TMPDIR/notification-feedback-retained.json"
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-feedback-retained.json")
receipt=$(jq -er .id "$TMPDIR/notification-feedback-retained.json")
event_id=$(jq -er .feedback.events[1].id "$TMPDIR/notification-feedback-retained.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" --arg event "$event_id" '{sessionKey:$key,agentId:"notifications-tanaabot",sessionId:$session,message:("Resume the retained feedback reply only. Use operation context, id " + $receipt + ", eventId " + $event + ". Do not repeat the pushed repair."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-feedback-resume"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-feedback-resume"'
feedback_run=notification-feedback-resume
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 300000
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json | jq --arg run "$feedback_run" '. + {requestedRunId:$run}' > "$TMPDIR/notification-feedback-history.json"
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback.json"
jq -e --slurpfile before "$TMPDIR/notification-feedback-retained.json" '.feedback.events[1].ownerResumptions[0].previousTurn.runId == $before[0].feedback.events[1].turn.runId and .feedback.events[1].work == $before[0].feedback.events[1].work and .work.delivery == $before[0].work.delivery and .feedback.events[1].result.privateText == $before[0].feedback.events[1].result.privateText' "$TMPDIR/notification-feedback.json"
jq -e --slurp '
  (.[0].feedback.events[0]) as $before |
  (.[1].feedback.events[0]) as $after |
  if $after == ($before + {turn:($before.turn + {status:"completed",replyEventId:$after.turn.replyEventId,executionModel:$after.turn.executionModel})})
    and $after.turn.replyEventId != null and $after.turn.executionModel != null
    and $after.turn.failed != true and $after.turn.cancelled != true
  then true else error({code:"initial-feedback-receipts-changed",before:$before,after:$after} | tojson) end
' "$TMPDIR/notification-recovered.json" "$TMPDIR/notification-feedback.json"
jq -e --slurp '{
  feedbackOwner:(.[1].progression.workOwner == .[1].feedback.events[1].id),
  sameIssue:(.[0].id == .[1].id),
  sameChat:(.[0].threadId == .[1].threadId),
  sameWorktree:(.[0].worktree == .[1].worktree),
  originalAssessment:(.[0].result == .[1].result),
  originalImplementation:(.[0].work.result == .[1].work.result),
  samePullRequest:(.[0].work.delivery.pullRequest == .[1].work.delivery.pullRequest),
  sameAnnouncement:(.[0].work.delivery.announcement == .[1].work.delivery.announcement),
  changedHead:(.[0].work.delivery.pushedHead != .[1].work.delivery.pushedHead),
  exactEventCount:((.[1].feedback.events | length) == 2),
  publishedFeedback:all(.[1].feedback.events[1:][]; .phase == "published" and .work.result.outcome == "done" and .work.head == .workDelivery.pushedHead and .itemType == "pull-request" and .receipt.nodeId != null and (.result.privateText | length > 0) and (.result.publicText | length > 0) and .composition.skill.path != null)
} | to_entries | map(select(.value == false)) | if length == 0 then true else error({code:"feedback-continuity-mismatch",failed:map(.key)} | tojson) end' "$TMPDIR/notification-recovered.json" "$TMPDIR/notification-feedback.json"
openclaw agent-system tool gh -- pr view "$number" --repo tanaabased/big-test-bucket --json headRefOid | jq -e --arg head "$(jq -er .feedback.events[1].work.head "$TMPDIR/notification-feedback.json")" '.headRefOid == $head'
git -C "$worktree" show HEAD | grep -F 'Keep feedback changes on the original PR.'
git -C "$worktree" merge-base --is-ancestor "$(jq -er .commit.sha "$TMPDIR/notification-collaborator.json")" HEAD
git -C "$worktree" show "HEAD:collaborator-$number.txt" | grep -F 'Collaborator work.'
openclaw agent-system tool gh -- pr list --repo tanaabased/big-test-bucket --head "$(jq -er .work.delivery.binding.branch "$TMPDIR/notification-feedback.json")" --state all --json number | jq -e --argjson pr "$number" 'length == 1 and .[0].number == $pr'

# should verify the exact response and suppress another reply on a repeat scan
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
number=$(jq -er .feedback.events[1].number "$TMPDIR/notification-feedback.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-feedback-replies.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("feedback"); const replies=read("feedback-replies"); const history=read("feedback-history"); assert.equal(record.feedback.events.length,2); const event=record.feedback.events[1]; assert.equal(event.itemType,"pull-request"); assert.equal(JSON.parse(event.source).nodeId,read("feedback-source").node_id); assert.equal(history.requestedRunId,event.turn.runId); const found=replies.filter(c=>c.node_id===event.receipt.nodeId); assert.equal(found.length,1); assert.equal(found[0].user.login,"tanaabot"); assert.ok(found[0].body.includes(event.result.publicText)); const answer=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===event.turn.runId && m.stopReason==="stop"); assert.equal(answer.length,1); const text=typeof answer[0].content==="string"?answer[0].content:answer[0].content.map(c=>c.text??"").join(""); assert.ok(text.includes(event.result.privateText)); assert.ok(text.includes(event.result.publicText)); assert.ok(text.includes("[Reply ↗]("+found[0].html_url+") from [@tanaabot](https://github.com/tanaabot)")); assert.ok(!text.includes("Reply published")); assert.equal(replies.filter(c=>c.user.login==="tanaabot").length,1);'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es '[.[].records[]] | length == 1 and (.[0].feedback.events | length) == 2 and all(.[0].feedback.events[]; .turn.status == "completed" and .phase == "published")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/emori"
if test -s "$TMPDIR/notification-issue.json"; then
  number=$(jq -er .number "$TMPDIR/notification-issue.json")
  openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
fi

# should remove only this run's ssh authentication key
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-delivery/tanaabot"
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
