# Doctor Example

This scenario installs the prepared Agent System package and verifies foundational lifecycle state and notification-hook prerequisites through the public doctor and install commands.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE"

# should install the scenario-owned workspace through agent system
cd "$GITHUB_WORKSPACE/examples/doctor/data"
openclaw agent-system install
```

## Testing

```bash
# should report healthy agent and path state in the default human table
cd "$GITHUB_WORKSPACE/examples/doctor/data"
openclaw agent-system doctor | grep -F 'healthy' | grep -F 'agent'
openclaw agent-system doctor | grep -F 'healthy' | grep -F 'path'

# should report the same healthy aggregate state as structured json
cd "$GITHUB_WORKSPACE/examples/doctor/data"
openclaw agent-system doctor --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'

# should detect public identity drift with a failing exit code
cd "$GITHUB_WORKSPACE/examples/doctor/data"
openclaw agents set-identity \
  --agent doctor-data \
  --workspace "$GITHUB_WORKSPACE/examples/doctor/data" \
  --name Drifted \
  --json
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'agent'

# should repair identity drift through install and return doctor to healthy state
cd "$GITHUB_WORKSPACE/examples/doctor/data"
openclaw agent-system install --json | jq -e '.outcomes | any(.status == "updated")'
openclaw agent-system doctor --json | jq -e '.status == "healthy"'

# should report unset and denied notification hook access without changing configuration
openclaw agents add hook-doctor-data --workspace "$GITHUB_WORKSPACE/examples/doctor/hook-data" --non-interactive --json
for state in unset false; do
  if [ "$state" = unset ]; then
    openclaw config unset plugins.entries.agent-system.hooks.allowConversationAccess
  else
    openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess false
  fi
  before="$(openclaw config get plugins.entries.agent-system --json | jq -cS .)"
  if output="$(openclaw agent-system doctor --agent hook-doctor-data --json)"; then exit 1; fi
  printf '%s\n' "$output" | jq -e '.findings | any(.code == "github-notification-hook-access-required" and .status == "blocked" and (.message | contains("plugins.entries.agent-system.hooks.allowConversationAccess")) and (.remediation | contains("openclaw agent-system install")))'
  test "$(openclaw config get plugins.entries.agent-system --json | jq -cS .)" = "$before"
  openclaw plugins inspect agent-system --runtime --json | jq -e 'all(.typedHooks[]; .name != "before_prompt_build")'
done

# should report healthy hook access when the required hooks are registered
openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess true
before="$(openclaw config get plugins.entries.agent-system --json | jq -cS .)"
output="$(openclaw agent-system doctor --agent hook-doctor-data --json || true)"
printf '%s\n' "$output" | jq -e '.findings | any(.code == "github-notification-hook-ready" and .status == "healthy")'
test "$(openclaw config get plugins.entries.agent-system --json | jq -cS .)" = "$before"
openclaw plugins inspect agent-system --runtime --json | jq -e '.policy.allowConversationAccess == true and any(.typedHooks[]; .name == "before_prompt_build") and any(.typedHooks[]; .name == "before_agent_run")'
```
