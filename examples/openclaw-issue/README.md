# OpenClaw Issue Planning and Feedback Example

Assign one disposable issue, retain its assessment in a native chat and managed worktree, publish the proposed-plan summary after the private plan, and answer approved comments. Compare a later GitHub question with direct input using the retained responses; neither starts implementation. Repeat scans verify the same owner and no duplicate assessment or reply.

Notification installation compatibility and concurrent admission belong to `openclaw-intake`; restart recovery, reactivation, replay-safe replies, and retirement belong to `openclaw-lifecycle`. Implementation and PR delivery belong to `openclaw-pr`; scheduler drift belongs to `openclaw-automations`.

Strict AIMock supplies judgment and text; GitHub, native scheduling, dispatch, managed Git, and receipts remain real. Scoped refreshes admit only this run’s issue, and the 24-hour schedule avoids unrelated recurring scans. Only Tanaabot receives assignments. Failed activation preserves its status and redacted diagnostics; cleanup stops the Gateway before closing fixtures or revoking the disposable key.

The assessment fixture also requests retained evidence through the bound presentation
route. Its default reply shows the user-journey review and documentation/test impact;
the full engineering assessment and investigation remain saved and readable on request.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-issue
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

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
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
openclaw agent-system install --yes --json | tee "$TMPDIR/notification-install.json" | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and ([.warnings[] | select(.code == "github-notification-runtime-unsupported")] | length) == 1'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == true)'
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
touch "$TMPDIR/notification-activation-ready"

```

## Testing

```bash
# should assign one disposable issue from emori to tanaabot after the safe intake baseline
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/emori"
openclaw agent-system tool gh -- api repos/tanaabased/big-test-bucket | jq '{id,node_id}' > "$TMPDIR/notification-repository.json"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System notification flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-issue/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain native bindings for the issue selected for feedback
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
# reconcile native completion before a later run selects feedback for this issue
reconcile_run=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$reconcile_run" 300000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
jq -e '.assessmentTurn.status == "completed" and .result.outcome == "plan-ready"' "$TMPDIR/notification-dispatch-before.json"
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json > "$TMPDIR/notification-assessment-history.json"
jq -e --arg run "$run_id" --slurpfile record "$TMPDIR/notification-dispatch-before.json" '($record[0].result.fullAssessment | type == "string" and length > 0) and ([.messages[] | select(.role == "assistant" and .__openclaw.runId == $run and .stopReason == "stop")] | if length == 1 then .[0].content | (if type == "string" then . else map(.text // "") | join("") end) | contains("Model routing") and contains($record[0].result.summary) and contains($record[0].result.reviewSummary) and (contains($record[0].result.fullAssessment) | not) and (contains($record[0].result.evidence[0].detail) | not) else error("one stopped assessment response required") end)' "$TMPDIR/notification-assessment-history.json"
jq -e --arg conversation "$conversation" --arg issue "$(jq -er .node_id "$TMPDIR/notification-issue.json")" --arg repository "$(jq -er .node_id "$TMPDIR/notification-repository.json")" '.result.outcome == "plan-ready" and (.result.fullAssessment | length > 0) and (.result.plan | length > 0) and .stageReceipt.binding.threadId == $conversation and .stageReceipt.binding.subjectId == $issue and .stageReceipt.binding.repositoryId == $repository and .stageReceipt.binding.worktree == .worktree and .stageReceipt.binding.turnId == .assessmentTurn.runId and .resultTurnId == .assessmentTurn.runId and .sessionCreation.verified == true' "$TMPDIR/notification-dispatch-before.json"
openclaw agent-system tool worktree -- list | tee "$TMPDIR/notification-worktrees-before.json" | jq -e --arg path "$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")" 'length == 1 and any(.[]; .path == $path)'
jq -es '[.[].records[]]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-started.json"

