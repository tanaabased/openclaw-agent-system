# OpenClaw Notification Intake Example

Activate notification intake, start three independent issue assessments before any result completes, retain all three plans, and verify that a repeat scan preserves the same chats, worktrees, and assessment turns.

## What Belongs Here

- Native channel readiness and a safe intake baseline before fixture assignment.
- Concurrent admission with distinct verified native owners and complete retained assessments.
- One repeat scan proving that admission does not duplicate chats, checkouts, or turns.

## What Does Not Belong Here

- Assessment presentation and ordinary issue feedback: [issue planning](../openclaw-notifications-issue-journey/README.md). Implementation and PR feedback: [PR delivery](../openclaw-notifications-pr-journey/README.md).
- Restart recovery: [assessment recovery](../openclaw-notifications-assessment-recovery/README.md). Unassigned-issue feedback: [reactivation](../openclaw-notifications-reactivation/README.md). Coordinator/tracking reset: [reset](../openclaw-notifications-reset/README.md). Resource reconciliation: [retirement](../openclaw-notifications-retirement/README.md).
- Scheduler controls: [scheduling](../openclaw-notifications-scheduling/README.md). Unavailable-assignment recovery: [assignment policy](../openclaw-notifications-assignment-policy/README.md). Debug-card presentation: [assessment recovery](../openclaw-notifications-assessment-recovery/README.md).

## Notes

- Strict AIMock holds each assessment behind a per-receipt release barrier. The test releases all three only after verifying their native starts; model judgment is not under test.
- V3 object identities preserve supplied names and node IDs through installation and intake. Only Tanaabot receives the three disposable assignments.
- Scoped refreshes and a 24-hour schedule bound discovery. The job owns its workspaces, issues, native state, and SSH registration; cleanup stops the Gateway before changing external fixtures.
- A failed native channel-status assertion captures the original response, saved channel-account flags, Gateway config revision metadata, and bounded redacted logs before cleanup. `config.get` may be cached; its snapshot is not proof of applied account configuration. The native status response records the accounts exposed by the running Gateway. Evidence is retained in the workflow's `install-evidence` artifact without retrying or replacing the failed assertion.

## Setup

