# OpenClaw prompt automation

Complete a scheduled prompt in its owning agent context, then preserve its job and chat on repeat sync.

## What belongs here

- Native scheduling, configured model/effort, and completion.
- Compact requests with the file-backed instructions injected at user priority.
- The job's medium effort overriding the agent's high default at execution.
- Install and Doctor through an activated prompt without per-run approval.
- Refuse a scheduled request before inference when its automation declaration is removed.

## What does not belong here

- Other automation paths have separate examples: [command](../openclaw-automation-command/README.md), [command-to-chat](../openclaw-automation-command-chat/README.md), and [recovery](../openclaw-automation-recovery/README.md).

## Notes

- Reuses the strict AIMock tool exchange. Native scheduling and lifecycle effects remain real.
- Group, name, and label permutations remain in thread, projection, and service source tests.
- Poll deadlines include CLI startup and RPC time.
- Provider assertions prove instruction transport, not live/reloaded UI rendering on either harness.

## Testing

```bash
# should prepare the packed plugin and strict scheduled-prompt fixture
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --yolo
openclaw-aimock prepare --scenario openclaw-automation-prompt
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt"
openclaw agent-system install --skip-setup --yes --json
openclaw agent-system automations list --json > "$TMPDIR/automation-before.json"
```

```bash
# should synchronize the declared one-shot schedule
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt"
node --input-type=module -e 'import fs from "node:fs"; import {parse,stringify} from "yaml"; const jobs=parse(fs.readFileSync("automations.yaml","utf8")); jobs.find(({id})=>id==="prompt").schedule="in 1 minute"; fs.writeFileSync("automations.yaml",stringify(jobs));'
status=0
openclaw agent-system doctor --json > "$TMPDIR/prompt-doctor-drift.json" || status=$?
test "$status" -eq 1
jq -e 'any(.findings[]; .stepId == "prompt" and .code == "automation-drift" and .status == "drift")' "$TMPDIR/prompt-doctor-drift.json"
node -p 'Date.now()' > "$TMPDIR/prompt-sync-started-ms"
if ! openclaw agent-system automations sync --json | jq -e 'if .status == "synchronized" then true else error("initial prompt sync: " + ({status, outcomes: [.outcomes[]? | {id, stepId, status}]} | tojson)) end'; then
  printf '%s\n' 'Initial prompt sync failed before timer verification.' >&2
  exit 1
fi
status=0
openclaw agent-system doctor --json > "$TMPDIR/prompt-doctor-after-sync.json" || status=$?
if test "$status" -ne 0; then
  test "$status" -eq 1
  jq -ce 'select(.status == "drift" or .status == "blocked") | {status, findings: [.findings[] | select(.status == "drift" or .status == "blocked") | {component, stepId, code, status}]}' "$TMPDIR/prompt-doctor-after-sync.json" >&2
fi
jq -e '[.findings[] | select(.stepId == "prompt" and .code == "automation-drift") | {code, status}] | if length == 0 then true else error("prompt drift after sync: " + tojson) end' "$TMPDIR/prompt-doctor-after-sync.json"
```

