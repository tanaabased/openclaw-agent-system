# Path Example

This scenario runs the prepared Agent System package in the default Gateway with explicitly installed agents. It verifies that one manifest-declared executable directory reaches both Codex-native shell commands and OpenClaw exec with the documented precedence.

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
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" start
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
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" stop
```
