# OpenClaw Collaboration Example

Verify that ordinary Agent System installation enables collaboration between two managed agents while preserving an operator-owned participant grant. A strict AIMock drives a native session exchange and history read; completion requires the actual tool results. Repeat installation and Doctor verify the resulting configuration.

Runtime tests run this example on Ubuntu with the packed plugin and no live model or provider credentials. Configuration permutations remain in source tests and the older unscheduled collaboration example.

## Setup

```bash
# should prepare the packed plugin and strict collaboration model
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --yolo
openclaw-aimock prepare --scenario openclaw-collaboration

# should retain an operator grant when installation enables the managed team
openclaw agents add external --workspace "$GITHUB_WORKSPACE/examples/openclaw-collaboration/external" --model aimock/gpt-5.5 --non-interactive --json
openclaw config set tools.agentToAgent '{"enabled":false,"allow":["external","alpha"]}' --strict-json
openclaw config set tools.sessions.visibility agent
cd "$GITHUB_WORKSPACE/examples/openclaw-collaboration/alpha"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.code == "collaboration-not-applicable")'
cd "$GITHUB_WORKSPACE/examples/openclaw-collaboration/beta"
openclaw agent-system install --yes --json | jq -e '.warnings | any(.code == "collaboration-session-access")'
openclaw config get tools.agentToAgent --json | jq -e '.enabled == true and .allow == ["external","alpha","beta"]'
openclaw config get tools.sessions.visibility | grep -Fx all
openclaw config get plugins.entries.agent-system.config.collaborationState --json | jq -e '.ownedAgentIds == ["beta"]'
openclaw-gateway start
```

## Testing

```bash
# should complete a native exchange between the managed agents
openclaw agent --agent beta --session-key agent:beta:collaboration --message collaboration-ready --timeout 120 | grep -F collaboration-ready
openclaw agent --agent alpha --session-key agent:alpha:collaboration --message collaboration-send --timeout 120 | grep -F collaboration-exchange-complete

# should retrieve the peer session history through the native tool
openclaw agent --agent alpha --session-key agent:alpha:collaboration-history --message collaboration-read --timeout 120 | grep -F collaboration-history-verified
curl --fail --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0 and .finalResponseCount >= 4 and any(.tools[]; .name == "sessions_send" and .callResponseCount == 1 and .resultRequestCount >= 1) and any(.tools[]; .name == "sessions_history" and .callResponseCount == 1 and .resultRequestCount >= 1)'

# should leave the proven collaboration configuration unchanged on repeat installation
openclaw-gateway stop --timeout 340
cd "$GITHUB_WORKSPACE/examples/openclaw-collaboration/alpha"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.code == "collaboration-unchanged")'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "collaboration-ready" and .status == "healthy")'
openclaw config get tools.agentToAgent --json | jq -e '.enabled == true and .allow == ["external","alpha","beta"]'
```

## Cleanup

```bash
# should stop the strict mock provider
openclaw-aimock stop
```
