# OpenClaw Notification Retirement Example

Reconcile retirement after external worktree cleanup, reclaim a fresh attempt with a changed branch and dirty files without losing its commits, and retire a second task whose completed native session is already missing while preserving its original evidence.

## What Belongs Here

- Closed-issue retirement observing external cleanup and archiving the retained native owner without losing its assessment.
- A fresh assignment creating a distinct owner/branch from the repository base while preserving the retired branch's local commit.
- Closed-issue archival and automatic removal of that fresh checkout despite a changed branch and modified/untracked files, preserving its commits and assessment.
- Explicit retirement from an active turn remaining pending, followed by verified missing-session reconciliation and safe checkout removal without invented archival.

## What Does Not Belong Here

- Generic worktree removal mechanics: [worktree](../openclaw-worktree/README.md). Coordinator/tracking replacement: [reset](../openclaw-notifications-reset/README.md).
- Author policy and unassignment reactivation: [feedback policy](../openclaw-notifications-feedback-policy/README.md), [assignment policy](../openclaw-notifications-assignment-policy/README.md), and [reactivation](../openclaw-notifications-reactivation/README.md).
- Automatic reclamation of the first closed checkout, which is deliberately removed through the public worktree command. The fresh attempt covers automatic removal.

## Notes

- Strict AIMock reuses assessment judgment and adds the existing digest-bound retirement preview/apply exchange. Real native execution must leave the request pending while its own turn is active.
- The two native cases share a job but select their exact retained owners. No reset empties the journal between them; earlier retired attempts remain as independent history.
- The fresh attempt is closed and retired before the missing-session case. Three 61-second waits preserve the existing lifecycle observation coverage with zero shared cleanup grace.
- CI owns two disposable issues, their workspaces/state, and SSH registration. Only Tanaabot is assigned. Scoped refreshes and a 24-hour schedule bound discovery; cleanup stops the Gateway before external changes.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-notifications-retirement
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should select one shared installation grace for both agent workspaces
install -d -m 700 "$XDG_CONFIG_HOME/tanaab/agent-system"
cp "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/config.yaml" "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"
chmod 600 "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"

# should prepare the declared identity pins and isolated ssh fixture
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot/keys" "$HOME/.ssh"
owner_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id)
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
receiver_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id')
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__RECEIVER_NODE_ID__|$receiver_node|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
node --import tsx "$GITHUB_WORKSPACE/scripts/test-resources-task.ts" keys --manifest "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot/agent.yaml"

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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