```bash
# should observe the timer-fired prompt on the original job with the saved model and effort
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt"
native=$(jq -er '.jobs[] | select(.id == "prompt") | .nativeId' "$TMPDIR/automation-before.json")
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" --scheduled-after prompt "$native" "$(cat "$TMPDIR/prompt-sync-started-ms")" 180000 > "$TMPDIR/automation-timer-run.json"
if ! openclaw-fixture-gateway cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json > "$TMPDIR/prompt-timer-job.json"; then
  echo 'could not read the original native prompt job after timer completion' >&2
  jq -c '{type:.error.type,kind:.error.kind,code:.error.code}' "$TMPDIR/prompt-timer-job.json" >&2
  exit 1
fi
jq -e '(.payload.message // "") as $message | {hasMarker: ($message | contains("\n\n> Run scheduled automation: 🔄 AUTOMATION STATUS.")), hasLegacyMarker: ($message | contains("Acknowledge the scheduled owning-agent context."))} | if .hasMarker and (.hasLegacyMarker | not) then true else error("native prompt payload: " + tojson) end' "$TMPDIR/prompt-timer-job.json"
due=$(jq -er --arg id "$native" 'if .id == $id and .schedule.kind == "at" then .schedule.at else error("expected the saved one-shot schedule on the original prompt job") end' "$TMPDIR/prompt-timer-job.json")
due_ms=$(node -e 'const ms = Date.parse(process.argv[1]); if (!Number.isFinite(ms)) throw new Error("invalid one-shot time"); console.log(ms)' "$due")
jq -e --argjson due "$due_ms" 'if .runAtMs >= $due and .provider == "aimock" and .model == "gpt-5.5" and (.sessionId | type == "string") then true else error("unexpected prompt run: " + ({runAtMs,expectedAtMs:$due,status,provider,model,hasSession:(.sessionId | type == "string")} | tojson)) end' "$TMPDIR/automation-timer-run.json"
curl --fail --silent --show-error http://127.0.0.1:4010/proof/reasoning | jq -e 'length > 0 and all(.[]; (.model == "gpt-5.5" or .model == "aimock/gpt-5.5") and .effort == "medium")'
grep -Fx installed maintenance.installed
curl --fail --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e '
  .scenario == "openclaw-automation-prompt" and .strictMissCount == 0 and .finalResponseCount == 1 and
  .requestCount == .successfulFixtureResponseCount and .requestCount == .promptRequestCount and
  ([.tools[] | select(.callResponseCount == 1 and .resultRequestCount > 0) | .name] | sort) == ["agent_system_doctor", "agent_system_install"]
'
```

```bash
# should preserve the job and chat across repeat synchronization
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt"
native=$(jq -er '.jobs[] | select(.id == "prompt") | .nativeId' "$TMPDIR/automation-before.json")
params=$(jq -nc --arg id "$native" '{id:$id}')
if ! openclaw agent-system automations sync --json | jq -e 'if .status == "synchronized" and all(.outcomes[]; .status == "unchanged") then true else error("repeat prompt sync: " + ({status, outcomes: [.outcomes[]? | {id, stepId, status}]} | tojson)) end'; then
  if openclaw-fixture-gateway cron.get --params "$params" --json > "$TMPDIR/prompt-after-repeat.json"; then
    jq -cs '.[0] as $before | .[1] as $after | ["enabled","schedule","deleteAfterRun","payload","delivery","sessionTarget","sessionKey","wakeMode","failureAlert","trigger","pacing","displayName"] | map(select(. as $key | $before[$key] != $after[$key])) | {changedNativeFields: .}' "$TMPDIR/prompt-timer-job.json" "$TMPDIR/prompt-after-repeat.json" >&2
  fi
  exit 1
fi
jq -S '[.jobs[] | {id,nativeId,routing}]' "$TMPDIR/automation-before.json" > "$TMPDIR/prompt-identities.json"
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id,nativeId,routing}]' | diff - "$TMPDIR/prompt-identities.json"
```

```bash
# should stop a native scheduled request when its automation declaration is removed
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt"
native=$(jq -er '.jobs[] | select(.id == "prompt") | .nativeId' "$TMPDIR/automation-before.json")
before=$(curl --fail --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -er '.requestCount | numbers')
printf '[]\n' > automations.yaml
openclaw-fixture-gateway cron.run --params "$(jq -nc --arg id "$native" '{id:$id,mode:"force"}')" --json | tee "$TMPDIR/automation-refusal-ack.json"
run_id=$(jq -er 'select(.ok == true and .enqueued == true) | .runId | strings | select(length > 0)' "$TMPDIR/automation-refusal-ack.json")
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" prompt "$run_id" error
openclaw-fixture-gateway cron.runs --params "$(jq -nc --arg id "$native" --arg run "$run_id" '{id:$id,runId:$run,limit:1,offset:0}')" --json > "$TMPDIR/automation-refusal-run.json"
jq -e --arg id "$native" --arg run "$run_id" 'if any(.entries[]; .jobId == $id and .runId == $run and .status == "error" and ((.error // "") | contains("automation-prompt-load-blocked"))) then true else error("unexpected refusal outcome: " + (.entries | map({jobId,runId,status,error}) | tojson)) end' "$TMPDIR/automation-refusal-run.json"
curl --fail --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e --argjson before "$before" '.strictMissCount == 0 and .requestCount == $before'
```
