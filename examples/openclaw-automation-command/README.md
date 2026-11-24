# OpenClaw command automation

Run a deterministic script and inspect its actual process outcome without a model or reporting chat.

## What belongs here

- Managed identity and same-agent lifecycle descendants.
- Long stdout/stderr and actual failing exit status.
- Capture-limit migration and installed command recovery preserving native history.

## What does not belong here

- Other automation paths have separate examples: [prompt](../openclaw-automation-prompt/README.md), [command-to-chat](../openclaw-automation-command-chat/README.md), and [recovery](../openclaw-automation-recovery/README.md).

## Notes

- The success probe retains Install/Doctor descendant coverage without model calls.
- The failure fixture exceeds the former output caps with 64 KiB per stream and late markers.
- Empty output, timeout, cancellation, and declaration variants remain in source tests.
- The recovery case removes only the new command data from this isolated fixture’s ledger to model a pre-upgrade installation. It does not edit the native job.

## Testing

```bash
# should install the command workspace without applying maintenance
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
openclaw config set plugins.entries.agent-system.config.storage.backend sqlite
openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-command"
openclaw agent-system install --skip-setup --yes --json
```

```bash
# should complete one command under the owning managed git identity
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-command"
run_id=$(openclaw agent-system automations run identity --json | jq -er 'select(.status == "queued" and .execution == "unavailable") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" identity "$run_id"
grep -F 'Tanaabot <tanaabot@tanaab.dev>' identity.git
grep -Fx installed maintenance.installed
test "$(wc -l < identity.runs | tr -d ' ')" = 1
openclaw agent-system automations runs identity --json | jq -e '.reports == []'

```

```bash
# should retain long output and the actual exit of a failed command with notifications disabled
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-command"
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
# should report restored command data without changing the native job
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-command"
native=$(jq -er '.jobs[] | select(.id == "failed-output") | .nativeId' "$TMPDIR/automation-output-job.json")
openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json > "$TMPDIR/command-data-before.json"
node --input-type=module - "$TMPDIR/command-data-before.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const scope = /^agent-system:([a-f0-9]{64}):failed-output$/u.exec(job.declarationKey)?.[1];
assert.ok(scope);
const state = process.env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw');
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(state, 'agent-system-storage', 'command-tanaabot.sqlite'), { timeout: 5000 });
const update = db.prepare("UPDATE automation_registrations SET value = json_remove(value, '$.installedCommand') WHERE scope = ? AND json_extract(value, '$.nativeId') = ? AND json_type(value, '$.installedCommand') IS NOT NULL");
assert.equal(update.run(scope, job.id).changes, 1);
db.close();
NODE
openclaw agent-system doctor --json | jq -e 'any(.findings[]; .stepId == "failed-output" and .code == "automation-installed-command-missing" and .status == "warning")'
openclaw agent-system install --skip-setup --yes --json | jq -e 'any(.outcomes[]; .stepId == "failed-output" and .status == "updated")'
openclaw agent-system doctor --json | jq -e 'all(.findings[]; .code != "automation-installed-command-missing")'
openclaw gateway call cron.get --params "$(jq -nc --arg id "$native" '{id:$id}')" --json | jq -e --slurpfile before "$TMPDIR/command-data-before.json" '.id == $before[0].id and .configRevision == $before[0].configRevision'
```

```bash
# should migrate an existing command limit without replacing its schedule or failed run history
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-command"
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
