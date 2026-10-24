# OpenClaw Tool Access Example

Add configured capabilities to an installed agent, reconcile its native tool grants, enforce operator denials, and remove stale owned grants when those capabilities disappear.

## What Belongs Here

- Additive grants and exact allowlists preserve unrelated operator access.
- Doctor detects tool-access drift and operator denials; Install reconciles only permitted access.
- Converged installation stays unchanged, and removed capabilities lose their owned grants.

## What Does Not Belong Here

- General inspection and identity repair: [Doctor](../openclaw-doctor/README.md).
- Tool execution and contextual shims: [tools](../openclaw-tools/README.md).

## Notes

- Direct checks use the packed plugin without a model, Gateway, or provider credential. The configured capabilities select tools without executing them.
- The workspace runs in place. A temporary manifest baseline allows the final check to remove capabilities while retaining native access state from the preceding checks.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"

# should install the disposable tool access workspace through agent system
cp "$GITHUB_WORKSPACE/examples/openclaw-tool-access/data/agent.yaml" "$TMPDIR/tool-access-base.yaml"
cd "$GITHUB_WORKSPACE/examples/openclaw-tool-access/data"
openclaw agent-system install
```

## Testing

```bash
# should reconcile additive native tool grants while preserving unrelated access
openclaw config set 'agents.entries.tool-access-data.tools.alsoAllow' '["message"]' --strict-json
cp "$GITHUB_WORKSPACE/examples/openclaw-tool-access/with-tools.yaml" "$GITHUB_WORKSPACE/examples/openclaw-tool-access/data/agent.yaml"
cd "$GITHUB_WORKSPACE/examples/openclaw-tool-access/data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.tool-access-data.tools.alsoAllow' --json | jq -e 'index("message") != null'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should reconcile selected native tools through an exact allowlist
openclaw config unset 'agents.entries.tool-access-data.tools.alsoAllow'
openclaw config set 'agents.entries.tool-access-data.tools.allow' '["read"]' --strict-json
cd "$GITHUB_WORKSPACE/examples/openclaw-tool-access/data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.tool-access-data.tools.allow' --json | jq -e 'index("read") != null'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should leave converged native tool access unchanged
cd "$GITHUB_WORKSPACE/examples/openclaw-tool-access/data"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "agent-tool-access-unchanged")'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should block a selected native tool denied by operator policy
openclaw config set 'agents.entries.tool-access-data.tools.deny' '["agent_system_github"]' --strict-json
cd "$GITHUB_WORKSPACE/examples/openclaw-tool-access/data"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.findings | any(.component == "tool-access" and .status == "blocked" and .code == "agent-tool-access-denied" and (.message | contains("agent_system_github")))'
if output=$(openclaw agent-system install --json 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=agent-tool-access-denied'
```

```bash
# should remove stale owned grants when capabilities disappear
openclaw config set 'agents.entries.tool-access-data.tools.deny' '[]' --strict-json
cp "$TMPDIR/tool-access-base.yaml" "$GITHUB_WORKSPACE/examples/openclaw-tool-access/data/agent.yaml"
cd "$GITHUB_WORKSPACE/examples/openclaw-tool-access/data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.tool-access-data.tools' --json | jq -e '(.allow | sort) == (["read", "agent_system_install", "agent_system_doctor"] | sort) and (has("alsoAllow") | not)'
```
