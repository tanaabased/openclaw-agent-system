# Agent Example

This scenario runs the prepared Agent System package in the default Gateway with an explicitly registered Data agent. It verifies manifest loading at `session_start`, cache invalidation at `before_tool_call`, and redacted lifecycle logging.

## Setup

```bash
# should configure the default profile with the CI model
if test -z "$OPENAI_API_KEY"; then echo 'OPENAI_API_KEY is required for the agent example.' >&2; exit 1; fi
if test -z "$OPENAI_MODEL"; then echo 'OPENAI_MODEL is required for the agent example.' >&2; exit 1; fi
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

# should register the scenario-owned data workspace explicitly
cp -R "$GITHUB_WORKSPACE/examples/agent/data" "$TMPDIR/data"
openclaw agents add data --workspace "$TMPDIR/data" --model "openai/$OPENAI_MODEL" --non-interactive

# should install and enable the packed plugin
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system

# should start the default Gateway as a supervised background process
(
  exec env OPENCLAW_LOG_LEVEL=debug openclaw gateway run --verbose > "$TMPDIR/gateway.log" 2>&1 < /dev/null
) &
echo "$!" > "$TMPDIR/gateway.pid"
"$GITHUB_WORKSPACE/examples/agent/gateway-process.sh" wait
```

## Testing

```bash
# should resolve and validate the configured data agent workspace
openclaw agent-system validate --agent data | grep -F 'valid: Agent System manifest for data'

# should load the data manifest when a new session starts
set -o pipefail
openclaw agent \
  --agent data \
  --session-key agent:data:agent-system-leia \
  --message-file "$GITHUB_WORKSPACE/examples/agent/ready.md" \
  --timeout 120 \
  --json | tee "$TMPDIR/ready.json"
grep -F 'DATA_READY' "$TMPDIR/ready.json"
"$GITHUB_WORKSPACE/examples/agent/gateway-process.sh" wait-log 'agent_system.manifest_loaded trigger="session_start" agentId="data"'

# should reload a changed manifest before a tool call in the existing session
cp "$GITHUB_WORKSPACE/examples/agent/agent.changed.yaml" "$TMPDIR/data/agent.yaml"
set -o pipefail
openclaw agent \
  --agent data \
  --session-key agent:data:agent-system-leia \
  --message-file "$GITHUB_WORKSPACE/examples/agent/exec.md" \
  --timeout 120 \
  --json | tee "$TMPDIR/tool.json"
grep -F 'DATA_TOOL_OK' "$TMPDIR/agent-system-data-sentinel"
"$GITHUB_WORKSPACE/examples/agent/gateway-process.sh" wait-log 'agent_system.manifest_changed trigger="before_tool_call" agentId="data"'

# should keep manifest values out of Gateway lifecycle logs
if grep -Fq 'leia-initial-manifest-value' "$TMPDIR/gateway.log"; then exit 1; fi
if grep -Fq 'leia-changed-manifest-value' "$TMPDIR/gateway.log"; then exit 1; fi
```

## Cleanup

```bash
# should stop the background Gateway cleanly
"$GITHUB_WORKSPACE/examples/agent/gateway-process.sh" stop
```
