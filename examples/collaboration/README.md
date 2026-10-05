# Collaboration Example

Prove ordinary installation repairs restricted host collaboration while preserving
operator grants. Strict AIMock exercises managed messaging and session reading
and messaging with a preserved unmanaged participant. Configuration checks cover
selection changes, wildcard ownership, and native deletion boundaries. CI only.

## Setup

```bash
# should prepare the packed plugin and strict model
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --yolo
openclaw-aimock prepare --scenario collaboration

# should register an unmanaged participant with operator-owned access
openclaw agents add external --workspace "$GITHUB_WORKSPACE/examples/collaboration/external" --model aimock/gpt-5.5 --non-interactive --json
openclaw agents set-identity --agent external --name External
openclaw config set tools.agentToAgent '{"enabled":false,"allow":["external","alpha"]}' --strict-json
openclaw config set tools.sessions.visibility agent

# should leave the first managed agent quiet before a team exists
cd "$GITHUB_WORKSPACE/examples/collaboration/alpha"
openclaw agent-system install --json | jq -e 'any(.outcomes[]; .code == "collaboration-not-applicable")'
openclaw config get tools.agentToAgent.enabled --json | jq -e '. == false'

# should automatically enable the team while preserving operator entries
cd "$GITHUB_WORKSPACE/examples/collaboration/beta"
openclaw agent-system install --json | jq -e 'any(.warnings[]; .code == "collaboration-session-access")'
openclaw config get tools.agentToAgent --json | jq -e '.enabled == true and .allow == ["external","alpha","beta"]'
openclaw config get tools.sessions.visibility | grep -Fx 'all'
openclaw config get plugins.entries.agent-system.config.collaborationState --json | jq -e '.ownedAgentIds == ["beta"]'

# should start the gateway with installed collaboration settings
openclaw-gateway start --debug
```

## Testing

```bash
# should seed the managed peer session through its native entrypoint
openclaw agent --agent beta --session-key agent:beta:collaboration --message collaboration-ready --timeout 120 | grep -F 'collaboration-ready'

# should receive the managed peer reply through the native session tool
openclaw agent --agent alpha --session-key agent:alpha:collaboration --message collaboration-send --timeout 120 | grep -F 'collaboration-exchange-complete'

# should seed a preserved unmanaged participant session
openclaw agent --agent external --session-key agent:external:collaboration --message external-ready --timeout 120 | grep -F 'external-ready'

# should message the preserved unmanaged participant
openclaw agent --agent alpha --session-key agent:alpha:external-send --message external-send --timeout 120 | grep -F 'external-exchange-complete'

# should read the preserved unmanaged participant session
openclaw agent --agent alpha --session-key agent:alpha:external-read --message external-read --timeout 120 | grep -F 'external-history-verified'
curl --fail --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.strictMissCount == 0 and .finalResponseCount >= 7 and ([.tools[] | select(.name == "sessions_send" and .callResponseCount == 1 and .resultRequestCount >= 1)] | length) == 2 and any(.tools[]; .name == "sessions_history" and .callResponseCount == 1 and .resultRequestCount >= 1)'

# should stop the gateway before configuration lifecycle checks
openclaw-gateway stop

# should report unchanged collaboration through ordinary lifecycle commands
cd "$GITHUB_WORKSPACE/examples/collaboration/alpha"
openclaw agent-system install --json | jq -e 'any(.outcomes[]; .code == "collaboration-unchanged")'
openclaw agent-system doctor --json | jq -e 'any(.findings[]; .code == "collaboration-ready")'

# should repair later visibility restrictions without changing selection
openclaw config set tools.sessions.visibility agent
cd "$GITHUB_WORKSPACE/examples/collaboration/alpha"
openclaw agent-system install --json
openclaw config get tools.sessions.visibility | grep -Fx 'all'

# should give all future coverage without adopting operator grants
openclaw config set plugins.entries.agent-system.config.collaboration all
cd "$GITHUB_WORKSPACE/examples/collaboration/alpha"
openclaw agent-system install --json
openclaw config get tools.agentToAgent.allow --json | jq -e '. == ["external","alpha","*"]'
openclaw config get plugins.entries.agent-system.config.collaborationState --json | jq -e '.ownedAgentIds == ["*"]'

# should replace only the owned wildcard when returning to auto
openclaw config set plugins.entries.agent-system.config.collaboration auto
cd "$GITHUB_WORKSPACE/examples/collaboration/alpha"
openclaw agent-system install --json
openclaw config get tools.agentToAgent.allow --json | jq -e '. == ["external","alpha","beta"]'

# should select registered unmanaged participants through an explicit list
openclaw config set plugins.entries.agent-system.config.collaboration '["beta","external"]' --strict-json
cd "$GITHUB_WORKSPACE/examples/collaboration/alpha"
openclaw agent-system install --json
openclaw config get tools.agentToAgent.allow --json | jq -e '. == ["external","alpha","beta"]'

# should clean ownership at the next install after native deletion prunes a grant
openclaw agents delete beta --force
openclaw config get tools.agentToAgent.allow --json | jq -e '. == ["external","alpha"]'
openclaw config get plugins.entries.agent-system.config.collaborationState --json | jq -e '.ownedAgentIds == ["beta"]'
cd "$GITHUB_WORKSPACE/examples/collaboration/alpha"
openclaw agent-system install --json
openclaw config get plugins.entries.agent-system.config.collaborationState --json | jq -e '.ownedAgentIds == []'

# should withdraw owned grants before deleting the last managed agent
openclaw config set plugins.entries.agent-system.config.collaboration all
cd "$GITHUB_WORKSPACE/examples/collaboration/alpha"
openclaw agent-system install --json
openclaw config set plugins.entries.agent-system.config.collaboration false --strict-json
openclaw agent-system install --json
openclaw config get tools.agentToAgent.allow --json | jq -e '. == ["external","alpha"]'
openclaw agents delete alpha --force
openclaw config get tools.agentToAgent.allow --json | jq -e '. == ["external"]'
```

OpenClaw prunes deleted exact IDs but does not run an Agent System deletion hook.
Cleanup is next-install work. Before deleting the final managed agent, withdraw
owned grants while its workspace can still run ordinary install; there is no
workspace-free cleanup mode.

## Cleanup

```bash
# should stop the strict mock provider
openclaw-aimock stop
```
