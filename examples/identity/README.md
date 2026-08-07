# Identity Example

This scenario installs the prepared Agent System package on a fresh runner and verifies that install resolves an environment-backed display name from the completed Agent System environment.

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
```

## Testing

```bash
# should install an agent with its display name resolved from the agent environment
cd "$GITHUB_WORKSPACE/examples/identity/data"
openclaw agent-system install
openclaw agents list --json | grep -F '"id": "identity-data"'
openclaw agents list --json | grep -F '"identityName": "Data from environment"'
```
