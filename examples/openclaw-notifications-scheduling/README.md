# OpenClaw Notification Scheduling Example

Pause and resume the notification job through native controls and manifest settings.
Verify that its ID, routing, channel readiness, and dispatch enrollment are preserved.

## What Belongs Here

- Native scheduler enable/disable controls for the installed notification job.
- Manifest pause/resume through Install without another dispatch enrollment.
- Unchanged job identities and routing, with the channel remaining enabled while scheduling is paused.

## What Does Not Belong Here

- Issue admission, concurrent assessment, and duplicate prevention: [intake](../openclaw-notifications-intake/README.md).
- Assignment failures and authority: [assignment policy](../openclaw-notifications-assignment-policy/README.md). Generic prompt/command scheduling: [automations](../openclaw-automation-command/README.md).

## Notes

- Direct installed commands need one GitHub identity and native dispatch enrollment, without creating issues, PRs, worktrees, or SSH registrations. No model turn runs.
- Setup, first Install, and scheduling assertions share one fail-fast block. Failed installation retains its output and automation inspection, then stops before dependent checks. CI enables bounded, redacted native rejection evidence for that first attempt.
- The 24-hour interval keeps scheduled agent work outside this bounded job. All scheduler and Gateway state belongs to the ephemeral runner.

## Testing

```bash
# should install and verify pause and resume of the same notification job
set -euo pipefail
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service
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
