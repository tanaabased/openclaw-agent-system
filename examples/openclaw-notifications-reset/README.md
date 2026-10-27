# OpenClaw Notification Reset Example

Preview and confirm a notification reset. Verify that it replaces the intake chat,
clears saved tracking, establishes a fresh assignment baseline, and restores the
previous intake schedule.

## What Belongs Here

- An operator preview with readable targets and masked chat identifiers, and its exact confirmation token for the bound agent.
- Native coordinator archival, cleared tracking, a new reset generation, and a ready empty baseline.
- Restoration of the installed intake automation's enabled state after reset.

## What Does Not Belong Here

- Retirement assertions themselves: [retirement](../openclaw-notifications-retirement/README.md). Live actor-policy changes: [feedback policy](../openclaw-notifications-feedback-policy/README.md) and [assignment policy](../openclaw-notifications-assignment-policy/README.md).
- Purge, uncertain session lookup, partial reset recovery, or native desktop sidebar/scheduler behavior. Their separate source/manual evidence is not supplied by this example.

## Notes

- Setup creates one real assessment, closes its issue, removes its worktree publicly, and observes retirement before reset. This completed record makes tracking-clear verification meaningful without depending on the full retirement/fresh-assignment journey.
- Strict AIMock reuses the existing assessment protocol. The Gateway, native coordinator, reset command, automation, and receipts remain real.
- One 61-second setup wait observes retirement; zero cleanup grace does not bypass the lifecycle observation interval. Reset diagnostics preserve safe phase/operation details and keep raw provider errors private.
- CI owns its disposable issue, workspaces/state, and SSH registration. Only Tanaabot is assigned. Scoped refreshes and a 24-hour schedule isolate discovery; cleanup stops the Gateway before external changes.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-notifications-reset
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should select one shared installation grace for both agent workspaces
install -d -m 700 "$XDG_CONFIG_HOME/tanaab/agent-system"
cp "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/config.yaml" "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"
chmod 600 "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"

# should prepare the declared identity pins and isolated ssh fixture
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/tanaabot/keys" "$HOME/.ssh"
owner_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id)
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
receiver_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id')
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__RECEIVER_NODE_ID__|$receiver_node|g" -e "s|__GITHUB_REPOSITORY_ID__|$GITHUB_REPOSITORY_ID|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/tanaabot/keys/id_ed25519.pub"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/emori"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/tanaabot"
openclaw agent-system install --yes --json > "$TMPDIR/notification-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'

# should assign one disposable issue from emori to tanaabot after the safe intake baseline
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/emori"
openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT- Agent System reset flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/issue.md" | tee "$TMPDIR/notification-issue.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'

# should retain native bindings for the issue selected for feedback
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/tanaabot"
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

# should retire externally cleaned work using installation-owned cleanup policy
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/emori"
number=$(jq -er .number "$TMPDIR/notification-issue.json")
openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/tanaabot"
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

# should retain completed management history before reset
jq -es '[.[].records[]] | length == 1 and .[0].retired.at != null' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
```

## Testing

```bash
# should preview the selected agent with a masked coordinator before confirmation
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/tanaabot"
openclaw agent-system notifications reset --agent reset-tanaabot --fresh --preview --json > "$TMPDIR/reset-preview.json"
jq -e '.status == "confirmation-required" and .targets[0].fresh == true and any(.targets[0].resources[]; .kind == "coordinator")' "$TMPDIR/reset-preview.json"
old_coordinator=$(jq -er '.targets[0].resources[] | select(.kind == "coordinator") | .description' "$TMPDIR/reset-preview.json")
human_preview=$(NO_COLOR=1 openclaw agent-system notifications reset --agent reset-tanaabot --fresh --preview)
printf '%s\n' "$human_preview" | grep -F 'agent' | grep -F 'reset-tanaabot'
masked_coordinator=$(jq -er '.targets[0].resources[] | select(.kind == "coordinator") | "***" + .description[-4:]' "$TMPDIR/reset-preview.json")
printf '%s\n' "$human_preview" | grep -F 'coordinator' | grep -F "$masked_coordinator"
if printf '%s\n' "$human_preview" | grep -F "$old_coordinator"; then
  exit 1
fi

# should reset local management with a fresh coordinator and restore the installed intake setting
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-reset/tanaabot"
old_coordinator=$(jq -er '.targets[0].resources[] | select(.kind == "coordinator") | .description' "$TMPDIR/reset-preview.json")
confirmation=$(jq -er .confirmation "$TMPDIR/reset-preview.json")
openclaw agent-system notifications reset --agent reset-tanaabot --fresh --confirmation "$confirmation" --yes --json | jq -e '.results | length == 1 and .[0].status == "complete" and .[0].automationRestored == true'
openclaw gateway call sessions.describe --params "$(jq -nc --arg key "$old_coordinator" '{key:$key}')" --json | jq -e '.session.archived == true'
openclaw agent-system automations list --agent reset-tanaabot --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == true)'
jq -es 'all(.[]; (.records | length) == 0 and .resetGeneration != null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
openclaw agent-system notifications status --agent reset-tanaabot --json | jq -e '.baseline.status == "ready" and (.items | length) == 0'
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should stop the isolated gateway
openclaw-gateway stop --timeout 340

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
