# Provider Diagnostics Example

This scenario injects a synthetic 1Password SDK rate-limit failure without contacting the provider. It verifies that the installed CLI and native tool consumer retain useful classification while redacting credential and response details.

## Setup

```bash
# should configure an isolated openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --yolo

# should register the synthetic quota agent without resolving provider values
openclaw agents add quota-diagnostic --workspace "$GITHUB_WORKSPACE/examples/diagnostics/quota-agent" --non-interactive
```

## Testing

```bash
# should retain safe sdk rate-limit evidence through the installed managed cli
if output=$(OP_SERVICE_ACCOUNT_TOKEN=agent-system-synthetic-quota NODE_OPTIONS="--require=$GITHUB_WORKSPACE/examples/diagnostics/provider-failure.cjs" openclaw agent-system tool gh --agent quota-diagnostic api user 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'provider="1password"' | grep -F 'classification="rate-limit"' | grep -F 'httpStatus="unknown"' | grep -F 'resetAt="unknown"'
if printf '%s\n' "$output" | grep -E 'SYNTHETIC_PRIVATE|op://synthetic|Authorization:'; then exit 1; fi

# should start an isolated gateway with the synthetic sdk failure
openclaw-aimock prepare --scenario diagnostics
OP_SERVICE_ACCOUNT_TOKEN=agent-system-synthetic-quota NODE_OPTIONS="--require=$GITHUB_WORKSPACE/examples/diagnostics/provider-failure.cjs" openclaw-gateway start

# should deliver safe quota classification to the installed native tool consumer
openclaw agent --agent quota-diagnostic --session-key agent:quota-diagnostic:provider-diagnostic --message 'Use the configured Git tool to report its version for the synthetic provider diagnostic check.' --timeout 120 | grep -F 'quota reported'
openclaw-aimock evidence --scenario diagnostics --expected-evidence "$GITHUB_WORKSPACE/examples/diagnostics/expected-evidence.json"
```

## Cleanup

```bash
# should stop the synthetic gateway
openclaw-gateway stop

# should stop the synthetic diagnostic model
openclaw-aimock stop
```
