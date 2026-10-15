# OpenClaw Automations Example

Verify the installed scheduler's critical paths through `openclaw agent-system automations`: sync without duplication, execute a command under the owning agent, and retain native identity and persistent prompt routing through a Gateway restart. Strict AIMock verifies one completed prompt in the owning agent's context. Runtime tests run this example on Ubuntu without provider credentials or remote SSH.

The workspace is copied because command execution writes its receipts there. Both jobs recur hourly; explicit `run` requests exercise them immediately, and exact run IDs distinguish admission from completion. Source tests cover option variants, offline failures, one-shot retention, unmanaged jobs, stale authority, containment, timeouts, cancellation cleanup, and thread-selection permutations.

## Setup

```bash
# should prepare the packed plugin and strict scheduled-prompt fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
openclaw-aimock prepare --scenario openclaw-automations

# should install the owning workspace before starting the gateway
mkdir -p "$TMPDIR/automation-agent"
cp "$GITHUB_WORKSPACE/examples/openclaw-automations/agent.yaml" \
  "$GITHUB_WORKSPACE/examples/openclaw-automations/automations.yaml" \
  "$GITHUB_WORKSPACE/examples/openclaw-automations/probe.sh" \
  "$GITHUB_WORKSPACE/examples/openclaw-automations/IDENTITY.md" \
  "$GITHUB_WORKSPACE/examples/openclaw-automations/prompt.md" \
  "$TMPDIR/automation-agent"
cd "$TMPDIR/automation-agent"
openclaw agent-system install --yes --json

# should start the gateway with the installed agent
openclaw-gateway start
```

## Testing

```bash
# should synchronize both jobs without duplicating native identities or routing
cd "$TMPDIR/automation-agent"
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
openclaw agent-system automations list --json | tee "$TMPDIR/automation-before.json" | jq -e '.status == "aligned" and ([.jobs[].id] | sort) == ["identity","prompt"] and all(.jobs[]; .nativeEnabled == true) and any(.jobs[]; .id == "prompt" and (.routing | startswith("session:agent:")))'
jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' "$TMPDIR/automation-before.json" > "$TMPDIR/automation-identities.json"
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "unchanged")'
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' | diff - "$TMPDIR/automation-identities.json"

# should complete one command under the owning managed git identity
cd "$TMPDIR/automation-agent"
run_id=$(openclaw agent-system automations run identity --json | jq -er 'select(.status == "queued" and .execution == "unavailable") | .runId | strings')
node "$GITHUB_WORKSPACE/examples/openclaw-automations/wait-for-run.mjs" identity "$run_id"
grep -F 'Tanaabot <tanaabot@tanaab.dev>' identity.git
test "$(wc -l < identity.runs | tr -d ' ')" = 1

# should preserve routing across restart and complete a prompt in the owning agent context
openclaw-gateway stop
openclaw-gateway start
cd "$TMPDIR/automation-agent"
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "unchanged")'
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' | diff - "$TMPDIR/automation-identities.json"
run_id=$(openclaw agent-system automations run prompt --json | jq -er 'select(.status == "queued" and .execution == "unavailable") | .runId | strings')
node "$GITHUB_WORKSPACE/examples/openclaw-automations/wait-for-run.mjs" prompt "$run_id"
openclaw-aimock evidence --scenario openclaw-automations --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-automations/expected-evidence.json"
test "$(wc -l < identity.runs | tr -d ' ')" = 1
```

## Cleanup

```bash
# should stop the gateway and strict mock provider
openclaw-gateway stop
openclaw-aimock stop
```
