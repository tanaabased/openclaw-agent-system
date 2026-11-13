# OpenClaw Issue Conversation Continuity Example

Assess an assigned issue, publish its concise summary after the private plan, and
use an earlier answer in queued GitHub and direct questions. Retain clarification
in the same chat without starting implementation. Publish one requested status
update, then verify that an already-current issue needs no further post.

## What Belongs Here

- Initial assignment, private/public plan ordering, and retained ownership.
- Feedback queued behind an active native turn retains its exact source; delivery settles on verified input consumption independently of the answer.
- Prior private feedback supplied to later GitHub and direct questions, with source-bound publication only for GitHub feedback.
- Native clarification and answer history without a saved assessment checkpoint.

## What Does Not Belong Here

- Live author changes: [feedback policy](../openclaw-issue-assignment-policy/README.md). Implementation and PR feedback: [PR delivery](../openclaw-pr-journey/README.md).
- Independent direct operations on unassigned issues: [issue assessment](../openclaw-issue-assessment/README.md) and [GitHub reply](../openclaw-github-reply/README.md).

## Notes

- A real admitted issue and its initial assessment are prerequisites. Strict AIMock supplies text through the existing issue protocol; native context, routing, result history, and GitHub publication remain real.
- The paired-question check compares retained fixture answers. It proves context transport and publication boundaries, not genuine model interpretation.
- Feedback context resolves the active-stage and reply skills from one request-local catalog. Component tests cover discovery reuse, fresh discovery on the next request, and scoped missing-skill failures; the existing installed feedback turns exercise consumption of both selections without another model turn solely to count reads.
- The shared fixture requires the private native turn probe before answering queued GitHub feedback, including when the accepted delivery and consuming execution have different identities. If source lookup fails, it uses the private recovery request instead of guessing a comment or restarting assessment. Component tests inject those failures; this installed scenario exercises ordinary queued-source resolution. Exact source authorization remains with the feedback context tool; the probe introduces no admission or completion gate.
- Repository preparation recovery is component-covered for fetch locks, repaired path permissions, disk failures, retained attempts, and native non-replay. Installed recovery acceptance must retain the same issue/checkout and create only one session after repair; identity or ownership conflicts remain explicit stops.
- Native context calls exercise asynchronous session lookup while final admission keeps a synchronous authority check. Reset/archive races during reads and revocation during manifest refresh belong to the dispatch tool's unit tests.
- Only Tanaabot is assigned; refreshes target this job's issue and cleanup stops the Gateway before external changes.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-issue-conversation
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should configure native openclaw cleanup grace
openclaw config set plugins.entries.agent-system.config.cleanup.graceMinutes 0 --strict-json

# should prepare the isolated ssh fixture and run-specific key title
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot/keys" "$HOME/.ssh"
sed -e "s|__GITHUB_REPOSITORY_ID__|$GITHUB_REPOSITORY_ID|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"

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
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'

