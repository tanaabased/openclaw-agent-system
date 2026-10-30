# OpenClaw Automations Example

Install one command job and one prompt job, then execute each as its configured agent.
Verify that both finish and repeat installation preserves their IDs and routing.

## What Belongs Here

- Public managed sync/list/run boundaries and repeated sync preserving the same native jobs, including migration of legacy native names and command output limits.
- Shared model/effort creation and same-chat updates, followed by a timer-fired occurrence with native execution evidence.
- Command reporting and a scheduled prompt share one persistent chat; the prompt receives the preceding report as history.
- Native display-name rename/removal while preserving the job, its completed run state, and separate chat binding.
- Completed same-agent Install/Doctor through a command descendant and native prompt tools, including default setup, without per-occurrence approval.
- Failed command output beyond the former local caps and exit status reaching the exact native run record with delivery disabled.
- Exact native run IDs and durable completion evidence, rather than treating queued admission as success.

## What Does Not Belong Here

- Offline scheduler diagnostics, native drift/repair, and routing after restart: [automation recovery](../openclaw-automation-recovery/README.md).
- Strict Git/GitHub launcher descendants and token isolation: [tool descendants](../openclaw-tool-descendants/README.md).
- Notification intake and issue progression: [intake](../openclaw-notifications-intake/README.md) and [progression](../openclaw-notifications-progression/README.md).

## Notes

- The command uses an explicit command/args object; the prompt explicitly enables its default-enabled behavior while the command leaves that default implicit.

- Jobs initially recur hourly. Run the command explicitly; after updating prompt settings, change its schedule to one minute from now and wait for the native timer. This adds a bounded wait, not another model turn. Command receipts are written beside the checked-in manifest on the disposable runner.
- Strict AIMock supplies Install, Doctor, and the final response; scheduling, native lifecycle authorization, setup, and command execution remain real. No hosted provider credential or remote SSH is needed. Native lifecycle approval is not automatically allowed; an unexpected approval stalls and fails the occurrence.
- AIMock normalizes away request reasoning effort. Verify effort through the native embedded-run diagnostic correlated with the completed occurrence's session, not through the mock response or saved settings alone.
- Source tests cover option/offline variants, one-shot retention, unmanaged jobs, stale authority, containment, timeout/cancellation cleanup, and thread-selection permutations.
- The failure fixture emits 64 KiB per stream, then late markers and exit 17. This exceeds the former local caps while keeping native diagnostic redaction within its transaction admission budget. Component tests cover forwarding native truncation metadata; this installed case verifies default capture without truncation. It adds no model turn or provider call.
- Reporting adds one formatting turn per reporting command, three timer-fired commands, one repeated Install, and fresh history reads. The strict fixture verifies transport and card envelopes, not genuine model interpretation. Component tests own delivery failures and sanitization. Browser rendering remains a separate visual check.
- The output check reads `cron.runs`, the Gateway API supplying run cards. It verifies output propagation, not browser rendering or OpenClaw restart persistence.

## Setup

