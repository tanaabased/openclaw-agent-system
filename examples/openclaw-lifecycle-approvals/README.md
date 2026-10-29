# OpenClaw Lifecycle Approvals Example

Request lifecycle tools through native OpenClaw and hosted Codex, deny installation before any effects, approve one installation, and inspect through Doctor without applying setup.

## What Belongs Here

- Native approval requests and decisions bound to the originating agent/tool call.
- Denied Install leaves check/apply markers absent, approved Install applies once, and both Doctor routes remain read-only.
- Activated scheduled hosted-Codex maintenance uses the same native tools without approval, while the ordinary interactive calls still require it.

## What Does Not Belong Here

- Ordinary native execution, PATH, and cross-agent containment: [runtimes](../openclaw-runtimes/README.md).
- Operator CLI installation: [OS install](../os-install/README.md).

## Notes

- Strict AIMock supplies four interactive turns and one scheduled hosted-Codex maintenance turn with synthetic credentials. The Gateway, hosted Codex app server, approval protocol, and lifecycle effects remain real. The scheduled turn adds the runtime-specific proof that host occurrence identity reaches these tools; no global plugin-approval bypass is enabled.
- The driver connects as the native Control UI approval client. It verifies protocol decisions and filesystem effects, not rendered UI. Denial may end the chat before another model request.

## Setup

```bash
# should prepare the packed plugin with strict lifecycle approval models
export OPENAI_API_KEY=agent-system-aimock-test
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --model openai/gpt-5.4-nano \
  --yolo
openclaw-aimock prepare --scenario openclaw-lifecycle-approvals
openclaw config set models.mode merge
openclaw config set memory.search.enabled false --strict-json
openclaw config set plugins.entries.codex.config.codexDynamicToolsLoading direct
openclaw config set plugins.entries.codex.config.appServer.args '["-c","openai_base_url=\"http://127.0.0.1:4010/v1\"","app-server","--listen","stdio://"]' --strict-json

# should install both runtime workspaces without applying approval probe setup
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle-approvals/codex"
openclaw agent-system install --skip-setup --yes
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle-approvals/openclaw"
openclaw agent-system install --skip-setup --yes
openclaw-gateway start
```

## Testing

```bash
# should deny native openclaw installation before any setup effects
node --import tsx "$GITHUB_WORKSPACE/examples/openclaw-lifecycle-approvals/approval-scenario.mts" runtime-openclaw

# should allow exactly one installation through the hosted codex approval route
node --import tsx "$GITHUB_WORKSPACE/examples/openclaw-lifecycle-approvals/approval-scenario.mts" runtime-codex

# should approve native openclaw doctor checks without applying setup
node --import tsx "$GITHUB_WORKSPACE/examples/openclaw-lifecycle-approvals/approval-scenario.mts" runtime-openclaw doctor

# should resolve and approve the hosted codex doctor tool without applying setup
node --import tsx "$GITHUB_WORKSPACE/examples/openclaw-lifecycle-approvals/approval-scenario.mts" runtime-codex doctor

# should complete activated hosted codex maintenance without another native approval
cd "$GITHUB_WORKSPACE/examples/openclaw-lifecycle-approvals/codex"
rm -f "$TMPDIR/agent-system-approval-check" "$TMPDIR/agent-system-approval-apply"
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
run_id=$(openclaw agent-system automations run maintenance --json | jq -er 'select(.status == "queued") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" maintenance "$run_id"
grep -Fx applied "$TMPDIR/agent-system-approval-apply"
test "$(wc -l < "$TMPDIR/agent-system-approval-apply" | tr -d ' ')" = 1
grep -Fx checked "$TMPDIR/agent-system-approval-check"

# should complete all lifecycle approval turns through strict aimock
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | tee "$TMPDIR/lifecycle-approvals-evidence.json"
jq -e '.scenario == "openclaw-lifecycle-approvals" and .strictMissCount == 0 and .finalResponseCount >= 4 and .finalResponseCount <= 5 and any(.tools[]; .name == "agent_system_doctor" and .callResponseCount == 3 and .resultRequestCount == 3) and any(.tools[]; .name == "agent_system_install" and .callResponseCount >= 2 and .callResponseCount <= 3 and .resultRequestCount >= 3 and .resultRequestCount <= 4)' "$TMPDIR/lifecycle-approvals-evidence.json"
```
