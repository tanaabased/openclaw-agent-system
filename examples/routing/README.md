# GitHub Notification Routing Example

This scenario runs the prepared Agent System package on macOS and Ubuntu. It
installs one read-only GitHub notification route, records the authenticated
assignment baseline without creating GitHub content or a model session, proves
that no baseline assignment starts local work, and removes only the owned routing
state.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE"

# should prepare an isolated notification workspace
mkdir "$TMPDIR/agent-system-notifications"
cp "$GITHUB_WORKSPACE/examples/routing/agent.yaml" "$TMPDIR/agent-system-notifications/agent.yaml"

# should remove inherited setup consent before testing normal installation
openclaw config unset plugins.entries.agent-system.hooks.allowConversationAccess
openclaw config set plugins.entries.agent-system.hooks.timeoutMs 30000

# should report the missing hook prerequisite without granting access
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system credentials set op --from-env
if output="$(openclaw agent-system doctor --json)"; then exit 1; fi
printf '%s\n' "$output" | jq -e '.findings | any(.code == "github-notification-hook-access-required" and .status == "blocked" and (.message | contains("plugins.entries.agent-system.hooks.allowConversationAccess")))'

# should start the default gateway before routing installation
OPENCLAW_NO_RESPAWN=1 openclaw-gateway start

# should install the route and establish the current baseline synchronously
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system credentials set op --from-env
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "updated")'
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-notification-baseline-established")'
printf '%s\n' "$output" | jq -e '.outcomes | any(.code == "github-notification-hook-ready" and .status == "updated")'
openclaw config get plugins.entries.agent-system.hooks --json | jq -e '.allowConversationAccess == true and .timeoutMs == 30000'
openclaw plugins inspect agent-system --runtime --json | jq -e '.policy.allowConversationAccess == true and any(.typedHooks[]; .name == "before_prompt_build")'
openclaw agent-system doctor --json | jq -e '.findings[] | select(.component == "git" and .code == "git-worktrees-root-ready")'
```

## Testing

```bash
# should expose the running connected notification account through the gateway
openclaw-github-notifications wait-route \
  --route-state present \
  --account-id notification-data
openclaw channels status --channel agent-system-github --json | jq -e '(.channelAccounts["agent-system-github"] // []) | any(.accountId == "notification-data" and .configured == true and .enabled == true and .running == true and .connected == true and .healthState == "healthy")'

# should persist one enabled channel account and exact account binding
openclaw config get 'channels.agent-system-github.accounts.notification-data.enabled' | grep -F 'true'
openclaw agents bindings --json | jq -e '[.[] | select(.agentId == "notification-data" and .match.channel == "agent-system-github" and .match.accountId == "notification-data")] | length == 1'
```

```bash
# should retain the install-time baseline during manual refresh
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system notifications refresh --agent notification-data --json | jq -e '.status == "completed" and .baselineAt != null and .baselineEstablished == false'

# should keep baseline assignments free of managed worktrees
cd "$TMPDIR/agent-system-notifications"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree --agent notification-data -- list | jq -e 'length == 0'

# should keep baseline assignments free of local sessions
cd "$TMPDIR/agent-system-notifications"
openclaw sessions --agent notification-data --json | jq -e '(.sessions // []) | length == 0'
```

```bash
# should reconcile explicitly denied hook access through normal install
openclaw-gateway stop
openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess false
cd "$TMPDIR/agent-system-notifications"
if output="$(openclaw agent-system doctor --json)"; then exit 1; fi
printf '%s\n' "$output" | jq -e '.findings | any(.code == "github-notification-hook-access-required" and .status == "blocked")'
openclaw config get plugins.entries.agent-system.hooks --json | jq -e '.allowConversationAccess == false and .timeoutMs == 30000'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "github-notification-hook-ready" and .status == "updated")'
openclaw plugins inspect agent-system --runtime --json | jq -e '.policy.allowConversationAccess == true and any(.typedHooks[]; .name == "before_prompt_build")'
OPENCLAW_NO_RESPAWN=1 openclaw-gateway start

# should keep repeated notification installation unchanged
cd "$TMPDIR/agent-system-notifications"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "github-notification-hook-ready" and .status == "unchanged")'

# should stop the gateway before deterministic routing removal
openclaw-gateway stop

# should remove the owned route and converged private monitor state
cd "$TMPDIR/agent-system-notifications"
cp "$GITHUB_WORKSPACE/examples/routing/disabled-agent.yaml" "$TMPDIR/agent-system-notifications/agent.yaml"
output="$(openclaw agent-system install --json)"
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .status == "removed")'
printf '%s\n' "$output" | jq -e '.outcomes[] | select(.component == "github-notifications" and .code == "github-notification-monitor-state-removed")'

# should start the gateway without the removed notification route
OPENCLAW_NO_RESPAWN=1 openclaw-gateway start
cd "$TMPDIR/agent-system-notifications"
openclaw-github-notifications wait-route \
  --route-state absent \
  --account-id notification-data
if openclaw config get 'channels.agent-system-github.accounts.notification-data.enabled'; then exit 1; fi
openclaw agents bindings --json | jq -e '[.[] | select(.match.channel == "agent-system-github" and .match.accountId == "notification-data")] | length == 0'
openclaw agent-system doctor --json | jq -e '.status == "healthy"'
```

## Cleanup

```bash
# should stop the background gateway cleanly
openclaw-gateway stop
```