```bash
# should prepare the packed plugin and strict scheduled-prompt fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --yolo
openclaw-aimock prepare --scenario openclaw-automations

# should keep automation session choices local even when native sticky selection is global
openclaw config set agents.defaults.modelSelectionScope global
openclaw config get agents.defaults.model --json > "$TMPDIR/automation-global-model.json"

# should install the owning workspace with reporting enrollment
openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess true --strict-json
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
openclaw agent-system install --skip-setup --yes --json
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

# should move the persistent chat between normalized categories without replacing its schedule
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
chat=$(jq -er '.jobs[] | select(.id == "prompt") | .routing | sub("^session:"; "")' "$TMPDIR/automation-before.json")
openclaw gateway call sessions.list --params '{"limit":100}' --json | jq -e --arg key "$chat" 'any(.sessions[]; .key == $key and .category == "AGENT SYSTEM")'
node --input-type=module -e 'import fs from "node:fs"; import {parse,stringify} from "yaml"; const jobs=parse(fs.readFileSync("automations.yaml","utf8")); for(const job of jobs) job.group="  straße ops  "; fs.writeFileSync("automations.yaml",stringify(jobs));'
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
openclaw gateway call sessions.list --params '{"limit":100}' --json | jq -e --arg key "$chat" 'any(.sessions[]; .key == $key and .category == "STRASSE OPS")'
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "unchanged")'
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' | diff - "$TMPDIR/automation-identities.json"

# should save changed effort on the same chat and scheduled job
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
chat=$(jq -er '.jobs[] | select(.id == "prompt") | .routing | sub("^session:"; "")' "$TMPDIR/automation-before.json")
openclaw gateway call sessions.list --params '{"limit":100}' --json | jq -e --arg key "$chat" 'any(.sessions[]; .key == $key and .thinkingLevel == "medium")'
node --input-type=module -e 'import fs from "node:fs"; import {parse,stringify} from "yaml"; const jobs=parse(fs.readFileSync("automations.yaml","utf8")); for(const job of jobs) job.effort="high"; fs.writeFileSync("automations.yaml",stringify(jobs));'
if output=$(NO_COLOR=1 openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'name: Automation status'
printf '%s\n' "$output" | grep -F 'automation-thread-model-drift'
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
openclaw gateway call sessions.list --params '{"limit":100}' --json | jq -e --arg key "$chat" 'any(.sessions[]; .key == $key and .thinkingLevel == "high" and (.model == "gpt-5.5" or .model == "aimock/gpt-5.5"))'
native=$(jq -er '.jobs[] | select(.id == "prompt") | .nativeId' "$TMPDIR/automation-before.json")
openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json | jq -e '.payload.model == "aimock/gpt-5.5" and .payload.thinking == "high"'
openclaw config get agents.defaults.model --json | diff - "$TMPDIR/automation-global-model.json"
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "unchanged")'
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' | diff - "$TMPDIR/automation-identities.json"

# should complete one command under the owning managed git identity
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
run_id=$(openclaw agent-system automations run identity --json | jq -er 'select(.status == "queued" and .execution == "unavailable") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" identity "$run_id"
grep -F 'Tanaabot <tanaabot@tanaab.dev>' identity.git
grep -Fx installed maintenance.installed
test "$(wc -l < identity.runs | tr -d ' ')" = 1
for attempt in $(seq 1 60); do
  openclaw agent-system automations runs identity --json > "$TMPDIR/identity-report.json"
  if jq -e 'any(.reports[]; .status == "delivered" and .effective.model == "aimock/gpt-5.5")' "$TMPDIR/identity-report.json"
report_execution=$(jq -er '.reports[] | select(.status == "delivered") | .executionId' "$TMPDIR/identity-report.json")
grep -F 'embedded run start:' "$(openclaw-gateway log-path)" | grep -F "runId=$report_execution " | grep -F 'provider=aimock model=gpt-5.5 thinking=high '
 >/dev/null; then break; fi
  sleep 2
done
jq -e 'any(.reports[]; .status == "delivered" and .effective.model == "aimock/gpt-5.5")' "$TMPDIR/identity-report.json"
report_execution=$(jq -er '.reports[] | select(.status == "delivered") | .executionId' "$TMPDIR/identity-report.json")
grep -F 'embedded run start:' "$(openclaw-gateway log-path)" | grep -F "runId=$report_execution " | grep -F 'provider=aimock model=gpt-5.5 thinking=high '



# should execute the next timer-fired prompt with the saved model and effort
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
rm maintenance.installed
node --input-type=module -e 'import fs from "node:fs"; import {parse,stringify} from "yaml"; const jobs=parse(fs.readFileSync("automations.yaml","utf8")); jobs.find(({id})=>id==="prompt").schedule="in 1 minute"; fs.writeFileSync("automations.yaml",stringify(jobs));'
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
native=$(jq -er '.jobs[] | select(.id == "prompt") | .nativeId' "$TMPDIR/automation-before.json")
due=$(openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json | jq -er '.state.nextRunAtMs | numbers')
for attempt in $(seq 1 90); do
  openclaw gateway call cron.runs --params "$(jq -nc --arg id "$native" '{id:$id,limit:1,offset:0}')" --json > "$TMPDIR/automation-timer-run.json"
  if jq -e --arg id "$native" --argjson due "$due" 'any(.entries[]; .jobId == $id and .runAtMs >= $due)' "$TMPDIR/automation-timer-run.json" >/dev/null; then break; fi
  sleep 2
done
run_session=$(jq -er --arg id "$native" --argjson due "$due" '.entries[] | select(.jobId == $id and .runAtMs >= $due and .status == "ok" and .provider == "aimock" and .model == "gpt-5.5") | .sessionId | strings' "$TMPDIR/automation-timer-run.json")
grep -F 'embedded run start:' "$(openclaw-gateway log-path)" | grep -F "sessionId=$run_session " | grep -F 'provider=aimock model=gpt-5.5 thinking=high '
grep -Fx installed maintenance.installed
test "$(wc -l < identity.runs | tr -d ' ')" = 1
# should migrate legacy native names in place after both jobs have completed
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
for job in identity prompt; do
  native=$(jq -er --arg job "$job" '.jobs[] | select(.id == $job) | .nativeId' "$TMPDIR/automation-before.json")
  openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json > "$TMPDIR/name-before-$job.json"
  jq -S 'del(.name,.configRevision,.updatedAtMs)' "$TMPDIR/name-before-$job.json" > "$TMPDIR/name-preserved-$job.json"
  openclaw gateway call cron.update --params "$(jq -c --arg job "$job" '{id,expectedConfigRevision:.configRevision,patch:{name:("Agent System: "+$job)}}' "$TMPDIR/name-before-$job.json")" --json > /dev/null
done
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "updated")'
for job in identity prompt; do
  native=$(jq -er --arg job "$job" '.jobs[] | select(.id == $job) | .nativeId' "$TMPDIR/automation-before.json")
  openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json | tee "$TMPDIR/name-after-$job.json" | jq -e --arg job "$job" '.name == ("AUTOMATION-TANAABOT: "+$job)'
  jq -S 'del(.name,.configRevision,.updatedAtMs)' "$TMPDIR/name-after-$job.json" | diff - "$TMPDIR/name-preserved-$job.json"
done
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "unchanged")'

# should rename and clear the automation label without replacing its job or chat
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
native=$(jq -er '.jobs[] | select(.id == "prompt") | .nativeId' "$TMPDIR/automation-before.json")
openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json > "$TMPDIR/label-before.json"
jq -e '.displayName == "🔄 AUTOMATION STATUS" and .name == "AUTOMATION-TANAABOT: prompt"' "$TMPDIR/label-before.json"
jq -S '{id,name,declarationKey,agentId,schedule,sessionTarget,payload,enabled,history:(.state | {lastRunAtMs,lastRunStatus,lastDurationMs})}' "$TMPDIR/label-before.json" > "$TMPDIR/label-preserved.json"
for label in '🔄 RENAMED STATUS' ''; do
  node --input-type=module -e 'import fs from "node:fs"; import {parse,stringify} from "yaml"; const jobs=parse(fs.readFileSync("automations.yaml","utf8")); const job=jobs.find(({id})=>id==="prompt"); if(process.argv[1]) job["display-name"]=process.argv[1]; else delete job["display-name"]; fs.writeFileSync("automations.yaml",stringify(jobs));' "$label"
  openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and any(.outcomes[]; .stepId == "prompt" and .status == "updated")'
  openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json > "$TMPDIR/label-after.json"
  jq -e --arg label "$label" '(.displayName // "") == $label' "$TMPDIR/label-after.json"
  jq -S '{id,name,declarationKey,agentId,schedule,sessionTarget,payload,enabled,history:(.state | {lastRunAtMs,lastRunStatus,lastDurationMs})}' "$TMPDIR/label-after.json" | diff - "$TMPDIR/label-preserved.json"
  openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "unchanged")'
done
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' | diff - "$TMPDIR/automation-identities.json"
```

