# Environment Example

This scenario uses a scenario-owned Data agent on a fresh runner. It verifies value-free environment inspection and the opt-in Gateway probe without invoking a model.

## Setup

```bash
# should configure an unauthenticated local OpenClaw profile
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

# should allow unattended exec approval on the isolated ephemeral runner
openclaw exec-policy preset yolo

# should install and enable the packed plugin
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system

# should install the scenario-owned data workspace through Agent System
cd "$GITHUB_WORKSPACE/examples/env/data"
openclaw agent-system install
```

## Testing

```bash
# should inspect literal environment metadata without exposing values
cd "$GITHUB_WORKSPACE/examples/env/data"
openclaw agent-system env --json > "$TMPDIR/local-env.json"
grep -F '"name": "AGENT_SYSTEM_LEIA_VISIBLE"' "$TMPDIR/local-env.json"
grep -F '"name": "GITHUB_TOKEN"' "$TMPDIR/local-env.json"
if grep -Fq -e 'leia-agent-system-visible' -e 'leia-agent-system-filtered' "$TMPDIR/local-env.json"; then exit 1; fi

# should explain the disabled Gateway exec opt-in without invoking exec
if openclaw agent-system env --agent data --exec > "$TMPDIR/disabled-env.log" 2>&1; then exit 1; fi
grep -F '[exec-probe-disabled]' "$TMPDIR/disabled-env.log"
grep -F 'authenticated operator clients' "$TMPDIR/disabled-env.log"
grep -F "openclaw config set gateway.tools.allow '[\"exec\"]' --strict-json" "$TMPDIR/disabled-env.log"

# should enable the explicit Gateway exec surface and start the Gateway
openclaw config set gateway.tools.allow '["exec"]' --strict-json
(
  exec env OPENCLAW_LOG_LEVEL=debug openclaw gateway run --verbose > "$TMPDIR/gateway.log" 2>&1 < /dev/null
) &
echo "$!" > "$TMPDIR/gateway.pid"
"$GITHUB_WORKSPACE/examples/env/gateway-process.sh" wait

# should observe accepted and filtered Agent System variables through Gateway exec
openclaw agent-system env --agent data --exec --json > "$TMPDIR/exec-env.json"
node -e "const data=require(process.argv[1]); const variables=Object.fromEntries(data.variables.map(variable => [variable.name, variable.observedExecDelivery])); if (variables.AGENT_SYSTEM_LEIA_VISIBLE !== 'accepted' || variables.GITHUB_TOKEN !== 'filtered') process.exit(1)" "$TMPDIR/exec-env.json"
if grep -Fq -e 'leia-agent-system-visible' -e 'leia-agent-system-filtered' -e 'agent-system-env-probe-' "$TMPDIR/exec-env.json"; then exit 1; fi
grep -F 'agent_system.environment_resolved trigger="resolve_exec_env" agentId="data" variables=2' "$TMPDIR/gateway.log"
```

## Cleanup

```bash
# should stop the background Gateway cleanly
"$GITHUB_WORKSPACE/examples/env/gateway-process.sh" stop
```
