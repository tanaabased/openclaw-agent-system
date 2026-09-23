# Lifecycle Approval Example

This scenario runs the prepared Agent System package in the default Gateway with one native OpenClaw agent and one Codex agent. It exercises the authenticated Control UI protocol and installed approval router, proving that denial prevents lifecycle effects and Allow once permits exactly one installation. Unit tests own the exhaustive lifecycle tool and decision matrix; the live model is used only for installed native tool discovery, including Codex dynamic tools. OpenClaw 2026.9.5 is the compatibility target.

## Setup

```bash
# should configure the default profile with the ci model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --model "openai/$OPENAI_MODEL" \
  --yolo

# should install both scenario-owned workspaces without applying setup
cd "$GITHUB_WORKSPACE/examples/approval/codex"
openclaw agent-system install --skip-setup
cd "$GITHUB_WORKSPACE/examples/approval/openclaw"
openclaw agent-system install --skip-setup

# should route one agent through codex and one through native openclaw
# temporary openclaw 9.5 cleanup workaround: https://github.com/tanaabased/openclaw-agent-system/issues/135
openclaw plugins disable codex
openclaw config set 'agents.entries.approval-codex.model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.entries.approval-codex.models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"codex\"}}}" --strict-json
openclaw config set 'agents.entries.approval-openclaw.model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.entries.approval-openclaw.models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"openclaw\"}}}" --strict-json
openclaw plugins enable codex

# should start the default gateway as a supervised background process
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
```

## Testing

```bash
# should deny one installed lifecycle operation in the native openclaw harness
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" approval-openclaw

# should allow one installed lifecycle operation in the openclaw-hosted codex harness
node --import tsx "$GITHUB_WORKSPACE/scripts/lifecycle-approval-scenario.ts" approval-codex
```

## Cleanup

```bash
# should stop the background gateway cleanly
openclaw-gateway stop
```
