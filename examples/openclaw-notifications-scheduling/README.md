# OpenClaw Notification Scheduling Example

Pause and resume the notification job through native controls and manifest settings.
Verify that its ID, routing, channel readiness, and dispatch enrollment are preserved.
Enroll a project pickup job, retain its identity across pause/resume, and verify pickup authorization through OpenClaw-hosted Codex.

## What Belongs Here

- Pickup enrollment against disposable milestones, with repeated Install and Doctor readback.
- Hosted Codex invoking the activated pickup tool through the native automation boundary.
- Native scheduler enable/disable controls for the installed notification job.
- Manifest pause/resume through Install without another dispatch enrollment.
- Unchanged job identities and routing, with the channel remaining enabled while scheduling is paused.

## What Does Not Belong Here

- Issue admission, concurrent assessment, and duplicate prevention: [intake](../openclaw-notifications-intake/README.md).
- Assignment failures and authority: [assignment policy](../openclaw-notifications-assignment-policy/README.md). Generic prompt/command scheduling: [automations](../openclaw-automation-command/README.md).

## Notes

- Direct installed commands need one GitHub identity and native dispatch enrollment, without creating issues, PRs, worktrees, or SSH registrations. Pickup creates two disposable milestones in `tanaabased/big-test-bucket`. Strict AIMock turns invoke the native pickup job through embedded OpenClaw and hosted Codex against empty milestones and requires its quiet response; the tool, scheduler, provider reads and journal are real. It does not establish unattended timing or assignment-to-PR delivery.
- Setup, first Install, and scheduling assertions share one fail-fast block. Failed installation retains its output and automation inspection, then stops before dependent checks. CI enables bounded, redacted native rejection evidence for that first attempt.
- The pickup fixture has one daily midnight slot and a 24-hour window for forced authorization checks. All scheduler and Gateway state belongs to the ephemeral runner.

## Testing

```bash
# should install and verify pause and resume of the same notification job
set -euo pipefail
export OPENAI_API_KEY=agent-system-aimock-test
export NODE_OPTIONS="--import=$GITHUB_WORKSPACE/examples/openclaw-notifications-scheduling/catalog-fixture.mjs"
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --model openai/gpt-5.4-nano --yolo
openclaw-aimock prepare --scenario openclaw-notifications-scheduling
openclaw config set models.mode merge
openclaw config set memory.search.enabled false --strict-json
openclaw config set plugins.entries.codex.config.codexDynamicToolsLoading direct
openclaw config set plugins.entries.codex.config.appServer.args '["-c","openai_base_url=\"http://127.0.0.1:4010/v1\"","app-server","--listen","stdio://"]' --strict-json
owner_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id)
receiver_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id')
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__RECEIVER_NODE_ID__|$receiver_node|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-scheduling/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-scheduling/tanaabot/agent.yaml"
OPENCLAW_LOG_LEVEL=info openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-scheduling/tanaabot"
install_status=0
OPENCLAW_DEBUG=1 openclaw agent-system install --yes --json > "$TMPDIR/scheduling-install.json" 2> "$TMPDIR/scheduling-install.stderr" || install_status=$?
cat "$TMPDIR/scheduling-install.json" "$TMPDIR/scheduling-install.stderr"
if test "$install_status" -ne 0; then
  list_status=0
  openclaw agent-system automations list --json > "$TMPDIR/scheduling-install-jobs.json" || list_status=$?
  printf 'automation inspection after failed install exited %s\n' "$list_status" >&2
  cat "$TMPDIR/scheduling-install-jobs.json" >&2
  exit "$install_status"
fi
jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated")' "$TMPDIR/scheduling-install.json"
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-scheduling/tanaabot"
openclaw agent-system automations list --json > "$TMPDIR/intake-before-pause.json"
native=$(jq -er '.jobs[] | select(.id == "github-issue-assignment") | .nativeId' "$TMPDIR/intake-before-pause.json")
openclaw cron edit "$native" --disable --json | jq -e '.enabled == false'
openclaw cron edit "$native" --enable --json | jq -e '.enabled == true'
cp agent.yaml "$TMPDIR/intake-active-agent.yaml"
sed 's/  issue-assignment:/  issue-assignment:\n    paused: true/' "$TMPDIR/intake-active-agent.yaml" > agent.yaml
openclaw agent-system install --yes --json | jq -e 'all(.outcomes[]; .code != "session-dispatch-enrolled")'
openclaw agent-system automations list --json | jq -e --arg id "$native" 'any(.jobs[]; .id == "github-issue-assignment" and .nativeId == $id and .nativeEnabled == false)'
openclaw config get channels.agent-system-github --json | jq -e '.accounts["scheduling-tanaabot"].enabled == true'
cp "$TMPDIR/intake-active-agent.yaml" agent.yaml
openclaw agent-system install --yes --json | jq -e 'all(.outcomes[]; .code != "session-dispatch-enrolled")'
openclaw agent-system automations list --json | jq -e --arg id "$native" 'any(.jobs[]; .id == "github-issue-assignment" and .nativeId == $id and .nativeEnabled == true)'
jq -S '[.jobs[] | {id, nativeId, routing}]' "$TMPDIR/intake-before-pause.json" > "$TMPDIR/intake-identities-before.json"
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id, nativeId, routing}]' | diff - "$TMPDIR/intake-identities-before.json"
```

