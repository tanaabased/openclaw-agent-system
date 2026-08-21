# Agent Command Security Example

This scenario runs the prepared Agent System package in the default Gateway with two explicitly installed agents. It verifies that a repository helper can use a managed shim with the active identity but cannot switch identity by changing into another agent workspace.

## Setup

```bash
# should configure the default profile with the ci model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE" \
  --model "openai/$OPENAI_MODEL" \
  --yolo

# should enable the codex runtime
openclaw plugins enable codex

# should install both scenario-owned workspaces through agent system
cd "$GITHUB_WORKSPACE/examples/security/tanaabot"
openclaw agent-system install
cd "$GITHUB_WORKSPACE/examples/security/emori"
openclaw agent-system install

# should route tanaabot through codex with the ci model
openclaw config set 'agents.list[0].model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.list[0].models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"codex\"}}}" --strict-json

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
grep -F 'tanaabot-security@example.invalid' "$TMPDIR/agent-system-active-agent-result.txt"
test ! -e "$TMPDIR/agent-system-cross-agent-result.txt"
```

## Cleanup

```bash
# should stop the background gateway cleanly
openclaw-gateway stop
```
