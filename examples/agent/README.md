# Agent Example

This scenario runs the prepared Agent System package in the default Gateway with an explicitly installed Data agent. It verifies agent onboarding, manifest loading at `session_start`, current manifest and environment loading for a real `exec`, and redacted lifecycle logging.

## Setup

```bash
# should configure the default profile with the CI model
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice openai-api-key \
  --openai-api-key "$OPENAI_API_KEY" \
  --secret-input-mode plaintext \
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
openclaw models set "openai/$OPENAI_MODEL"

# should allow unattended tool execution on the isolated ephemeral CI runner
openclaw exec-policy preset yolo

# should install and enable the packed plugin
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system

# should install the scenario-owned data workspace through Agent System
cd "$GITHUB_WORKSPACE/examples/agent/data"
openclaw agent-system install

# should start the default Gateway as a supervised background process
(
  exec env AGENT_SYSTEM_LEIA_SOURCE=leia-agent-system-runtime-value OPENCLAW_LOG_LEVEL=debug openclaw gateway run --verbose > "$TMPDIR/gateway.log" 2>&1 < /dev/null
) &
echo "$!" > "$TMPDIR/gateway.pid"
"$GITHUB_WORKSPACE/examples/agent/gateway-process.sh" wait
```

## Testing

```bash
# should load the data manifest when a new session starts
openclaw agent \
  --agent data \
  --session-key agent:data:agent-system-leia \
  --message-file "$GITHUB_WORKSPACE/examples/agent/ready.md" \
  --timeout 120
grep -F 'agent_system.manifest_loaded trigger="session_start" agentId="data"' "$TMPDIR/gateway.log"

# should apply the current manifest to the next exec call in the existing session
cp "$GITHUB_WORKSPACE/examples/agent/agent.changed.yaml" "$GITHUB_WORKSPACE/examples/agent/data/agent.yaml"
changed_digest=$(shasum -a 256 "$GITHUB_WORKSPACE/examples/agent/data/agent.yaml" | cut -c 1-12)
openclaw agent \
  --agent data \
  --session-key agent:data:agent-system-leia \
  --message-file "$GITHUB_WORKSPACE/examples/agent/exec.md" \
  --timeout 120
grep -F 'ENV_OK' "$TMPDIR/agent-system-data-sentinel"
grep -F 'agent_system.manifest_' "$TMPDIR/gateway.log" \
  | grep -F 'trigger="before_tool_call" agentId="data"' \
  | grep -F "$changed_digest"

# should keep manifest values out of Gateway lifecycle logs
if grep -Fq -e 'leia-initial-manifest-value' -e 'leia-changed-manifest-value' -e 'leia-agent-system-runtime-value' "$TMPDIR/gateway.log"; then exit 1; fi
```

## Cleanup

```bash
# should stop the background Gateway cleanly
"$GITHUB_WORKSPACE/examples/agent/gateway-process.sh" stop
```
