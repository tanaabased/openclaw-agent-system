# OpenClaw Automation Recovery Example

Observe an offline scheduler failure, synchronize two native jobs, repair deliberately changed routing through Doctor and Install, then restart the Gateway and complete the prompt with the same native job identities.

## What Belongs Here

- Offline diagnostics with an actionable connectivity recovery.
- Read-only drift inspection, explicit repair, and preservation of both changed and unrelated native job identities.
- Restored routing after restart and a completed prompt in the owning native context.

## What Does Not Belong Here

- Ordinary command/prompt execution and repeat synchronization: [automations](../openclaw-automations/README.md).
- Notification pause/resume: [notification scheduling](../openclaw-notifications-scheduling/README.md).

## Notes

- Strict AIMock supplies one prompt completion. The Gateway, native scheduler, drift, repair, and restart remain real without a hosted credential.
- Two jobs make preservation meaningful during repair; the recovery flow runs only the prompt. The ordinary flow owns command completion.

## Setup

```bash
# should prepare the packed plugin and strict scheduled-prompt fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
openclaw-aimock prepare --scenario openclaw-automation-recovery

# should install the owning workspace before starting the gateway
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery"
openclaw agent-system install --yes --json


# should group an unavailable gateway failure with evidence and recovery before startup
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery"
sync_status=0
NO_COLOR=1 openclaw agent-system automations sync >"$TMPDIR/offline-sync.stdout" 2>"$TMPDIR/offline-sync.stderr" || sync_status=$?
test "$sync_status" -eq 1
test "$(grep -Fc '✖ error' "$TMPDIR/offline-sync.stderr")" -eq 1
grep -F 'code=automation-gateway-unavailable' "$TMPDIR/offline-sync.stderr"
grep -F 'gateway diagnostic:' "$TMPDIR/offline-sync.stderr"
grep -F 'restore gateway connectivity' "$TMPDIR/offline-sync.stderr"


# should start the gateway for native recovery checks
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
```

## Testing

```bash
# should synchronize both jobs without duplicating native identities or routing
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery"
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
openclaw agent-system automations list --json | tee "$TMPDIR/automation-before.json" | jq -e '.status == "aligned" and ([.jobs[].id] | sort) == ["identity","prompt"] and all(.jobs[]; .nativeEnabled == true) and any(.jobs[]; .id == "prompt" and (.routing | startswith("session:agent:")))'
jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' "$TMPDIR/automation-before.json" > "$TMPDIR/automation-identities.json"

# should diagnose native drift without repair and reinstall the same jobs
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery"
native=$(jq -er '.jobs[] | select(.id == "prompt") | .nativeId' "$TMPDIR/automation-before.json")
openclaw cron edit "$native" --thinking high --json | jq -e '.payload.thinking == "high"'
status=0
openclaw agent-system doctor --json > "$TMPDIR/automation-drift.json" || status=$?
test "$status" -eq 1
jq -e 'any(.findings[]; .component == "automations" and .code == "automation-drift" and .status == "drift")' "$TMPDIR/automation-drift.json"
openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json | jq -e '.payload.thinking == "high"'
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .component == "automations" and .status == "updated")'
openclaw agent-system automations list --json | tee "$TMPDIR/automation-reconciled.json" | jq -e '.status == "aligned"'
jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' "$TMPDIR/automation-reconciled.json" | diff - "$TMPDIR/automation-identities.json"

# should preserve routing across restart and complete a prompt in the owning agent context
gateway_log=$(openclaw-gateway log-path)
gateway_redactor="$(dirname "$(command -v openclaw-gateway)")/lib/redact-stream.mjs"
shutdown_status=0
openclaw-gateway stop --timeout 340 || shutdown_status=$?
tail -n 1000 "$gateway_log" | node "$gateway_redactor" | tee "$TMPDIR/openclaw-automation-recovery-before-restart.log"
test "$shutdown_status" -eq 0
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery"
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "unchanged")'
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' | diff - "$TMPDIR/automation-identities.json"
run_id=$(openclaw agent-system automations run prompt --json | jq -er 'select(.status == "queued" and .execution == "unavailable") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" prompt "$run_id"
openclaw-aimock evidence --scenario openclaw-automation-recovery --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery/expected-evidence.json"
```
