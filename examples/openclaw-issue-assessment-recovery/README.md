# OpenClaw Issue Assessment Recovery Example

Restart the Gateway for an active issue, change its thinking level through native
controls, and refresh its assessment with current issue facts. Recover the pending
public summary from its independent draft while keeping the same chat and checkout.

## What Belongs Here

- Equivalent permission ordering and operator thinking-level tuning preserving the verified native owner across restart.
- Fresh private issue facts reaching the native assessment without leaking into visible messages.
- An unfinished summary publishing from the saved reply draft without replacing the assessment, chat, or worktree.
- Historical source and completion recovery beyond the recent history window, including an input shortened by the native display projection.

## What Does Not Belong Here

- Author-policy changes: [feedback policy](../openclaw-issue-feedback-policy/README.md). Assignment removal and reactivation: [assignment policy](../openclaw-issue-assignment-policy/README.md) and [reactivation](../openclaw-issue-reactivation/README.md).
- Retirement and reset: [retirement](../openclaw-notifications-retirement/README.md) and [reset](../openclaw-notifications-reset/README.md).
- Ordinary planning and PR delivery: [issue planning](../openclaw-issue-journey/README.md) and [PR delivery](../openclaw-pr-journey/README.md).

## Notes

- Strict AIMock reuses the issue assessment protocol, including its returned schema and pure presentation request. GitHub, the Gateway, managed Git, native ownership, and summary receipts remain real; model judgment is not under test.
- The first restart changes equivalent actor ordering, tunes thinking from medium to high, and refreshes hidden issue facts. The strict model remains unchanged; separate model-only and thinking-only permutations belong to component coverage. The second restart recovers the deliberately retained summary draft; these are distinct native conversation and reply-recovery assertions.
- The refresh input includes 20,000 characters of inert padding. Native default history must mark it truncated; exact-message retrieval must recover it before the native assessment can advance.
- Before summary recovery, 201 short native assistant injections move the native assessment outside the 200-entry history tail. These writes add no model turns or provider fixtures; they exercise exact-source recovery rather than a volume benchmark.
- CI owns one disposable issue, two agent workspaces, and its SSH registration. Only Tanaabot is assigned; scoped refreshes and a 24-hour schedule isolate discovery. Cleanup stops the Gateway before external fixture changes.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-issue-assessment-recovery
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should configure native openclaw cleanup grace
openclaw config set plugins.entries.agent-system.config.cleanup.graceMinutes 0 --strict-json

# should prepare the declared identity pins and isolated ssh fixture
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/tanaabot/keys" "$HOME/.ssh"
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
receiver_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id')
sed -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__RECEIVER_NODE_ID__|$receiver_node|g" -e "s|__GITHUB_REPOSITORY_ID__|$GITHUB_REPOSITORY_ID|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/tanaabot/keys/id_ed25519.pub"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

