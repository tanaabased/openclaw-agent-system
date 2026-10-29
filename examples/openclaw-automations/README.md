# OpenClaw Automations Example

Install one command job and one prompt job, then execute each as its configured agent.
Verify that both finish and repeat installation preserves their IDs and routing.

## What Belongs Here

- Public managed sync/list/run boundaries and repeated sync preserving the same native jobs, including migration of legacy command output limits.
- Shared model/effort creation and same-chat updates, followed by a timer-fired occurrence with native execution evidence.
- Native display-name rename/removal while preserving the job, its completed run state, and separate chat binding.
- Completed same-agent Install/Doctor through a command descendant and native prompt tools, including default setup, without per-occurrence approval.
- Failed command tails, truncation evidence, and exit status reaching the exact native run record with delivery disabled.
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
- The failure fixture emits 32 MiB per stream to exercise native truncation on the pinned host, then emits late markers and exits 17. It adds no model turn or provider call.
- The output check reads `cron.runs`, the Gateway API supplying run cards. It verifies output propagation, not browser rendering or OpenClaw restart persistence.

## Setup

```bash
# should prepare the packed plugin and strict scheduled-prompt fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --yolo
openclaw-aimock prepare --scenario openclaw-automations

# should install the owning workspace before starting the gateway
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
openclaw agent-system install --skip-setup --yes --json

# should keep automation session choices local even when native sticky selection is global
openclaw config set agents.defaults.modelSelectionScope global
openclaw config get agents.defaults.model --json > "$TMPDIR/automation-global-model.json"

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

# should move the persistent chat between normalized categories without replacing its schedule
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
chat=$(jq -er '.jobs[] | select(.id == "prompt") | .routing | sub("^session:"; "")' "$TMPDIR/automation-before.json")
openclaw gateway call sessions.list --params '{"limit":100}' --json | jq -e --arg key "$chat" 'any(.sessions[]; .key == $key and .category == "AGENT SYSTEM")'
node --input-type=module -e 'import fs from "node:fs"; import {parse,stringify} from "yaml"; const jobs=parse(fs.readFileSync("automations.yaml","utf8")); jobs.find(({id})=>id==="prompt").group="  straße ops  "; fs.writeFileSync("automations.yaml",stringify(jobs));'
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
openclaw gateway call sessions.list --params '{"limit":100}' --json | jq -e --arg key "$chat" 'any(.sessions[]; .key == $key and .category == "STRASSE OPS")'
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "unchanged")'
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id, nativeId, routing}] | sort_by(.id)' | diff - "$TMPDIR/automation-identities.json"

# should save changed effort on the same chat and scheduled job
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
chat=$(jq -er '.jobs[] | select(.id == "prompt") | .routing | sub("^session:"; "")' "$TMPDIR/automation-before.json")
openclaw gateway call sessions.list --params '{"limit":100}' --json | jq -e --arg key "$chat" 'any(.sessions[]; .key == $key and .thinkingLevel == "medium")'
node --input-type=module -e 'import fs from "node:fs"; import {parse,stringify} from "yaml"; const jobs=parse(fs.readFileSync("automations.yaml","utf8")); jobs.find(({id})=>id==="prompt").effort="high"; fs.writeFileSync("automations.yaml",stringify(jobs));'
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
openclaw-aimock evidence --scenario openclaw-automations --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-automations/expected-evidence.json"
grep -Fx installed maintenance.installed
test "$(wc -l < identity.runs | tr -d ' ')" = 1

# should rename and clear the automation label without replacing its job or chat
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
native=$(jq -er '.jobs[] | select(.id == "prompt") | .nativeId' "$TMPDIR/automation-before.json")
openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json > "$TMPDIR/label-before.json"
jq -e '.displayName == "🔄 AUTOMATION STATUS" and .name == "Agent System: prompt"' "$TMPDIR/label-before.json"
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
# should retain late diagnostics and truncation evidence for a failed command with notifications disabled
cd "$GITHUB_WORKSPACE/examples/openclaw-automations"
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
jq -e --arg runId "$run_id" 'any(.entries[]; .runId == $runId and .status == "error" and (.summary | contains("stdout-fixture-marker")) and (.summary | contains("stderr-fixture-marker")) and any(.diagnostics.entries[]; .exitCode == 17 and .truncated == true) and any(.summary | split("\n")[] | fromjson?; .id == "failed-output" and .exitCode == 17 and .termination == "exit" and .timedOut == false and .cancelled == false and .truncated == true and .stdoutTruncatedBytes > 0 and .stderrTruncatedBytes > 0))' "$TMPDIR/failed-output-native-run.json"
printf '%s\n' "$run_id" > "$TMPDIR/failed-output-run-id"
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

## Cleanup

```bash
# should stop the gateway and strict mock provider
shutdown_status=0
openclaw-gateway stop --timeout 340 || shutdown_status=$?
openclaw-aimock stop
test "$shutdown_status" -eq 0
```
