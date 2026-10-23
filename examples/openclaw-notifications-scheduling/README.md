# OpenClaw Notification Scheduling Example

Pause and resume the installed notification job through native controls and manifest reconciliation, preserving its native identity, routing, channel readiness, and existing dispatch enrollment.

## What Belongs Here

- Native scheduler enable/disable controls for the installed notification job.
- Manifest pause/resume through Install without another dispatch enrollment.
- Unchanged job identities and routing, with the channel remaining enabled while scheduling is paused.

## What Does Not Belong Here

- Issue admission, concurrent assessment, and duplicate prevention: [intake](../openclaw-notifications-intake/README.md).
- Assignment failures and authority: [assignment policy](../openclaw-notifications-assignment-policy/README.md). Generic prompt/command scheduling: [automations](../openclaw-automations/README.md).

## Notes

- Direct installed commands need one GitHub identity and native dispatch enrollment, without creating issues, PRs, worktrees, or SSH registrations. No model turn runs.
- The 24-hour interval keeps scheduled agent work outside this bounded job. All scheduler and Gateway state belongs to the ephemeral runner.

## Setup

```bash
# should prepare the packed plugin and declared identity pins
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service
owner_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api orgs/tanaabased --jq .node_id)
receiver_node=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api user --jq 'select(.login == "tanaabot") | .node_id')
sed -e "s|__OWNER_NODE_ID__|$owner_node|g" -e "s|__RECEIVER_NODE_ID__|$receiver_node|g" "$GITHUB_WORKSPACE/examples/openclaw-notifications-scheduling/tanaabot/agent.yaml" > "$TMPDIR/notification-agent.yaml"
mv "$TMPDIR/notification-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-notifications-scheduling/tanaabot/agent.yaml"

# should install the notification job with native dispatch enrollment
OPENCLAW_LOG_LEVEL=info openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-notifications-scheduling/tanaabot"
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated")'
openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
```

## Testing

```bash
# should pause and resume the same scheduler job through native and manifest controls
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
