# Install Example

This scenario installs the prepared Agent System package on a fresh GitHub Actions runner and verifies explicit lifecycle installation, human output, JSON output, and idempotency.

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

# should install and enable the packed plugin through openclaw's managed npm package path
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system
```

## Testing

```bash
# should load the packed runtime from dist
openclaw plugins inspect agent-system --runtime --json | grep -F '"id": "agent-system"'
openclaw plugins inspect agent-system --runtime --json | grep -F 'dist/index.js'

# should expose the canonical command tree and its alias
openclaw agent-system --help | grep -F 'validate'
openclaw as --help | grep -F 'validate'

# should install the scenario agent with the default human lifecycle table
cd "$GITHUB_WORKSPACE/examples/install/data"
openclaw agent-system install | grep -F 'created' | grep -F 'agent' | grep -F 'OpenClaw agent install-data'

# should report every foundational component as unchanged in json on repeated install
cd "$GITHUB_WORKSPACE/examples/install/data"
openclaw agent-system install --json | grep -F '"component": "agent"'
openclaw agent-system install --json | grep -F '"component": "path"'
openclaw agent-system install --json | grep -F '"status": "unchanged"'
```
