# OpenClaw Issue Customized Work Delivery Example

Deliver a Work assignment, then an Auto Work assignment, using one installation with custom assessment, implementation, and reply skills. Each issue keeps its own chat, checkout, linked PR, and public receipts.

## What Belongs Here

- Initial assignment-to-delivery in the same native chat, worktree, and assessment run.
- Combined final native text keeps the assessment before delivery, debug last within the composed output, and additional prose visible afterwards.
- Native plan context, exact linked PR and public receipts, and duplicate prevention.

## What Does Not Belong Here

- Plan-to-Work through approved feedback and later PR conversation: [PR journey](../openclaw-pr-journey/README.md).
- Auto Plan holds and authorized continuation: [Auto Plan](../openclaw-issue-auto-plan/README.md).

## Notes

- Final-text assertions inspect the terminal assistant message separately from the composer tool result. They establish native text ordering, not desktop rendering or live model copying.
- Strict AIMock supplies the decisions and tool choices. GitHub requests, native execution, stage changes, publication, and native receipts remain real. Model interpretation and desktop rendering need separate verification.
- Adapted from the automatic-delivery fixtures in #434 (`a17b4f7`, authored by `emoriwan`), with one disposable issue and PR per mode.
- Account checks use the live provider. Only Tanaabot is assigned. Refreshes target this test issue, and cleanup stops the Gateway before closing external resources.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-issue-work-custom
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should prepare the declared identity pins and isolated ssh fixture
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot/keys" "$HOME/.ssh"
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
sed -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__GITHUB_REPOSITORY_ID__|$GITHUB_REPOSITORY_ID|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot/keys/id_ed25519.pub"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

Fixture assignments use the native GitHub tool; lost responses are reconciled without repeating the write. Safe reads use bounded retries.

