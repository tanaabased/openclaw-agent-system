# OpenClaw Agent Example

This scenario runs the prepared Agent System package in the default Gateway with an explicitly installed agent and a strict AIMock fixture. It verifies agent onboarding, passive Gateway manifest loading, read-only model routing, and value-free lifecycle logging without depending on live model behavior.

The readiness turn uses a GitHub-shaped session key after the installed agent's
manifest declares notification V3. It must reach the mock model using passive
manifest discovery. Both workflows declare paused schedules, and their intake has
not been installed; this tests passive loading without activating notification work.
The routing turn also requests issue-session dispatch before intake activation and must be rejected before credential access or creation. This scenario does not exercise successful issue-session creation;
passing it does not establish dispatch recovery or single-execution guarantees.

Runtime tests run this scenario on Ubuntu without a live model or hosted secrets. The passive-loading check changes the checked-in manifest after installation on the disposable runner.

## Setup

```bash
# should configure the default profile with the prepared plugin and strict mock model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --yolo
openclaw-aimock prepare --scenario openclaw-agent

# should start the default gateway as a supervised background process
openclaw config set logging.file "$TMPDIR/agent-file.jsonl"
openclaw-gateway start --debug

# should install the scenario-owned data workspace into the running gateway
cd "$GITHUB_WORKSPACE/examples/openclaw-agent/data"
openclaw agent-system install
openclaw gateway call agents.list --params '{}' --json | jq -e 'any(.agents[]; .id == "data")'
```

## Testing

```bash
# should reject retired notification configuration through the public validator
cd "$GITHUB_WORKSPACE/examples/openclaw-agent/retired-notifications"
if openclaw agent-system validate --json > "$TMPDIR/retired-notifications.stdout" 2> "$TMPDIR/retired-notifications.stderr"; then exit 1; fi
test ! -s "$TMPDIR/retired-notifications.stdout"
grep -F 'code=manifest-unknown-key' "$TMPDIR/retired-notifications.stderr"

# should load a v3 agent without activating notification work
cat "$GITHUB_WORKSPACE/examples/openclaw-agent/v3-notifications.yaml" >> "$GITHUB_WORKSPACE/examples/openclaw-agent/data/agent.yaml"
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

# should require installation before public commands can use the declared native intake
if openclaw agent-system notifications status --agent data --json > "$TMPDIR/notification-status.json"; then exit 1; fi
jq -e '.status == "degraded" and .code == "intake-activation-required" and .schemaVersion == 2' "$TMPDIR/notification-status.json"
if openclaw agent-system notifications refresh --agent data --json > "$TMPDIR/notification-refresh.json"; then exit 1; fi
jq -e '.status == "failed" and .code == "intake-activation-required"' "$TMPDIR/notification-refresh.json"
if openclaw agent-system notifications wait --agent data --for baseline-ready --timeout 1 --json > "$TMPDIR/notification-wait.json"; then exit 1; fi
jq -e '.status == "failed" and .code == "intake-activation-required"' "$TMPDIR/notification-wait.json"

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