```bash
# should assign one disposable issue from emori to tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/emori"
openclaw agent-system tool gh -- api repos/tanaabased/big-test-bucket | jq '{id,node_id,default_branch}' > "$TMPDIR/notification-repository.json"
node --import tsx "$GITHUB_WORKSPACE/scripts/test-resources-task.ts" create-issue --title "Agent System retirement flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --body-file "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/issue.md" --output "$TMPDIR/notification-issue.json"
jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0' "$TMPDIR/notification-issue.json"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain native bindings for the issue selected for feedback
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for plan-ready --timeout 600 --json | tee "$TMPDIR/notification-plan.json" | jq -e '.status == "completed" and (.observation.items | length) == 1 and .observation.items[0].workflow.phase == "plan-ready"'
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-plan.json")
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-dispatch-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
# reconcile native completion before a later run selects feedback for this issue
reconcile_run=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$reconcile_run" 600000
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-dispatch-before.json"
openclaw agent-system tool worktree -- list > "$TMPDIR/notification-worktrees-before.json"

# should retire externally cleaned work using installation-owned cleanup policy
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot"
worktree=$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")
# preserve a distinct local commit as evidence that fresh work does not reset the old branch.
git -C "$worktree" -c user.name=Fixture -c user.email=fixture@example.test -c commit.gpgsign=false commit --allow-empty -m 'preserve retired attempt'
git -C "$worktree" rev-parse HEAD > "$TMPDIR/notification-retired-tip"
git -C "$worktree" rev-parse --path-format=absolute --git-common-dir > "$TMPDIR/notification-git-dir"
git -C "$worktree" branch --show-current > "$TMPDIR/notification-retired-branch"
repository_id=$(openclaw agent-system tool worktree -- list | jq -er --arg path "$worktree" '.[] | select(.path == $path) | .repositoryId')
work_id="issue-$(jq -er .id "$TMPDIR/notification-issue.json")"
openclaw agent-system tool worktree -- remove "$repository_id" "$work_id"
# allow the bounded lifecycle observation interval to elapse; this fixture has zero cleanup grace.
sleep 61
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-retired.json"
jq -e --slurpfile before "$TMPDIR/notification-dispatch-before.json" '.retirement.worktreeRemovalObserved.source == "external-cleanup" and .retirement.worktreeRemovalAttemptedAt == null and .retirement.reason == "issue-closed" and .retired.at != null and .retirement.archivedAt != null and .retirement.worktreeRemovedAt != null and .result == $before[0].result and .threadId == $before[0].threadId' "$TMPDIR/notification-retired.json"
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.archived == true or .session.archivedAt != null'
worktree=$(jq -er .worktree "$TMPDIR/notification-retired.json")
test ! -e "$worktree"
openclaw agent-system tool worktree -- list | jq -e --arg path "$worktree" 'all(.[]; .path != $path)'

# should prepare a fresh assignment from the base while preserving the retired branch
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=open | jq -e '.state == "open"'
openclaw agent-system tool gh -- api --method DELETE "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot'
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for plan-ready --timeout 600 --json | jq -e '.status == "completed"'
jq -es --slurpfile old "$TMPDIR/notification-retired.json" '[.[].records[] | select(.issueKey == $old[0].issueKey)] | if length == 2 then map(select(.retired == null))[0] else error("exactly two attempts required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-fresh.json"
jq -e --slurpfile old "$TMPDIR/notification-retired.json" '.id != $old[0].id and .worktreeAttemptId == .id and .threadId != $old[0].threadId and .sessionCreation.verified == true and .result.outcome == "plan-ready"' "$TMPDIR/notification-fresh.json"
conversation=$(jq -er .threadId "$TMPDIR/notification-fresh.json")
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e --slurpfile old "$TMPDIR/notification-retired.json" '.session.displayName == $old[0].request.label and .session.label == null'
worktree=$(jq -er .worktree "$TMPDIR/notification-fresh.json")
test "$(git -C "$worktree" branch --show-current)" != "$(cat "$TMPDIR/notification-retired-branch")"
test "$(git --git-dir="$(cat "$TMPDIR/notification-git-dir")" rev-parse "$(cat "$TMPDIR/notification-retired-branch")")" = "$(cat "$TMPDIR/notification-retired-tip")"
test "$(git -C "$worktree" rev-parse HEAD)" = "$(git -C "$worktree" rev-parse "origin/$(jq -er .default_branch "$TMPDIR/notification-repository.json")")"
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-fresh.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000

# should leave modified and untracked files on a changed checkout branch
worktree=$(jq -er .worktree "$TMPDIR/notification-fresh.json")
git -C "$worktree" switch -c "retirement-leftovers-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
printf 'committed\n' > "$worktree/retirement-tracked.txt"
git -C "$worktree" add retirement-tracked.txt
git -C "$worktree" -c user.name=Fixture -c user.email=fixture@example.test -c commit.gpgsign=false commit -m 'preserve dirty attempt'
git -C "$worktree" rev-parse HEAD > "$TMPDIR/notification-dirty-tip"
git -C "$worktree" branch --show-current > "$TMPDIR/notification-dirty-branch"
printf 'modified\n' > "$worktree/retirement-tracked.txt"
printf 'untracked\n' > "$worktree/retirement-untracked.txt"

# should retire the closed dirty fixture automatically before the missing-session case
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot"
sleep 61
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --slurpfile before "$TMPDIR/notification-fresh.json" '[.[].records[] | select(.id == $before[0].id)] | length == 1 and .[0].retired.at != null and .[0].retirement.archivedAt != null and .[0].retirement.worktreeRemovalAttemptedAt != null and .[0].retirement.worktreeRemovedAt != null and .[0].result == $before[0].result and .[0].threadId == $before[0].threadId' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
test ! -e "$(jq -er .worktree "$TMPDIR/notification-fresh.json")"
test "$(git --git-dir="$(cat "$TMPDIR/notification-git-dir")" rev-parse "$(cat "$TMPDIR/notification-dirty-branch")")" = "$(cat "$TMPDIR/notification-dirty-tip")"

# should admit another disposable issue for unavailable-session retirement
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/emori"
node --import tsx "$GITHUB_WORKSPACE/scripts/test-resources-task.ts" create-issue --title "Agent System unavailable session $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --body-file "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/issue.md" --output "$TMPDIR/notification-unavailable-issue.json"
number=$(jq -er .number "$TMPDIR/notification-unavailable-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot"
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for plan-ready --timeout 600 --json > "$TMPDIR/notification-unavailable-plan.json"
conversation=$(jq -er .observation.items[0].workflow.conversation "$TMPDIR/notification-unavailable-plan.json")
jq -es --arg conversation "$conversation" '[.[].records[] | select(.threadId == $conversation)] | if length == 1 then .[0] else error("one dispatch record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-unavailable-before.json"
run_id=$(jq -er .assessmentTurn.runId "$TMPDIR/notification-unavailable-before.json")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000

# should record explicit retirement of open assigned work without archiving its active turn
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot"
conversation=$(jq -er .threadId "$TMPDIR/notification-unavailable-before.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-unavailable-before.json")
receipt=$(jq -er .id "$TMPDIR/notification-unavailable-before.json")
leaf=$(openclaw gateway call chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:1}')" --json | jq -er .sessionInfo.activeLeafEntryId)
params="$(jq -nc --arg key "$conversation" --arg session "$session_id" --arg leaf "$leaf" --arg receipt "$receipt" '{sessionKey:$key,agentId:"retirement-tanaabot",sessionId:$session,message:("Retire this managed task now " + $receipt),queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"notification-manual-retire"}')"
node --input-type=module -e 'import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime"; const result = await callGatewayFromCli("chat.send", {json:true}, JSON.parse(process.argv[1]), {scopes:["operator.admin"],progress:false,sharedStateMode:"read-only"}); console.log(JSON.stringify(result));' "$params" | jq -e '.runId == "notification-manual-retire"'
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" notification-manual-retire 600000
jq -es --arg id "$receipt" '[.[].records[] | select(.id == $id)] | length == 1 and (.[0] | .retirement.reason == "operator-requested" and .retirement.eligibleAt == .retirement.operatorRequest.at and .retirement.code == "retirement-native-work-unresolved" and .retired == null and .retirement.archivedAt == null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system tool gh -- api "repos/tanaabased/big-test-bucket/issues/$(jq -er .number "$TMPDIR/notification-unavailable-issue.json")" | jq -e '.state == "open" and any(.assignees[]; .login == "tanaabot")'

# should leave a managed checkout after deleting its exact completed session
conversation=$(jq -er .threadId "$TMPDIR/notification-unavailable-before.json")
session_id=$(jq -er .sessionCreation.sessionId "$TMPDIR/notification-unavailable-before.json")
openclaw gateway call sessions.delete --params "$(jq -nc --arg key "$conversation" --arg id "$session_id" '{key:$key,expectedSessionId:$id,deleteTranscript:true}')" --json | jq -e '.deleted == true'
test -d "$(jq -er .worktree "$TMPDIR/notification-unavailable-before.json")"
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session == null'

# should reconcile manual retirement of the preserved checkout without inventing archival
# allow the bounded observation interval to elapse; cleanup grace is zero.
sleep 61
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-retirement/tanaabot"
number=$(jq -er .number "$TMPDIR/notification-unavailable-issue.json")
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
id=$(jq -er .id "$TMPDIR/notification-unavailable-before.json")
jq -es --arg id "$id" '[.[].records[] | select(.id == $id)] | if length == 1 then .[0] else error("one retained record required") end' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-unavailable-after.json"
jq -e --slurpfile before "$TMPDIR/notification-unavailable-before.json" '.retirement.reason == "operator-requested" and .retired.at != null and .retirement.sessionUnavailableObserved.session == "not-found" and .retirement.archivedAt == null and .retirement.archiveAttempt == null and .retirement.worktreeRemovalAttemptedAt != null and .retirement.worktreeRemovedAt != null and .request == $before[0].request and .sessionCreation == $before[0].sessionCreation and .result == $before[0].result and .threadId == $before[0].threadId' "$TMPDIR/notification-unavailable-after.json"
worktree=$(jq -er .worktree "$TMPDIR/notification-unavailable-after.json")
test ! -e "$worktree"
openclaw agent-system tool worktree -- list | jq -e --arg path "$worktree" 'all(.[]; .path != $path)'
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
