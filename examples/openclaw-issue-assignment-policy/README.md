# OpenClaw Issue Assignment Policy Example

Keep an unavailable assignment candidate from blocking a valid one. Have an
unapproved actor unassign the active issue and verify that its chat and checkout
remain intact with a warning. Reassign it and clear the warning without starting
a second workflow. Exclude disallowed feedback, then resume the unassigned issue
from an approved comment in its original owner.

## What Belongs Here

- Live feedback-author removal excludes comments; restoration admits a new comment into the same unassigned owner without replay.

- Unavailable-candidate retention without blocking a later valid assignment.
- Provider-verified removal actor evidence evaluated against the current manifest.
- Missing assignment reporting without retirement, archival, or loss of the retained assessment, checkout, and implementation stage.
- Verified reassignment preserving the original native owner and clearing the unresolved observation.

## What Does Not Belong Here

- Task disposal and coordinator reset: [retirement](../openclaw-notifications-retirement/README.md).

## Notes

- Issue pickup selection and uncertain-assignment recovery have controlled native-adapter coverage in `test/issue-pickup-selection.component.spec.ts`. Installed pickup activation remains [#527](https://github.com/tanaabased/openclaw-agent-system/issues/527); unattended acceptance remains [#529](https://github.com/tanaabased/openclaw-agent-system/issues/529). This scenario does not establish either outcome.

- Strict AIMock supplies the initial assessment; GitHub assignment changes and native state observations remain real.
- Two 61-second waits observe removal and reassignment through the owning lifecycle interval. The OpenClaw cleanup grace is zero; it does not bypass that interval.
- CI owns one disposable issue and its workspaces/SSH registration. Only Tanaabot is assigned. Scoped refreshes and a 24-hour schedule bound discovery; cleanup stops the Gateway before external changes.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-issue-assignment-policy
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should configure native openclaw cleanup grace
openclaw config set plugins.entries.agent-system.config.cleanup.graceMinutes 0 --strict-json

# should prepare the declared identity pins and isolated ssh fixture
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot/keys" "$HOME/.ssh"
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
receiver_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id')
sed -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__RECEIVER_NODE_ID__|$receiver_node|g" -e "s|__GITHUB_REPOSITORY_ID__|$GITHUB_REPOSITORY_ID|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"

# should boot the isolated gateway
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
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

```bash
# should retain an unavailable issue without blocking later assignments
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot"
openclaw agent-system notifications refresh --repository tanaabased/big-test-bucket --kind issue --number 2147483647 --json | jq -e '.status == "completed" and .admitted == 0'
jq -es '[.[].deferred[]?] | any(.[]; (.candidate | fromjson).number == 2147483647 and .code == "intake-github-permission")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-intake-v2/"github-intake-*.json

# should assign one disposable issue from emori to tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/emori"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT- Agent System assignment-policy flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain native bindings for the issue selected for feedback
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for worktree-ready --timeout 600 --json | tee "$TMPDIR/notification-plan.json" | jq -e '.status == "completed" and (.observation.items | length) == 1'
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
run_id=$(jq -er '(.nativeTurns | map(select(.role == "assessment")) | last | .turn).runId' "$TMPDIR/notification-dispatch-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
# reconcile native completion before a later run selects feedback for this issue
reconcile_run=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$reconcile_run" 600000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"

# should preserve admitted work when the live actor list does not authorize its removal
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot"
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; import {parse,stringify} from "yaml"; const path="agent.yaml"; const value=parse(readFileSync(path,"utf8")); writeFileSync(process.env.TMPDIR+"/notification-policy-before.yaml",readFileSync(path)); value.github["issue-assignment"].allowed=value.github["issue-assignment"].allowed.filter(actor=>(actor.login??actor.name)!=="emoriwan"); writeFileSync(path,stringify(value));'
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method DELETE "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'all(.assignees[]; .login != "tanaabot")'
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot"
# allow the owning lifecycle observation interval, not the zero cleanup grace, to elapse.
sleep 61
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --slurpfile before "$TMPDIR/notification-dispatch-before.json" '[.[].records[] | select(.id == $before[0].id)] | length == 1 and (.[0] | .assignmentObservation.missing == true and .assignmentObservation.code == "assignment-removal-unapproved" and .assignmentObservation.event.actor.login == "emoriwan" and .retirement == null and .threadId == $before[0].threadId and .worktree == $before[0].worktree and .progression == $before[0].progression)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.archived != true and .session.archivedAt == null'
test -d "$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")"

# should clear the unresolved warning on verified reassignment without creating another owner
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot"
cp "$TMPDIR/notification-policy-before.yaml" agent.yaml
sleep 61
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --slurpfile before "$TMPDIR/notification-dispatch-before.json" '[.[].records[]] | length == 1 and (.[0] | .id == $before[0].id and .threadId == $before[0].threadId and .worktree == $before[0].worktree and .assignmentObservation == null and .retirement == null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json

# should exclude feedback while all approved authors are removed
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot"
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
const manifest = parse(readFileSync('agent.yaml', 'utf8'));
manifest.github['issue-assignment'].allowed = [];
manifest.github['issue-assignment'].reviewers = [];
writeFileSync('agent.yaml', stringify(manifest));
NODE
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot this author is excluded by the current actor policy.' > "$TMPDIR/notification-excluded-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --arg conversation "$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")" --arg source "$(jq -er .node_id "$TMPDIR/notification-excluded-source.json")" '[.[].records[] | select(.threadId == $conversation)] | length == 1 and .[0].feedback.admission.enabled == false and all(.[0].feedback.events[]; .sourceId != $source)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
const manifest = parse(readFileSync('agent.yaml', 'utf8'));
manifest.github['issue-assignment'].allowed = ['@emoriwan'];
manifest.github['issue-assignment'].reviewers = ['@tanaabot'];
writeFileSync('agent.yaml', stringify(manifest));
NODE
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --arg conversation "$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")" --arg source "$(jq -er .node_id "$TMPDIR/notification-excluded-source.json")" '[.[].records[] | select(.threadId == $conversation)] | length == 1 and .[0].feedback.admission.enabled == true and (.[0].feedback.events | length) == 0 and all(.[0].feedback.events[]; .sourceId != $source)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json

# should retain open unassigned work without cleanup or an idle execution slot
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot"
worktree=$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")
printf '%s\n' 'unfinished task work' > "$worktree/unassigned-local.txt"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method DELETE "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'all(.assignees[]; .login != "tanaabot")'
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
openclaw agent-system notifications status --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")" --json | jq -e '.capacity.active == 0 and (.items | length) == 1 and .items[0].workflow.phase == "awaiting-reassignment"'
grep -Fx 'unfinished task work' "$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")/unassigned-local.txt"

# should reactivate an unassigned issue from approved feedback in its original chat
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot explain the retained plan.' > "$TMPDIR/notification-feedback-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
feedback_run=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-feedback-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source and .turn != null)] | if length == 1 then .[0].turn.runId else error("one feedback turn required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 600000
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json | jq --arg run "$feedback_run" '. + {requestedRunId:$run}' > "$TMPDIR/notification-feedback-history.json"
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback.json"
jq -e --slurp '.[1].retirement == null and .[1].feedbackReactivation.eventId != null and .[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[1].work == null and (.[1].feedback.events | length) == 1 and all(.[1].feedback.events[]; .itemType == "issue" and .work == null)' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-feedback.json"
grep -Fx 'unfinished task work' "$(jq -er .worktree "$TMPDIR/notification-feedback.json")/unassigned-local.txt"

# should verify the exact response and suppress another reply on a repeat scan
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assignment-policy/tanaabot"
number=$(jq -er .feedback.events[0].number "$TMPDIR/notification-feedback.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-feedback-replies.json"
jq -s '[.[] | .]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-reply-drafts.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("feedback"); const replies=read("feedback-replies"); const history=read("feedback-history"); assert.equal(record.feedback.events.length,1); const event=record.feedback.events[0]; assert.equal(event.itemType,"issue"); assert.equal(JSON.parse(event.source).nodeId,read("feedback-source").node_id); assert.equal(history.requestedRunId,event.turn.runId); const draft=read("reply-drafts").find(d=>d.feedback?.eventId===event.id); assert.ok(draft); const found=replies.filter(c=>c.node_id===draft.receipt.nodeId); assert.equal(found.length,1); assert.equal(found[0].user.login,"tanaabot"); assert.ok(found[0].body.includes(draft.publicText)); const answer=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===event.turn.runId && m.stopReason==="stop"); assert.equal(answer.length,1); const text=typeof answer[0].content==="string"?answer[0].content:answer[0].content.map(c=>c.text??"").join(""); assert.ok(text.includes(draft.privateText)); assert.ok(text.includes(draft.publicText)); assert.ok(text.includes("[Reply ↗]("+found[0].html_url+") from [@tanaabot](https://github.com/tanaabot)")); assert.ok(!text.includes("Reply published")); assert.deepEqual(replies.filter(c=>c.user.login==="tanaabot").map(c=>c.node_id).sort(), read("reply-drafts").filter(d=>d.receipt).map(d=>d.receipt.nodeId).sort());'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --arg id "$(jq -er .id "$TMPDIR/notification-feedback.json")" '[.[].records[]] | length == 1 and ([.[] | select(.id == $id)] | length == 1 and (.[0].feedback.events | length) == 1 and all(.[0].feedback.events[]; .turn.status == "consumed" and .phase == "delivered"))' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-feedback-replies.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'
jq -es --arg id "$(jq -er .id "$TMPDIR/notification-feedback.json")" '[.[].records[] | select(.id == $id)] | if length == 1 then .[0] else error("one retained owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-replayed.json"
jq -e --slurp '.[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree' "$TMPDIR/notification-feedback.json" "$TMPDIR/notification-replayed.json"
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
