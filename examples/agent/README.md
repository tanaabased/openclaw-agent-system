# Agent Example

This scenario runs the prepared Agent System package in the default Gateway with an explicitly installed agent and a strict AIMock fixture. It verifies agent onboarding, passive Gateway manifest loading, read-only model routing, and value-free lifecycle logging without depending on live model behavior.

## Setup

```bash
# should configure the default profile with the prepared plugin and strict mock model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"
openclaw-aimock prepare --scenario agent

# should install the scenario-owned data workspace through agent system
cd "$GITHUB_WORKSPACE/examples/agent/data"
openclaw agent-system install

# should start the default gateway as a supervised background process
openclaw-gateway start --debug
```

## Testing

```bash
# should start an explicitly installed data-agent session without tools
openclaw agent \
  --agent data \
  --session-key agent:data:agent-system-leia \
  --message-file "$GITHUB_WORKSPACE/examples/agent/ready.md" \
  --timeout 120

# should load the data manifest through a passive gateway lifecycle
gateway_log_path="$(openclaw-gateway log-path)"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  openclaw logs --plain --limit 1000 --max-bytes 1000000 > "$TMPDIR/agent-lifecycle.log"
  if grep -Eq \
    '\[agent-system\] manifest_loaded trigger="(service|session_start|before_prompt_build)" agentId="data"' \
    "$TMPDIR/agent-lifecycle.log"; then
    break
  fi
  if [ "$attempt" -eq 10 ]; then
    grep -F '[agent-system]' "$TMPDIR/agent-lifecycle.log" || true
    tail -n 100 "$TMPDIR/agent-lifecycle.log"
    tail -n 100 "$gateway_log_path"
    exit 1
  fi
  sleep 1
done

# should keep manifest values out of lifecycle and gateway logs
if grep -Fq 'leia-initial-manifest-value' "$TMPDIR/agent-lifecycle.log"; then exit 1; fi
if grep -Fq 'leia-initial-manifest-value' "$gateway_log_path"; then exit 1; fi

# should inspect and resolve routing through the active agent without changing its session selection
openclaw agent \
  --agent data \
  --session-key agent:data:agent-system-routing-leia \
  --message-file "$GITHUB_WORKSPACE/examples/agent/routing.md" \
  --timeout 120 \
  | grep -F 'routing-default-ready'

# should match the complete strict mock exchange
openclaw-aimock evidence \
  --scenario agent \
  --expected-evidence "$GITHUB_WORKSPACE/examples/agent/expected-evidence.json"
```

## Cleanup

```bash
# should stop the background gateway cleanly
openclaw-gateway stop

# should stop the strict mock model cleanly
openclaw-aimock stop
```
