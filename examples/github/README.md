# GitHub Tool Example

This scenario runs the prepared Agent System package in the default Gateway with two explicitly installed agents. It verifies that the GitHub tool runtime selects each agent's configured 1Password-backed credential and authenticated account through either supported invocation route.

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

# should store access and install both scenario-owned github agents through agent system
cd "$GITHUB_WORKSPACE/examples/github/tanaabot"
openclaw agent-system credentials set op --from-env
openclaw agent-system install
cd "$GITHUB_WORKSPACE/examples/github/emori"
openclaw agent-system credentials set op --from-env
openclaw agent-system install

# should configure both installed agents with the ci model
openclaw config set 'agents.list[0].model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.list[1].model' "openai/$OPENAI_MODEL"

# should allow unattended tool execution only on the isolated ci profile
openclaw exec-policy preset yolo

# should start the default gateway as a supervised background process
(
  exec openclaw gateway run --verbose > "$TMPDIR/gateway.log" 2>&1 < /dev/null
) &
echo "$!" > "$TMPDIR/gateway.pid"
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" wait
```

## Testing

```bash
# should identify tanaabot through its configured github tool credential
openclaw agent \
  --agent tanaabot \
  --session-key agent:tanaabot:agent-system-github-leia \
  --message-file "$GITHUB_WORKSPACE/examples/github/whoami.md" \
  --timeout 120 | grep -F 'tanaabot'
grep -F 'tool_call_started' "$TMPDIR/gateway.log" | grep -F 'tool="github"' | grep -F 'agentId="tanaabot"'

# should identify emori through her configured github tool credential
openclaw agent \
  --agent emori \
  --session-key agent:emori:agent-system-github-leia \
  --message-file "$GITHUB_WORKSPACE/examples/github/whoami.md" \
  --timeout 120 | grep -F 'emoriwan'
grep -F 'tool_call_started' "$TMPDIR/gateway.log" | grep -F 'tool="github"' | grep -F 'agentId="emori"'
```

## Cleanup

```bash
# should stop the background gateway cleanly
"$GITHUB_WORKSPACE/scripts/gateway-process.sh" stop
```
