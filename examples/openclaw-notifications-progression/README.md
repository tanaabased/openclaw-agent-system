# OpenClaw Notification Progression Example

Move an already assessed issue from Plan to Auto, retain the verified Work decision, enter implementation in the same native owner, hold on clarification, and resume an authorized answer to a local commit without another handoff.

## What Belongs Here

- A live mode edit taking effect without Install and preserving the original assessment, model selection, chat, and worktree.
- The authorized assessment-to-implementation transition, with completed work reconciled rather than dispatched again.
- A reported summary-publication hold retained independently of same-turn authorized implementation.
- Clarification holding the implementation stage until an answer arrives, then resuming the same work without pushing or publishing.

## What Does Not Belong Here

- Auto Plan hold and later operator continuation: [Auto Plan](../openclaw-notifications-auto-plan/README.md).
- Initial concurrent intake: [intake](../openclaw-notifications-intake/README.md). Ordinary planning questions: [issue planning](../openclaw-notifications-issue-journey/README.md).
- PR publication and PR feedback: [PR delivery](../openclaw-notifications-pr-journey/README.md). Restart recovery, reactivation, reset, and retirement belong to [assessment recovery](../openclaw-notifications-assessment-recovery/README.md), [reactivation](../openclaw-notifications-reactivation/README.md), [reset](../openclaw-notifications-reset/README.md), and [retirement](../openclaw-notifications-retirement/README.md).
- Interrupted-decision recovery: [decision recovery](../openclaw-notifications-decision-recovery/README.md). Exhaustive mode/customization combinations remain outside this journey.

## Notes

- Strict AIMock supplies decisions; the installed plugin, GitHub assignment, managed checkout, coordinator, and receipts remain real. This is not proof of genuine model judgment.
- The Auto decision turn records a controlled reported summary denial without invoking publication. This verifies the installed hold protocol and independent progression, not an actual native reviewer refusal. Controlled Codex and OpenClaw adapter coverage owns denial and negative-authority permutations.
- The final operator answer explicitly requests a local commit and prohibits push/PR publication. The test verifies the committed change, not delivery.
- EMORI creates the disposable issue; only Tanaabot is assigned. Scoped refreshes and a 24-hour schedule isolate discovery. Cleanup disposes of the issue and SSH registration; the runner owns the local workspace.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-notifications-progression
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should prepare the declared identity pins and isolated ssh fixture
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/tanaabot/keys" "$HOME/.ssh"
owner_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id)
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/tanaabot/keys/id_ed25519.pub"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'

```

## Testing

```bash
# should assign one disposable issue from emori to tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/emori"
openclaw agent-system tool gh -- api repos/tanaabased/big-test-bucket | jq '{id,node_id}' > "$TMPDIR/notification-repository.json"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System progression flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain a plan through the installed owning coordinator
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for plan-ready --refresh --timeout 600 --json | tee "$TMPDIR/notification-plan.json" | jq -e '.status == "completed" and (.observation.items | length) == 1 and .observation.items[0].workflow.phase == "plan-ready"'
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.parentSessionKey == "agent:notifications-tanaabot:main" and .session.spawnDepth == 0 and .session.spawnedBy == null'
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
jq -e --arg conversation "$conversation" --arg issue "$(jq -er .node_id "$TMPDIR/notification-issue.json")" --arg repository "$(jq -er .node_id "$TMPDIR/notification-repository.json")" '.result.outcome == "plan-ready" and (.result.fullAssessment | length > 0) and (.result.plan | length > 0) and .stageReceipt.binding.threadId == $conversation and .stageReceipt.binding.subjectId == $issue and .stageReceipt.binding.repositoryId == $repository and .stageReceipt.binding.worktree == .worktree and .stageReceipt.binding.turnId == .assessmentTurn.runId and .resultTurnId == .assessmentTurn.runId and .sessionCreation.verified == true and (.routing | length > 0) and (.effective.model | length > 0) and (.request.model | length > 0) and (.request.thinkingLevel | length > 0)' "$TMPDIR/notification-dispatch-before.json"
openclaw agent-system tool worktree -- list | jq -e --arg path "$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")" 'length == 1 and .[0].path == $path'

