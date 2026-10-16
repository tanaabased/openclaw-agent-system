# OpenClaw Agent Example

This scenario runs the prepared Agent System package in the default Gateway with an explicitly installed agent and a strict AIMock fixture. It verifies agent onboarding, passive Gateway manifest loading, read-only model routing, and value-free lifecycle logging without depending on live model behavior.

The readiness turn uses a GitHub-shaped session key after the installed agent's
manifest switches to notification V2. It must reach the mock model without a
legacy conversation record or V1 prompt attestation. The declaration disables
both intake triggers; this tests passive version selection, not notification
installation or polling. Unit coverage supplies stale V1 state as the negative
control. The routing turn also requests issue-session dispatch while intake is inactive and must be rejected before credential access or creation. This scenario does not exercise successful issue-session creation;
passing it does not establish dispatch recovery or single-execution guarantees.

Runtime tests run this scenario on Ubuntu without a live model or hosted secrets. The data workspace is copied because the passive-loading check changes its manifest after installation.

## Setup

```bash
# should configure the default profile with the prepared plugin and strict mock model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --yolo
openclaw-aimock prepare --scenario openclaw-agent

# should install the scenario-owned data workspace through agent system
cp -R "$GITHUB_WORKSPACE/examples/openclaw-agent/data" "$TMPDIR/data"
cd "$TMPDIR/data"
openclaw agent-system install

# should start the default gateway as a supervised background process
openclaw config set logging.file "$TMPDIR/agent-file.jsonl"
openclaw-gateway start --debug
```

## Testing

```bash
# should keep a v2 agent out of legacy github prompt processing
cat "$GITHUB_WORKSPACE/examples/openclaw-agent/v2-notifications.yaml" >> "$TMPDIR/data/agent.yaml"
openclaw agent \
  --agent data \
  --session-key agent:data:agent-system-github:data:direct:github:issue:r_example:1 \
  --message-file "$GITHUB_WORKSPACE/examples/openclaw-agent/ready.md" \
  --timeout 120

# should load the data manifest through a passive gateway lifecycle
jq -Rr 'fromjson? | .. | strings' "$TMPDIR/agent-file.jsonl" > "$TMPDIR/agent-lifecycle.log"
grep -E \
  '\[agent-system\] manifest_loaded trigger="(service|session_start|before_prompt_build)" agentId="data"' \
  "$TMPDIR/agent-lifecycle.log"

# should keep manifest values out of lifecycle and gateway logs
gateway_log_path="$(openclaw-gateway log-path)"
if grep -Fq 'leia-initial-manifest-value' "$TMPDIR/agent-lifecycle.log"; then exit 1; fi
if grep -Fq 'leia-initial-manifest-value' "$TMPDIR/agent-file.jsonl"; then exit 1; fi
if grep -Fq 'leia-initial-manifest-value' "$gateway_log_path"; then exit 1; fi

# should resolve routing and reject dispatch without active intake
openclaw agent \
  --agent data \
  --session-key agent:data:agent-system-routing-leia \
  --message-file "$GITHUB_WORKSPACE/examples/openclaw-agent/routing.md" \
  --timeout 120 \
  | grep -F 'routing-default-ready'

# should keep disabled native intake inactive through the public notification commands
if openclaw agent-system notifications status --agent data --json > "$TMPDIR/notification-status.json"; then exit 1; fi
jq -e '.status == "degraded" and .code == "github-notification-disabled" and .schemaVersion == 2' "$TMPDIR/notification-status.json"
if openclaw agent-system notifications refresh --agent data --json > "$TMPDIR/notification-refresh.json"; then exit 1; fi
jq -e '.status == "failed" and .code == "github-notification-disabled"' "$TMPDIR/notification-refresh.json"
if openclaw agent-system notifications wait --agent data --for baseline-ready --timeout 1 --json > "$TMPDIR/notification-wait.json"; then exit 1; fi
jq -e '.status == "failed" and .code == "github-notification-disabled"' "$TMPDIR/notification-wait.json"

# should omit temporary dispatch invocation tracing from runtime logs
if grep -Fq 'dispatch-invocation ' "$TMPDIR/agent-file.jsonl"; then exit 1; fi
if grep -Fq 'dispatch-invocation ' "$(openclaw-gateway log-path)"; then exit 1; fi

# should match the complete strict mock exchange
openclaw-aimock evidence \
  --scenario openclaw-agent \
  --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-agent/expected-evidence.json"
```

## Cleanup

```bash
# should stop the background gateway cleanly
openclaw-gateway stop

# should stop the strict mock model cleanly
openclaw-aimock stop
```