```bash
# should create an issue as emori and assign it as tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/emori"
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" create --title "agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT- Agent System work-custom flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --body-file "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot"
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" assign --number "$number" | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should deliver the assigned issue in its initial native assessment turn
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for worktree-ready --timeout 600 --json > "$TMPDIR/notification-plan.json"
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
run_id=$(jq -ers --arg key "$conversation" '[.[].records[] | select(.threadId == $key)] | if length == 1 then (.[0] | .nativeTurns | map(select(.role == "assessment")) | last | .turn).runId else error("one conversation required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --arg key "$conversation" '[.[].records[] | select(.threadId == $key)] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-delivery.json"
jq -e --arg run "$run_id" '.progression.stage == "implementation" and .progression.via == "work" and .work.implementation.runId == $run and .delivery.reconciled and .delivery.pullRequest.pullRequestNodeId != null and .announcement.receipt.nodeId != null and .pullRequestLink == .delivery.pullRequest and (.feedback.events | length) == 0' "$TMPDIR/notification-delivery.json"
jq -e '.announcement.publicText == null and .announcement.publication == null and .announcement.composition == null and .announcement.snapshot.body == null' "$TMPDIR/notification-delivery.json"
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$run_id" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json > "$TMPDIR/notification-history.json"
input_event_id=$(jq -er --arg key "$run_id:user" '[.messages[] | select(.role == "user" and (.__openclaw.idempotencyKey // .idempotencyKey) == $key)] | if length == 1 then .[0].__openclaw.id | select(type == "string" and length > 0 and . != $key) else error("one exact input required") end' "$TMPDIR/notification-history.json")
session_id=$(jq -er .sessionId "$TMPDIR/notification-history.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg event "$input_event_id" '{sessionKey:$key,sessionId:$session,messageId:$event,limit:1}')" --json | jq -e --arg session "$session_id" --arg event "$input_event_id" --arg key "$run_id:user" '.sessionId == $session and ([.messages[] | select(.role == "user" and .__openclaw.id == $event and (.__openclaw.idempotencyKey // .idempotencyKey) == $key)] | length) == 1'
jq -e --arg run "$run_id" --slurpfile saved "$TMPDIR/notification-delivery.json" 'any(.messages[]; .role == "assistant" and .__openclaw.runId == $run and .stopReason == "stop" and ((.content | if type == "string" then . else map(.text // "") | join("") end) | startswith("> ") and contains("https://github.com/tanaabased/big-test-bucket/pull/" + ($saved[0].delivery.pullRequest.pullRequestNumber | tostring)) and (gsub("(?m)^> ?"; "") | contains("#issuecomment-" + ($saved[0].announcement.receipt.databaseId | tostring)))))' "$TMPDIR/notification-history.json"
jq -e --arg run "$run_id" '[.messages[] | select(.role == "assistant" and .__openclaw.runId == $run and .stopReason == "stop") | .content | if type == "string" then . else map(.text // "") | join("") end] | last | . as $text | ($text | index("🧭 Plan ready")) as $plan | ($text | index("🔀 Pull request")) as $pr | $plan != null and $pr != null and $plan < $pr and contains("Implementation and focused checks completed.") and endswith("Additional prose after composition remains visible.") and (if contains("🔬 Debug") then index("🔬 Debug") > $pr else true end)' "$TMPDIR/notification-history.json"
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e --slurpfile saved "$TMPDIR/notification-delivery.json" '.session.sessionId == $saved[0].sessionCreation.sessionId and .session.spawnedCwd == $saved[0].worktree and .session.thinkingLevel == $saved[0].request.thinkingLevel'

# should retain the linked pr and exact public receipts without repeating delivery
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
pr=$(jq -er .delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- pr view "$pr" --repo tanaabased/big-test-bucket --json assignees,closingIssuesReferences | jq -e --argjson issue "$number" 'any(.assignees[]; .login == "tanaabot") and any(.closingIssuesReferences[]; .number == $issue)'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
branch=$(jq -er .delivery.binding.branch "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- pr list --repo tanaabased/big-test-bucket --head "$branch" --state all --json number | jq -e --argjson pr "$pr" 'length == 1 and .[0].number == $pr'
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-comments.json"
jq -s --arg target "$(jq -er .html_url "$TMPDIR/notification-issue.json")" '[.[] | select(.update != null and .receipt != null and (.target | fromjson | .url) == $target)]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-summary-drafts.json"
jq -e --slurpfile saved "$TMPDIR/notification-delivery.json" --slurpfile summaries "$TMPDIR/notification-summary-drafts.json" '[.[] | select(.user.login == "tanaabot")] | length == 2 and any(.[]; .node_id == $summaries[0][0].receipt.nodeId) and any(.[]; .node_id == $saved[0].announcement.receipt.nodeId)' "$TMPDIR/notification-comments.json"

# should preserve independently selected custom skills without saved plans
jq -e '.work.selection.skill.name == "cleanup-implementation"' "$TMPDIR/notification-delivery.json"
worktree=$(jq -er .worktree "$TMPDIR/notification-delivery.json")
git -C "$worktree" show HEAD | grep -F 'Retain sanitized evidence before cleanup.'
jq -e 'all(.[] | select(.user.login == "tanaabot"); (.body | contains("Evidence first")) and (.body | contains("Live interpretation remains untested")))' "$TMPDIR/notification-comments.json"
```

## Testing Auto Work

