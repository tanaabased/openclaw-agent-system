# OpenClaw Automation Recovery Example

Check how an offline scheduler fails, then synchronize two jobs and repair changed
routing with Doctor and Install. Restart the Gateway and complete the prompt using
the same job IDs. Finally, remove the command job and its ownership record while
preserving the unrelated prompt.

## What Belongs Here

- Offline diagnostics with an actionable connectivity recovery.
- Read-only drift inspection, explicit repair, and preservation of both changed and unrelated native job identities.
- Restored routing after restart and a completed prompt in the owning native context.
- A captured command report held by changed chat settings, then delivered after restart without rerunning the command.
- Retirement after declaration removal and native deletion, without recreating the job or blocking the unrelated prompt.

## What Does Not Belong Here

- Ordinary command/prompt execution and repeat synchronization: [automations](../openclaw-automation-command/README.md).
- Notification pause/resume: [notification scheduling](../openclaw-notifications-scheduling/README.md).

## Notes

- Strict AIMock supplies responses; the Gateway, scheduler, repair, and restart remain real.
- The prompt must receive the recovered report as history without rerunning the command.
- Removing the last reporting command leaves a stale tool grant until Install reconciles it. Retirement checks that drift before repair, without another model turn or Gateway restart.

## Setup

```bash
# should prepare the packed plugin and strict scheduled-prompt fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service
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
openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess true --strict-json
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start

# should enroll command reporting only after the offline scheduler diagnostic is complete
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery"
node --input-type=module -e 'import fs from "node:fs"; import {parse,stringify} from "yaml"; const jobs=parse(fs.readFileSync("automations.yaml","utf8")); jobs.find(({id})=>id==="identity").thread={id:"automation-status",name:"Automation status"}; fs.writeFileSync("automations.yaml",stringify(jobs));'
openclaw agent-system install --yes --json
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

# should retain a successful command when its reporting chat settings have drifted
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery"
chat=$(jq -er '.jobs[] | select(.id == "identity") | .routing | sub("^session:"; "")' "$TMPDIR/automation-before.json")
openclaw gateway call sessions.patch --params "$(jq -nc --arg key "$chat" '{key:$key,thinkingLevel:"high"}')" --json
run_id=$(openclaw agent-system automations run identity --json | jq -er 'select(.status == "queued") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" identity "$run_id"
openclaw agent-system automations runs identity --json | jq -e --argjson expected '{"status":"pending","reason":"Exit 0","code":"automation-report-settings-drift"}' -f "$GITHUB_WORKSPACE/scripts/assert-automation-report.jq"
test "$(wc -l < identity.runs | tr -d ' ')" = 1

# should recover the report across restart and complete a prompt in the owning agent context
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery"
chat=$(jq -er '.jobs[] | select(.id == "identity") | .routing | sub("^session:"; "")' "$TMPDIR/automation-before.json")
openclaw gateway call sessions.patch --params "$(jq -nc --arg key "$chat" '{key:$key,thinkingLevel:"medium"}')" --json
gateway_log=$(openclaw-gateway log-path)
gateway_redactor="$(dirname "$(command -v openclaw-gateway)")/lib/redact-stream.mjs"
shutdown_status=0
openclaw-gateway stop --timeout 340 || shutdown_status=$?
tail -n 1000 "$gateway_log" | node "$gateway_redactor" | tee "$TMPDIR/openclaw-automation-recovery-before-restart.log"
test "$shutdown_status" -eq 0
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-recovery"
deadline=$((SECONDS + 120))
while test "$SECONDS" -lt "$deadline"; do
  remaining=$((deadline - SECONDS))
  test "$remaining" -gt 0 || break
  timeout --signal=TERM --kill-after=5 "$remaining" openclaw agent-system automations runs identity --json > "$TMPDIR/recovered-report.json"
  if jq -e 'any(.reports[]; .status == "delivered" and (.messageId | type == "string"))' "$TMPDIR/recovered-report.json" >/dev/null; then break; fi
  sleep 2
done
jq -e --argjson expected '{"status":"delivered","effective.model":"aimock/gpt-5.5"}' -f "$GITHUB_WORKSPACE/scripts/assert-automation-report.jq" "$TMPDIR/recovered-report.json"
report_execution=$(jq -er '.reports[] | select(.status == "delivered") | .executionId' "$TMPDIR/recovered-report.json")
grep -F 'embedded run start:' "$(openclaw-gateway log-path)" | grep -F "runId=$report_execution " | grep -F 'provider=aimock model=gpt-5.5 thinking=medium '
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
doctor_status=0
openclaw agent-system doctor --json > "$TMPDIR/automation-retired-doctor.json" || doctor_status=$?
if [ "$doctor_status" -ne 0 ]; then
  jq -c '{status, findings: [.findings[] | select(.status == "blocked" or .status == "drift") | {component, stepId, code, status}][:20]}' "$TMPDIR/automation-retired-doctor.json" >&2
fi
test "$doctor_status" -eq 1
jq -e '.status == "drift" and ([.findings[] | select(.status == "blocked" or .status == "drift") | {component, code, status}] == [{component:"tool-access", code:"agent-tool-access-drift", status:"drift"}])' "$TMPDIR/automation-retired-doctor.json"
jq -e 'any(.findings[]; .component == "automations" and .stepId == "identity" and .code == "automation-retired" and .status == "healthy")' "$TMPDIR/automation-retired-doctor.json"
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .component == "tool-access" and .code == "set-agent-tool-access" and .status == "updated") and all(.outcomes[]; .status != "created")'
openclaw agent-system doctor --json | jq -e '.status == "healthy" and any(.findings[]; .component == "automations" and .stepId == "identity" and .code == "automation-retired" and .status == "healthy")'
openclaw agent-system automations list --json | tee "$TMPDIR/automation-retired.json" | jq -e '.status == "aligned" and any(.jobs[]; .id == "identity" and .retired == true and .nativeEnabled == null)'
jq -S '[.jobs[] | select(.id == "prompt") | {id, nativeId, routing}]' "$TMPDIR/automation-before.json" > "$TMPDIR/automation-prompt-identity.json"
jq -S '[.jobs[] | select(.id == "prompt") | {id, nativeId, routing}]' "$TMPDIR/automation-retired.json" | diff - "$TMPDIR/automation-prompt-identity.json"
```