```bash
# should prepare the packed plugin and strict notification fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --yolo
touch "$TMPDIR/notification-assessments-held"
openclaw-aimock prepare --scenario openclaw-notifications-intake
openclaw config set skills.workshop.autonomous.mode off
# keep unrelated nightly memory turns out of the strict notification fixture
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json

# should select shared installation cleanup grace
install -d -m 700 "$XDG_CONFIG_HOME/tanaab/agent-system"
cp "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/config.yaml" "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"
chmod 600 "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"

# should prepare the declared identity pins and isolated ssh fixture
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/keys" "$HOME/.ssh"
owner_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id)
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
receiver_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id')
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__RECEIVER_NODE_ID__|$receiver_node|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/agent.yaml"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"

# should boot with retained legacy channel configuration
openclaw config set channels.agent-system-github '{"accounts":{"retired-agent":{"enabled":false}}}' --strict-json
openclaw config set plugins.entries.agent-system.config.githubNotifications '{"maxCommentCharacters":8000}' --strict-json
openclaw config set logging.file "$TMPDIR/install-native.log"
openclaw config set logging.level debug
openclaw config set diagnostics.enabled true --strict-json
OPENCLAW_LOG_LEVEL=debug OPENCLAW_PLUGIN_LIFECYCLE_TRACE=1 openclaw-gateway start
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
channel_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
channel_diagnostics() {
  channel_status=$?
  if test "$channel_status" -ne 0; then
    node --import tsx "$GITHUB_WORKSPACE/scripts/install-evidence.ts" intake-channel-status "$channel_status" "$channel_started" "$TMPDIR/intake-channel-status.json" "$TMPDIR/intake-channel-status.stderr" "$TMPDIR/install-native.log" channel-status || printf '%s\n' 'channel evidence capture unavailable' >&2
  fi
  exit "$channel_status"
}
trap channel_diagnostics EXIT
for attempt in $(seq 1 30); do
  openclaw gateway call channels.status --json > "$TMPDIR/intake-channel-status.json" 2> "$TMPDIR/intake-channel-status.stderr"
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
  openclaw agent-system tool gh -- api --method POST repos/tanaabased/big-test-bucket/issues -f "title=Agent System intake flow $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$slot" -F "body=@$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/issue.md" | tee "$TMPDIR/notification-issue-$slot.json" | jq -e '.state == "open" and .user.login == "emoriwan" and (.assignees | length) == 0'
  number=$(jq -er .number "$TMPDIR/notification-issue-$slot.json")
  openclaw agent-system tool gh -- api --method POST "repos/tanaabased/big-test-bucket/issues/$number/assignees" -f 'assignees[]=tanaabot' | jq -e 'any(.assignees[]; .login == "tanaabot")'
done
cp "$TMPDIR/notification-issue-1.json" "$TMPDIR/notification-issue.json"

# should start three native assessments in one automation run before any plan completes
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
for slot in 1 2 3; do
  number=$(jq -er .number "$TMPDIR/notification-issue-$slot.json")
  openclaw agent-system notifications refresh --repository tanaabased/big-test-bucket --kind issue --number "$number" --json | jq -e '.status == "completed"'
done
run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$(jq -er .number "$TMPDIR/notification-issue.json")")
node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
jq -es '[.[].records[]] | length == 3 and ([.[].threadId] | unique | length) == 3 and all(.[]; .sessionCreation.verified == true and .assessmentTurn.status == "accepted" and .result == null)' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
jq -es '[.[].records[]]' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json > "$TMPDIR/notification-started.json"
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

# should retain complete results and native bindings for all three owners
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
for slot in 1 2 3; do
  issue=$(jq -er .node_id "$TMPDIR/notification-issue-$slot.json")
  repository=$(jq -er .node_id "$TMPDIR/notification-repository.json")
  jq -es --arg issue "$issue" --arg repository "$repository" '[.[].records[] | select(.stageReceipt.binding.subjectId == $issue)] | if length == 1 then .[0] else error("one issue owner required") end | .result.outcome == "plan-ready" and (.result.fullAssessment | length > 0) and (.result.plan | length > 0) and .stageReceipt.binding.threadId == .threadId and .stageReceipt.binding.repositoryId == $repository and .stageReceipt.binding.worktree == .worktree and .stageReceipt.binding.turnId == .assessmentTurn.runId and .resultTurnId == .assessmentTurn.runId and .sessionCreation.verified == true' "$XDG_CONFIG_HOME/tanaab/agent-system/agent-system-dispatch-v2/"openclaw-dispatch-*.json
done
openclaw agent-system tool worktree -- list | tee "$TMPDIR/notification-worktrees-before.json" | jq -e 'length == 3'

# should preserve all three native owners on a repeat intake scan
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
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
openclaw gateway call sessions.list --params '{"agentId":"intake-tanaabot","limit":100}' --json | jq -e '.hasMore == false and ([.sessions[] | select(.key | startswith("agent:intake-tanaabot:dashboard:agent-system-issue-"))] | length) == 3'
```

## Cleanup

GitHub issues, PRs, branches, and SSH registrations persist beyond the runner. Quiesce the Gateway once before disposing of those resources; the runner owns local files and the mock process.

```bash
# should dispose of this run's persistent github fixtures
openclaw-gateway stop --timeout 340
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/emori"
for slot in 1 2 3; do
  if test -s "$TMPDIR/notification-issue-$slot.json"; then
    number=$(jq -er .number "$TMPDIR/notification-issue-$slot.json")
    openclaw agent-system tool gh -- api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed | jq -e '.state == "closed"'
  fi
done
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-intake/tanaabot"
key_material=$(awk '{print $2}' keys/id_ed25519.pub)
key_id=$(openclaw agent-system tool gh -- api --paginate /user/keys --jq ".[] | select((.key | split(\" \")) | index(\"$key_material\")) | .id")
if test -n "$key_id"; then
  openclaw agent-system tool gh -- api --method DELETE "/user/keys/$key_id"
fi

# should report strict model failures after the final native turn
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
