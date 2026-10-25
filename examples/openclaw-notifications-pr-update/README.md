# OpenClaw Notification PR Operator Update Example

After one delivered PR, accept an explicit operator request to add a follow-up commit and update its title and body, then retain the same PR and issue announcement.

## What Belongs Here

- Operator-driven changes to committed content and PR title/body after initial delivery.
- An advanced pushed head with unchanged issue, chat, checkout, PR identity, feedback receipts, and announcement.

## What Does Not Belong Here

- Live recipient preview: [PR recipient preview](../openclaw-notifications-pr-recipients/README.md).
- Ordinary assignment, initial delivery, and uninterrupted feedback: [PR journey](../openclaw-notifications-pr-journey/README.md).
- Saved plan/card readback after dirty edits: [PR presentation readback](../openclaw-notifications-pr-presentation/README.md).
- Other feedback conditions: [PR collaborator reconciliation](../openclaw-notifications-pr-collaboration/README.md), [PR discovery recovery](../openclaw-notifications-pr-discovery/README.md), [PR reply recovery](../openclaw-notifications-pr-reply-recovery/README.md).
- Mode transitions and implementation clarification: [progression](../openclaw-notifications-progression/README.md). Inline review-thread processing and replacement-coordinator recovery remain separate acceptance work.

## Notes

- Strict AIMock supplies model text and tool selection; GitHub, native chat execution, dispatch, managed Git, and receipts remain real. Only Tanaabot is assigned; EMORI creates fixtures and comments.
- Each job prepares its own issue, assessment, and linked PR. Initial feedback permits three bounded coordinator passes for native assessment reconciliation, while preserving the exact source revision. Refreshes target only this issue; the 24-hour schedule avoids unrelated discovery.
- Operator follow-ups collect direct implementation context from the retained owner and plan, without a separate assessment or handoff; delivery preserves the same PR and announcement.
- Native operator messages use the public Gateway SDK with `operator.admin`; the enrolled dispatch device retains `operator.read` and `operator.write`. Native transcript receipts bind the input.
- The shared PR fixture reconciles delayed closing-issue linkage with at most three prepare/publish passes on the same delivery. Unknown failures and uncertain writes do not create replacement PRs.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-notifications-pr-update
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should prepare the declared identity pins and isolated ssh fixture
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/tanaabot/keys" "$HOME/.ssh"
owner_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id)
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__TEST_RESOURCE_PREFIX__|$TEST_RESOURCE_PREFIX|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"

# should start the isolated gateway
OPENCLAW_LOG_LEVEL=info openclaw-gateway start

# should install emori in its fixture workspace
set -o pipefail
registration_diagnostics() {
  registration_status=$?
  if test "$registration_status" -ne 0; then
    node --import tsx "$GITHUB_WORKSPACE/scripts/registration-evidence.ts" pr-update-emori || true
  fi
  exit "$registration_status"
}
trap registration_diagnostics EXIT
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/emori"
openclaw agent-system install --json

# should install tanaabot and activate native intake with explicit dispatch enrollment
set -o pipefail
activation_diagnostics() {
  activation_status=$?
  if test "$activation_status" -ne 0; then
    node --import tsx "$GITHUB_WORKSPACE/scripts/registration-evidence.ts" pr-update-tanaabot || true
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'

# should create an issue as emori and assign it as tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/emori"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=$TEST_RESOURCE_PREFIX Agent System pr flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/tanaabot"
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain a plan through the installed owning coordinator
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/tanaabot"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/comments" -f 'body=@tanaabot Please implement the agreed plan and publish its pull request.' > "$TMPDIR/notification-initial-source.json"
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/tanaabot"
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

# should capture the original issue announcements before the later operation
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-announcements.json"
```

## Testing

```bash
# should update the existing pr after a follow-up commit without another announcement
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-pr-update/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-delivery.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-delivery.json")
receipt=$(jq -er .id "$TMPDIR/notification-delivery.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"pr-update-tanaabot",sessionId:$session,message:("Operator request for managed issue " + $receipt + ": Add a follow-up commit and update the existing PR title and body."),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-update"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-update"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "notification-update" 600000
jq -es --arg id "$receipt" '[.[].records[] | select(.id == $id)] | .[0]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-updated.json"
jq -e --slurp '.[0].progression.stage == .[1].progression.stage and .[0].progression.via == .[1].progression.via and .[0].feedback == .[1].feedback and .[0].threadId == .[1].threadId and .[0].worktree == .[1].worktree and .[0].work.delivery.id == .[1].work.delivery.id and .[0].work.delivery.pullRequest == .[1].work.delivery.pullRequest and .[0].work.delivery.announcement == .[1].work.delivery.announcement and .[0].work.delivery.binding.head != .[1].work.delivery.binding.head and .[1].work.delivery.binding.head == .[1].work.delivery.pushedHead and .[1].work.delivery.reconciled == true and .[1].work.delivery.contentUpdate == null' "$TMPDIR/notification-delivery.json" "$TMPDIR/notification-updated.json"
pr=$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-updated.json")
openclaw agent-system tool gh -- pr view "$pr" --repo tanaabased/big-test-bucket --json number,title,body,headRefOid,closingIssuesReferences | jq -e --slurpfile delivery "$TMPDIR/notification-updated.json" --argjson issue "$(jq -er .number "$TMPDIR/notification-issue.json")" '.number == $delivery[0].work.delivery.pullRequest.pullRequestNumber and .headRefOid == $delivery[0].work.delivery.pushedHead and .title == "Document disposable notification fixture cleanup and verification" and (.body | contains("verifying the retained delivery after follow-up commits")) and any(.closingIssuesReferences[]; .number == $issue)'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" | jq -e --slurpfile before "$TMPDIR/notification-announcements.json" '[.[] | select(.user.login == "tanaabot") | .node_id] == [$before[0][] | select(.user.login == "tanaabot") | .node_id]'
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