# should show ordered native entry cards without debug instructions or private facts
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json > "$TMPDIR/notification-entry-history.json"
jq -e --arg run "$run_id" '([.messages[] | select(.role == "user" and .idempotencyKey == ($run + ":user"))] | if length == 1 then .[0].content | (if type == "string" then . else map(.text // "") | join("") end) | contains("Issue assigned") and contains("Assess this issue and prepare a plan") and (contains("Model routing") | not) and (contains("Assessment instructions") | not) and (contains("Effective settings") | not) else error("one opening user message required") end) and ([.messages[] | select(.role == "user" or .role == "assistant") | (.content | if type == "string" then . else map(.text // "") | join("") end)] | join("\n") | (contains("notification-hidden-initial-fact") | not))' "$TMPDIR/notification-entry-history.json"

# should publish one assessment summary after the private plan
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-summary-comments.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("dispatch-before"); const comments=read("summary-comments"); assert.equal(record.assessmentSummaries.length,1); const summary=record.assessmentSummaries[0]; assert.equal(summary.resultDigest,record.stageReceipt.resultDigest); const found=comments.filter(c=>c.node_id===summary.receipt.nodeId); assert.equal(found.length,1); assert.equal(found[0].user.login,"tanaabot"); assert.ok(found[0].body.includes(summary.publicText)); assert.ok(!found[0].body.includes(record.result.fullAssessment)); assert.equal(comments.filter(c=>c.user.login==="tanaabot").length,1); const history=read("entry-history"); const assistant=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===record.resultTurnId); const text=m=>typeof m.content==="string"?m.content:(m.content??[]).map(c=>c.text??"").join(""); const firstPrivate=assistant.findIndex(m=>text(m).includes(record.result.reviewSummary)); const firstPublic=assistant.findIndex(m=>text(m).includes(summary.publicText)); assert.ok(firstPrivate>=0 && firstPublic>firstPrivate);'

# should keep the existing issue usable after cosmetic native chat edits
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call sessions.patch --params "$(jq -nc --arg key "$conversation" '{key:$key,label:"Renamed issue conversation",category:"Operator grouping"}')" --json > "$TMPDIR/notification-renamed.json"
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.label == "Renamed issue conversation" and .session.category == "Operator grouping"'

# should exclude a parent actor through an empty replacement author list
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
const manifest = parse(readFileSync('agent.yaml', 'utf8'));
manifest.github.notifications['issue-assignment'].feedback = { inherit: false, allowed: [] };
writeFileSync('agent.yaml', stringify(manifest));
NODE
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot this author is excluded by the replacement policy.' > "$TMPDIR/notification-excluded-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es --arg conversation "$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")" --arg source "$(jq -er .node_id "$TMPDIR/notification-excluded-source.json")" '[.[].records[] | select(.threadId == $conversation)] | length == 1 and all(.[0].feedback.events[]; .sourceId != $source)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
const manifest = parse(readFileSync('agent.yaml', 'utf8'));
delete manifest.github.notifications['issue-assignment'].feedback;
writeFileSync('agent.yaml', stringify(manifest));
NODE