# should apply a live auto decision and retain implementation clarification without another handoff
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
node -e 'const fs=require("node:fs");const file="agent.yaml";const body=fs.readFileSync(file,"utf8");if(!body.includes("mode: plan"))throw new Error("expected plan");fs.writeFileSync(file,body.replace("mode: plan","mode: auto"));'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
receipt=$(jq -er .id "$TMPDIR/notification-dispatch-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$receipt:auto-decision" 600000
jq -es --slurpfile before "$TMPDIR/notification-dispatch-before.json" '[.[].records[]] | length == 1 and .[0].threadId == $before[0].threadId and .[0].worktree == $before[0].worktree and .[0].assessmentTurn.runId == $before[0].assessmentTurn.runId and .[0].result.plan == $before[0].result.plan and .[0].routing == $before[0].routing and .[0].effective == $before[0].effective and .[0].request.model == $before[0].request.model and .[0].request.thinkingLevel == $before[0].request.thinkingLevel and .[0].result.decision.mode == "work" and .[0].resultTurnId == .[0].decisionTurn.runId' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-clarification.json"
jq -e --arg run "$receipt:auto-decision" '.progression.stage == "implementation" and .progression.via == "auto" and .work.turn.runId == $run and .work.turn.origin == "assessment" and .work.result.outcome == "clarification-needed" and (.work.result.questions | length) == 1' "$TMPDIR/notification-clarification.json"
jq -e '.assessmentSummaries | any(.code == "assessment-summary-native-approval-denied" and (.diagnostic | length > 0) and .attempt == null and .receipt == null)' "$TMPDIR/notification-clarification.json"
openclaw agent-system notifications status --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")" --json | jq -e '.items[0].workflow.phase == "clarification-needed"'

# should reconcile the finished auto handoff without restarting work while clarification is pending
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --slurpfile before "$TMPDIR/notification-clarification.json" '[.[].records[]] | length == 1 and .[0].decisionTurn.status == "completed" and .[0].work.turn.status == "completed" and .[0].work.turn.runId == $before[0].work.turn.runId and .[0].work.result == $before[0].work.result and .[0].routing == $before[0].routing and .[0].effective == $before[0].effective and .[0].request.model == $before[0].request.model and .[0].request.thinkingLevel == $before[0].request.thinkingLevel and .[0].work.deliveryTurn == null' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json

# should resume an authorized answer and commit locally without another handoff
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-before.json")
receipt=$(jq -er .id "$TMPDIR/notification-dispatch-before.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"notifications-tanaabot",sessionId:$session,message:("Answer for managed issue " + $receipt + ": Yes, after evidence is captured. Do not push or publish a PR."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-answer"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-answer"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-answer" 600000
jq -es '[.[].records[]] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-implemented.json"
jq -e --slurp '.[1].progression.workOwner == "issue" and .[0].id == .[1].id and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].routing == .[1].routing and .[0].effective == .[1].effective and .[0].request.model == .[1].request.model and .[0].request.thinkingLevel == .[1].request.thinkingLevel and .[0].result == (.[1].result | del(.decision)) and .[1].progression.stage == "implementation" and .[1].progression.via == "auto" and .[1].work.caller.runId == "notification-answer" and .[1].work.result.outcome == "done" and .[1].work.delivery == null' "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-implemented.json"
jq -e --slurp '.[0].work.implementation == .[1].work.implementation and .[0].work.turn.runId == .[1].work.turn.runId and .[0].handoff == .[1].handoff and .[1].work.caller.runId == "notification-answer"' "$TMPDIR/notification-clarification.json" "$TMPDIR/notification-implemented.json"
jq -e --slurp '.[0].assessmentSummaries == .[1].assessmentSummaries and .[1].summaryRecovery == null' "$TMPDIR/notification-clarification.json" "$TMPDIR/notification-implemented.json"
worktree=$(jq -er .worktree "$TMPDIR/notification-implemented.json")
git -C "$worktree" show HEAD | grep -F 'Close disposable test issues after capturing their evidence.'

```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should dispose of this run's persistent github fixtures
openclaw-gateway stop --timeout 340
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/emori"
if test -s "$TMPDIR/notification-issue.json"; then
  number=$(jq -er .number "$TMPDIR/notification-issue.json")
  openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
fi
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-progression/tanaabot"
key_material=$(awk '{print $2}' keys/id_ed25519.pub)
key_id=$(openclaw agent-system tool gh -- api --paginate /user/keys --jq ".[] | select((.key | split(\" \")) | index(\"$key_material\")) | .id")
if test -n "$key_id"; then
  openclaw agent-system tool gh -- api --method DELETE "/user/keys/$key_id"
fi

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