```bash
# should create an issue as emori and assign it as tanaabot after the safe intake baseline under auto mode
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot"
sed 's/mode: work/mode: auto/' agent.yaml > "$TMPDIR/auto-work-agent.yaml"
mv "$TMPDIR/auto-work-agent.yaml" agent.yaml
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/emori"
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" create --title "agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT- Agent System auto-work flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --body-file "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot"
node --import tsx "$GITHUB_WORKSPACE/scripts/notification-fixture-github.ts" assign --number "$number" | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should deliver the assigned issue in its initial native assessment turn under auto mode
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for worktree-ready --timeout 600 --json > "$TMPDIR/notification-plan.json"
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
run_id=$(jq -ers --arg key "$conversation" '[.[].records[] | select(.threadId == $key)] | if length == 1 then (.[0] | .nativeTurns | map(select(.role == "assessment")) | last | .turn).runId else error("one conversation required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json)
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --arg key "$conversation" '[.[].records[] | select(.threadId == $key)] | if length == 1 then .[0] else error("one issue owner required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-delivery.json"
jq -e --arg run "$run_id" '.progression.stage == "implementation" and .progression.via == "auto" and .work.implementation.runId == $run and .delivery.reconciled and .delivery.pullRequest.pullRequestNodeId != null and .announcement.receipt.nodeId != null and .pullRequestLink == .delivery.pullRequest and (.feedback.events | length) == 0' "$TMPDIR/notification-delivery.json"
jq -e '.announcement.publicText == null and .announcement.publication == null and .announcement.composition == null and .announcement.snapshot.body == null' "$TMPDIR/notification-delivery.json"
openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" --arg run "$run_id" '{sessionKey:$key,inputRunIds:[$run],limit:200,maxChars:100000}')" --json > "$TMPDIR/notification-history.json"
jq -e --arg run "$run_id" --slurpfile saved "$TMPDIR/notification-delivery.json" 'any(.messages[]; .role == "assistant" and .__openclaw.runId == $run and .stopReason == "stop" and ((.content | if type == "string" then . else map(.text // "") | join("") end) | startswith("> ") and contains("https://github.com/tanaabased/big-test-bucket/pull/" + ($saved[0].delivery.pullRequest.pullRequestNumber | tostring)) and (gsub("(?m)^> ?"; "") | contains("#issuecomment-" + ($saved[0].announcement.receipt.databaseId | tostring)))))' "$TMPDIR/notification-history.json"
jq -e --arg run "$run_id" '[.messages[] | select(.role == "assistant" and .__openclaw.runId == $run and .stopReason == "stop") | .content | if type == "string" then . else map(.text // "") | join("") end] | last | . as $text | ($text | index("🧭 Plan ready")) as $plan | ($text | index("🔀 Pull request")) as $pr | $plan != null and $pr != null and $plan < $pr and contains("Implementation and focused checks completed.") and endswith("Additional prose after composition remains visible.") and (if contains("🔬 Debug") then index("🔬 Debug") > $pr else true end)' "$TMPDIR/notification-history.json"
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e --slurpfile saved "$TMPDIR/notification-delivery.json" '.session.sessionId == $saved[0].sessionCreation.sessionId and .session.spawnedCwd == $saved[0].worktree and .session.thinkingLevel == $saved[0].request.thinkingLevel'

# should retain the linked pr and exact public receipts without repeating delivery under auto mode
cd "$GITHUB_WORKSPACE/examples/openclaw-issue-work-custom/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
pr=$(jq -er .delivery.pullRequest.pullRequestNumber "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- pr view "$pr" --repo tanaabased/big-test-bucket --json assignees,closingIssuesReferences | jq -e --argjson issue "$number" 'any(.assignees[]; .login == "tanaabot") and any(.closingIssuesReferences[]; .number == $issue)'
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
branch=$(jq -er .delivery.binding.branch "$TMPDIR/notification-delivery.json")
openclaw agent-system tool gh -- pr list --repo tanaabased/big-test-bucket --head "$branch" --state all --json number | jq -e --argjson pr "$pr" 'length == 1 and .[0].number == $pr'
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$number/comments" > "$TMPDIR/notification-comments.json"
jq -s --arg target "$(jq -er .html_url "$TMPDIR/notification-issue.json")" '[.[] | select(.update != null and .receipt != null and (.target | fromjson | .url) == $target)]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"github-reply-*.json > "$TMPDIR/notification-summary-drafts.json"
jq -e --slurpfile saved "$TMPDIR/notification-delivery.json" --slurpfile summaries "$TMPDIR/notification-summary-drafts.json" '[.[] | select(.user.login == "tanaabot")] | length == 2 and any(.[]; .node_id == $summaries[0][0].receipt.nodeId) and any(.[]; .node_id == $saved[0].announcement.receipt.nodeId)' "$TMPDIR/notification-comments.json"

# should preserve independently selected custom skills without saved plans under auto mode
jq -e '.work.selection.skill.name == "cleanup-implementation"' "$TMPDIR/notification-delivery.json"
worktree=$(jq -er .worktree "$TMPDIR/notification-delivery.json")
git -C "$worktree" show HEAD | grep -F 'Retain sanitized evidence before cleanup.'
jq -e 'all(.[] | select(.user.login == "tanaabot"); (.body | contains("Evidence first")) and (.body | contains("Live interpretation remains untested")))' "$TMPDIR/notification-comments.json"
jq -e '.implementationDecision.mode == "work" and (.implementationDecision.reasons | length > 0)' "$TMPDIR/notification-delivery.json"
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
