# OpenClaw Issue Journey Example

Assign an issue and assess it in one chat and managed worktree. Publish the
plan summary and answer an approved GitHub question without starting implementation.
Verify that another scan reuses the same chat without repeating assessment or publication.

## What Belongs Here

- A single uppercase issue prefix even when the supplied description repeats repository and issue metadata.
- A complete assessment and plan in the verified native issue conversation.
- The private plan before its public summary, with private investigation excluded from publication.
- One approved issue comment shown as incoming native chat, one exact public reply card with distinct private context, and repeat-scan duplicate prevention.

## What Does Not Belong Here

- Activation and concurrent admission: [intake](../openclaw-issue-intake/README.md). Implementation and PR delivery: [PR delivery](../openclaw-pr-journey/README.md).
- Restart recovery: [assessment recovery](../openclaw-issue-assessment-recovery/README.md). Unassigned-issue feedback: [reactivation](../openclaw-issue-reactivation/README.md). Coordinator/tracking reset: [reset](../openclaw-notifications-reset/README.md). Resource reconciliation: [retirement](../openclaw-notifications-retirement/README.md).
- Live author changes: [feedback policy](../openclaw-issue-feedback-policy/README.md). Chat edits, repeated questions, clarification, and native assessment continuation: [conversation continuity](../openclaw-issue-conversation/README.md).
- Unassigned direct operations: [issue assessment](../openclaw-issue-assessment/README.md) and [GitHub reply](../openclaw-github-reply/README.md).

## Notes

- The initial assessment also exercises the no-argument context recovery tool and continues to issue inspection and publication in the same native turn. Strict model fixtures prove the installed tool path, not spontaneous model recovery.

- The fixture submits through the returned entry-specific request and validates its candidate against the returned schema; it does not infer a contract or prove model adaptation.
- Strict AIMock supplies judgment and text; GitHub, scheduling, dispatch, managed Git, and receipts remain real. The selected ordinary workspace assessment skill proves installed selection and retention, not genuine model adaptation.
- Initial assignment and feedback fixture responses read task/source lookup requests from model-only hook context. Sent messages retain their quoted user-facing cards without appended workflow instructions. The fixture proves context transport and request construction, not autonomous instruction following or native card rendering.
- The fixture's compact reviewer differs from the assigning actor and is initially uncached. This example creates no PR and requests no review.
- The default private response shows the user journey and documentation/test impact; full engineering assessment and evidence remain retained for explicit readback.
- Only Tanaabot is assigned. Refreshes target this job's issue; the 24-hour schedule avoids unrelated discovery. Cleanup stops the Gateway before closing fixtures or revoking its SSH key.
- Repository reads remain live conditional requests. An HTTP 304 reuses the verified unchanged record; profile counts still include that request. Issue state and exact comment receipts remain fresh provider observations.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-issue-journey
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should configure native openclaw cleanup grace
openclaw config set plugins.entries.agent-system.config.cleanup.graceMinutes 0 --strict-json

# should prepare the isolated ssh fixture and run-specific key title
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/tanaabot/keys" "$HOME/.ssh"
sed -e "s|__GITHUB_REPOSITORY_ID__|$GITHUB_REPOSITORY_ID|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/tanaabot/keys/id_ed25519.pub"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

