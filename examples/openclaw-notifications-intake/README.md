# OpenClaw Notification Intake Example

Activate notification intake, exclude fixture assignments through repository routing, then reorder the rules to claim three assignments and start their assessments on a second native pass before any result completes. Retain all three plans and verify that narrowing routing preserves the same chats, worktrees, and assessment turns.

## What Belongs Here

- Native channel readiness and a safe intake baseline before fixture assignment.
- First-match repository routing overriding legacy owners, with two-pass Swarm admission and live rule changes preserving admitted work.
- Custom routing skill/guidance selection during concurrent admission with distinct verified native owners, complete retained assessments, and private routing-method readback.
- One repeat scan proving that admission does not duplicate chats, checkouts, or turns.

## What Does Not Belong Here

- Other assessment presentation and ordinary issue feedback: [issue planning](../openclaw-notifications-issue-journey/README.md). Implementation and PR feedback: [PR delivery](../openclaw-notifications-pr-journey/README.md).
- Restart recovery: [assessment recovery](../openclaw-notifications-assessment-recovery/README.md). Unassigned-issue feedback: [reactivation](../openclaw-notifications-reactivation/README.md). Coordinator/tracking reset: [reset](../openclaw-notifications-reset/README.md). Resource reconciliation: [retirement](../openclaw-notifications-retirement/README.md).
- Scheduler controls: [scheduling](../openclaw-notifications-scheduling/README.md). Unavailable-assignment recovery: [assignment policy](../openclaw-notifications-assignment-policy/README.md). Debug-card presentation: [assessment recovery](../openclaw-notifications-assessment-recovery/README.md).

## Notes

- Native skill discovery and retained guidance are asserted during admission; the fixed mock judgment does not prove interpretation of the custom skill. No additional live-model turn is required.
- One completed assessment checks that the retained custom method reaches the private routing card. Formatting and debug variants stay in owning renderer tests.
- Strict AIMock holds each assessment behind a per-receipt release barrier. The test releases all three only after verifying their native starts; model judgment is not under test.
- Swarm adds one coordinator turn to verify that claims precede native creation. This single-installation journey does not prove cross-installation exclusion; the comment-only POC can overlap under incomplete provider views.
- V3 object identities pin assignment actors; repository routing overrides the retained legacy owner list. Only Tanaabot receives the three disposable assignments.
- Scoped refreshes and a 24-hour schedule bound discovery. The job owns its workspaces, issues, native state, and SSH registration; cleanup stops the Gateway before changing external fixtures.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
touch "$TMPDIR/notification-assessments-held"
openclaw-aimock prepare --scenario openclaw-notifications-intake
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should configure native openclaw cleanup grace
openclaw config set plugins.entries.agent-system.config.cleanup.graceMinutes 0 --strict-json

# should prepare the declared identity pins and isolated ssh fixture
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/keys" "$HOME/.ssh"
owner_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id)
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
receiver_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id')
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__RECEIVER_NODE_ID__|$receiver_node|g" -e "s|__GITHUB_REPOSITORY_ID__|$GITHUB_REPOSITORY_ID|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"

# should boot with retained legacy channel configuration
openclaw config set channels.agent-system-github '{"accounts":{"retired-agent":{"enabled":false}}}' --strict-json
openclaw config set plugins.entries.agent-system.config.githubNotifications '{"maxCommentCharacters":8000}' --strict-json
OPENCLAW_LOG_LEVEL=info openclaw-gateway start
openclaw config get channels.agent-system-github --json | jq -e '.accounts["retired-agent"].enabled == false'

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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
openclaw agent-system install --yes --json | tee "$TMPDIR/notification-install.json" | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated") and ([.warnings[] | select(.code == "github-notification-runtime-unsupported")] | length) == 1'
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == true)'
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