```bash
# should assign one disposable issue from emori to tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/emori"
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" create --title "agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT- Agent System assessment-recovery flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --body-file "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" assign --number "$number" | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain native bindings for the issue selected for feedback
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for worktree-ready --timeout 600 --json | tee "$TMPDIR/notification-plan.json" | jq -e '.status == "completed" and (.observation.items | length) == 1'
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
# reconcile native completion before a later run selects feedback for this issue
reconcile_run=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$reconcile_run" 600000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"

# should recover the same issue after permission reordering and restart with fresh private facts
cp "$TMPDIR/notification-dispatch-before.json" "$TMPDIR/notification-pre-refresh.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/tanaabot"
sed -i '1a debug: true' agent.yaml
number=$(jq -er .number "$TMPDIR/notification-issue.json")
cp "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/issue.md" "$TMPDIR/notification-later-issue.md"
printf '\nModel-only verification fact: notification-hidden-later-fact.\n' >> "$TMPDIR/notification-later-issue.md"
openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -F "body=@$TMPDIR/notification-later-issue.md" | jq -e '.state == "open"'
openclaw-gateway stop --timeout 340
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; import {parse,stringify} from "yaml"; const path=process.env.GITHUB_WORKSPACE+"/examples/openclaw-issue-assessment-recovery/tanaabot/agent.yaml"; const value=parse(readFileSync(path,"utf8")); value.github["issue-assignment"].allowed.reverse(); writeFileSync(path,stringify(value));'
openclaw-gateway start
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-before.json")
receipt=$(jq -er .id "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call sessions.patch --params "$(jq -nc --arg key "$conversation" '{key:$key,thinkingLevel:"high"}')" --json
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"assessment-recovery-tanaabot",sessionId:$session,message:("Refresh native assessment for managed issue " + $receipt + "; leave summary pending\n" + ("." * 20000)),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-refresh-context"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-refresh-context"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-refresh-context" 600000
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key}')" --json | jq -e 'any(.messages[]; .role == "user" and .__openclaw.idempotencyKey == "notification-refresh-context:user" and .__openclaw.truncated == true)'
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
jq -e --slurpfile before "$TMPDIR/notification-pre-refresh.json" '$before[0] as $before | .result == null and .stageReceipt == null and .assessmentHistory == null and .sessionCreation.sessionId == $before.sessionCreation.sessionId and .threadId == $before.threadId and .worktree == $before.worktree and .request == $before.request and .routing == $before.routing and .effective.status == "verified" and .effective.model == $before.effective.model and .effective.effort == "high" and .request.thinkingLevel == "medium" and .turnEvidence.runId == "notification-refresh-context" and (.turnEvidence.evidence | fromjson | .body | contains("notification-hidden-later-fact"))' "$TMPDIR/notification-dispatch-before.json"
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200,inputRunIds:["notification-refresh-context"]}')" --json | jq -e '[.messages[] | select(.role == "assistant" and .__openclaw.runId == "notification-refresh-context" and .stopReason == "stop")] | if length == 1 then .[0].content | (if type == "string" then . else map(.text // "") | join("") end) | contains("Proposed change") and contains("Fresh issue facts") and (contains("Documentation-only change:") | not) and (contains("notification-hidden-initial-fact") | not) and (contains("notification-hidden-later-fact") | not) else error("one stopped refreshed response required") end'

# should recover only an explicitly prepared public summary after restart in the same native issue owner
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-assessment-recovery/tanaabot"
jq -es '[.[] | (.drafts // [.])[] | select(.update != null and any(.update.facts[]; .reference == "notification-refresh-context"))] | if length == 1 then .[0] else error("one pending reply required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-summary-before.json"
jq -e '(.publicText | length > 0) and .attempted != true and .receipt == null' "$TMPDIR/notification-summary-before.json"
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
node --input-type=module -e 'import {callGatewayFromCli} from "openclaw/plugin-sdk/gateway-runtime"; for (let index = 0; index < 201; index++) await callGatewayFromCli("chat.inject", {json:true}, {sessionKey:process.argv[1],message:"Recovery history filler " + index}, {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"});' "$conversation"
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json | jq -e 'all(.messages[]; .__openclaw.runId != "notification-refresh-context")'
openclaw-gateway stop --timeout 340
openclaw-gateway start
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --slurpfile before "$TMPDIR/notification-summary-before.json" '[.[] | (.drafts // [.])[] | select(.id == $before[0].id)] | length == 1 and .[0] == $before[0]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json
receipt=$(jq -er .id "$TMPDIR/notification-dispatch-before.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-dispatch-before.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
draft=$(jq -er .id "$TMPDIR/notification-summary-before.json")
params=$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg draft "$draft" '{sessionKey:$key,agentId:"assessment-recovery-tanaabot",sessionId:$session,message:("Direct reply publish draft: " + $draft),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-summary-recovery"}')
node --input-type=module -e 'import {callGatewayFromCli} from "openclaw/plugin-sdk/gateway-runtime"; console.log(JSON.stringify(await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"})));' "$params" | jq -e '.runId == "notification-summary-recovery"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-summary-recovery 600000
jq -es --slurpfile before "$TMPDIR/notification-dispatch-before.json" '[.[].records[] | select(.id == $before[0].id)] | if length == 1 then .[0] else error("one retained owner required") end | .result == null and .stageReceipt == null and .threadId == $before[0].threadId and .worktree == $before[0].worktree and .sessionCreation.sessionId == $before[0].sessionCreation.sessionId and .request == $before[0].request and .routing == $before[0].routing' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
jq -es --slurpfile before "$TMPDIR/notification-summary-before.json" '[.[] | (.drafts // [.])[] | select(.id == $before[0].id)] | length == 1 and .[0].receipt.databaseId > 0 and .[0].publicText == $before[0].publicText and .[0].publication == $before[0].publication' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
