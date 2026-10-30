# OpenClaw Automation Recovery Example

Check how an offline scheduler fails, then synchronize two jobs and repair changed
routing with Doctor and Install. Restart the Gateway and complete the prompt using
the same job IDs. Finally, remove the command job and its ownership record while
preserving the unrelated prompt.

## What Belongs Here

- Offline diagnostics with an actionable connectivity recovery.
- Read-only drift inspection, explicit repair, and preservation of both changed and unrelated native job identities.
- Restored routing after restart and a completed prompt in the owning native context.
- A captured command report held by missing hook permission, then delivered after restart without rerunning the command.
- Retirement after declaration removal and native deletion, without recreating the job or blocking the unrelated prompt.

## What Does Not Belong Here

- Ordinary command/prompt execution and repeat synchronization: [automations](../openclaw-automations/README.md).
- Notification pause/resume: [notification scheduling](../openclaw-notifications-scheduling/README.md).

## Notes

- Strict AIMock supplies one recovered report and one prompt completion. The Gateway, native scheduler, drift, repair, and restart remain real without a hosted credential.
- Two jobs make preservation meaningful during repair. The command runs once with reporting held; after restart, the prompt must receive its recovered report as history.
- Retirement adds only direct native observations and synchronization; no additional model turn or Gateway restart.

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
openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess false --strict-json
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

# should retain a successful command when reporting lacks native hook permission
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery"
run_id=$(openclaw agent-system automations run identity --json | jq -er 'select(.status == "queued") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" identity "$run_id"
openclaw agent-system automations runs identity --json | jq -e 'any(.reports[]; .status == "pending" and .reason == "Exit 0" and .code == "automation-report-hook-permission-required")'
test "$(wc -l < identity.runs | tr -d ' ')" = 1

# should recover the report across restart and complete a prompt in the owning agent context
gateway_log=$(openclaw-gateway log-path)
gateway_redactor="$(dirname "$(command -v openclaw-gateway)")/lib/redact-stream.mjs"
shutdown_status=0
openclaw-gateway stop --timeout 340 || shutdown_status=$?
tail -n 1000 "$gateway_log" | node "$gateway_redactor" | tee "$TMPDIR/openclaw-automation-recovery-before-restart.log"
test "$shutdown_status" -eq 0
openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess true --strict-json
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery"
for attempt in $(seq 1 60); do
  openclaw agent-system automations runs identity --json > "$TMPDIR/recovered-report.json"
  if jq -e 'any(.reports[]; .status == "delivered" and (.messageId | type == "string"))' "$TMPDIR/recovered-report.json" >/dev/null; then break; fi
  sleep 2
done
jq -e 'any(.reports[]; .status == "delivered" and .effective.model == "aimock/gpt-5.5" and .effective.effort == "medium")' "$TMPDIR/recovered-report.json"
test "$(wc -l < identity.runs | tr -d ' ')" = 1
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "unchanged")'
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' | diff - "$TMPDIR/automation-identities.json"
run_id=$(openclaw agent-system automations run prompt --json | jq -er 'select(.status == "queued" and .execution == "unavailable") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" prompt "$run_id"
openclaw-aimock evidence --scenario openclaw-automation-recovery --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery/expected-evidence.json"

# should retire a deleted undeclared job while preserving the unrelated native identity
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery"
native=$(jq -er '.jobs[] | select(.id == "identity") | .nativeId' "$TMPDIR/automation-before.json")
node --input-type=module -e 'import fs from "node:fs"; import YAML from "yaml"; const file = "automations.yaml"; fs.writeFileSync(file, YAML.stringify(YAML.parse(fs.readFileSync(file, "utf8")).filter(job => job.id !== "identity")));'
openclaw agent-system automations sync --json | jq -e 'any(.outcomes[]; .stepId == "identity" and .code == "automation-disabled-retained")'
openclaw cron rm "$native" --json | jq -e '.removed == true'
openclaw agent-system automations sync --json | jq -e 'any(.outcomes[]; .stepId == "identity" and .code == "automation-retired") and all(.outcomes[]; .status != "created")'
openclaw agent-system doctor --json | jq -e 'any(.findings[]; .component == "automations" and .stepId == "identity" and .code == "automation-retired" and .status == "healthy")'
openclaw agent-system automations list --json | tee "$TMPDIR/automation-retired.json" | jq -e '.status == "aligned" and any(.jobs[]; .id == "identity" and .retired == true and .nativeEnabled == null)'
jq -S '[.jobs[] | select(.id == "prompt") | {id, nativeId, routing}]' "$TMPDIR/automation-before.json" > "$TMPDIR/automation-prompt-identity.json"
jq -S '[.jobs[] | select(.id == "prompt") | {id, nativeId, routing}]' "$TMPDIR/automation-retired.json" | diff - "$TMPDIR/automation-prompt-identity.json"
```
