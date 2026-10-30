# OpenClaw prompt automation

Complete a scheduled prompt in its owning agent context, then preserve its job and chat on repeat sync.

## What belongs here

- Native scheduling, configured model/effort, and completion.
- Install and Doctor through an activated prompt without per-run approval.

## What does not belong here

- Other automation paths have separate examples: [command](../openclaw-automation-command/README.md), [command-to-chat](../openclaw-automation-command-chat/README.md), and [recovery](../openclaw-automation-recovery/README.md).

## Notes

- Reuses the strict AIMock tool exchange. Native scheduling and lifecycle effects remain real.
- Group, name, and label permutations remain in thread, projection, and service source tests.
- Poll deadlines include CLI startup and RPC time.

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
# should execute the next timer-fired prompt with the saved model and effort
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt"
node --input-type=module -e 'import fs from "node:fs"; import {parse,stringify} from "yaml"; const jobs=parse(fs.readFileSync("automations.yaml","utf8")); jobs.find(({id})=>id==="prompt").schedule="in 1 minute"; fs.writeFileSync("automations.yaml",stringify(jobs));'
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
native=$(jq -er '.jobs[] | select(.id == "prompt") | .nativeId' "$TMPDIR/automation-before.json")
due=$(openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json | jq -er '.state.nextRunAtMs | numbers')
deadline=$((SECONDS + 180))
while test "$SECONDS" -lt "$deadline"; do
  remaining=$((deadline - SECONDS))
  test "$remaining" -gt 0 || break
  timeout --signal=TERM --kill-after=5 "$remaining" openclaw gateway call cron.runs --params "$(jq -nc --arg id "$native" '{id:$id,limit:1,offset:0}')" --json > "$TMPDIR/automation-timer-run.json"
  if jq -e --arg id "$native" --argjson due "$due" 'any(.entries[]; .jobId == $id and .runAtMs >= $due)' "$TMPDIR/automation-timer-run.json" >/dev/null; then break; fi
  sleep 2
done
run_session=$(jq -er --arg id "$native" --argjson due "$due" '.entries[] | select(.jobId == $id and .runAtMs >= $due and .status == "ok" and .provider == "aimock" and .model == "gpt-5.5") | .sessionId | strings' "$TMPDIR/automation-timer-run.json")
grep -F 'embedded run start:' "$(openclaw-gateway log-path)" | grep -F "sessionId=$run_session " | grep -F 'provider=aimock model=gpt-5.5 thinking=medium '
grep -Fx installed maintenance.installed
openclaw-aimock evidence --scenario openclaw-automation-prompt --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt/expected-evidence.json"
```

```bash
# should preserve the job and chat across repeat synchronization
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-prompt"
openclaw agent-system automations sync --json | jq -e '.status == "synchronized" and all(.outcomes[]; .status == "unchanged")'
jq -S '[.jobs[] | {id,nativeId,routing}]' "$TMPDIR/automation-before.json" > "$TMPDIR/prompt-identities.json"
openclaw agent-system automations list --json | jq -S '[.jobs[] | {id,nativeId,routing}]' | diff - "$TMPDIR/prompt-identities.json"
```
