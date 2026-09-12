# Models Example

This scenario runs the prepared Agent System package against the repository's known API-key model. It verifies model and effort reconciliation, readiness, idempotency, and effective native Codex execution without borrowing another capability's example. The fresh CI runner supplies ambient authentication for the readiness and live-turn assertions; Agent System does not install or retain that credential.

## Setup

```bash
# should configure the default profile with the known api key model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE" \
  --model "openai/gpt-5.4-nano"

# should establish the existing api key backed codex route
openclaw plugins enable codex
openclaw agents add models-data \
  --workspace "$GITHUB_WORKSPACE/examples/models/data" \
  --non-interactive \
  --json
openclaw config set 'agents.entries.models-data.model' 'openai/gpt-5.4-nano'
openclaw config set 'agents.entries.models-data.models' '{"openai/gpt-5.4-nano":{"agentRuntime":{"id":"codex"}}}' --strict-json
```

## Testing

```bash
# should reconcile the manifest model and effort without changing its native route
cd "$GITHUB_WORKSPACE/examples/models/data"
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "models" and .code == "set-agent-models" and .status == "updated")'
openclaw config get 'agents.entries.models-data' --json \
  | jq -e '.model == "openai/gpt-5.4-nano" and .thinkingDefault == "medium" and .models["openai/gpt-5.4-nano"].agentRuntime.id == "codex"'

# should report the installed model configuration and readiness as healthy
cd "$GITHUB_WORKSPACE/examples/models/data"
openclaw agent-system doctor --json \
  | jq -e '.findings | any(.component == "models" and .code == "agent-models-ready" and .status == "healthy")'

# should leave repeated model installation unchanged
cd "$GITHUB_WORKSPACE/examples/models/data"
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "models" and .code == "agent-models-unchanged" and .status == "unchanged")'

# should execute the installed model through the retained native runtime
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
