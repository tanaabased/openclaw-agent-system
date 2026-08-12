# Agent Command Security Example

This scenario runs the prepared Agent System package in the default Gateway with two explicitly installed agents. It verifies that a managed agent cannot use a command tool to invoke an Agent System operator route through another agent identity.

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

# should install, enable, and trust the packed plugin with codex
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system
openclaw plugins enable codex
openclaw config set plugins.allow '["agent-system","codex"]' --strict-json

# should install both scenario-owned workspaces through agent system
cd "$GITHUB_WORKSPACE/examples/security/tanaabot"
openclaw agent-system install
cd "$GITHUB_WORKSPACE/examples/security/emori"
openclaw agent-system install

# should route tanaabot through codex with the ci model
openclaw config set 'agents.list[0].model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.list[0].models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"codex\"}}}" --strict-json

# should allow unattended tool execution only on the isolated ci profile
openclaw exec-policy preset yolo

# should start the default gateway as a supervised background process
OPENCLAW_LOG_LEVEL=debug "$GITHUB_WORKSPACE/scripts/gateway-process.sh" start
```

## Testing

```bash
# should prevent tanaabot from executing through emori identity
openclaw agent \
  --agent tanaabot \
  --session-key agent:tanaabot:agent-system-security-leia \
  --message-file "$GITHUB_WORKSPACE/examples/security/cross-agent.md" \
  --timeout 120
test ! -e "$TMPDIR/agent-system-cross-agent-result.txt"
```

## Cleanup

```bash
# should stop the background gateway cleanly
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" stop
```
