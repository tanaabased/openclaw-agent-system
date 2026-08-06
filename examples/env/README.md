# Environment Example

This scenario uses scenario-owned workspaces on a fresh runner. It verifies ordered dotenv and 1Password Environment resolution, host references, required-value enforcement, and value-free environment inspection without invoking a model.

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

# should install the scenario-owned data workspace through agent system
cd "$GITHUB_WORKSPACE/examples/env/data"
openclaw agent-system install
```

## Testing

```bash
# should inspect resolved host and dotenv metadata without exposing values
cd "$GITHUB_WORKSPACE/examples/env/data"
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --json | grep -F '"name": "AGENT_SYSTEM_LEIA_BARE"'
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --json | grep -F '"name": "AGENT_SYSTEM_LEIA_BRACED"'
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env | grep -F 'AGENT_SYSTEM_LEIA_LAYERED source=environment.dotenv[1] required=false overridden=1'
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env | grep -F 'AGENT_SYSTEM_LEIA_SET_OVERRIDE source=environment.set required=false overridden=1'
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env | grep -F 'AGENT_SYSTEM_LEIA_FROM_DOTENV source=environment.set required=true overridden=0'
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --json | grep -F '"required": true'
if AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --json | grep -Fq -e 'leia-agent-system-reference' -e 'leia-agent-system-private-'; then exit 1; fi

# should inspect a registered agent without current workspace discovery
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --agent data --json | grep -F '"agentId": "data"'

# should fail when a required environment variable is absent
cd "$GITHUB_WORKSPACE/examples/env/missing-required"
if openclaw agent-system env; then exit 1; fi
openclaw agent-system env 2>&1 | grep -F '[environment-required-missing]'

# should resolve a live 1password environment without exposing values or its bootstrap token
cd "$GITHUB_WORKSPACE/examples/env/onepassword"
openclaw agent-system env --json | grep -F '"name": "VIBES"'
openclaw agent-system env --json | grep -F '"source": "environment.op[0]"'
openclaw agent-system env --json | grep -F '"required": true'
if openclaw agent-system env --json | grep -Fq -e '"values":' -e "$OP_SERVICE_ACCOUNT_TOKEN"; then exit 1; fi
```
