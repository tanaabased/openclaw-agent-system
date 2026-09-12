# Models Example

This scenario verifies model reconciliation, readiness, idempotency, and native Codex execution against the repository's API-key test model. CI supplies ambient authentication for doctor and the live turn; Agent System neither installs nor stores it.

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
