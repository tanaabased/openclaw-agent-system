# Install Example

This scenario installs the prepared Agent System package on a fresh GitHub Actions runner and verifies explicit lifecycle installation, human output, JSON output, idempotency, and manifest-derived native tool access reconciliation.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE"

# should prepare an isolated install workspace
mkdir -p "$TMPDIR/install-data"
cp "$GITHUB_WORKSPACE/examples/install/data/agent.yaml" "$TMPDIR/install-data/agent.yaml"
```

## Testing

```bash
# should expose the canonical command tree and its alias
openclaw agent-system --help | grep -F 'validate'
openclaw as --help | grep -F 'validate'

# should install the scenario agent with the default human lifecycle table
cd "$TMPDIR/install-data"
openclaw agent-system install | grep -F 'created' | grep -F 'agent' | grep -F 'OpenClaw agent install-data'

# should report every foundational component as unchanged in json on repeated install
cd "$TMPDIR/install-data"
output=$(openclaw agent-system install --json)
printf '%s\n' "$output" | jq -e '.outcomes | (any(.component == "agent" and .status == "unchanged") and any(.component == "path" and .status == "unchanged"))'
```

```bash
# should reconcile additive native tool grants while preserving unrelated access
openclaw config set 'agents.entries.install-data.tools.alsoAllow' '["message"]' --strict-json
cp "$GITHUB_WORKSPACE/examples/install/with-tools/agent.yaml" "$TMPDIR/install-data/agent.yaml"
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.install-data.tools.alsoAllow' --json | jq -e 'index("message") != null'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should reconcile selected native tools through an exact allowlist
openclaw config unset 'agents.entries.install-data.tools.alsoAllow'
openclaw config set 'agents.entries.install-data.tools.allow' '["read"]' --strict-json
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.install-data.tools.allow' --json | jq -e 'index("read") != null'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should leave converged native tool access unchanged
cd "$TMPDIR/install-data"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "agent-tool-access-unchanged")'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should block a selected native tool denied by operator policy
openclaw config set 'agents.entries.install-data.tools.deny' '["agent_system_github"]' --strict-json
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'blocked' | grep -F 'tool-access' | grep -F 'agent_system_github'
if output=$(openclaw agent-system install --json 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=agent-tool-access-denied'
```

```bash
# should remove stale owned grants when capabilities disappear
openclaw config set 'agents.entries.install-data.tools.deny' '[]' --strict-json
cp "$GITHUB_WORKSPACE/examples/install/data/agent.yaml" "$TMPDIR/install-data/agent.yaml"
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.install-data.tools' --json | jq -e '.allow == ["read"] and (has("alsoAllow") | not)'
```

```bash
# should create main when the host roster is explicitly empty
openclaw config set agents.entries '{}' --strict-json --replace
mkdir -p "$TMPDIR/install-main"
cp "$GITHUB_WORKSPACE/examples/install/main/agent.yaml" "$TMPDIR/install-main/agent.yaml"
cd "$TMPDIR/install-main"
openclaw agent-system install --json | jq -e '.outcomes | any(.component == "agent" and .code == "add-agent" and .status == "created")'
openclaw agents list --json | jq -e 'any(.id == "main")'
```
