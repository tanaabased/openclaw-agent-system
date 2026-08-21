# Path Example

This scenario runs the prepared Agent System package in the default Gateway with explicitly installed agents. It verifies that one manifest-declared executable directory reaches both Codex-native shell commands and OpenClaw exec with the documented precedence.

## Setup

```bash
# should configure the default profile with the ci model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE" \
  --model "openai/$OPENAI_MODEL"

# should install both scenario-owned workspaces through agent system
cd "$GITHUB_WORKSPACE/examples/path/codex"
openclaw agent-system install
cd "$GITHUB_WORKSPACE/examples/path/openclaw"
openclaw agent-system install

# should route one agent through codex and one through the openclaw runtime
openclaw plugins enable codex
openclaw config set 'agents.list[0].model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.list[0].models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"codex\"}}}" --strict-json
openclaw config set 'agents.list[1].model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.list[1].models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"openclaw\"}}}" --strict-json

# should allow unattended tool execution only on the isolated ci profile
openclaw exec-policy preset yolo

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
