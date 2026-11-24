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
openclaw config set plugins.entries.agent-system.config.storage.backend sqlite
openclaw-aimock prepare --scenario openclaw-automation-prompt
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt"
openclaw agent-system install --skip-setup --yes --json
openclaw agent-system automations list --json > "$TMPDIR/automation-before.json"
```

```bash
# should execute the next timer-fired prompt with the saved model and effort
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt"
node --input-type=module -e 'import fs from "node:fs"; import {parse,stringify} from "yaml"; const jobs=parse(fs.readFileSync("automations.yaml","utf8")); jobs.find(({id})=>id==="prompt").schedule="in 1 minute"; fs.writeFileSync("automations.yaml",stringify(jobs));'
status=0
openclaw agent-system doctor --json > "$TMPDIR/prompt-doctor-drift.json" || status=$?
test "$status" -eq 1
jq -e 'any(.findings[]; .stepId == "prompt" and .code == "automation-drift" and .status == "drift")' "$TMPDIR/prompt-doctor-drift.json"
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
native=$(jq -er '.jobs[] | select(.id == "prompt") | .nativeId' "$TMPDIR/automation-before.json")
openclaw agent-system automations list --json | jq -e --arg native "$native" '([.jobs[] | select(.id == "prompt") | .nativeId]) as $ids | if $ids == [$native] then true else error("prompt native ID changed: " + ({expected: $native, observed: $ids} | tojson)) end'
openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json | jq -e '(.payload.message // "") as $message | {hasMarker: ($message | contains("\n\n> Run scheduled automation: 🔄 AUTOMATION STATUS.")), hasLegacyMarker: ($message | contains("Acknowledge the scheduled owning-agent context."))} | if .hasMarker and (.hasLegacyMarker | not) then true else error("native prompt payload: " + tojson) end'
due=$(openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json | jq -er '.state.nextRunAtMs | numbers')
deadline=$((SECONDS + 180))
while test "$SECONDS" -lt "$deadline"; do
  remaining=$((deadline - SECONDS))
  test "$remaining" -gt 0 || break
  timeout --signal=TERM --kill-after=5 "$remaining" openclaw gateway call cron.runs --params "$(jq -nc --arg id "$native" '{id:$id,limit:1,offset:0}')" --json > "$TMPDIR/automation-timer-run.json"
  if jq -e --arg id "$native" --argjson due "$due" 'any(.entries[]; .jobId == $id and .runAtMs >= $due)' "$TMPDIR/automation-timer-run.json" >/dev/null; then break; fi
  sleep 2
done
jq -er --arg id "$native" --argjson due "$due" '.entries[] | select(.jobId == $id and .runAtMs >= $due and .status == "ok" and .provider == "aimock" and .model == "gpt-5.5") | .sessionId | strings' "$TMPDIR/automation-timer-run.json" >/dev/null || {
  jq -c '[.entries[] | {jobId, runAtMs, status, provider, model, hasSession: (.sessionId | type == "string")}]' "$TMPDIR/automation-timer-run.json" >&2
  exit 1
}
curl --fail --silent --show-error http://127.0.0.1:4010/proof/reasoning | jq -e 'length > 0 and all(.[]; (.model == "gpt-5.5" or .model == "aimock/gpt-5.5") and .effort == "medium")'
grep -Fx installed maintenance.installed
openclaw-aimock evidence --scenario openclaw-automation-prompt --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt/expected-evidence.json"
```

```bash
# should preserve the job and chat across repeat synchronization
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt"
native=$(jq -er '.jobs[] | select(.id == "prompt") | .nativeId' "$TMPDIR/automation-before.json")
params=$(jq -nc --arg id "$native" '{id:$id}')
openclaw gateway call cron.get --params "$params" --json > "$TMPDIR/prompt-before-repeat.json"
if ! openclaw agent-system automations sync --json | jq -e 'if .status == "synchronized" and all(.outcomes[]; .status == "unchanged") then true else error("repeat prompt sync: " + ({status, outcomes: [.outcomes[]? | {id, stepId, status}]} | tojson)) end'; then
  if openclaw gateway call cron.get --params "$params" --json > "$TMPDIR/prompt-after-repeat.json"; then
    jq -cs '.[0] as $before | .[1] as $after | ["enabled","schedule","deleteAfterRun","payload","delivery","sessionTarget","sessionKey","wakeMode","failureAlert","trigger","pacing","displayName"] | map(select(. as $key | $before[$key] != $after[$key])) | {changedNativeFields: .}' "$TMPDIR/prompt-before-repeat.json" "$TMPDIR/prompt-after-repeat.json" >&2
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
printf '[]\n' > automations.yaml
openclaw gateway call cron.run --params "$(jq -nc --arg id "$native" '{id:$id,mode:"force"}')" --json | tee "$TMPDIR/automation-refusal-ack.json"
run_id=$(jq -er 'select(.ok == true and .enqueued == true) | .runId | strings | select(length > 0)' "$TMPDIR/automation-refusal-ack.json")
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" prompt "$run_id" error
openclaw gateway call cron.runs --params "$(jq -nc --arg id "$native" --arg run "$run_id" '{id:$id,runId:$run,limit:1,offset:0}')" --json > "$TMPDIR/automation-refusal-run.json"
jq -e --arg id "$native" --arg run "$run_id" 'if any(.entries[]; .jobId == $id and .runId == $run and .status == "error" and ((.error // "") | contains("automation-prompt-load-blocked"))) then true else error("unexpected refusal outcome: " + (.entries | map({jobId,runId,status,error}) | tojson)) end' "$TMPDIR/automation-refusal-run.json"
openclaw-aimock evidence --scenario openclaw-automation-prompt --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt/expected-evidence.json"
```