# should answer approved feedback in the assigned issue chat
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot explain the retained plan.' > "$TMPDIR/notification-feedback-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
feedback_run=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-feedback-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source and .turn != null)] | if length == 1 then .[0].turn.runId else error("one feedback turn required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 300000
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json | jq --arg run "$feedback_run" '. + {requestedRunId:$run}' > "$TMPDIR/notification-feedback-history.json"
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback.json"
jq -e --slurp '.[1].retirement == null and .[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].result == .[1].result and .[0].stageReceipt == .[1].stageReceipt and .[1].work == null and (.[1].feedback.events | length) == 1 and all(.[1].feedback.events[]; .phase == "published" and .itemType == "issue" and .receipt.nodeId != null and (.result.privateText | length > 0) and (.result.publicText | length > 0) and .composition.skill.path != null)' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-feedback.json"

# should verify the exact response and suppress another reply on a repeat scan
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
number=$(jq -er .feedback.events[0].number "$TMPDIR/notification-feedback.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-feedback-replies.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("feedback"); const replies=read("feedback-replies"); const history=read("feedback-history"); assert.equal(record.feedback.events.length,1); const event=record.feedback.events[0]; assert.equal(event.itemType,"issue"); assert.equal(JSON.parse(event.source).nodeId,read("feedback-source").node_id); assert.equal(history.requestedRunId,event.turn.runId); const found=replies.filter(c=>c.node_id===event.receipt.nodeId); assert.equal(found.length,1); assert.equal(found[0].user.login,"tanaabot"); assert.ok(found[0].body.includes(event.result.publicText)); const answer=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===event.turn.runId && m.stopReason==="stop"); assert.equal(answer.length,1); const text=typeof answer[0].content==="string"?answer[0].content:answer[0].content.map(c=>c.text??"").join(""); assert.ok(text.includes(event.result.privateText)); assert.ok(text.includes(event.result.publicText)); assert.ok(text.includes("[Reply ↗]("+found[0].html_url+") from [@tanaabot](https://github.com/tanaabot)")); assert.ok(!text.includes("Reply published")); assert.deepEqual(replies.filter(c=>c.user.login==="tanaabot").map(c=>c.node_id).sort(), [...record.assessmentSummaries.map(s=>s.receipt.nodeId), event.receipt.nodeId].sort());'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es --arg id "$(jq -er .id "$TMPDIR/notification-feedback.json")" '[.[].records[]] | length == 1 and ([.[] | select(.id == $id)] | length == 1 and (.[0].feedback.events | length) == 1 and all(.[0].feedback.events[]; .turn.status == "completed" and .phase == "published"))' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-feedback-replies.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'
jq -es '[.[].records[]]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-all-after.json"
jq -e --slurp '.[0] as $before | .[1] as $after | ($after | length) == 1 and all($after[]; .assessmentTurn.status == "completed" and .result.outcome == "plan-ready") and ([$before[] | {id,intakeId,threadId,worktree,run:.assessmentTurn.runId}] | sort_by(.id)) == ([$after[] | {id,intakeId,threadId,worktree,run:.assessmentTurn.runId}] | sort_by(.id))' "$TMPDIR/notification-started.json" "$TMPDIR/notification-all-after.json"
for conversation in $(jq -r '.[].threadId' "$TMPDIR/notification-all-after.json"); do
  run_id=$(jq -er --arg key "$conversation" '.[] | select(.threadId == $key) | .assessmentTurn.runId' "$TMPDIR/notification-all-after.json")
  openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json | jq -e --arg run "$run_id" '([.messages[] | select(.role == "user" and .idempotencyKey == ($run + ":user"))] | length) == 1'
done
openclaw agent-system tool worktree -- list | jq -S 'sort_by(.path)' > "$TMPDIR/notification-worktrees-after.json"
jq -S 'sort_by(.path)' "$TMPDIR/notification-worktrees-before.json" | diff - "$TMPDIR/notification-worktrees-after.json"
openclaw gateway call sessions.list --params '{"agentId":"notifications-tanaabot","limit":100}' --json | jq -e '.hasMore == false and ([.sessions[] | select(.key | startswith("agent:notifications-tanaabot:dashboard:agent-system-issue-"))] | length) == 1'
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0'

# should answer another github question with the earlier private explanation in context
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot explain the retained plan again using the earlier explanation.' > "$TMPDIR/notification-followup-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
feedback_run=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-followup-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source and .turn != null)] | if length == 1 then .[0].turn.runId else error("one follow-up turn required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 300000
conversation=$(jq -er .threadId "$TMPDIR/notification-feedback.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json > "$TMPDIR/notification-followup-history.json"
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-followup.json"
jq -e --slurp '.[0] as $before | .[1] as $after | $before.id == $after.id and $before.threadId == $after.threadId and $before.worktree == $after.worktree and $before.result == $after.result and $after.progression == null and $after.work == null and ($after.feedback.events | length) == 2 and $before.feedback.events[0].result == $after.feedback.events[0].result and all($after.feedback.events[]; .phase == "published" and .work == null)' "$TMPDIR/notification-feedback.json" "$TMPDIR/notification-followup.json"
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-followup-replies.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("followup"), event=record.feedback.events[1], source=read("followup-source"), replies=read("followup-replies"); assert.equal(event.sourceId,source.node_id); const reply=replies.filter(c=>c.node_id===event.receipt.nodeId); assert.equal(reply.length,1); assert.ok(reply[0].body.includes(event.result.publicText)); const history=read("followup-history"); const text=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===event.turn.runId && m.stopReason==="stop").map(m=>typeof m.content==="string"?m.content:m.content.map(c=>c.text??"").join("")).join("\n"); assert.ok(text.includes(event.result.privateText)); assert.ok(text.includes(event.result.publicText));'

# should answer the equivalent direct question without implementation or another github reply
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-followup.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-followup.json")
receipt=$(jq -er .id "$TMPDIR/notification-followup.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"notifications-tanaabot",sessionId:$session,message:("Explain retained plan for managed issue " + $receipt + ": explain the retained plan again using the earlier explanation."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-direct-question"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-direct-question"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-direct-question" 300000
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,inputRunIds:["notification-direct-question"],limit:200,maxChars:100000}')" --json > "$TMPDIR/notification-direct-history.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const event=read("followup").feedback.events[1]; const answers=read("direct-history").messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId==="notification-direct-question" && m.stopReason==="stop"); assert.equal(answers.length,1); const text=typeof answers[0].content==="string"?answers[0].content:answers[0].content.map(c=>c.text??"").join(""); assert.ok(text.includes(event.result.privateText));'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es '[.[].records[]] | length == 1 and .[0].progression == null and .[0].work == null and (.[0].feedback.events | length) == 2 and all(.[0].feedback.events[]; .phase == "published" and .turn.status == "completed")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-followup-replies.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0'

```

```bash
# should draft in an ordinary chat for an unassigned issue without publishing or admitting work
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/emori"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System manual reply $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -f 'body=Disposable direct reply target; do not assign.' > "$TMPDIR/notification-manual-issue.json"
target=$(jq -er .html_url "$TMPDIR/notification-manual-issue.json")
params=$(jq -nc --arg target "$target" '{sessionKey:"agent:notifications-tanaabot:manual-reply",agentId:"notifications-tanaabot",message:("Direct reply draft target: " + $target),deliver:false,idempotencyKey:"notification-manual-draft"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-manual-draft"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-manual-draft 300000
jq -es '[.[].drafts[]] | if length == 1 then .[0] else error("one manual draft required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-manual-draft.json"
jq -e '.publicText != null and .receipt == null and .attempted != true' "$TMPDIR/notification-manual-draft.json"
number=$(jq -er .number "$TMPDIR/notification-manual-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e 'length == 0'
jq -es '[.[].records[]] | length == 1' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json

# should publish only after a later explicit request and reconcile without another post
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/emori"
draft_id=$(jq -er .id "$TMPDIR/notification-manual-draft.json")
params=$(jq -nc --arg id "$draft_id" '{sessionKey:"agent:notifications-tanaabot:manual-reply",agentId:"notifications-tanaabot",message:("Direct reply publish draft: " + $id),deliver:false,idempotencyKey:"notification-manual-publish"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-manual-publish"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-manual-publish 300000
number=$(jq -er .number "$TMPDIR/notification-manual-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-manual-comments.json"
jq -e --slurpfile draft "$TMPDIR/notification-manual-draft.json" 'length == 1 and .[0].user.login == "tanaabot" and (.[0].body | startswith($draft[0].publicText)) and (.[0].body | contains("agent-system-github-publication:manual-response:"))' "$TMPDIR/notification-manual-comments.json"
openclaw gateway call chat.history --params '{"sessionKey":"agent:notifications-tanaabot:manual-reply","inputRunIds":["notification-manual-publish"],"limit":200,"maxChars":100000}' --json > "$TMPDIR/notification-manual-history.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-manual-"+n+".json","utf8")); const comment=read("comments")[0]; const history=read("history"); const text=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId==="notification-manual-publish" && m.stopReason==="stop").map(m=>typeof m.content==="string"?m.content:m.content.map(c=>c.text??"").join("")).join("\n"); assert.ok(text.includes(comment.html_url)); assert.ok(text.includes(read("draft").publicText));'
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0'
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

# should close the separate unassigned manual reply fixture
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue/emori"
if test -s "$TMPDIR/notification-manual-issue.json"; then
  number=$(jq -er .number "$TMPDIR/notification-manual-issue.json")
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
