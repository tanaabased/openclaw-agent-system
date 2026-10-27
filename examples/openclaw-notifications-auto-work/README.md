# OpenClaw Notification Auto Work Delivery Example

Start an Auto assignment, save its Work decision, and deliver the linked PR in the
initial assessment turn without another operator handoff.

## What Belongs Here

- Initial assignment-to-delivery in the same native chat, worktree, and assessment run.
- Retained private results, exact linked PR and public receipts, and duplicate prevention.

## What Does Not Belong Here

- Plan-to-Work through approved feedback and later PR conversation: [PR journey](../openclaw-notifications-pr-journey/README.md).
- Auto Plan holds and authorized continuation: [Auto Plan](../openclaw-notifications-auto-plan/README.md). Interrupted decisions: [decision recovery](../openclaw-notifications-decision-recovery/README.md).
- Other automatic delivery selections: [default Work](../openclaw-notifications-work/README.md) and [custom Work](../openclaw-notifications-work-custom/README.md).

## Notes

- Strict AIMock supplies the decisions and tool choices. GitHub requests, native execution, stage changes, publication, and saved results remain real. Model interpretation and desktop rendering need separate verification.
- Adapted from the automatic-delivery fixtures in #434 (`a17b4f7`, authored by `emoriwan`), with one disposable issue and PR per job.
- Account checks use the live provider. Only Tanaabot is assigned. Refreshes target this test issue, and cleanup stops the Gateway before closing external resources.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-notifications-auto-work
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should prepare the declared identity pins and isolated ssh fixture
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications-auto-work/tanaabot/keys" "$HOME/.ssh"
owner_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id)
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__GITHUB_REPOSITORY_ID__|$GITHUB_REPOSITORY_ID|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-auto-work/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-auto-work/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications-auto-work/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications-auto-work/tanaabot/keys/id_ed25519.pub"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-auto-work/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-auto-work/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

```bash
# should create an issue as emori and assign it as tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-auto-work/emori"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT- Agent System auto-work flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-notifications-auto-work/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-auto-work/tanaabot"
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should deliver the assigned issue in its initial native assessment turn
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-auto-work/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for worktree-ready --timeout 600 --json > "$TMPDIR/notification-plan.json"
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
run_id=$(jq -ers --arg key "$conversation" '[.[].records[] | select(.threadId == $key)] | if length == 1 then .[0].assessmentTurn.runId else error("one conversation required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --arg key "$conversation" '[.[].records[] | select(.threadId == $key)] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-delivery.json"
jq -e --arg run "$run_id" '.progression.stage == "implementation" and .progression.via == "auto" and .work.turn.runId == $run and .work.turn.origin == "assessment" and .work.result.outcome == "done" and .work.delivery.reconciled and .work.delivery.pullRequest.pullRequestNodeId != null and .work.delivery.announcement.receipt.nodeId != null and (.work.delivery.presentation | length > 0) and .stageReceipt.binding.worktree == .worktree and .stageReceipt.binding.threadId == .threadId and (.result.fullAssessment | length > 0) and .assessmentSummaries[0].receipt.nodeId != null and (.feedback.events | length) == 0' "$TMPDIR/notification-delivery.json"
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$run_id" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json > "$TMPDIR/notification-history.json"
jq -e --arg run "$run_id" --arg card "$(jq -er .work.delivery.presentation "$TMPDIR/notification-delivery.json")" 'any(.messages[]; .role == "assistant" and .__openclaw.runId == $run and .stopReason == "stop" and ((.content | if type == "string" then . else map(.text // "") | join("") end) | contains($card)))' "$TMPDIR/notification-history.json"
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e --slurpfile saved "$TMPDIR/notification-delivery.json" '.session.sessionId == $saved[0].sessionCreation.sessionId and .session.spawnedCwd == $saved[0].worktree and .session.thinkingLevel == $saved[0].request.thinkingLevel'

# should retain the linked pr and exact public receipts without repeating delivery
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-auto-work/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
pr=$(jq -er .work.delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- pr view "$pr" --repo tanaabased/big-test-bucket --json assignees,closingIssuesReferences | jq -e --argjson issue "$number" 'any(.assignees[]; .login == "tanaabot") and any(.closingIssuesReferences[]; .number == $issue)'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
branch=$(jq -er .work.delivery.binding.branch "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- pr list --repo tanaabased/big-test-bucket --head "$branch" --state all --json number | jq -e --argjson pr "$pr" 'length == 1 and .[0].number == $pr'
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-comments.json"
jq -e --slurpfile saved "$TMPDIR/notification-delivery.json" '[.[] | select(.user.login == "tanaabot")] | length == 2 and any(.[]; .node_id == $saved[0].assessmentSummaries[0].receipt.nodeId) and any(.[]; .node_id == $saved[0].work.delivery.announcement.receipt.nodeId)' "$TMPDIR/notification-comments.json"

# should retain the structured auto work decision and its rationale
jq -e ' .result.decision.mode == "work" and (.result.decision.reasons | length > 0)' "$TMPDIR/notification-delivery.json"
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
