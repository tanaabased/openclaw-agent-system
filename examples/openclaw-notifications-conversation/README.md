# OpenClaw Notification Conversation Continuity Example

Continue one admitted issue after cosmetic chat edits, use a retained answer in a later GitHub question and an equivalent direct question, then revise the assessment through clarification and answer without changing its owner or starting implementation. Publish one later operator status update after the delivered assessment, then verify an already-current no-op.

## What Belongs Here

- Labels and categories remaining cosmetic while the same native chat and checkout continue.
- Prior private feedback supplied to later GitHub and direct questions, with source-bound publication only for GitHub feedback.
- Complete assessment history through clarification and answer; direct readback reuses the saved result and receipts without resubmission.

## What Does Not Belong Here

- Initial assignment, private/public ordering, and first-reply duplicate prevention: [issue journey](../openclaw-notifications-issue-journey/README.md).
- Live author changes: [feedback policy](../openclaw-notifications-feedback-policy/README.md). Implementation and PR feedback: [PR delivery](../openclaw-notifications-pr-journey/README.md).
- Independent direct operations on unassigned issues: [issue assessment](../openclaw-issue-assessment/README.md) and [GitHub reply](../openclaw-github-reply/README.md).

## Notes

- A real admitted issue and its initial assessment are prerequisites. Strict AIMock supplies text through the existing issue protocol; native context, routing, result history, and GitHub publication remain real.
- The paired-question check compares retained fixture answers. It proves context transport and publication boundaries, not genuine model interpretation.
- Only Tanaabot is assigned; refreshes target this job's issue and cleanup stops the Gateway before external changes.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-notifications-conversation
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should select shared installation cleanup grace
install -d -m 700 "$XDG_CONFIG_HOME/tanaab/agent-system"
cp "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/config.yaml" "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"
chmod 600 "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"

# should prepare the isolated ssh fixture and run-specific key title
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot/keys" "$HOME/.ssh"
sed -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
node --import tsx "$GITHUB_WORKSPACE/scripts/test-resources-task.ts" keys --manifest "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot/agent.yaml"

# should start the isolated gateway
OPENCLAW_LOG_LEVEL=info openclaw-gateway start

# should install emori in its fixture workspace
set -o pipefail
registration_diagnostics() {
  registration_status=$?
  if test "$registration_status" -ne 0; then
    node --import tsx "$GITHUB_WORKSPACE/scripts/registration-evidence.ts" issue-conversation-emori || true
  fi
  exit "$registration_status"
}
trap registration_diagnostics EXIT
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/emori"
openclaw agent-system install --json

