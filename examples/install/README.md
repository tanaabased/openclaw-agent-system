# Install Example

This scenario installs the prepared Agent System package on a fresh GitHub Actions runner and verifies explicit lifecycle installation, human output, JSON output, idempotency, and manifest-derived native tool access reconciliation.

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

# should prepare an isolated install workspace
mkdir -p "$TMPDIR/install-data"
cp "$GITHUB_WORKSPACE/examples/install/data/agent.yaml" "$TMPDIR/install-data/agent.yaml"
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
cd "$TMPDIR/install-data"
openclaw agent-system install | grep -F 'created' | grep -F 'agent' | grep -F 'OpenClaw agent install-data'

# should report every foundational component as unchanged in json on repeated install
cd "$TMPDIR/install-data"
output=$(openclaw agent-system install --json)
printf '%s\n' "$output" | grep -F '"component": "agent"'
printf '%s\n' "$output" | grep -F '"component": "path"'
printf '%s\n' "$output" | grep -F '"status": "unchanged"'
```

```bash
# should reconcile additive native tool grants while preserving unrelated access
agent_index="$(openclaw config get agents.list --json | jq -er 'map(.id) | index("install-data")')"
openclaw config set "agents.list[$agent_index].tools.alsoAllow" '["message"]' --strict-json
cp "$GITHUB_WORKSPACE/examples/install/with-tools/agent.yaml" "$TMPDIR/install-data/agent.yaml"
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | grep -F '"code": "set-agent-tool-access"'
openclaw config get "agents.list[$agent_index].tools.alsoAllow" --json | jq -e 'index("message") != null'
openclaw agent-system doctor --json | grep -F '"code": "agent-tool-access-ready"'
```

```bash
# should reconcile selected native tools through an exact allowlist
agent_index="$(openclaw config get agents.list --json | jq -er 'map(.id) | index("install-data")')"
openclaw config unset "agents.list[$agent_index].tools.alsoAllow"
openclaw config set "agents.list[$agent_index].tools.allow" '["read"]' --strict-json
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | grep -F '"code": "set-agent-tool-access"'
openclaw config get "agents.list[$agent_index].tools.allow" --json | jq -e 'index("read") != null'
openclaw agent-system doctor --json | grep -F '"code": "agent-tool-access-ready"'
```

```bash
# should leave converged native tool access unchanged
cd "$TMPDIR/install-data"
openclaw agent-system install --json | grep -F '"code": "agent-tool-access-unchanged"'
openclaw agent-system doctor --json | grep -F '"code": "agent-tool-access-ready"'
```

```bash
# should block a selected native tool denied by operator policy
agent_index="$(openclaw config get agents.list --json | jq -er 'map(.id) | index("install-data")')"
openclaw config set "agents.list[$agent_index].tools.deny" '["agent_system_github"]' --strict-json
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'blocked' | grep -F 'tool-access' | grep -F 'agent_system_github'
if output=$(openclaw agent-system install --json 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=agent-tool-access-denied'
```

```bash
# should remove stale owned grants when capabilities disappear
agent_index="$(openclaw config get agents.list --json | jq -er 'map(.id) | index("install-data")')"
openclaw config set "agents.list[$agent_index].tools.deny" '[]' --strict-json
cp "$GITHUB_WORKSPACE/examples/install/data/agent.yaml" "$TMPDIR/install-data/agent.yaml"
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | grep -F '"code": "set-agent-tool-access"'
openclaw config get "agents.list[$agent_index].tools" --json | jq -e '.allow == ["read"] and (has("alsoAllow") | not)'
```