```bash
# should retain long output and the actual exit of a failed command with notifications disabled
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
rm -f failed-output.started failed-output.finished
trap 'for phase in started finished; do if test -f "failed-output.$phase"; then printf "fixture %s: present\n" "$phase" >&2; else printf "fixture %s: absent\n" "$phase" >&2; fi; done' ERR
cat failed-output.yaml >> automations.yaml
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
openclaw agent-system automations list --json > "$TMPDIR/automation-output-job.json"
native=$(jq -er '.jobs[] | select(.id == "failed-output") | .nativeId' "$TMPDIR/automation-output-job.json")
openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json | jq -e '.delivery.mode == "none" and (.payload | has("outputMaxBytes") | not)'
run_id=$(openclaw agent-system automations run failed-output --json | jq -er 'select(.status == "queued") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" failed-output "$run_id" error
openclaw gateway call cron.runs --params "$(jq -nc --arg id "$native" --arg runId "$run_id" '{id:$id,runId:$runId,limit:1}')" --json > "$TMPDIR/failed-output-native-run.json"
node --input-type=module - "$native" "$run_id" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { assertFailedCommandRun } = await import(pathToFileURL(process.env.GITHUB_WORKSPACE + '/scripts/wait-for-automation-run.mjs'));
const page = JSON.parse(readFileSync(process.env.TMPDIR + '/failed-output-native-run.json', 'utf8'));
assertFailedCommandRun(page, process.argv[2], process.argv[3], 17);
NODE
jq -e --arg runId "$run_id" 'any(.entries[]; .runId == $runId and .status == "error" and (.summary | contains("stdout-fixture-marker")) and (.summary | contains("stderr-fixture-marker")) and any(.diagnostics.entries[]; .exitCode == 17 and .truncated != true) and any(.summary | split("\n")[] | fromjson?; .id == "failed-output" and .exitCode == 17 and .termination == "exit" and .timedOut == false and .cancelled == false and .truncated == false and .stdoutTruncatedBytes == 0 and .stderrTruncatedBytes == 0))' "$TMPDIR/failed-output-native-run.json"
test -f failed-output.started
test -f failed-output.finished
printf '%s\n' "$run_id" > "$TMPDIR/failed-output-run-id"
trap - ERR
```

