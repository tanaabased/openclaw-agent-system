# Environment Example

This scenario uses scenario-owned Data workspaces on a fresh runner. It verifies host reference resolution, required-value enforcement, and value-free environment inspection without invoking a model.

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
# should inspect resolved required metadata without exposing values
cd "$GITHUB_WORKSPACE/examples/env/data"
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --json | grep -F '"name": "AGENT_SYSTEM_LEIA_BARE"'
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --json | grep -F '"name": "AGENT_SYSTEM_LEIA_BRACED"'
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --json | grep -F '"required": true'
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --json | grep -F '"staticExecDelivery": "documented-filtered"'
if AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --json | grep -Fq -e 'leia-agent-system-reference' -e 'leia-agent-system-filtered'; then exit 1; fi

# should inspect a registered agent without current workspace discovery
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --agent data --json | grep -F '"agentId": "data"'

# should fail when a required environment variable is absent
cd "$GITHUB_WORKSPACE/examples/env/missing-required"
if missing_output=$(openclaw agent-system env 2>&1); then exit 1; fi
grep -F '[environment-required-missing]' <<< "$missing_output"
```
