# Path Example

This scenario runs the prepared Agent System package in the default Gateway with explicitly installed agents. It verifies native model and effort reconciliation, then proves that one manifest-declared executable directory reaches both Codex-native shell commands and OpenClaw exec with the documented precedence.

## Setup

```bash
# should configure the default profile with the ci model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE" \
  --model "openai/$OPENAI_MODEL" \
  --yolo

# should establish the existing codex route used for model reconciliation
openclaw plugins enable codex
openclaw agents add path-codex \
  --workspace "$GITHUB_WORKSPACE/examples/path/codex" \
  --non-interactive \
  --json
openclaw config set 'agents.entries.path-codex.model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.entries.path-codex.models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"codex\"}}}" --strict-json

# should install the native model and effort through agent system
cd "$GITHUB_WORKSPACE/examples/path/codex"
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "models" and .code == "set-agent-models" and .status == "updated")'
openclaw agent-system doctor --json \
  | jq -e '.findings | any(.component == "models" and .code == "agent-models-ready" and .status == "healthy")'
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "models" and .code == "agent-models-unchanged" and .status == "unchanged")'

# should install the openclaw scenario and retain its explicit runtime
cd "$GITHUB_WORKSPACE/examples/path/openclaw"
openclaw agent-system install
openclaw config set 'agents.entries.path-openclaw.model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.entries.path-openclaw.models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"openclaw\"}}}" --strict-json

# should start the default gateway as a supervised background process
openclaw-gateway start
```

## Testing

```bash
# should run the manifest path command through codex native exec
openclaw agent \
  --agent path-codex \
  --session-key agent:path-codex:agent-system-path-leia \
  --message-file "$GITHUB_WORKSPACE/examples/path/path-codex.md" \
  --timeout 120
grep -F 'manifest-path-prepend-precedence' "$GITHUB_WORKSPACE/examples/path/codex/codex-path-result.txt"

# should run the manifest path command through openclaw exec
openclaw agent \
  --agent path-openclaw \
  --session-key agent:path-openclaw:agent-system-path-leia \
  --message-file "$GITHUB_WORKSPACE/examples/path/path-openclaw.md" \
  --timeout 120
grep -F 'manifest-path-prepend-precedence' "$GITHUB_WORKSPACE/examples/path/openclaw/openclaw-path-result.txt"
```

## Cleanup

```bash
# should stop the background gateway cleanly
openclaw-gateway stop
```