```bash
# should migrate an existing command limit without replacing its schedule or failed run history
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
native=$(jq -er '.jobs[] | select(.id == "failed-output") | .nativeId' "$TMPDIR/automation-output-job.json")
run_id=$(cat "$TMPDIR/failed-output-run-id")
openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json > "$TMPDIR/capture-before.json"
openclaw gateway call cron.update --params "$(jq -c '{id,expectedConfigRevision:.configRevision,patch:{payload:{kind:"command",outputMaxBytes:16384}}}' "$TMPDIR/capture-before.json")" --json > /dev/null
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and any(.outcomes[]; .stepId == "failed-output" and .status == "updated")'
openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json > "$TMPDIR/capture-after.json"
jq -e '.payload.outputMaxBytes == 16777216' "$TMPDIR/capture-after.json"
jq -S '{id,name,declarationKey,agentId,enabled,schedule,sessionTarget,delivery,payload:(.payload | del(.outputMaxBytes)),history:(.state | {lastRunAtMs,lastRunStatus,lastDurationMs})}' "$TMPDIR/capture-before.json" > "$TMPDIR/capture-preserved.json"
jq -S '{id,name,declarationKey,agentId,enabled,schedule,sessionTarget,delivery,payload:(.payload | del(.outputMaxBytes)),history:(.state | {lastRunAtMs,lastRunStatus,lastDurationMs})}' "$TMPDIR/capture-after.json" | diff - "$TMPDIR/capture-preserved.json"
openclaw gateway call cron.runs --params "$(jq -nc --arg id "$native" --arg runId "$run_id" '{id:$id,runId:$runId,limit:1}')" --json | jq -e --arg runId "$run_id" 'any(.entries[]; .runId == $runId and .status == "error" and (.summary | contains("stderr-fixture-marker")))'
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "unchanged")'
```