```bash
# should expose the install-managed account through the native channel status interface
set -eo pipefail
for attempt in $(seq 1 30); do
  openclaw gateway call channels.status --params '{"probe":true}' --json > "$TMPDIR/intake-channel-status.json"
  if jq -e '.channelAccounts["agent-system-github"] | any(.accountId == "intake-tanaabot")' "$TMPDIR/intake-channel-status.json" > /dev/null; then
    break
  fi
  sleep 1
done
cat "$TMPDIR/intake-channel-status.json"
jq -e '.channelAccounts["agent-system-github"] | any(.accountId == "intake-tanaabot" and .enabled == true and .configured == true and .mode == "readiness" and .statusState == "degraded" and .lifecycle == "ready" and .running == true and (.lastError | contains("review requests")))' "$TMPDIR/intake-channel-status.json"
openclaw config get channels.agent-system-github --json | jq -e '.accounts["retired-agent"].enabled == false and .accounts["intake-tanaabot"].enabled == true'

# should assign three disposable issues from emori to tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/emori"
openclaw agent-system tool gh -- api repos/tanaabased/big-test-bucket | jq '{id,node_id}' > "$TMPDIR/notification-repository.json"
for slot in 1 2 3; do
  openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT- Agent System intake flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$slot" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/issue.md" | tee "$TMPDIR/notification-issue-$slot.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
  number=$(jq -er .number "$TMPDIR/notification-issue-$slot.json")
  openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'
done
cp "$TMPDIR/notification-issue-1.json" "$TMPDIR/notification-issue.json"

# should exclude assignments with the first route despite the legacy owner grant
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications refresh --repository tanaabased/big-test-bucket --kind issue --number "$number" --json | jq -e '.status == "completed" and .admitted == 0 and any(.repositoryScope[]; .source == "routing" and .reason == "excluded" and .index == 0)'
jq -es '[.[].records[]] | length == 0' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-intake-v2/"github-intake-*.json

# should register three swarm claims without starting native assessments
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; import {parse,stringify} from "yaml"; const path="agent.yaml"; const value=parse(readFileSync(path,"utf8")); value.github.routing.reverse(); writeFileSync(path,stringify(value));'
for slot in 1 2 3; do
  number=$(jq -er .number "$TMPDIR/notification-issue-$slot.json")
  openclaw agent-system notifications refresh --repository tanaabased/big-test-bucket --kind issue --number "$number" --json | jq -e '.status == "completed"'
done
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es '[.[].records[]] | length == 3 and all(.[]; .threadId == null and .sessionCreation == null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
jq -e '.claims | length == 3 and all(.[]; .attempted == true and .commentId != null and .nativeReceipt == null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-instance/assignment-claims.json"

# should start three native assessments on the second swarm pass
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
if ! jq -es '[.[].records[]] | length == 3 and ([.[].threadId] | unique | length) == 3 and all(.[]; .claimAccepted == true and .sessionCreation.verified == true and (.assessmentTurn.status == "accepted" or (.assessmentTurn.status == "consumed" and (.assessmentTurn.consumedByEventId | type == "string" and length > 0))) and .assessmentTurn.failed != true and .assessmentTurn.cancelled != true and .result == null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json; then
  jq -s '[.[].records[]] | {count: length, records: (.[0:10] | map({id, phase, blocker, threadId, sessionVerified: .sessionCreation.verified, assessmentTurn: (.assessmentTurn | {runId, status, consumedByEventId, failed, cancelled}), hasResult: (.result != null)}))}' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json >&2
  exit 1
fi
jq -es '[.[].records[]]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-started.json"
jq -e 'all(.[]; .routingInstructions.requestedSkill == "intake-routing" and .routingInstructions.skill.name == "intake-routing" and (.routingInstructions.skill.digest | length) == 64 and .routingInstructions.guidance.source == "file" and (.routingInstructions.guidance.content | contains("Keep disposable cleanup plans bounded.")))' "$TMPDIR/notification-started.json"
for conversation in $(jq -r '.[].threadId' "$TMPDIR/notification-started.json"); do
  openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.parentSessionKey == "agent:intake-tanaabot:main" and .session.spawnDepth == 0 and .session.spawnedBy == null'
done

# should release all held responses together after the three native starts and retain every plan
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
for receipt in $(jq -r '.[].id' "$TMPDIR/notification-started.json"); do
  touch "$TMPDIR/notification-assessment-released-$receipt"
done
for slot in 1 2 3; do
  number=$(jq -er .number "$TMPDIR/notification-issue-$slot.json")
  assessment_run=$(jq -er --arg source "https://github.com/tanaabased/big-test-bucket/issues/$number" '.[] | select((.context | fromjson).source == $source) | .assessmentTurn.runId' "$TMPDIR/notification-started.json")
  node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$assessment_run" 600000
done
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es '[.[].records[]] | length == 3 and all(.[]; .assessmentTurn.status == "completed" and .result.outcome == "plan-ready")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json

# should show the retained custom routing method in the native private assessment
conversation=$(jq -er '.[0].threadId' "$TMPDIR/notification-started.json")
run_id=$(jq -er '.[0].assessmentTurn.runId' "$TMPDIR/notification-started.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json | jq -e --arg run "$run_id" '([.messages[] | select(.role == "assistant" and .__openclaw.runId == $run and .stopReason == "stop")] | if length == 1 then .[0].content | (if type == "string" then . else map(.text // "") | join("") end) | contains("Model routing") and contains("Routing method") and contains("intake-routing") and contains("+ custom guidance") and (contains("Keep disposable cleanup plans bounded.") | not) else error("one stopped assessment response required") end)'

# should retain complete results and native bindings for all three owners
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
for slot in 1 2 3; do
  issue=$(jq -er .node_id "$TMPDIR/notification-issue-$slot.json")
  repository=$(jq -er .node_id "$TMPDIR/notification-repository.json")
  jq -es --arg issue "$issue" --arg repository "$repository" '[.[].records[] | select(.stageReceipt.binding.subjectId == $issue)] | if length == 1 then .[0] else error("one issue owner required") end | .result.outcome == "plan-ready" and (.result.fullAssessment | length > 0) and (.result.plan | length > 0) and .stageReceipt.binding.threadId == .threadId and .stageReceipt.binding.repositoryId == $repository and .stageReceipt.binding.worktree == .worktree and .stageReceipt.binding.turnId == .assessmentTurn.runId and .resultTurnId == .assessmentTurn.runId and .sessionCreation.verified == true' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
done
openclaw agent-system tool worktree -- list | tee "$TMPDIR/notification-worktrees-before.json" | jq -e 'length == 3'

# should preserve all three native owners after narrowing routing to no new work
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; import {parse,stringify} from "yaml"; const path="agent.yaml"; const value=parse(readFileSync(path,"utf8")); value.github.routing=[]; writeFileSync(path,stringify(value));'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es '[.[].records[]]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-all-after.json"
jq -e --slurp '.[0] as $before | .[1] as $after | ($after | length) == 3 and all($after[]; .assessmentTurn.status == "completed" and .result.outcome == "plan-ready") and ([$before[] | {id,intakeId,threadId,worktree,run:.assessmentTurn.runId}] | sort_by(.id)) == ([$after[] | {id,intakeId,threadId,worktree,run:.assessmentTurn.runId}] | sort_by(.id))' "$TMPDIR/notification-started.json" "$TMPDIR/notification-all-after.json"
for conversation in $(jq -r '.[].threadId' "$TMPDIR/notification-all-after.json"); do
  run_id=$(jq -er --arg key "$conversation" '.[] | select(.threadId == $key) | .assessmentTurn.runId' "$TMPDIR/notification-all-after.json")
  openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json | jq -e --arg run "$run_id" '([.messages[] | select(.role == "user" and .idempotencyKey == ($run + ":user"))] | length) == 1'
done
openclaw agent-system tool worktree -- list | jq -S 'sort_by(.path)' > "$TMPDIR/notification-worktrees-after.json"
jq -S 'sort_by(.path)' "$TMPDIR/notification-worktrees-before.json" | diff - "$TMPDIR/notification-worktrees-after.json"
openclaw gateway call sessions.list --params '{"agentId":"intake-tanaabot","limit":100}' --json | jq -e '.hasMore == false and ([.sessions[] | select(.key | startswith("agent:intake-tanaabot:dashboard:agent-system-issue-"))] | length == 3 and all(.[]; .category == "BIG-TEST-BUCKET"))'
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
