# GitHub Notification Routing Example

This scenario runs the prepared Agent System package in the default Gateway and verifies the notification channel foundation: manifest prerequisites, exact account-scoped routing installation, managed-worktree lifecycle installation, idempotency, one authenticated observe-only GitHub baseline, live Gateway config convergence, and owned cleanup. It does not run an agent turn or write to GitHub.

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

# should complete one authenticated observe-only baseline without a local agent turn
cd "$TMPDIR/agent-system-notifications"
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18; do
  if openclaw agent-system doctor --json | jq -e '.findings[] | select(.component == "github-notifications" and .code == "github-notification-monitor-healthy")'; then
    break
  fi
  if test "$attempt" = 18; then
    tail -n 100 "$TMPDIR/gateway.log"
    exit 1
  fi
  sleep 5
done

# should keep repeated notification installation unchanged
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system install --json | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "unchanged")'

# should remove only the owned route when notifications leave the manifest
cp "$GITHUB_WORKSPACE/examples/notifications/disabled-agent.yaml" "$TMPDIR/agent-system-notifications/agent.yaml"
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system install --json | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "removed")'
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
