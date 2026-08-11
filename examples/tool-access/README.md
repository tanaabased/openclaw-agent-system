# Tool Access Example

This scenario installs the prepared Agent System package and verifies manifest-derived native tool access, doctor drift detection, preservation, removal, and idempotency through public commands.

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
```

```bash
# should install and enable the packed plugin
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system
```

```bash
# should install the scenario agent without managed tool capabilities
mkdir -p "$TMPDIR/tool-access"
cp "$GITHUB_WORKSPACE/examples/tool-access/without-tools/agent.yaml" "$TMPDIR/tool-access/agent.yaml"
cd "$TMPDIR/tool-access"
openclaw agent-system install
openclaw config set 'agents.list[0].tools.alsoAllow' '["message"]' --strict-json
```

## Testing

```bash
# should detect and reconcile all manifest-derived grants while preserving unrelated access
cp "$GITHUB_WORKSPACE/examples/tool-access/with-tools/agent.yaml" "$TMPDIR/tool-access/agent.yaml"
cd "$TMPDIR/tool-access"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | grep -F '"code": "set-agent-tool-access"'
openclaw config get 'agents.list[0].tools.alsoAllow' --json | jq -c . | grep -Fx '["message","agent_system_git","agent_system_git_worktree","agent_system_github"]'
```

```bash
# should leave converged native tool access unchanged on repeated install
cd "$TMPDIR/tool-access"
openclaw agent-system install --json | grep -F '"code": "agent-tool-access-unchanged"'
openclaw agent-system doctor --json | grep -F '"code": "agent-tool-access-ready"'
```

```bash
# should detect and remove stale owned grants when capabilities disappear
cp "$GITHUB_WORKSPACE/examples/tool-access/without-tools/agent.yaml" "$TMPDIR/tool-access/agent.yaml"
cd "$TMPDIR/tool-access"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | grep -F '"code": "set-agent-tool-access"'
openclaw config get 'agents.list[0].tools.alsoAllow' --json | jq -c . | grep -Fx '["message"]'
```
