# OpenClaw Automations Example

Synchronize one command and one prompt automation without duplication, execute each under its owning agent, and verify completed runs and stable native job identities/routing.

## What Belongs Here

- Public managed sync/list/run boundaries and repeated sync preserving the same native jobs.
- A completed command receipt proving managed Git identity and a completed prompt in the owning agent context.
- Exact native run IDs and durable completion evidence, rather than treating queued admission as success.

## What Does Not Belong Here

- Offline scheduler diagnostics, native drift/repair, and routing after restart: [automation recovery](../openclaw-automation-recovery/README.md).
- Strict Git/GitHub launcher descendants and token isolation: [tool descendants](../openclaw-tool-descendants/README.md).
- Notification intake and issue progression: [intake](../openclaw-notifications-intake/README.md) and [progression](../openclaw-notifications-progression/README.md).

## Notes

- Both jobs recur hourly; explicit run requests exercise them immediately. Command receipts are written beside the checked-in manifest on the disposable runner.
- Strict AIMock supplies one prompt completion; scheduling, the Gateway, and command execution remain real. No hosted provider credential or remote SSH is needed.
- Pending tightening: category/name presentation checks remain below; their source-owner coverage will be assessed in the duplication pass.
- Source tests cover option/offline variants, one-shot retention, unmanaged jobs, stale authority, containment, timeout/cancellation cleanup, and thread-selection permutations.

## Setup

```bash
# should prepare the packed plugin and strict scheduled-prompt fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
openclaw-aimock prepare --scenario openclaw-automations

# should install the owning workspace before starting the gateway
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
openclaw agent-system install --yes --json

# should start the gateway with the installed agent
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
```

## Testing

```bash
# should synchronize both jobs without duplicating native identities or routing
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
openclaw agent-system automations list --json | tee "$TMPDIR/automation-before.json" | jq -e '.status == "aligned" and ([.jobs[].id] | sort) == ["identity","prompt"] and all(.jobs[]; .nativeEnabled == true) and any(.jobs[]; .id == "prompt" and (.routing | startswith("session:agent:")))'
jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' "$TMPDIR/automation-before.json" > "$TMPDIR/automation-identities.json"
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "unchanged")'
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' | diff - "$TMPDIR/automation-identities.json"

# should present each job under a stable category with unquoted names on install and doctor
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
NO_COLOR=1 openclaw agent-system install --yes | grep -E '^automation[[:space:]]+unchanged[[:space:]]' | grep -F 'name:'
NO_COLOR=1 openclaw agent-system doctor | grep -E '^automation[[:space:]]+healthy[[:space:]]' | grep -F 'name:'

# should complete one command under the owning managed git identity
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
run_id=$(openclaw agent-system automations run identity --json | jq -er 'select(.status == "queued" and .execution == "unavailable") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" identity "$run_id"
grep -F 'Tanaabot <tanaabot@tanaab.dev>' identity.git
test "$(wc -l < identity.runs | tr -d ' ')" = 1

# should complete a prompt in the owning agent context
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
run_id=$(openclaw agent-system automations run prompt --json | jq -er 'select(.status == "queued" and .execution == "unavailable") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" prompt "$run_id"
openclaw-aimock evidence --scenario openclaw-automations --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-automations/expected-evidence.json"
test "$(wc -l < identity.runs | tr -d ' ')" = 1
```

## Cleanup

```bash
# should stop the gateway and strict mock provider
shutdown_status=0
openclaw-gateway stop --timeout 340 || shutdown_status=$?
openclaw-aimock stop
test "$shutdown_status" -eq 0
```
