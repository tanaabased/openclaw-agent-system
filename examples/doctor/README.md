# Doctor Example

This scenario installs the prepared Agent System package and verifies healthy, drifted, and repaired foundational lifecycle state through the public doctor and install commands.

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
```
