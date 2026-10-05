# Collaboration Example

Prove that two registered managed agents exchange a native session message using
strict AIMock. Configuration assertions cover preserved operator entries,
explicit migration, idempotence, and cleanup after the final registration is gone.
This scenario runs only on fresh GitHub Actions runners.

## Setup

```bash
# should prepare the packed plugin and strict model
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --yolo
openclaw-aimock prepare --scenario collaboration

# should preserve operator entries while installing both managed agents
openclaw config set tools.agentToAgent.allow '["external","alpha"]' --strict-json
cd "$GITHUB_WORKSPACE/examples/collaboration/alpha"
openclaw agent-system install --json
cd "$GITHUB_WORKSPACE/examples/collaboration/beta"
openclaw agent-system install --json
openclaw config get tools.agentToAgent --json | jq -e '.enabled == true and .allow == ["external","alpha","beta"]'
openclaw config get plugins.entries.agent-system.config.collaborationState --json | jq -e '.ownedAgentIds == ["beta"]'

# should start the gateway with the installed collaboration settings
openclaw-gateway start --debug
```

## Testing

```bash
# should seed the peer session through its native agent entrypoint
openclaw agent --agent beta --session-key agent:beta:collaboration --message collaboration-ready --timeout 120 | grep -F 'collaboration-ready'

# should receive the peer reply through the native session tool
openclaw agent --agent alpha --session-key agent:alpha:collaboration --message collaboration-send --timeout 120 | grep -F 'collaboration-exchange-complete'
curl --fail --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0 and .finalResponseCount >= 3 and any(.tools[]; .name == "sessions_send" and .callResponseCount == 1 and .resultRequestCount >= 1)'

# should stop the gateway before configuration lifecycle checks
openclaw-gateway stop

# should report unchanged membership on repeated host reconciliation
openclaw agent-system install --collaboration --json | jq -e '.outcomes[0].status == "unchanged"'
openclaw agent-system doctor --collaboration --json | jq -e '.findings[0].status == "healthy"'

# should retain later host restrictions until the operator changes the selection
openclaw config set tools.sessions.visibility agent
if openclaw agent-system install --collaboration --json; then exit 1; fi
openclaw config get tools.sessions.visibility | grep -Fx 'agent'
openclaw config set plugins.entries.agent-system.config.collaboration all
openclaw agent-system install --collaboration --json
openclaw config get tools.sessions.visibility | grep -Fx 'all'

# should reconcile an explicit group while preserving operator-owned matching ids
openclaw config set plugins.entries.agent-system.config.collaboration '["beta"]' --strict-json
openclaw agent-system install --collaboration --json
openclaw config get tools.agentToAgent.allow --json | jq -e '. == ["external","alpha","beta"]'

# should remove only owned entries after native agent removal
openclaw agents delete beta --force
openclaw agent-system install --collaboration --json
openclaw config get tools.agentToAgent.allow --json | jq -e '. == ["external","alpha"]'

# should prevent allow-all when the last owned member is removed
openclaw config set plugins.entries.agent-system.config.collaboration all
openclaw config set tools.agentToAgent.allow '[]' --strict-json
openclaw agent-system install --collaboration --json
openclaw config get plugins.entries.agent-system.config.collaborationState --json | jq -e '.ownedAgentIds == ["alpha"]'
openclaw agents delete alpha --force
cd "$TMPDIR"
openclaw agent-system install --collaboration --json
openclaw config get tools.agentToAgent --json | jq -e '.enabled == false and .allow == []'
openclaw agent-system install --collaboration --json | jq -e '.outcomes[0].status == "unchanged"'
```

## Cleanup

```bash
# should stop the strict mock provider
openclaw-aimock stop
```
