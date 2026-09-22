# Agent Command Security Example

This scenario runs the prepared Agent System package in the default Gateway with two explicitly installed agents. It verifies that a repository helper can use a managed shim with the active identity but cannot switch identity by changing into another agent workspace.

## Setup

```bash
# should configure the default profile with the ci model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --model "openai/$OPENAI_MODEL" \
  --yolo

# should install both scenario-owned workspaces through agent system
cd "$GITHUB_WORKSPACE/examples/security/tanaabot"
openclaw agent-system install
cd "$GITHUB_WORKSPACE/examples/security/emori"
openclaw agent-system install

# should route tanaabot through codex with the ci model
# temporary openclaw 9.5 cleanup workaround: https://github.com/tanaabased/openclaw-agent-system/issues/135
openclaw plugins disable codex
openclaw config set 'agents.entries.tanaabot.model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.entries.tanaabot.models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"codex\"}}}" --strict-json
openclaw plugins enable codex

# should start the default gateway as a supervised background process
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
```

## Testing

```bash
# should bind helper shims to tanaabot and prevent a cwd switch to emori
openclaw agent \
  --agent tanaabot \
  --session-key agent:tanaabot:agent-system-security-leia \
  --message-file "$GITHUB_WORKSPACE/examples/security/cross-agent.md" \
  --timeout 120
if ! grep -F 'tanaabot-security@example.invalid' "$TMPDIR/agent-system-active-agent-result.txt"; then
  openclaw gateway call chat.history \
    --params '{"sessionKey":"agent:tanaabot:agent-system-security-leia","limit":10,"maxBytes":32768}' \
    --json | jq '{messages: [.messages[] | select(.role == "assistant" or .role == "toolResult")]}'
  exit 1
fi
test ! -e "$TMPDIR/agent-system-cross-agent-result.txt"
```

## Cleanup

```bash
# should stop the background gateway cleanly
openclaw-gateway stop
```
