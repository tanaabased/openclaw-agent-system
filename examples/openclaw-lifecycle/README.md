# OpenClaw Issue Lifecycle Example

Normally admit one disposable issue, retain its native chat, worktree and assessment across restart and equivalent permission reordering, reactivate it from an approved comment after unassignment, suppress replayed replies, and retire closed work after operator worktree cleanup while preserving the assessment. The worktree example covers removal itself; this scenario checks that retirement reconciles cleanup performed outside its own transaction.

`openclaw-intake` owns activation compatibility, concurrent admission and repeat-scan duplicate prevention. Assessment presentation and ordinary feedback belong to `openclaw-issue`; implementation and PR delivery belong to `openclaw-pr`; scheduler drift belongs to `openclaw-automations`.

Strict AIMock reuses the issue assessment protocol without the intake release barrier. This job owns its one issue, agent workspaces, native state and SSH registration; it consumes no other job's resources. Scoped refreshes and a 24-hour schedule isolate discovery. Only Tanaabot receives assignments. Failed activation retains diagnostics. Cleanup stops the Gateway before closing its issue or revoking its key.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-lifecycle
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should prepare the agent with provider-verified identity pins
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot/keys" "$HOME/.ssh"
GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id > "$TMPDIR/notification-owner-node"
GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id' > "$TMPDIR/notification-actor-node"
owner_node=$(cat "$TMPDIR/notification-owner-node")
actor_node=$(cat "$TMPDIR/notification-actor-node")
receiver_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id')
test -n "$owner_node"
test -n "$actor_node"
test -n "$receiver_node"
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__RECEIVER_NODE_ID__|$receiver_node|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

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
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
openclaw agent-system install --yes --json | tee "$TMPDIR/notification-install.json" | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and ([.warnings[] | select(.code == "github-notification-runtime-unsupported")] | length) == 1'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == true)'
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
touch "$TMPDIR/notification-activation-ready"
```

## Testing

The historical-receipt regression seeds one original fingerprint only while the
disposable Gateway is stopped. Checkout helpers prepare that input; the packed
plugin performs the native continuation. This is test setup, not an operator
recovery procedure. It follows the separate current-format reordering journey;
historical hashes remain provenance rather than continuing permission. The stopped
fixture also seeds a known configuration blocker so restart must recover it without
replacing the chat or its receipts.

```bash
# should assign one disposable issue from emori to tanaabot after the safe intake baseline
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/emori"
openclaw agent-system tool gh -- api repos/tanaabased/big-test-bucket | jq '{id,node_id}' > "$TMPDIR/notification-repository.json"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System lifecycle flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-lifecycle/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain native bindings for the issue selected for feedback
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for plan-ready --timeout 600 --json | tee "$TMPDIR/notification-plan.json" | jq -e '.status == "completed" and (.observation.items | length) == 1 and .observation.items[0].workflow.phase == "plan-ready"'
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.parentSessionKey == "agent:lifecycle-tanaabot:main" and .session.spawnDepth == 0 and .session.spawnedBy == null'
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
# reconcile native completion before a later run selects feedback for this issue
reconcile_run=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$reconcile_run" 300000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
jq -e '.assessmentTurn.status == "completed" and .result.outcome == "plan-ready"' "$TMPDIR/notification-dispatch-before.json"
jq -e --arg conversation "$conversation" --arg issue "$(jq -er .node_id "$TMPDIR/notification-issue.json")" --arg repository "$(jq -er .node_id "$TMPDIR/notification-repository.json")" '.result.outcome == "plan-ready" and (.result.fullAssessment | length > 0) and (.result.plan | length > 0) and .stageReceipt.binding.threadId == $conversation and .stageReceipt.binding.subjectId == $issue and .stageReceipt.binding.repositoryId == $repository and .stageReceipt.binding.worktree == .worktree and .stageReceipt.binding.turnId == .assessmentTurn.runId and .resultTurnId == .assessmentTurn.runId and .sessionCreation.verified == true' "$TMPDIR/notification-dispatch-before.json"
openclaw agent-system tool worktree -- list | tee "$TMPDIR/notification-worktrees-before.json" | jq -e --arg path "$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")" 'length == 1 and any(.[]; .path == $path)'