# should assign one disposable issue from emori to tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/emori"
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" create --title "agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT- Agent System notification flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --body-file "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" assign --number "$number" | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should complete the initial assessment in its native owner
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for worktree-ready --refresh --timeout 600 --json | tee "$TMPDIR/notification-plan.json" | jq -e '.status == "completed" and (.observation.items | length) == 1'
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
run_id=$(jq -er '(.nativeTurns | map(select(.role == "assessment")) | last | .turn).runId' "$TMPDIR/notification-dispatch-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
# reconcile native completion before a later run selects feedback for this issue
reconcile_run=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$reconcile_run" 600000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"

# should show ordered native entry cards without debug instructions or private facts
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
run_id=$(jq -er '(.nativeTurns | map(select(.role == "assessment")) | last | .turn).runId' "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json > "$TMPDIR/notification-entry-history.json"
jq -e --arg run "$run_id" '([.messages[] | select(.role == "user" and .idempotencyKey == ($run + ":user"))] | if length == 1 then .[0].content | (if type == "string" then . else map(.text // "") | join("") end) | startswith("## 📥 Issue assigned\n") and (split("\n") | all(startswith(">") | not)) and (contains("Call agent_system_dispatch") | not) and (contains("Model routing") | not) and (contains("Assessment instructions") | not) and (contains("Effective settings") | not) else error("one opening user message required") end) and ([.messages[] | select(.role == "user" or .role == "assistant") | (.content | if type == "string" then . else map(.text // "") | join("") end)] | join("\n") | (contains("notification-hidden-initial-fact") | not))' "$TMPDIR/notification-entry-history.json"

# should publish one assessment summary after the private plan
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-summary-comments.json"
jq -s '[.[] | . | select(.update != null and .receipt != null)]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-summary-drafts.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("dispatch-before"); const comments=read("summary-comments"); const drafts=read("summary-drafts"); assert.equal(drafts.length,1); const summary=drafts[0];  const found=comments.filter(c=>c.node_id===summary.receipt.nodeId); assert.equal(found.length,1); assert.equal(found[0].user.login,"tanaabot"); assert.ok(found[0].body.includes(summary.publicText)); assert.ok(!found[0].body.includes("Documentation-only change:")); assert.equal(comments.filter(c=>c.user.login==="tanaabot").length,1); const history=read("entry-history"); const assistant=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===(record.nativeTurns?.find(entry=>entry.role==="assessment")?.turn).runId); const text=m=>typeof m.content==="string"?m.content:(m.content??[]).map(c=>c.text??"").join(""); const firstPrivate=assistant.findIndex(m=>/disposable (test )?issues/i.test(text(m)) && /close|cleanup/i.test(text(m)) && /evidence/i.test(text(m))); const publishedReply=assistant.findLastIndex(m=>text(m).includes(summary.publicText)); assert.ok(firstPrivate>=0 && publishedReply>firstPrivate);'

```

## Testing

Fixture assignments and comments use the native GitHub tool; lost responses are reconciled without repeating the write. Safe reads use bounded retries.

```bash

# should answer approved feedback in the assigned issue chat
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" comment --number "$number" --body '@tanaabot explain the retained plan.' > "$TMPDIR/notification-feedback-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
feedback_run=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-feedback-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source and .turn != null)] | if length == 1 then .[0].turn.runId else error("one feedback turn required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 600000
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json | jq --arg run "$feedback_run" '. + {requestedRunId:$run}' > "$TMPDIR/notification-feedback-history.json"
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback.json"
jq -e --slurp '.[1].retirement == null and .[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[1].work == null and (.[1].feedback.events | length) == 1 and all(.[1].feedback.events[]; .itemType == "issue" and .work == null)' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-feedback.json"

# should answer queued github feedback with the earlier private explanation in context
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-feedback.json")
openclaw gateway call chat.send --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,message:"Hold conversation queue until release",queueMode:"followup",deliver:false,idempotencyKey:"conversation-queue-hold"}')" --json | jq -e '.runId == "conversation-queue-hold"'
for attempt in $(seq 1 120); do
  if test -f "$TMPDIR/conversation-queue-ready"; then break; fi
  sleep 0.5
