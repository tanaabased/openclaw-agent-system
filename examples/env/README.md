# Environment Example

This scenario uses a scenario-owned Data agent on a fresh runner. It verifies value-free environment inspection without invoking a model.

## Setup

```bash
# should configure an unauthenticated local OpenClaw profile
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

# should install the scenario-owned data workspace through Agent System
cd "$GITHUB_WORKSPACE/examples/env/data"
openclaw agent-system install
```

## Testing

```bash
# should inspect literal environment metadata without exposing values
cd "$GITHUB_WORKSPACE/examples/env/data"
openclaw agent-system env --json | paste -sd ' ' | grep -F '"name": "AGENT_SYSTEM_LEIA_VISIBLE"' | grep -F '"name": "GITHUB_TOKEN"' | grep -Fv -e 'leia-agent-system-visible' -e 'leia-agent-system-filtered'

# should inspect a registered agent without current workspace discovery
openclaw agent-system env --agent data --json | grep -F '"agentId": "data"'
```