# should recover the same issue after permission reordering and restart with fresh private facts
cp "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-pre-refresh.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
sed -i '1a debug: true' agent.yaml
number=$(jq -er .number "$TMPDIR/notification-issue.json")
cp "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/issue.md" "$TMPDIR/notification-later-issue.md"
printf '\nModel-only verification fact: notification-hidden-later-fact.\n' >> "$TMPDIR/notification-later-issue.md"
openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -F "body=@$TMPDIR/notification-later-issue.md" | jq -e '.state == "open"'
openclaw-gateway stop --timeout 340
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; import {parse,stringify} from "yaml"; const path=process.env.GITHUB_WORKSPACE+"/examples/openclaw-lifecycle/tanaabot/agent.yaml"; const value=parse(readFileSync(path,"utf8")); value.github.notifications["issue-assignment"].allowed.reverse(); writeFileSync(path,stringify(value));'
openclaw-gateway start
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-before.json")
receipt=$(jq -er .id "$TMPDIR/notification-dispatch-before.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"lifecycle-tanaabot",sessionId:$session,message:("Refresh retained assessment for managed issue " + $receipt + "; leave summary pending"),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-refresh-context"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-refresh-context"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-refresh-context" 300000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
jq -e --slurpfile before "$TMPDIR/notification-pre-refresh.json" '. as $after | $before[0] as $before | .resultTurnId == "notification-refresh-context" and .assessmentRevision == ($before.assessmentRevision + 1) and .stageReceipt.binding.turnId == .resultTurnId and .result.plan == $before.result.plan and .result.reviewSummary == $before.result.reviewSummary and (.result.fullAssessment | contains($before.result.fullAssessment) and contains("Fresh issue context verified after restart")) and .turnEvidence.runId == .resultTurnId and (.turnEvidence.evidence | fromjson | .body | contains("notification-hidden-later-fact"))' "$TMPDIR/notification-dispatch-before.json"
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200,inputRunIds:["notification-refresh-context"]}')" --json | jq -e --slurpfile record "$TMPDIR/notification-dispatch-before.json" '[.messages[] | select(.role == "assistant" and .__openclaw.runId == "notification-refresh-context" and .stopReason == "stop")] | if length == 1 then .[0].content | (if type == "string" then . else map(.text // "") | join("") end) | contains("Proposed change") and contains("Model routing") and contains("Assessment instructions") and contains($record[0].result.reviewSummary) and (contains($record[0].result.fullAssessment) | not) and (contains("notification-hidden-initial-fact") | not) and (contains("notification-hidden-later-fact") | not) else error("one stopped refreshed response required") end'

# should recover only an uncomposed public summary after restart in the same native issue owner
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
jq -e '.assessmentRevision as $revision | all(.assessmentSummaries[]?; .revision != $revision)' "$TMPDIR/notification-dispatch-before.json"
openclaw-gateway stop --timeout 340
openclaw-gateway start
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
recovery_run=$(jq -ers '[.[].records[].summaryRecovery.turn.runId] | if length == 1 then .[0] else error("one summary recovery required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$recovery_run" 300000
jq -es --slurpfile before "$TMPDIR/notification-dispatch-before.json" '[.[].records[] | select(.id == $before[0].id)] | if length == 1 then .[0] else error("one retained owner required") end | .result == $before[0].result and .assessmentRevision == $before[0].assessmentRevision and .resultTurnId == $before[0].resultTurnId and .threadId == $before[0].threadId and .worktree == $before[0].worktree and (.assessmentRevision as $revision | any(.assessmentSummaries[]; .revision == $revision and .receipt.databaseId > 0))' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json

# should recover a historical configuration blocker in its existing issue conversation after restart
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
openclaw-gateway stop --timeout 340
node --import tsx --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const { default: parse } = await import(process.env.GITHUB_WORKSPACE + '/manifest/parse.ts');
const { originalIntakeDigest } = await import(process.env.GITHUB_WORKSPACE + '/test/github-intake-fixture.ts');
const { automationHash } = await import(process.env.GITHUB_WORKSPACE + '/agent/automation-hash.ts');
const parsed = parse(readFileSync('agent.yaml', 'utf8'));
assert.equal(parsed.status, 'valid');
const before = JSON.parse(readFileSync(process.env.TMPDIR + '/notification-dispatch-before.json', 'utf8'));
const directory = process.env.XDG_CONFIG_HOME + '/tanaab/agent-system/agent-system-dispatch-v2';
let found = 0;
for (const file of readdirSync(directory).filter(name => name.startsWith('openclaw-dispatch-') && name.endsWith('.json'))) {
  const path = directory + '/' + file;
  const state = JSON.parse(readFileSync(path, 'utf8'));
  for (const record of state.records.filter(record => record.id === before.id)) {
    found++;
    record.manifestDigest = automationHash({ policy: originalIntakeDigest(parsed.manifest), models: parsed.manifest.models });
    record.phase = "blocked";
    record.blocker = "dispatch-policy-changed";
    writeFileSync(process.env.TMPDIR + '/notification-historical-before.json', JSON.stringify(record));
  }
  writeFileSync(path, JSON.stringify(state));
}
assert.equal(found, 1);
NODE
openclaw-gateway start
conversation=$(jq -er .threadId "$TMPDIR/notification-historical-before.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-historical-before.json")
receipt=$(jq -er .id "$TMPDIR/notification-historical-before.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"lifecycle-tanaabot",sessionId:$session,message:("Refresh retained assessment for managed issue " + $receipt),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-historical-context"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-historical-context"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-historical-context 300000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one original owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
jq -e --slurpfile before "$TMPDIR/notification-historical-before.json" '. as $after | $before[0] as $before | ([.id,.intakeId,.threadId,.sessionCreation,.worktree,.routing,.effective,.manifestDigest,.assessmentTurn] == [$before.id,$before.intakeId,$before.threadId,$before.sessionCreation,$before.worktree,$before.routing,$before.effective,$before.manifestDigest,$before.assessmentTurn]) and .blocker == null and (.compatibilityRecovery.codes | index("dispatch-policy-changed")) != null and .resultTurnId == "notification-historical-context" and .assessmentRevision == ($before.assessmentRevision + 1) and .result.plan == $before.result.plan and (.result.fullAssessment | contains($before.result.fullAssessment)) and .assessmentCaller.inputEventId != null and .stageReceipt.binding.turnId == .resultTurnId and .handoff == null and .reset == null and .retirement == null and .retired == null' "$TMPDIR/notification-dispatch-before.json"

# should hold and resume feedback authors without reinstalling the parent automation
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const text = readFileSync('agent.yaml', 'utf8');
assert.ok(!text.includes('feedback:'));
writeFileSync('agent.yaml', text.replace('    issue-assignment:', '    issue-assignment:\n      feedback: {inherit: false, allowed: []}'));
NODE
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es --arg conversation "$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")" '[.[].records[] | select(.threadId == $conversation)] | length == 1 and .[0].feedback.admission.enabled == false and .[0].feedback.admission.observedAt > 0' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const text = readFileSync('agent.yaml', 'utf8');
assert.ok(text.includes('feedback: {inherit: false, allowed: []}'));
writeFileSync('agent.yaml', text.replace('      feedback: {inherit: false, allowed: []}\n', ''));
NODE
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es --arg conversation "$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")" '[.[].records[] | select(.threadId == $conversation)] | length == 1 and .[0].feedback.admission.enabled == true and .[0].feedback.admission.after > 0 and .[0].feedback.admission.after < .[0].feedback.admission.observedAt and (.[0].feedback.events | length) == 0' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json

# should preserve admitted work when the live actor list does not authorize its removal
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; import {parse,stringify} from "yaml"; const path="agent.yaml"; const value=parse(readFileSync(path,"utf8")); writeFileSync(process.env.TMPDIR+"/notification-policy-before.yaml",readFileSync(path)); value.github.notifications["issue-assignment"].allowed=value.github.notifications["issue-assignment"].allowed.filter(actor=>actor.login!=="emoriwan"); writeFileSync(path,stringify(value));'
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method DELETE "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'all(.assignees[]; .login != "tanaabot")'
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
# allow the owning lifecycle observation interval, not the zero cleanup grace, to elapse.
sleep 61
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es --slurpfile before "$TMPDIR/notification-dispatch-before.json" '[.[].records[] | select(.id == $before[0].id)] | length == 1 and (.[0] | .assignmentObservation.missing == true and .assignmentObservation.code == "assignment-removal-unapproved" and .assignmentObservation.event.actor.login == "emoriwan" and .retirement == null and .retired == null and .threadId == $before[0].threadId and .worktree == $before[0].worktree and .progression == $before[0].progression and .result == $before[0].result)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.archived != true and .session.archivedAt == null'
test -d "$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")"

# should clear the unresolved warning on verified reassignment without creating another owner
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
cp "$TMPDIR/notification-policy-before.yaml" agent.yaml
sleep 61
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es --slurpfile before "$TMPDIR/notification-dispatch-before.json" '[.[].records[]] | length == 1 and (.[0] | .id == $before[0].id and .threadId == $before[0].threadId and .worktree == $before[0].worktree and .assignmentObservation == null and .retirement == null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json

# should reactivate an unassigned issue from approved feedback in its original chat
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method DELETE "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'all(.assignees[]; .login != "tanaabot")'
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot explain the retained plan.' > "$TMPDIR/notification-feedback-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
feedback_run=$(jq -ers --arg source "$(jq -er .node_id "$TMPDIR/notification-feedback-source.json")" '[.[].records[].feedback.events[] | select(.sourceId == $source and .turn != null)] | if length == 1 then .[0].turn.runId else error("one feedback turn required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$feedback_run" 300000
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$feedback_run" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json | jq --arg run "$feedback_run" '. + {requestedRunId:$run}' > "$TMPDIR/notification-feedback-history.json"
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-feedback.json"
jq -e --slurp '.[1].retirement == null and .[1].feedbackReactivation.eventId != null and .[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].result == .[1].result and .[0].stageReceipt == .[1].stageReceipt and .[1].work == null and (.[1].feedback.events | length) == 1 and all(.[1].feedback.events[]; .phase == "published" and .itemType == "issue" and .receipt.nodeId != null and (.result.privateText | length > 0) and (.result.publicText | length > 0) and .composition.skill.path != null)' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-feedback.json"

# should verify the exact response and suppress another reply on a repeat scan
test -f "$TMPDIR/notification-activation-ready"
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
number=$(jq -er .feedback.events[0].number "$TMPDIR/notification-feedback.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-feedback-replies.json"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const read=n=>JSON.parse(readFileSync(process.env.TMPDIR+"/notification-"+n+".json","utf8")); const record=read("feedback"); const replies=read("feedback-replies"); const history=read("feedback-history"); assert.equal(record.feedback.events.length,1); const event=record.feedback.events[0]; assert.equal(event.itemType,"issue"); assert.equal(JSON.parse(event.source).nodeId,read("feedback-source").node_id); assert.equal(history.requestedRunId,event.turn.runId); const found=replies.filter(c=>c.node_id===event.receipt.nodeId); assert.equal(found.length,1); assert.equal(found[0].user.login,"tanaabot"); assert.ok(found[0].body.includes(event.result.publicText)); const answer=history.messages.filter(m=>m.role==="assistant" && m.__openclaw?.runId===event.turn.runId && m.stopReason==="stop"); assert.equal(answer.length,1); const text=typeof answer[0].content==="string"?answer[0].content:answer[0].content.map(c=>c.text??"").join(""); assert.ok(text.includes(event.result.privateText)); assert.ok(text.includes(event.result.publicText)); assert.ok(text.includes("[Reply ↗]("+found[0].html_url+") from [@tanaabot](https://github.com/tanaabot)")); assert.ok(!text.includes("Reply published")); assert.deepEqual(replies.filter(c=>c.user.login==="tanaabot").map(c=>c.node_id).sort(), [...record.assessmentSummaries.map(s=>s.receipt.nodeId), event.receipt.nodeId].sort());'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
jq -es --arg id "$(jq -er .id "$TMPDIR/notification-feedback.json")" '[.[].records[]] | length == 1 and ([.[] | select(.id == $id)] | length == 1 and (.[0].feedback.events | length) == 1 and all(.[0].feedback.events[]; .turn.status == "completed" and .phase == "published"))' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-feedback-replies.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'
jq -es --arg id "$(jq -er .id "$TMPDIR/notification-feedback.json")" '[.[].records[] | select(.id == $id)] | if length == 1 then .[0] else error("one retained owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-replayed.json"
jq -e --slurp '.[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].result == .[1].result and .[0].stageReceipt == .[1].stageReceipt' "$TMPDIR/notification-feedback.json" "$TMPDIR/notification-replayed.json"
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0'

# should retire a closed fixture after external worktree cleanup and preserve its plan
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
worktree=$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")
repository_id=$(openclaw agent-system tool worktree -- list | jq -er --arg path "$worktree" '.[] | select(.path == $path) | .repositoryId')
work_id="issue-$(jq -er .id "$TMPDIR/notification-issue.json")"
openclaw agent-system tool worktree -- remove "$repository_id" "$work_id"
# allow the bounded lifecycle observation interval to elapse; this fixture has zero cleanup grace.
sleep 61
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 300000
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-retired.json"
jq -e --slurpfile before "$TMPDIR/notification-dispatch-before.json" '.retirement.worktreeRemovalObserved.source == "external-cleanup" and .retirement.worktreeRemovalAttemptedAt == null and .retirement.reason == "issue-closed" and .retired.at != null and .retirement.archivedAt != null and .retirement.worktreeRemovedAt != null and .result == $before[0].result and .threadId == $before[0].threadId' "$TMPDIR/notification-retired.json"
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.archived == true or .session.archivedAt != null'
worktree=$(jq -er .worktree "$TMPDIR/notification-retired.json")
test ! -e "$worktree"
openclaw agent-system tool worktree -- list | jq -e --arg path "$worktree" 'all(.[]; .path != $path)'
```

## Cleanup

Cleanup requires a terminal Gateway stop before changing external fixtures. Every wait reports its receipt and remains bounded.

```bash
# should stop the isolated gateway before changing external fixture state
openclaw-gateway stop --timeout 340
touch "$TMPDIR/notification-gateway-stopped"

# should close only the disposable issue created by this run
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/emori"
if test -s "$TMPDIR/notification-issue.json"; then
  number=$(jq -er .number "$TMPDIR/notification-issue.json")
  openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
fi

# should remove only this run's ssh authentication key
test -f "$TMPDIR/notification-gateway-stopped"
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle/tanaabot"
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