```bash
# should enroll timer-fired reports into the existing shared chat without replacing it
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
cat reports.yaml >> automations.yaml
openclaw agent-system install --skip-setup --yes --json
openclaw agent-system automations list --json > "$TMPDIR/report-jobs.json"
chat=$(jq -er '.jobs[] | select(.id == "prompt") | .routing' "$TMPDIR/automation-before.json")
jq -e --arg chat "$chat" 'all(.jobs[] | select(.id | endswith("-report")); .routing == $chat)' "$TMPDIR/report-jobs.json"
openclaw agent-system install --skip-setup --yes --json
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id,nativeId,routing}] | sort_by(.id)' > "$TMPDIR/report-reinstalled.json"
jq -S '[.jobs[] | {id,nativeId,routing}] | sort_by(.id)' "$TMPDIR/report-jobs.json" | diff - "$TMPDIR/report-reinstalled.json"

# should deliver truthful timer-fired empty failure and timeout reports
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
for job in empty-report failed-report timeout-report; do
  native=$(jq -er --arg job "$job" '.jobs[] | select(.id == $job) | .nativeId' "$TMPDIR/report-jobs.json")
  for attempt in $(seq 1 90); do
    openclaw gateway call cron.runs --params "$(jq -nc --arg id "$native" '{id:$id,limit:1}')" --json > "$TMPDIR/$job-run.json"
    if jq -e '.entries | length > 0' "$TMPDIR/$job-run.json" >/dev/null; then break; fi
    sleep 2
  done
  jq -e --arg job "$job" 'any(.entries[]; (.runId | type == "string") and .status == (if $job == "empty-report" then "ok" else "error" end) and any(.summary | split("\n")[] | fromjson?; .id == $job and (.reporting.status == "pending" or .reporting.status == "delivered")))' "$TMPDIR/$job-run.json"
  for attempt in $(seq 1 60); do
    openclaw agent-system automations runs "$job" --json > "$TMPDIR/$job-report.json"
    if jq -e 'any(.reports[]; .status == "delivered" and (.messageId | type == "string"))' "$TMPDIR/$job-report.json" >/dev/null; then break; fi
    sleep 2
  done
  jq -e 'any(.reports[]; .status == "delivered" and .effective.model == "aimock/gpt-5.5")' "$TMPDIR/$job-report.json"
  report_execution=$(jq -er '.reports[] | select(.status == "delivered") | .executionId' "$TMPDIR/$job-report.json")
  grep -F 'embedded run start:' "$(openclaw-gateway log-path)" | grep -F "runId=$report_execution " | grep -F 'provider=aimock model=gpt-5.5 thinking=high '

done

# should retain markdown and diagnostics across fresh history connections with model-formatted cards
chat=$(jq -er '.jobs[] | select(.id == "prompt") | .routing | sub("^session:"; "")' "$TMPDIR/report-jobs.json")
for connection in 1 2; do
  openclaw gateway call chat.history --params "$(jq -nc --arg key "$chat" '{sessionKey:$key,limit:100,maxChars:100000}')" --json > "$TMPDIR/report-history-$connection.json"
  jq -e '([.messages[] | select(.role == "assistant") | .content[]? | select(.type == "text") | .text] | join("\n")) as $text | ($text | contains("✅ empty-report completed")) and ($text | contains("No output was supplied.")) and ($text | contains("❌ failed-report failed")) and ($text | contains("Exit 17")) and ($text | contains("report-diagnostic-marker")) and ($text | contains("report-markdown-marker")) and ($text | contains("❌ timeout-report failed")) and ($text | contains("Timed out"))' "$TMPDIR/report-history-$connection.json"
done
openclaw-aimock evidence --scenario openclaw-automations --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-automations/expected-evidence.json"
```

## Cleanup

```bash
# should stop the gateway and strict mock provider
shutdown_status=0
openclaw-gateway stop --timeout 340 || shutdown_status=$?
openclaw-aimock stop
test "$shutdown_status" -eq 0
```
