# OpenClaw Notification PR Journey Example

Assign an issue, save its plan, and implement approved GitHub direction to deliver a
linked PR from the same chat and worktree. Act on a PR comment, update that PR, and
publish a reply. Verify that another scan repeats none of the completed actions.

## What Belongs Here

- Authorized Plan-to-Work progression without an extra decision or delivery wake-up.
- Pushed changes, issue linkage, configured recipients, one issue announcement, and their durable receipts.
- One uninterrupted PR feedback change preserving the assessment, owner, checkout, PR, and announcement, with exact source attribution and duplicate prevention.

## What Does Not Belong Here

- Initial-turn delivery without feedback: [default Work](../openclaw-notifications-work/README.md), [custom Work](../openclaw-notifications-work-custom/README.md), and [Auto Work](../openclaw-notifications-auto-work/README.md).
- Recipient preview and operator updates: [PR recipient preview](../openclaw-notifications-pr-recipients/README.md) and [PR operator update](../openclaw-notifications-pr-update/README.md).
- Saved plan/card readback after dirty edits: [PR presentation readback](../openclaw-notifications-pr-presentation/README.md).
- Other feedback conditions: [PR collaborator reconciliation](../openclaw-notifications-pr-collaboration/README.md), [PR discovery recovery](../openclaw-notifications-pr-discovery/README.md), [PR reply recovery](../openclaw-notifications-pr-reply-recovery/README.md).
- Mode transitions and implementation clarification: [progression](../openclaw-notifications-progression/README.md). Inline review-thread processing and replacement-coordinator recovery remain separate acceptance work.

## Notes

- Strict AIMock supplies the model text and tool choices. GitHub requests, chat execution, dispatch, managed Git, and saved results still run normally. Only Tanaabot is assigned; EMORI creates the test issues and comments.
- Each job prepares its own issue, assessment, and linked PR. The coordinator has up to three passes to verify the assessment before handling initial feedback, keeping the same source revision. Refreshes target only this issue; a 24-hour schedule avoids unrelated discovery.
- Approved GitHub comments retain their exact source, native turn, and publication receipts in the owning issue chat.
- Feedback work enters through direct implementation with a scope argument; re-entry must preserve the existing feedback owner and its publication contract.
- If the closing-issue link is delayed, the shared fixture checks the same delivery through at most three prepare/publish passes. Unknown failures and uncertain writes never create replacement PRs.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-notifications-pr-journey
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should prepare the declared identity pins and isolated ssh fixture
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot/keys" "$HOME/.ssh"
owner_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id)
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__GITHUB_REPOSITORY_ID__|$GITHUB_REPOSITORY_ID|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"

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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/emori"
openclaw agent-system install --json

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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

