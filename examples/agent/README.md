# Agent Example

This scenario runs the prepared Agent System package in the default Gateway with explicitly installed agents. It verifies agent onboarding, manifest loading at `session_start`, value-free lifecycle logging, and workspace/global executable paths through both Codex-native and OpenClaw exec.

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

# should install the scenario-owned data workspace through agent system
cd "$GITHUB_WORKSPACE/examples/agent/data"
openclaw agent-system install

# should install a second workspace for the openclaw runtime path proof
cd "$GITHUB_WORKSPACE/examples/agent/openclaw"
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
(
  exec env OPENCLAW_LOG_LEVEL=debug openclaw gateway run --verbose > "$TMPDIR/gateway.log" 2>&1 < /dev/null
) &
echo "$!" > "$TMPDIR/gateway.pid"
"$GITHUB_WORKSPACE/examples/agent/gateway-process.sh" wait
```

## Testing

```bash
# should run the workspace override through codex native exec
openclaw agent \
  --agent data \
  --session-key agent:data:agent-system-leia \
  --message-file "$GITHUB_WORKSPACE/examples/agent/path-codex.md" \
  --timeout 120
grep -F 'picard-4-7-alpha-tango' "$GITHUB_WORKSPACE/examples/agent/data/codex-path-result.txt"

# should load the data manifest when the codex session starts
grep -F '[agent-system] manifest_loaded trigger="session_start" agentId="data"' "$TMPDIR/gateway.log"

# should keep manifest values out of gateway lifecycle logs
if grep -Fq 'leia-initial-manifest-value' "$TMPDIR/gateway.log"; then exit 1; fi

# should run the packaged global probe through openclaw exec
openclaw agent \
  --agent openclaw-data \
  --session-key agent:openclaw-data:agent-system-leia \
  --message-file "$GITHUB_WORKSPACE/examples/agent/path-openclaw.md" \
  --timeout 120
test -s "$GITHUB_WORKSPACE/examples/agent/openclaw/openclaw-path-result.txt"

# should expose managed path state through install files and doctor
grep -F '# agent-system: managed-path-v1' "$GITHUB_WORKSPACE/examples/agent/data/.codex/config.toml"
grep -F "$GITHUB_WORKSPACE/examples/agent/data/bin" "$GITHUB_WORKSPACE/examples/agent/data/.codex/config.toml"
grep -F '.codex/config.toml' "$GITHUB_WORKSPACE/examples/agent/data/.gitignore"
openclaw agent-system doctor --agent data | grep -F 'OpenClaw exec path matches the Agent System projection.'
```

## Cleanup

```bash
# should stop the background gateway cleanly
"$GITHUB_WORKSPACE/examples/agent/gateway-process.sh" stop
```