# should install tanaabot and activate native intake with explicit dispatch enrollment
set -o pipefail
activation_diagnostics() {
  activation_status=$?
  if test "$activation_status" -ne 0; then
    node --import tsx "$GITHUB_WORKSPACE/scripts/registration-evidence.ts" issue-conversation-tanaabot || true
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'

# should assign one disposable issue from emori to tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/emori"
node --import tsx "$GITHUB_WORKSPACE/scripts/test-resources-task.ts" create-issue --title "Agent System notification flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --body-file "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/issue.md" --output "$TMPDIR/notification-issue.json"
jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0' "$TMPDIR/notification-issue.json"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" assign --number "$number" | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should complete the initial assessment in its native owner
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for plan-ready --refresh --timeout 600 --json | tee "$TMPDIR/notification-plan.json" | jq -e '.status == "completed" and (.observation.items | length) == 1 and .observation.items[0].workflow.phase == "plan-ready"'
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
# reconcile native completion before a later run selects feedback for this issue
reconcile_run=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$reconcile_run" 600000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"

```

## Testing

Fixture assignments and comments use the native GitHub tool; lost responses are reconciled without repeating the write. Safe reads use bounded retries.

```bash
# should keep the existing issue usable after cosmetic native chat edits
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call sessions.patch --params "$(jq -nc --arg key "$conversation" '{key:$key,label:"Renamed issue conversation",category:"Operator grouping"}')" --json > "$TMPDIR/notification-renamed.json"
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.label == "Renamed issue conversation" and .session.category == "Operator grouping"'

# should answer approved feedback in the assigned issue chat
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" comment --number "$number" --body '@tanaabot explain the retained plan.' > "$TMPDIR/notification-feedback-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
feedback_run=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-feedback-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source and .turn != null)] | if length == 1 then .[0].turn.runId else error("one feedback turn required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 600000
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json | jq --arg run "$feedback_run" '. + {requestedRunId:$run}' > "$TMPDIR/notification-feedback-history.json"
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback.json"
jq -e --slurp '.[1].retirement == null and .[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].result == .[1].result and .[0].stageReceipt == .[1].stageReceipt and .[1].work == null and (.[1].feedback.events | length) == 1 and all(.[1].feedback.events[]; .phase == "published" and .itemType == "issue" and .receipt.nodeId != null and (.result.privateText | length > 0) and (.result.publicText | length > 0) and .composition.skill.path != null)' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-feedback.json"

# should answer another github question with the earlier private explanation in context
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" comment --number "$number" --body '@tanaabot explain the retained plan again using the earlier explanation.' > "$TMPDIR/notification-followup-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
feedback_run=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-followup-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source and .turn != null)] | if length == 1 then .[0].turn.runId else error("one follow-up turn required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 600000
conversation=$(jq -er .threadId "$TMPDIR/notification-feedback.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json > "$TMPDIR/notification-followup-history.json"
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-followup.json"
jq -e --slurp '.[0] as $before | .[1] as $after | $before.id == $after.id and $before.threadId == $after.threadId and $before.worktree == $after.worktree and $before.result == $after.result and $after.progression == null and $after.work == null and ($after.feedback.events | length) == 2 and $before.feedback.events[0].result == $after.feedback.events[0].result and all($after.feedback.events[]; .phase == "published" and .work == null)' "$TMPDIR/notification-feedback.json" "$TMPDIR/notification-followup.json"
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-followup-replies.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("followup"), event=record.feedback.events[1], source=read("followup-source"), replies=read("followup-replies"); assert.equal(event.sourceId,source.node_id); const reply=replies.filter(c=>c.node_id===event.receipt.nodeId); assert.equal(reply.length,1); assert.ok(reply[0].body.includes(event.result.publicText)); const history=read("followup-history"); const text=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===event.turn.runId && m.stopReason==="stop").map(m=>typeof m.content==="string"?m.content:m.content.map(c=>c.text??"").join("")).join("\n"); assert.ok(text.includes(event.result.privateText)); assert.ok(text.includes(event.result.publicText));'

# should answer the equivalent direct question without implementation or another github reply
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-followup.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-followup.json")
receipt=$(jq -er .id "$TMPDIR/notification-followup.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"issue-conversation-tanaabot",sessionId:$session,message:("Explain retained plan for managed issue " + $receipt + ": explain the retained plan again using the earlier explanation."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-direct-question"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-direct-question"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-direct-question" 600000
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,inputRunIds:["notification-direct-question"],limit:200,maxChars:100000}')" --json > "$TMPDIR/notification-direct-history.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const event=read("followup").feedback.events[1]; const answers=read("direct-history").messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId==="notification-direct-question" && m.stopReason==="stop"); assert.equal(answers.length,1); const text=typeof answers[0].content==="string"?answers[0].content:answers[0].content.map(c=>c.text??"").join(""); assert.ok(text.includes(event.result.privateText));'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es '[.[].records[]] | length == 1 and .[0].progression == null and .[0].work == null and (.[0].feedback.events | length) == 2 and all(.[0].feedback.events[]; .phase == "published" and .turn.status == "completed")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-followup-replies.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'

# should retain ordinary clarification and the later answer in the same native owner
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-followup.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-followup.json")
receipt=$(jq -er .id "$TMPDIR/notification-followup.json")
for stage in Clarify Answer; do
  leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
  run_id="notification-ordinary-$stage"
  params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" --arg stage "$stage" --arg run "$run_id" '{sessionKey:$key,agentId:"issue-conversation-tanaabot",sessionId:$session,message:($stage + " ordinary assessment for managed issue " + $receipt + ": cleanup only after evidence capture."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:$run}')"
  node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e --arg run "$run_id" '.runId == $run'
  node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
  jq -es '[.[].records[]] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-ordinary-$stage.json"
done
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(process.env.TMPDIR + '/notification-' + name + '.json', 'utf8'));
const initial = read('dispatch-before'), question = read('ordinary-Clarify'), answer = read('ordinary-Answer');
assert.equal(question.result.outcome, 'clarification-needed');
assert.deepEqual(question.result.questions, ['Should cleanup close the issue only after evidence capture?']);
assert.equal(answer.result.outcome, 'plan-ready');
for (const record of [question, answer]) {
  assert.equal(record.threadId, initial.threadId);
  assert.equal(record.worktree, initial.worktree);
  assert.equal(record.work, undefined);
  assert.deepEqual(record.assessmentHistory[0].result, initial.result);
  assert.equal(record.stageReceipt.selection.skill.name, 'generic-assessment');
}
assert.equal(answer.assessmentHistory.length, 3);
assert.deepEqual(answer.assessmentHistory[1].result, question.result);
assert.ok(answer.result.fullAssessment.startsWith(question.result.fullAssessment));
assert.equal(answer.resultTurnId, 'notification-ordinary-Answer');
assert.equal(answer.stageReceipt.binding.turnId, answer.resultTurnId);
NODE

