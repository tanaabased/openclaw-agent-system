# Agent Example

This scenario runs the prepared Agent System package in the default Gateway with an explicitly installed agent. It verifies agent onboarding, passive Gateway manifest loading, and value-free lifecycle logging.

## Setup

```bash
# should configure the default profile with the ci model
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

# should install and enable the packed plugin
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system

# should install the scenario-owned data workspace through agent system
cd "$GITHUB_WORKSPACE/examples/agent/data"
openclaw agent-system install

# should configure the installed agent with the ci model
openclaw config set 'agents.list[0].model' "openai/$OPENAI_MODEL"

# should start the default gateway as a supervised background process
(
  exec env OPENCLAW_LOG_LEVEL=debug openclaw gateway run --verbose > "$TMPDIR/gateway.log" 2>&1 < /dev/null
) &
echo "$!" > "$TMPDIR/gateway.pid"
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" wait
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
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if grep -Eq \
    '\[agent-system\] manifest_loaded trigger="(service|session_start|before_prompt_build)" agentId="data"' \
    "$TMPDIR/gateway.log"; then
    break
  fi
  if [ "$attempt" -eq 10 ]; then
    grep -F '[agent-system]' "$TMPDIR/gateway.log" || true
    tail -n 100 "$TMPDIR/gateway.log"
    exit 1
  fi
  sleep 1
done

# should keep manifest values out of gateway lifecycle logs
if grep -Fq 'leia-initial-manifest-value' "$TMPDIR/gateway.log"; then exit 1; fi
```

## Cleanup

```bash
# should stop the background gateway cleanly
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" stop
```