```bash
# should assign one disposable issue from emori to tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/emori"
openclaw agent-system tool gh -- api repos/tanaabased/big-test-bucket | jq '{id,node_id}' > "$TMPDIR/notification-repository.json"
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" create --title "agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT- Agent System notification flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --body-file "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" assign --number "$number" | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain native bindings for the issue selected for feedback
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for worktree-ready --refresh --timeout 600 --json | tee "$TMPDIR/notification-plan.json" | jq -e '.status == "completed" and (.observation.items | length) == 1'
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e --arg number "$number" '.session.displayName == ("#" + $number + ": DOCUMENT DISPOSABLE TEST ISSUE CLEANUP") and .session.parentSessionKey == "agent:notifications-tanaabot:main" and .session.spawnDepth == 0 and .session.spawnedBy == null'
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
run_id=$(jq -er '(.nativeTurns | map(select(.role == "assessment")) | last | .turn).runId' "$TMPDIR/notification-dispatch-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
# reconcile native completion before a later run selects feedback for this issue
reconcile_run=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$reconcile_run" 600000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
jq -e '(.nativeTurns | map(select(.role == "assessment")) | last | .turn).status == "completed" and .assessment.requestedSkill == "generic-assessment"' "$TMPDIR/notification-dispatch-before.json"
jq -e '(.nativeTurns | map(select(.role == "assessment")) | last | .turn).message == null' "$TMPDIR/notification-dispatch-before.json"
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json > "$TMPDIR/notification-assessment-history.json"
jq -e --arg run "$run_id" '[.messages[] | select(.role == "assistant" and .__openclaw.runId == $run) | (.content | if type == "string" then . else map(.text // "") | join("") end)] | any(.[]; test("disposable (test )?issues"; "i") and test("close|cleanup"; "i") and test("evidence"; "i")) and all(.[]; (contains("notification-hidden-initial-fact") | not) and (contains("Documentation-only change:") | not))' "$TMPDIR/notification-assessment-history.json"
jq -e --arg conversation "$conversation" --arg source "$(jq -er .html_url "$TMPDIR/notification-issue.json")" '.threadId == $conversation and (.context | fromjson).source == $source and .sessionCreation.verified == true' "$TMPDIR/notification-dispatch-before.json"
openclaw agent-system tool worktree -- list | tee "$TMPDIR/notification-worktrees-before.json" | jq -e --arg path "$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")" 'length == 1 and any(.[]; .path == $path)'
jq -es '[.[].records[]]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-started.json"

# should show ordered native entry cards without debug instructions or private facts
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
run_id=$(jq -er '(.nativeTurns | map(select(.role == "assessment")) | last | .turn).runId' "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json > "$TMPDIR/notification-entry-history.json"
jq -e --arg run "$run_id" '([.messages[] | select(.role == "user" and .idempotencyKey == ($run + ":user"))] | if length == 1 then .[0].content | (if type == "string" then . else map(.text // "") | join("") end) | startswith("## 📥 Issue assigned\n") and (split("\n") | all(startswith(">") | not)) and (contains("Call agent_system_dispatch") | not) and (contains("Model routing") | not) and (contains("Assessment instructions") | not) and (contains("Effective settings") | not) else error("one opening user message required") end) and ([.messages[] | select(.role == "user" or .role == "assistant") | (.content | if type == "string" then . else map(.text // "") | join("") end)] | join("\n") | (contains("notification-hidden-initial-fact") | not))' "$TMPDIR/notification-entry-history.json"

# should publish one assessment summary after the private plan
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-summary-comments.json"
jq -s '[.[] | . | select(.update != null and .receipt != null)]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-summary-drafts.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("dispatch-before"); const comments=read("summary-comments"); const drafts=read("summary-drafts"); assert.equal(drafts.length,1); const summary=drafts[0];  const found=comments.filter(c=>c.node_id===summary.receipt.nodeId); assert.equal(found.length,1); assert.equal(found[0].user.login,"tanaabot"); assert.ok(found[0].body.includes(summary.publicText)); assert.ok(!found[0].body.includes("Documentation-only change:")); assert.equal(comments.filter(c=>c.user.login==="tanaabot").length,1); const history=read("entry-history"); const assistant=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===(record.nativeTurns?.find(entry=>entry.role==="assessment")?.turn).runId); const text=m=>typeof m.content==="string"?m.content:(m.content??[]).map(c=>c.text??"").join(""); const firstPrivate=assistant.findIndex(m=>/disposable (test )?issues/i.test(text(m)) && /close|cleanup/i.test(text(m)) && /evidence/i.test(text(m))); const publishedReply=assistant.findLastIndex(m=>text(m).includes(summary.publicText)); assert.ok(firstPrivate>=0 && publishedReply>firstPrivate);'

# should answer approved feedback in the assigned issue chat
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" comment --number "$number" --body '@tanaabot explain the retained plan.' > "$TMPDIR/notification-feedback-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
feedback_run=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-feedback-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source and .turn != null)] | if length == 1 then .[0].turn.runId else error("one feedback turn required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 600000
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json | jq --arg run "$feedback_run" '. + {requestedRunId:$run}' > "$TMPDIR/notification-feedback-history.json"
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback.json"
jq -e --slurp '.[1].retirement == null and .[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[1].work == null and (.[1].feedback.events | length) == 1 and all(.[1].feedback.events[]; .itemType == "issue" and .work == null)' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-feedback.json"

# should verify the exact response and suppress another reply on a repeat scan
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-journey/tanaabot"
number=$(jq -er .feedback.events[0].number "$TMPDIR/notification-feedback.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-feedback-replies.json"
jq -s '[.[] | .]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-reply-drafts.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("feedback"); const replies=read("feedback-replies"); const history=read("feedback-history"); const source=read("feedback-source"); const incoming=history.messages.filter(m=>m.role==="user").map(m=>typeof m.content==="string"?m.content:m.content.map(c=>c.text??"").join("")); assert.equal(JSON.parse(record.feedback.events[0].source).body,source.body); assert.ok(incoming.some(text=>text.includes("[@tanaabot](https://github.com/tanaabot)") && text.includes("[Comment ↗]("+source.html_url+") from [@"+source.user.login+"](https://github.com/"+source.user.login+")"))); assert.equal(record.feedback.events.length,1); const event=record.feedback.events[0]; assert.equal(event.itemType,"issue"); assert.equal(JSON.parse(event.source).nodeId,read("feedback-source").node_id); assert.equal(history.requestedRunId,event.turn.runId); const draft=read("reply-drafts").find(d=>d.feedback?.eventId===event.id); assert.ok(draft); const found=replies.filter(c=>c.node_id===draft.receipt.nodeId); assert.equal(found.length,1); assert.equal(found[0].user.login,"tanaabot"); assert.ok(found[0].body.includes(draft.publicText)); const answer=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===event.turn.runId && m.stopReason==="stop"); assert.equal(answer.length,1); const text=typeof answer[0].content==="string"?answer[0].content:answer[0].content.map(c=>c.text??"").join(""); assert.ok(text.includes(draft.privateText)); assert.ok(text.includes(draft.publicText)); assert.ok(!text.includes("[Comment ↗]")); assert.ok(!text.includes(read("feedback-source").body)); assert.equal(text.split(draft.privateText).length-1,1); assert.ok(text.includes("[Reply ↗]("+found[0].html_url+") from [@tanaabot](https://github.com/tanaabot)")); assert.ok(!text.includes("Reply published")); assert.deepEqual(replies.filter(c=>c.user.login==="tanaabot").map(c=>c.node_id).sort(), read("reply-drafts").filter(d=>d.receipt).map(d=>d.receipt.nodeId).sort());'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --arg id "$(jq -er .id "$TMPDIR/notification-feedback.json")" '[.[].records[]] | length == 1 and ([.[] | select(.id == $id)] | length == 1 and (.[0].feedback.events | length) == 1 and all(.[0].feedback.events[]; .turn.status == "consumed" and .phase == "delivered"))' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-feedback-replies.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'
jq -es '[.[].records[]]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-all-after.json"
jq -e --slurp '.[0] as $before | .[1] as $after | ($after | length) == 1 and all($after[]; (.nativeTurns | map(select(.role == "assessment")) | last | .turn).status == "completed") and ([$before[] | {id,intakeId,threadId,worktree,run:(.nativeTurns | map(select(.role == "assessment")) | last | .turn).runId}] | sort_by(.id)) == ([$after[] | {id,intakeId,threadId,worktree,run:(.nativeTurns | map(select(.role == "assessment")) | last | .turn).runId}] | sort_by(.id))' "$TMPDIR/notification-started.json" "$TMPDIR/notification-all-after.json"
for conversation in $(jq -r '.[].threadId' "$TMPDIR/notification-all-after.json"); do
  run_id=$(jq -er --arg key "$conversation" '.[] | select(.threadId == $key) | (.nativeTurns | map(select(.role == "assessment")) | last | .turn).runId' "$TMPDIR/notification-all-after.json")
  openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json | jq -e --arg run "$run_id" '([.messages[] | select(.role == "user" and .idempotencyKey == ($run + ":user"))] | length) == 1'
done
openclaw agent-system tool worktree -- list | jq -S 'sort_by(.path)' > "$TMPDIR/notification-worktrees-after.json"
jq -S 'sort_by(.path)' "$TMPDIR/notification-worktrees-before.json" | diff - "$TMPDIR/notification-worktrees-after.json"
openclaw gateway call sessions.list --params '{"agentId":"notifications-tanaabot","limit":100}' --json | jq -e '.hasMore == false and ([.sessions[] | select(.key | startswith("agent:notifications-tanaabot:dashboard:agent-system-issue-"))] | length) == 1'
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
