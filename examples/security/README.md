# Agent Command Security Example

This scenario runs the prepared Agent System package in the default Gateway with two explicitly installed agents. It verifies that a repository helper can use a managed shim with the active identity but cannot switch identity by changing into another agent workspace. Both native OpenClaw and Codex descendants must reject setup operator commands, including unattended install and Doctor/status aliases.

The lifecycle cases use the Control UI protocol with an authenticated device and the real installed approval router. They verify Allow once, denial, cancellation, and unavailable CLI approval for both tools in both harnesses, using filesystem evidence before and after each decision. The live model exercises native tool discovery, including Codex's dynamic tools; assertions do not depend on its final wording. OpenClaw 2026.9.5 is the compatibility target.

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
openclaw agent-system install --skip-setup
cd "$GITHUB_WORKSPACE/examples/security/emori"
openclaw agent-system install --skip-setup

# should route tanaabot through codex and emori through native openclaw
# temporary openclaw 9.5 cleanup workaround: https://github.com/tanaabased/openclaw-agent-system/issues/135
openclaw plugins disable codex
openclaw config set 'agents.entries.tanaabot.model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.entries.tanaabot.models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"codex\"}}}" --strict-json
openclaw config set 'agents.entries.emori.model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.entries.emori.models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"openclaw\"}}}" --strict-json
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
  --timeout 180
if ! grep -F 'tanaabot-security@example.invalid' "$TMPDIR/agent-system-active-agent-result.txt"; then
  openclaw gateway call chat.history \
    --params '{"sessionKey":"agent:tanaabot:agent-system-security-leia","limit":10,"maxBytes":32768}' \
    --json | jq '{messages: [.messages[] | select(.role == "assistant" or .role == "toolResult")]}'
  exit 1
fi
test ! -e "$TMPDIR/agent-system-cross-agent-result.txt"
grep -Fx verified "$TMPDIR/agent-system-setup-boundary-codex.txt"
test ! -e "$TMPDIR/agent-system-forbidden-setup"
test ! -e "$TMPDIR/agent-system-doctor-check"

# should enforce lifecycle chat approval in the default openclaw harness
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" emori

# should enforce lifecycle chat approval in the openclaw-hosted codex harness
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" tanaabot

# should reject operator setup commands from a native openclaw descendant
openclaw agent \
  --agent emori \
  --session-key agent:emori:agent-system-setup-security-leia \
  --message-file "$GITHUB_WORKSPACE/examples/security/setup-native.md" \
  --timeout 180
grep -Fx verified "$TMPDIR/agent-system-setup-boundary-native.txt"
test ! -e "$TMPDIR/agent-system-forbidden-setup"
```

## Cleanup

```bash
# should stop the background gateway cleanly
openclaw-gateway stop
```