## Testing Pickup

```bash
# should enroll and pause the same pickup job through install
set -euo pipefail
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-scheduling/tanaabot"
milestone=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api --method POST repos/tanaabased/big-test-bucket/milestones -f title="pickup-scheduling-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --jq .number)
printf '%s\n' "$milestone" > "$TMPDIR/pickup-scheduling-milestone"
sed -e "s|__MILESTONE_NUMBER__|$milestone|g" -e 's/^/  /' "$GITHUB_WORKSPACE/examples/openclaw-notifications-scheduling/pickup.yaml" >> agent.yaml
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .stepId == "github-project-pickup" and .status == "created")'
openclaw agent-system automations list --json > "$TMPDIR/pickup-scheduling-jobs.json"
pickup=$(jq -er '.jobs[] | select(.id == "github-project-pickup" and .nativeEnabled == true) | .nativeId' "$TMPDIR/pickup-scheduling-jobs.json")
pickup_chat=$(jq -er '.jobs[] | select(.id == "github-project-pickup") | .routing | select(startswith("session:"))' "$TMPDIR/pickup-scheduling-jobs.json")
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .stepId == "github-project-pickup" and .status == "unchanged")'
openclaw agent-system automations list --json | jq -e --arg chat "$pickup_chat" 'any(.jobs[]; .id == "github-project-pickup" and .routing == $chat)'
openclaw agent-system doctor --json | jq -e 'any(.findings[]; .code == "project-pickup-ready")'
run_id=$(openclaw agent-system automations run github-project-pickup --json | jq -er 'select(.status == "queued") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" github-project-pickup "$run_id"
openclaw-aimock evidence --scenario openclaw-notifications-scheduling --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-notifications-scheduling/expected-evidence.json"
cp agent.yaml "$TMPDIR/pickup-active-agent.yaml"
sed 's/  project-pickup:/  project-pickup:\n    paused: true/' "$TMPDIR/pickup-active-agent.yaml" > agent.yaml
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .stepId == "github-project-pickup" and .status == "updated")'
openclaw agent-system automations list --json | jq -e --arg id "$pickup" 'any(.jobs[]; .id == "github-project-pickup" and .nativeId == $id and .nativeEnabled == false)'
cp "$TMPDIR/pickup-active-agent.yaml" agent.yaml
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .stepId == "github-project-pickup" and .status == "updated")'
openclaw agent-system automations list --json | jq -e --arg id "$pickup" '[.jobs[] | select(.id == "github-project-pickup")] | length == 1 and .[0].nativeId == $id and .[0].nativeEnabled == true'
```

## Testing Hosted Codex

```bash
# should authorize pickup through the hosted codex automation adapter
set -euo pipefail
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-scheduling/tanaabot"
milestone=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api --method POST repos/tanaabased/big-test-bucket/milestones -f title="pickup-codex-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --jq .number)
printf '%s\n' "$milestone" > "$TMPDIR/pickup-codex-milestone"
mkdir -p "$TMPDIR/pickup-codex"
bun -e 'import {parse,stringify} from "yaml"; const config=parse(await Bun.file("agent.yaml").text()); config.agent.id="scheduling-codex-tanaabot"; config.agent.runtime="codex"; config.models.default.model="openai/gpt-5.4-nano"; config.github["project-pickup"].projects[0].milestone.number=Number(process.argv[1]); await Bun.write(process.argv[2], stringify(config));' "$milestone" "$TMPDIR/pickup-codex/agent.yaml"
cd "$TMPDIR/pickup-codex"
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .stepId == "github-project-pickup" and .status == "created")'
openclaw gateway call models.list --params '{"agentId":"scheduling-codex-tanaabot","provider":"openai","view":"all","refresh":true}' --json | jq -e 'any(.models[]; .id == "gpt-5.4-nano" and .available == true and .agentRuntime.id == "codex")'
run_id=$(openclaw agent-system automations run github-project-pickup --json | jq -er 'select(.status == "queued") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" github-project-pickup "$run_id"
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.scenario == "openclaw-notifications-scheduling" and .strictMissCount == 0 and .finalResponseCount == 2 and any(.tools[]; .name == "agent_system_intake" and .callResponseCount == 2 and .resultRequestCount == 2)'
```

## Cleanup

```bash
# should quiesce the gateway before deleting the disposable pickup milestone
set -euo pipefail
openclaw-gateway stop --timeout 340
for saved in "$TMPDIR/pickup-scheduling-milestone" "$TMPDIR/pickup-codex-milestone"; do
  if test -f "$saved"; then
    milestone=$(cat "$saved")
    GH_TOKEN="$GH_TOKEN_TANAABOT" gh api --method DELETE "repos/tanaabased/big-test-bucket/milestones/$milestone"
  fi
done
```
