# OpenClaw Notification Assignment Policy Example

Retain an unavailable candidate without preventing a valid assignment, remove the admitted assignment through an actor outside the live allowed list, verify that unresolved removal authority preserves its native work, then reassign it and clear the warning without creating another owner.

## What Belongs Here

- Unavailable-candidate retention without blocking a later valid assignment.
- Provider-verified removal actor evidence evaluated against the current manifest.
- Missing assignment reporting without retirement, archival, or loss of the retained assessment, checkout, and implementation stage.
- Verified reassignment preserving the original native owner and clearing the unresolved observation.

## What Does Not Belong Here

- Feedback author admission: [feedback policy](../openclaw-notifications-feedback-policy/README.md). Comment-driven resumption: [reactivation](../openclaw-notifications-reactivation/README.md).
- Authorized retirement, fresh attempts after retirement, and coordinator reset: [retirement](../openclaw-notifications-retirement/README.md) and [reset](../openclaw-notifications-reset/README.md).

## Notes

- Strict AIMock supplies the initial assessment; GitHub assignment changes and native state observations remain real.
- Two 61-second waits observe removal and reassignment through the owning lifecycle interval. The shared cleanup grace is zero; it does not bypass that interval.
- CI owns one disposable issue and its workspaces/SSH registration. Only Tanaabot is assigned. Scoped refreshes and a 24-hour schedule bound discovery; cleanup stops the Gateway before external changes.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-notifications-assignment-policy
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should select one shared installation grace for both agent workspaces
install -d -m 700 "$XDG_CONFIG_HOME/tanaab/agent-system"
cp "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/config.yaml" "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"
chmod 600 "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"

# should prepare the declared identity pins and isolated ssh fixture
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/tanaabot/keys" "$HOME/.ssh"
owner_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id)
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
receiver_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id')
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__RECEIVER_NODE_ID__|$receiver_node|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
node --import tsx "$GITHUB_WORKSPACE/scripts/test-resources-task.ts" keys --manifest "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/tanaabot/agent.yaml"

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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

```bash
# should retain an unavailable issue without blocking later assignments
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/tanaabot"
openclaw agent-system notifications refresh --repository tanaabased/big-test-bucket --kind issue --number 2147483647 --json | jq -e '.status == "completed" and .admitted == 0'
jq -es '[.[].deferred[]?] | any(.[]; (.candidate | fromjson).number == 2147483647 and .code == "intake-github-permission")' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-intake-v2/"github-intake-*.json

# should assign one disposable issue from emori to tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/emori"
node --import tsx "$GITHUB_WORKSPACE/scripts/test-resources-task.ts" create-issue --title "Agent System assignment-policy flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --body-file "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/issue.md" --output "$TMPDIR/notification-issue.json"
jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0' "$TMPDIR/notification-issue.json"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain native bindings for the issue selected for feedback
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/tanaabot"
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

# should preserve admitted work when the live actor list does not authorize its removal
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/tanaabot"
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; import {parse,stringify} from "yaml"; const path="agent.yaml"; const value=parse(readFileSync(path,"utf8")); writeFileSync(process.env.TMPDIR+"/notification-policy-before.yaml",readFileSync(path)); value.github["issue-assignment"].allowed=value.github["issue-assignment"].allowed.filter(actor=>(actor.login??actor.name)!=="emoriwan"); writeFileSync(path,stringify(value));'
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method DELETE "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'all(.assignees[]; .login != "tanaabot")'
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/tanaabot"
# allow the owning lifecycle observation interval, not the zero cleanup grace, to elapse.
sleep 61
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --slurpfile before "$TMPDIR/notification-dispatch-before.json" '[.[].records[] | select(.id == $before[0].id)] | length == 1 and (.[0] | .assignmentObservation.missing == true and .assignmentObservation.code == "assignment-removal-unapproved" and .assignmentObservation.event.actor.login == "emoriwan" and .retirement == null and .retired == null and .threadId == $before[0].threadId and .worktree == $before[0].worktree and .progression == $before[0].progression and .result == $before[0].result)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
conversation=$(jq -er .threadId "$TMPDIR/notification-dispatch-before.json")
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$conversation" '{key:$key}')" --json | jq -e '.session.archived != true and .session.archivedAt == null'
test -d "$(jq -er .worktree "$TMPDIR/notification-dispatch-before.json")"

# should clear the unresolved warning on verified reassignment without creating another owner
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-assignment-policy/tanaabot"
cp "$TMPDIR/notification-policy-before.yaml" agent.yaml
sleep 61
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es --slurpfile before "$TMPDIR/notification-dispatch-before.json" '[.[].records[]] | length == 1 and (.[0] | .id == $before[0].id and .threadId == $before[0].threadId and .worktree == $before[0].worktree and .assignmentObservation == null and .retirement == null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