```bash
# should create an issue as emori and assign it as tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/emori"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT- Agent System pr flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot"
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain a plan through the installed owning coordinator
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for plan-ready --refresh --timeout 600 --json | tee "$TMPDIR/notification-plan.json" | jq -e '.status == "completed" and (.observation.items | length) == 1 and .observation.items[0].workflow.phase == "plan-ready"'
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"

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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot Please implement the agreed plan and publish its pull request.' > "$TMPDIR/notification-initial-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot"
feedback_checkpoint
feedback_run=
for attempt in 1 2 3; do
  run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
  node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
  feedback_checkpoint
  feedback_run=$(jq -rs --slurpfile source "$TMPDIR/notification-initial-source.json" '[.[].records[].feedback.events[]? | select(.sourceId == $source[0].node_id and (.source | fromjson).updatedAt == $source[0].updated_at)] | if length == 1 then .[0].turn.runId // empty else error("one exact initial feedback revision required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
  if test -n "$feedback_run"; then
    break
  fi
  jq -es --slurpfile source "$TMPDIR/notification-initial-source.json" '[.[].records[] | select(.assessmentTurn.status == "completed" and .feedback.discoveryPending == false and .feedback.code == null and .feedback.activity.busy == false) | .feedback.events[]? | select(.sourceId == $source[0].node_id and (.source | fromjson).updatedAt == $source[0].updated_at)] | length == 1 and .[0].phase == "queued" and .[0].turn == null and .[0].code == null and .[0].policyHeld == null' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
done
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 600000
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-delivery.json"
jq -e --slurp '.[1].progression.workOwner == .[1].feedback.events[0].id and .[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].result == .[1].result and .[1].progression.stage == "implementation" and .[1].progression.via == "operator" and .[1].feedback.events[0].work.decision == null and .[1].feedback.events[0].work.result.outcome == "done" and .[1].feedback.events[0].phase == "published" and .[1].work.delivery.reconciled == true and .[1].work.delivery.binding.sessionId == .[1].sessionCreation.sessionId and .[1].work.delivery.binding.issueId == .[1].stageReceipt.binding.subjectId' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-delivery.json"

# should bind the initial implementation reply to its exact github source
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile saved "$TMPDIR/notification-delivery.json" --slurpfile source "$TMPDIR/notification-initial-source.json" '($saved[0].feedback.events[0]) as $event | ($event.source | fromjson).nodeId == $source[0].node_id and ([.[] | select(.node_id == $event.receipt.nodeId and .user.login == "tanaabot" and (.body | contains($event.result.publicText)))] | length) == 1'

# should derive completion from receipts without a separate delivery wakeup
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot"
jq -e '.work.deliveryTurn == null and .work.delivery.announcement.receipt.nodeId != null' "$TMPDIR/notification-delivery.json"
openclaw agent-system notifications status --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")" --json | jq -e '.items[0].workflow.phase == "delivered"'

# should verify the actual pull request issue link and recipients
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot"
pr=$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- pr view "$pr" --repo tanaabased/big-test-bucket --json number,state,headRefOid,assignees,closingIssuesReferences | tee "$TMPDIR/notification-pr.json" | jq -e --arg head "$(jq -er .work.delivery.binding.head "$TMPDIR/notification-delivery.json")" --argjson issue "$(jq -er .number "$TMPDIR/notification-issue.json")" '.state == "OPEN" and .headRefOid == $head and (.assignees | length) == 1 and .assignees[0].login == "tanaabot" and any(.closingIssuesReferences[]; .number == $issue)'
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/pulls/$pr/requested_reviewers" | jq -e '(.users | length) == 0 and (.teams | length) == 0'
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json > "$TMPDIR/notification-published-history.json"
jq -e '.work.delivery.presentation == null' "$TMPDIR/notification-delivery.json"
jq -e --arg run "$(jq -er .feedback.events[0].turn.runId "$TMPDIR/notification-delivery.json")" --arg text "$(jq -er .feedback.events[0].result.privateText "$TMPDIR/notification-delivery.json")" 'any(.messages[]; .role == "assistant" and .__openclaw.runId == $run and .stopReason == "stop" and ((.content | if type == "string" then . else map(.text // "") | join("") end) | contains($text)))' "$TMPDIR/notification-published-history.json"

# should publish one issue announcement with a retained receipt and verified ready state
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-announcements.json"
jq -e --slurpfile delivery "$TMPDIR/notification-delivery.json" '[.[] | select(.user.login == "tanaabot" and (.body | contains("agent-system-github-publication:pull-request-handoff:")))] | length == 1 and .[0].node_id == $delivery[0].work.delivery.announcement.receipt.nodeId and (.[0].body | contains($delivery[0].work.delivery.announcement.publicText)) and (.[0].body | contains("Ready for review."))' "$TMPDIR/notification-announcements.json"

# should implement and publish one ordinary approved pr comment in the owning issue chat
set -o pipefail
feedback_diagnostics() {
  feedback_status=$?
  if test "$feedback_status" -ne 0; then
    jq -es '[.[].records[] | {id,phase,feedbackCode:.feedback.code,discoveryPending:.feedback.discoveryPending,stalls:.feedback.discoveryStalls,checkpoints:(.feedback.discovery // {} | with_entries(.value |= {startedAt,reads:(.reads | keys)}))}]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json >&2 || true
  fi
  exit "$feedback_status"
}
trap feedback_diagnostics EXIT
worktree=$(jq -er .worktree "$TMPDIR/notification-delivery.json")
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/emori"
number=$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot add a note that feedback changes stay on the original PR, check it, and push the change.' > "$TMPDIR/notification-feedback-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es '[.[].records[] | {id,phase,blocker,feedbackCode:.feedback.code,discoveryPending:.feedback.discoveryPending,events:[.feedback.events[]? | {sourceId,phase,code,policyHeld,turnStatus:.turn.status}]}]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
feedback_run=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-feedback-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source and .turn != null)] | if length == 1 then .[0].turn.runId else error("one feedback turn required; inspect retained dispatch feedback state") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 600000
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json | jq --arg run "$feedback_run" '. + {requestedRunId:$run}' > "$TMPDIR/notification-feedback-history.json"
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback.json"
jq -e --slurp '
  (.[0].feedback.events[0]) as $before |
  (.[1].feedback.events[0]) as $after |
  if $after == ($before + {turn:($before.turn + {status:"completed",replyEventId:$after.turn.replyEventId,executionModel:$after.turn.executionModel})})
    and $after.turn.replyEventId != null and $after.turn.executionModel != null
    and $after.turn.failed != true and $after.turn.cancelled != true
  then true else error({code:"initial-feedback-receipts-changed",before:$before,after:$after} | tojson) end
' "$TMPDIR/notification-delivery.json" "$TMPDIR/notification-feedback.json"
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
} | to_entries | map(select(.value == false)) | if length == 0 then true else error({code:"feedback-continuity-mismatch",failed:map(.key)} | tojson) end' "$TMPDIR/notification-delivery.json" "$TMPDIR/notification-feedback.json"
openclaw agent-system tool gh -- pr view "$number" --repo tanaabased/big-test-bucket --json headRefOid | jq -e --arg head "$(jq -er .feedback.events[1].work.head "$TMPDIR/notification-feedback.json")" '.headRefOid == $head'
git -C "$worktree" show HEAD | grep -F 'Keep feedback changes on the original PR.'
openclaw agent-system tool gh -- pr list --repo tanaabased/big-test-bucket --head "$(jq -er .work.delivery.binding.branch "$TMPDIR/notification-feedback.json")" --state all --json number | jq -e --argjson pr "$number" 'length == 1 and .[0].number == $pr'

# should verify the exact response and suppress another reply on a repeat scan
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-journey/tanaabot"
number=$(jq -er .feedback.events[1].number "$TMPDIR/notification-feedback.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-feedback-replies.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("feedback"); const replies=read("feedback-replies"); const history=read("feedback-history"); assert.equal(record.feedback.events.length,2); const event=record.feedback.events[1]; assert.equal(event.itemType,"pull-request"); assert.equal(JSON.parse(event.source).nodeId,read("feedback-source").node_id); assert.equal(history.requestedRunId,event.turn.runId); const found=replies.filter(c=>c.node_id===event.receipt.nodeId); assert.equal(found.length,1); assert.equal(found[0].user.login,"tanaabot"); assert.ok(found[0].body.includes(event.result.publicText)); const answer=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===event.turn.runId && m.stopReason==="stop"); assert.equal(answer.length,1); const text=typeof answer[0].content==="string"?answer[0].content:answer[0].content.map(c=>c.text??"").join(""); assert.ok(text.includes(event.result.privateText)); assert.ok(text.includes(event.result.publicText)); assert.ok(text.includes("[Reply ↗]("+found[0].html_url+") from [@tanaabot](https://github.com/tanaabot)")); assert.ok(!text.includes("Reply published")); assert.equal(replies.filter(c=>c.user.login==="tanaabot").length,1);'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es '[.[].records[]] | length == 1 and (.[0].feedback.events | length) == 2 and all(.[0].feedback.events[]; .turn.status == "completed" and .phase == "published")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-feedback-replies.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
