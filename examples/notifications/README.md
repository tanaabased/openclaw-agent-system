# GitHub Notification Routing Example

This scenario runs the prepared Agent System package on macOS and Ubuntu. It
installs one read-only GitHub notification route, completes an authenticated empty
baseline without creating GitHub content or a model session, proves that no local
assignment work exists, and removes only the owned routing state.

## Setup

```bash
# should configure an unauthenticated local openclaw profile
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice skip \
  --workspace "$TMPDIR/main" \
  --gateway-bind loopback \
  --skip-daemon \
  --skip-health \
  --skip-bootstrap \
  --skip-channels \
  --skip-hooks \
  --skip-search \
  --skip-skills \
  --skip-ui \
  --suppress-gateway-token-output

# should install and enable the packed plugin
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system

# should prepare an isolated notification workspace
mkdir "$TMPDIR/agent-system-notifications"
cp "$GITHUB_WORKSPACE/examples/notifications/agent.yaml" "$TMPDIR/agent-system-notifications/agent.yaml"

# should start the default gateway before routing installation
(
  exec env OPENCLAW_NO_RESPAWN=1 openclaw gateway run --verbose > "$TMPDIR/gateway.log" 2>&1 < /dev/null
) &
echo "$!" > "$TMPDIR/gateway.pid"
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" wait

# should install the agent and exact notification route through agent system
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system credentials set op --from-env
openclaw agent-system install --json | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "updated")'
openclaw agent-system doctor --json | jq -e '.findings[] | select(.component == "git" and .code == "git-worktrees-root-ready")'
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" wait
```

## Testing

```bash
# should expose the configured notification account through the running gateway
openclaw channels status --json | grep -F 'agent-system-github' | grep -F 'notification-data'

# should persist one enabled channel account and exact account binding
openclaw config get 'channels.agent-system-github.accounts.notification-data.enabled' | grep -F 'true'
openclaw agents bindings --json | grep -F 'agent-system-github' | grep -F 'notification-data'
```

```bash
# should complete one authenticated empty baseline without creating local work
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system notifications refresh --agent notification-data --json | jq -e '.status == "completed"'
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list | jq -e 'length == 0'
openclaw sessions --agent notification-data --json | jq -e '(.sessions // []) | length == 0'
```

```bash
# should keep repeated notification installation unchanged
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system install --json | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "unchanged")'

# should remove the owned route and converged private monitor state
cd "$TMPDIR/agent-system-notifications"
cp "$GITHUB_WORKSPACE/examples/notifications/disabled-agent.yaml" "$TMPDIR/agent-system-notifications/agent.yaml"
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "removed")'
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-notification-monitor-state-removed")'
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" wait
if openclaw config get 'channels.agent-system-github.accounts.notification-data.enabled'; then exit 1; fi
if openclaw agents bindings --json | grep -Fq 'agent-system-github'; then exit 1; fi
openclaw agent-system doctor --json | jq -e '.status == "healthy"'
```

## Cleanup

```bash
# should stop the background gateway cleanly
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" stop
```