# should reuse a managed assessment without resubmission or changing its receipts
conversation=$(jq -er .threadId "$TMPDIR/notification-ordinary-Answer.json")
checkout=$(jq -er .worktree "$TMPDIR/notification-ordinary-Answer.json")
target=$(jq -er .html_url "$TMPDIR/notification-issue.json")
params=$(jq -nc --arg key "$conversation" --arg target "$target" --arg checkout "$checkout" '{sessionKey:$key,agentId:"issue-conversation-tanaabot",message:("Direct issue assessment target: " + $target + " checkout: " + $checkout),deliver:false,idempotencyKey:"notification-managed-assessment-read"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-managed-assessment-read"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-managed-assessment-read 600000
jq -es --slurpfile before "$TMPDIR/notification-ordinary-Answer.json" '[.[].records[]] | length == 1 and .[0].result == $before[0].result and .[0].stageReceipt == $before[0].stageReceipt and .[0].assessmentHistory == $before[0].assessmentHistory and .[0].work == null' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
```

## Status Update

This adds a status draft, a later authorized publication and an already-current
request in the same chat. These three turns prove native input, retained publication
and no-op behavior; strict AIMock supplies materiality judgment, not real reasoning.

```bash
# should retain a typed update draft without publishing or beginning work
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-conversation/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-ordinary-Answer.json")
target=$(jq -er .html_url "$TMPDIR/notification-issue.json")
params=$(jq -nc --arg key "$conversation" --arg target "$target" '{sessionKey:$key,agentId:"issue-conversation-tanaabot",message:("Operator status update target: " + $target + "\nDecision: use the shared reply approach; implementation remains unstarted. Draft this public update."),deliver:false,idempotencyKey:"notification-status-draft"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-status-draft"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-status-draft 600000
jq -es '[.[].drafts[] | select(.update != null)] | if length == 1 then .[0] else error("one status draft required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-status-draft.json"
jq -e '.publicText != null and .receipt == null and .attempted != true' "$TMPDIR/notification-status-draft.json"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-status-before.json"

# should publish the original update on a later operator turn and reconcile its receipt
id=$(jq -er .id "$TMPDIR/notification-status-draft.json")
params=$(jq -nc --arg key "$conversation" --arg id "$id" '{sessionKey:$key,agentId:"issue-conversation-tanaabot",message:("Direct reply publish draft: " + $id),deliver:false,idempotencyKey:"notification-status-publish"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-status-publish"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-status-publish 600000
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-status-comments.json"
jq -e --slurpfile before "$TMPDIR/notification-status-before.json" --slurpfile draft "$TMPDIR/notification-status-draft.json" 'length == (($before[0] | length) + 1) and ([.[] | select(.body | contains("agent-system-github-publication:status-update:"))] | length) == 1 and any(.[]; .user.login == "tanaabot" and (.body | startswith($draft[0].publicText)))' "$TMPDIR/notification-status-comments.json"
params=$(jq -nc --arg key "$conversation" '{sessionKey:$key,inputRunIds:["notification-status-publish"],limit:200,maxChars:100000}')
openclaw gateway call chat.history --params "$params" --json > "$TMPDIR/notification-status-history.json"
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(process.env.TMPDIR + '/notification-status-' + name + '.json', 'utf8'));
const draft = read('draft');
const comment = read('comments').find(value => value.body.includes('agent-system-github-publication:status-update:'));
const text = read('history').messages.filter(value => value.role === 'assistant' && value.__openclaw?.runId === 'notification-status-publish' && value.stopReason === 'stop').map(value => typeof value.content === 'string' ? value.content : value.content.map(part => part.text ?? '').join('')).join('\n');
assert.equal(comment.user.login, 'tanaabot');
assert.ok(text.includes(comment.html_url));
assert.ok(text.includes(draft.publicText));
assert.ok(text.includes('https://github.com/tanaabot'));
assert.ok(text.includes(draft.privateText));
NODE

# should return already-current without another comment or draft
params=$(jq -nc --arg key "$conversation" --arg target "$target" '{sessionKey:$key,agentId:"issue-conversation-tanaabot",message:("Check current status target: " + $target),deliver:false,idempotencyKey:"notification-status-current"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-status-current"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-status-current 600000
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-status-after.json"
jq -e --slurpfile before "$TMPDIR/notification-status-comments.json" '. == $before[0]' "$TMPDIR/notification-status-after.json"
jq -es '[.[].drafts[] | select(.update != null)] | length == 1 and .[0].receipt != null' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json
# should preserve the admitted owner, assessment, mode and checkout without implementation
jq -es --slurpfile before "$TMPDIR/notification-ordinary-Answer.json" '[.[].records[]] | length == 1 and .[0].threadId == $before[0].threadId and .[0].worktree == $before[0].worktree and .[0].result == $before[0].result and .[0].work == null' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
