# OpenClaw Native Retirement Example

Explicitly clean up one unmanaged native session without GitHub or assignment
intake. Verify archival through the real tool, then restore native history.

## What Belongs Here

- Exact native selection, preview/apply and observed archival through an installed plugin.
- Wrong-agent refusal without changing the requested session.
- Supported native history and restore, without claiming checkout reclamation.

## What Does Not Belong Here

- Managed issue preservation and retirement: [managed retirement](../openclaw-notifications-retirement/README.md).
- Standalone Codex desktop effects: [Codex native acceptance](../codex-notifications/README.md).

## Notes

- Strict AIMock selects three tool calls in one operator turn; Gateway execution,
  credential enrollment, session archival and restoration remain real.
- The disposable target is conversation-only. No GitHub credential, fixture issue,
  assignment schedule, live model or repository checkout is needed. This does not
  establish native worktree reclamation or recovery of discarded local work.
- This scenario runs only on fresh GitHub Actions runners, never locally.

## Setup

```bash
# should prepare an isolated gateway with the packed plugin and strict model
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --yolo
openclaw-aimock prepare --scenario openclaw-native-retirement
openclaw config set skills.workshop.autonomous.mode off
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json
openclaw-gateway start

# should install the fixture and explicitly enroll native transport without github
cd "$GITHUB_WORKSPACE/examples/openclaw-native-retirement"
openclaw agent-system install --manual-session-dispatch --yes --json | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled")'

# should register a separate fixture agent without enrolling its native transport
cd "$GITHUB_WORKSPACE/examples/openclaw-native-retirement/other"
openclaw agent-system install --yes --json

# should create one deliberately unmanaged native session
openclaw gateway call sessions.create --params '{"key":"agent:native-retirement:disposable","agentId":"native-retirement","label":"Disposable native cleanup"}' --json | tee "$TMPDIR/native-retirement-target.json" | jq -e '.runStarted == false and (.sessionId | type == "string")'

# should create a real foreign target for the wrong-agent refusal
openclaw gateway call sessions.create --params '{"key":"agent:other:disposable","agentId":"other","label":"Foreign native cleanup control"}' --json | tee "$TMPDIR/native-retirement-foreign.json" | jq -e '.runStarted == false and (.sessionId | type == "string")'
```

## Testing

```bash
# should refuse a wrong agent then archive the exact native target through the tool
openclaw agent --agent native-retirement --session-key agent:native-retirement:operator --message-file "$GITHUB_WORKSPACE/examples/openclaw-native-retirement/cleanup.md" --timeout 120 | grep -F 'native-retirement-verified'
openclaw gateway call sessions.describe --params '{"key":"agent:native-retirement:disposable"}' --json | jq -e '.session.archived == true or .session.archivedAt > 0'

# should leave the foreign session unchanged
openclaw gateway call sessions.describe --params '{"key":"agent:other:disposable"}' --json | jq -e '.session.sessionId == input.sessionId and (.session.archivedAt // 0) == 0' - "$TMPDIR/native-retirement-foreign.json"

# should retain supported history and restore the same native session
openclaw gateway call chat.history --params '{"sessionKey":"agent:native-retirement:disposable","limit":1}' --json | jq -e '.sessionId == input.sessionId and (.messages | type == "array")' - "$TMPDIR/native-retirement-target.json"
openclaw gateway call sessions.patch --params "$(jq -nc --arg id "$(jq -r .sessionId "$TMPDIR/native-retirement-target.json")" '{key:"agent:native-retirement:disposable",expectedSessionId:$id,archived:false}')" --json
openclaw gateway call sessions.describe --params '{"key":"agent:native-retirement:disposable"}' --json | jq -e '.session.sessionId == input.sessionId and (.session.archivedAt // 0) == 0' - "$TMPDIR/native-retirement-target.json"

# should complete the strict model exchange without unexpected requests
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '.scenario == "openclaw-native-retirement" and .strictMissCount == 0 and .finalResponseCount == 1 and any(.tools[]; .name == "agent_system_dispatch" and .callResponseCount == 3)'
```

## Cleanup

```bash
# should report strict mock failures before stopping the provider
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics

# should stop the isolated gateway and strict provider
openclaw-gateway stop --timeout 340
openclaw-aimock stop
```
