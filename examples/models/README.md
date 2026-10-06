# Models Example

This scenario verifies manifest-declared Codex routing without a prior runtime binding, effective selection policy, configured model presence, idempotency, and native Codex execution against the repository's API-key test model. Doctor does not inspect authentication; CI supplies ambient authentication only for the live turn, and Agent System neither installs nor stores it.

## Setup

```bash
# should configure the default profile with the known api key model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --model "openai/gpt-5.4-nano"

# should register an agent without a codex runtime route
openclaw agents add models-data \
  --workspace "$GITHUB_WORKSPACE/examples/models/data" \
  --non-interactive \
  --json

# should inherit a restrictive model policy that excludes the declared model
openclaw config set 'agents.defaults.modelPolicy.allow' '["openai/gpt-5.5"]' --strict-json
```

## Testing

```bash
# should diagnose manifest configuration drift without creating bindings or policy
cd "$GITHUB_WORKSPACE/examples/models/data"
if output="$(openclaw agent-system doctor --json)"; then exit 1; fi
printf '%s\n' "$output" | jq -e '.findings | any(.component == "models" and .code == "agent-model-config-drift" and .status == "drift")'
openclaw config get 'agents.entries.models-data' --json \
  | jq -e '.modelPolicy == null and .models["openai/gpt-5.4-nano"].agentRuntime == null'

# should reconcile the declared codex runtime, model, effort, and agent-scoped policy
cd "$GITHUB_WORKSPACE/examples/models/data"
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "models" and .code == "set-agent-models" and .status == "updated")'
openclaw config get 'agents.entries.models-data' --json \
  | jq -e '.model.primary == "openai/gpt-5.4-nano" and .model.fallbacks == [] and .thinkingDefault == "medium" and .models["openai/gpt-5.4-nano"].agentRuntime.id == "codex" and .modelPolicy.allow == ["openai/gpt-5.5", "openai/gpt-5.4-nano"]'
openclaw config get 'agents.defaults.modelPolicy.allow' --json \
  | jq -e '. == ["openai/gpt-5.5"]'

# should report the installed model configuration as healthy
cd "$GITHUB_WORKSPACE/examples/models/data"
openclaw agent-system doctor --json \
  | jq -e '.findings | any(.component == "models" and .code == "agent-models-ready" and .status == "healthy")'

# should leave repeated model installation unchanged
cd "$GITHUB_WORKSPACE/examples/models/data"
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "models" and .code == "agent-models-unchanged" and .status == "unchanged")'

# should execute the installed model through the declared native runtime
openclaw-gateway start
openclaw agent \
  --agent models-data \
  --session-key agent:models-data:agent-system-models-leia \
  --message-file "$GITHUB_WORKSPACE/examples/models/model-ready.md" \
  --timeout 120 \
  | grep -F 'model-runtime-ready'
```

## Cleanup

```bash
# should stop the background gateway cleanly
openclaw-gateway stop
```
