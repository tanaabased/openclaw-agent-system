# Environment Example

This scenario uses scenario-owned workspaces on a fresh runner. It verifies ordered dotenv, 1Password Environment, and direct secret resolution; host references; required-value enforcement; and value-free environment inspection without invoking a model.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE"

# should install the scenario-owned data workspace through agent system
cd "$GITHUB_WORKSPACE/examples/env/data"
openclaw agent-system install
```

## Testing

```bash
# should inspect resolved host and dotenv metadata without exposing values
cd "$GITHUB_WORKSPACE/examples/env/data"
output="$(AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --json)"
printf '%s\n' "$output" | jq -e '.variables | any(.name == "AGENT_SYSTEM_LEIA_BARE")'
printf '%s\n' "$output" | jq -e '.variables | any(.name == "AGENT_SYSTEM_LEIA_BRACED")'
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env | grep -F 'AGENT_SYSTEM_LEIA_LAYERED' | grep -F 'source=environment.dotenv[1]' | grep -F 'required=false' | grep -F 'overridden=1'
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env | grep -F 'AGENT_SYSTEM_LEIA_SET_OVERRIDE' | grep -F 'source=environment.set' | grep -F 'required=false' | grep -F 'overridden=1'
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env | grep -F 'AGENT_SYSTEM_LEIA_FROM_DOTENV' | grep -F 'source=environment.set' | grep -F 'required=true' | grep -F 'overridden=0'
printf '%s\n' "$output" | jq -e '.variables | any(.required == true)'
printf '%s\n' "$output" | jq -e '[.. | objects | has("values")] | all(. == false)'
if printf '%s\n' "$output" | grep -Fq -e 'leia-agent-system-reference' -e 'leia-agent-system-private-'; then exit 1; fi

# should inspect a registered agent without current workspace discovery
AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-reference openclaw agent-system env --agent data --json | jq -e '.agentId == "data"'

# should fail when a required environment variable is absent
cd "$GITHUB_WORKSPACE/examples/env/missing-required"
if output=$(openclaw agent-system env 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=environment-required-missing'

# should resolve live 1password environments and direct secrets without exposing values or the bootstrap token
cd "$GITHUB_WORKSPACE/examples/env/onepassword"
output="$(openclaw agent-system env --json)"
printf '%s\n' "$output" | jq -e '.variables | any(.name == "VIBES" and .source == "environment.op[0]")'
printf '%s\n' "$output" | jq -e '.variables | any(.name == "OP_SSH_KEY" and .source == "environment.set" and .required == true)'
printf '%s\n' "$output" | jq -e '[.. | objects | has("values")] | all(. == false)'
if printf '%s\n' "$output" | grep -Fq "$OP_SERVICE_ACCOUNT_TOKEN"; then exit 1; fi

# should validate access to every declared 1password resource without returning values
cd "$GITHUB_WORKSPACE/examples/env/onepassword"
openclaw agent-system credentials validate op --from-env | grep -F 'environments' | grep -F '1'
openclaw agent-system credentials validate op --from-env | grep -F 'secrets' | grep -F '1'
```