done
test -f "$TMPDIR/conversation-queue-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" comment --number "$number" --body '@tanaabot explain the retained plan again using the earlier explanation.' > "$TMPDIR/notification-followup-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
feedback_run=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-followup-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source and .turn != null)] | if length == 1 then .[0].turn.runId else error("one follow-up turn required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:1}')" --json | jq -e --arg run "$feedback_run" '.sessionInfo.hasActiveRun == true and any(.inputReceipts[]; .runId == $run and .state == "pending" and .queued == true)'
touch "$TMPDIR/conversation-queue-release"
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" conversation-queue-hold 600000
feedback_event=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-followup-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source)] | if length == 1 then .[0].id else error("one follow-up source required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
execution_run=''
for attempt in $(seq 1 120); do
  execution_run=$(jq -rs --arg event "$feedback_event" '[.[] | . | select(.feedback.eventId == $event) | .turnId] | unique | if length == 1 then .[0] else "" end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json)
  if test -n "$execution_run"; then break; fi
  sleep 0.5
done
if test -z "$execution_run"; then
  openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json > "$TMPDIR/notification-followup-history.json"
  jq '{sessionId, sessionInfo, inputReceipts, messages: [.messages[] | {role, idempotencyKey, native: .__openclaw}]}' "$TMPDIR/notification-followup-history.json" >&2
  exit 1
fi
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$execution_run" 600000
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json > "$TMPDIR/notification-followup-history.json"
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-followup.json"
jq -e --slurp '.[0] as $before | .[1] as $after | $before.id == $after.id and $before.threadId == $after.threadId and $before.worktree == $after.worktree and $after.progression == null and $after.work == null and ($after.feedback.events | length) == 2 and $before.feedback.events[0].result == $after.feedback.events[0].result and all($after.feedback.events[]; .work == null)' "$TMPDIR/notification-feedback.json" "$TMPDIR/notification-followup.json"
jq -e 'all(.feedback.events[]; (.turn.message | contains("contextProbe") | not))' "$TMPDIR/notification-followup.json"
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-followup-replies.json"
jq -s '[.[] | .]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-reply-drafts.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("followup"), event=record.feedback.events[1], source=read("followup-source"), replies=read("followup-replies"); assert.equal(event.sourceId,source.node_id); const draft=read("reply-drafts").find(d=>d.feedback?.eventId===event.id); assert.ok(draft); const reply=replies.filter(c=>c.node_id===draft.receipt.nodeId); const history=read("followup-history"); const diagnostic=JSON.stringify({event:{phase:event.phase,code:event.code,retry:event.retry,turn:{status:event.turn?.status,runId:event.turn?.runId,executionRunId:event.turn?.executionRunId,consumedByEventId:event.turn?.consumedByEventId,inactive:event.turn?.inactive,cancelled:event.turn?.cancelled}},responderRunId:draft.turnId,sessionId:history.sessionId,hasActiveRun:history.sessionInfo?.hasActiveRun,inputReceipts:history.inputReceipts,messages:history.messages.map(m=>({role:m.role,stopReason:m.stopReason,id:m.__openclaw?.id,runId:m.__openclaw?.runId,idempotencyKey:m.__openclaw?.idempotencyKey??m.idempotencyKey,truncated:m.__openclaw?.truncated,runTerminal:m.__openclaw?.runTerminal}))}); assert.equal(event.phase,"delivered",diagnostic); assert.equal(event.turn.status,"consumed",diagnostic); assert.equal(reply.length,1); assert.ok(draft.publicText.startsWith("@"+source.user.login+", ")); assert.ok(reply[0].body.startsWith(draft.publicText+"\n\n<!-- agent-system-github-publication:")); const text=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===draft.turnId && m.stopReason==="stop").map(m=>typeof m.content==="string"?m.content:m.content.map(c=>c.text??"").join("")).join("\n"); assert.ok(text.includes(draft.privateText)); assert.ok(text.includes(draft.publicText.replace(/^@([a-z\d-]+), /iu, "[@$1](https://github.com/$1), ")));'

# should answer the equivalent direct question without implementation or another github reply
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-followup.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-followup.json")
receipt=$(jq -er .id "$TMPDIR/notification-followup.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"issue-conversation-tanaabot",sessionId:$session,message:("Explain retained plan for managed issue " + $receipt + ": explain the retained plan again using the earlier explanation."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-direct-question"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-direct-question"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-direct-question" 600000
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,inputRunIds:["notification-direct-question"],limit:200,maxChars:100000}')" --json > "$TMPDIR/notification-direct-history.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const answers=read("direct-history").messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId==="notification-direct-question" && m.stopReason==="stop"); assert.equal(answers.length,1); const text=typeof answers[0].content==="string"?answers[0].content:answers[0].content.map(c=>c.text??"").join(""); assert.match(text,/disposable issue cleanup/iu);'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es '[.[].records[]] | length == 1 and .[0].progression == null and .[0].work == null and (.[0].feedback.events | length) == 2 and all(.[0].feedback.events[]; .phase == "delivered" and .turn.status == "consumed")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-followup-replies.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'

# should retain ordinary clarification and the later answer in the same native owner
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot"
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
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json | jq -e 'any(.messages[]; .role == "assistant" and ((.content | if type == "string" then . else map(.text // "") | join("") end) | contains("Should cleanup close the issue only after evidence capture?")))'
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(process.env.TMPDIR + '/notification-' + name + '.json', 'utf8'));
const initial = read('dispatch-before'), question = read('ordinary-Clarify'), answer = read('ordinary-Answer');
for (const record of [question, answer]) {
  assert.equal(record.threadId, initial.threadId);
  assert.equal(record.worktree, initial.worktree);
  assert.equal(record.work, undefined);
}
NODE

```

## Testing Status Update

This adds a status draft, a later authorized publication and an already-current
request in the same chat. These three turns prove native input, retained publication
and no-op behavior; strict AIMock supplies materiality judgment, not real reasoning.

```bash
# should retain a typed update draft without publishing or beginning work
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-ordinary-Answer.json")
target=$(jq -er .html_url "$TMPDIR/notification-issue.json")
params=$(jq -nc --arg key "$conversation" --arg target "$target" '{sessionKey:$key,agentId:"issue-conversation-tanaabot",message:("Operator status update target: " + $target + "\nDecision: use the shared reply approach; implementation remains unstarted. Draft this public update."),deliver:false,idempotencyKey:"notification-status-draft"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-status-draft"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-status-draft 600000
jq -es --arg target "$target" '[.[] | select(.update != null and .receipt == null and .attempted != true and (.target | fromjson | .url) == $target and .publicText == "The operator selected the shared reply approach. Implementation remains unstarted.")] | if length == 1 then .[0] else error("one pending operator update required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-status-draft.json"
jq -e '.publicText != null and .receipt == null and .attempted != true' "$TMPDIR/notification-status-draft.json"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-status-before.json"

# should publish the original update on a later operator turn and reconcile its receipt
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-ordinary-Answer.json")
target=$(jq -er .html_url "$TMPDIR/notification-issue.json")
number=$(jq -er .number "$TMPDIR/notification-issue.json")
id=$(jq -c '{target:(.target | fromjson | .url),publicText}' "$TMPDIR/notification-status-draft.json")
params=$(jq -nc --arg key "$conversation" --arg id "$id" '{sessionKey:$key,agentId:"issue-conversation-tanaabot",message:("Direct reply publish: " + $id),deliver:false,idempotencyKey:"notification-status-publish"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-status-publish"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-status-publish 600000
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-status-comments.json"
jq -e --slurpfile before "$TMPDIR/notification-status-before.json" --slurpfile draft "$TMPDIR/notification-status-draft.json" 'length == (($before[0] | length) + 1) and ([.[] | select(.body | contains("agent-system-github-publication:status-update:"))] | length) == (([$before[0][] | select(.body | contains("agent-system-github-publication:status-update:"))] | length) + 1) and any(.[]; .user.login == "tanaabot" and (.body | startswith($draft[0].publicText)))' "$TMPDIR/notification-status-comments.json"
params=$(jq -nc --arg key "$conversation" '{sessionKey:$key,inputRunIds:["notification-status-publish"],limit:200,maxChars:100000}')
openclaw gateway call chat.history --params "$params" --json > "$TMPDIR/notification-status-history.json"
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(process.env.TMPDIR + '/notification-status-' + name + '.json', 'utf8'));
const draft = read('draft');
const comment = read('comments').find(value => value.body.startsWith(draft.publicText) && value.body.includes('agent-system-github-publication:status-update:'));
const text = read('history').messages.filter(value => value.role === 'assistant' && value.__openclaw?.runId === 'notification-status-publish' && value.stopReason === 'stop').map(value => typeof value.content === 'string' ? value.content : value.content.map(part => part.text ?? '').join('')).join('\n');
assert.equal(comment.user.login, 'tanaabot');
assert.ok(text.includes(comment.html_url));
assert.ok(text.includes(draft.publicText.replace(/^@([a-z\d-]+), /iu, "[@$1](https://github.com/$1), ")));
assert.ok(text.includes('https://github.com/tanaabot'));
assert.ok(text.includes(draft.privateText));
NODE

# should return already-current without another comment or draft
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-conversation/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-ordinary-Answer.json")
target=$(jq -er .html_url "$TMPDIR/notification-issue.json")
number=$(jq -er .number "$TMPDIR/notification-issue.json")
jq -s 'sort_by(.id)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-status-drafts-before.json"
params=$(jq -nc --arg key "$conversation" --arg target "$target" '{sessionKey:$key,agentId:"issue-conversation-tanaabot",message:("Check current status target: " + $target),deliver:false,idempotencyKey:"notification-status-current"}')
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-status-current"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-status-current 600000
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-status-after.json"
jq -e --slurpfile before "$TMPDIR/notification-status-comments.json" '. == $before[0]' "$TMPDIR/notification-status-after.json"
jq -es --slurpfile draft "$TMPDIR/notification-status-draft.json" '[.[] | select(.id == $draft[0].id)] | length == 1 and .[0].receipt != null' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json
jq -es --slurpfile before "$TMPDIR/notification-status-drafts-before.json" 'sort_by(.id) == $before[0]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json
# should preserve the admitted owner, assessment, mode and checkout without implementation
jq -es --slurpfile before "$TMPDIR/notification-ordinary-Answer.json" '[.[].records[]] | length == 1 and .[0].threadId == $before[0].threadId and .[0].worktree == $before[0].worktree and .[0].work == null' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
