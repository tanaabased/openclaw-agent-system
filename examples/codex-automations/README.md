# Codex Automations Example

Plan automation updates through the packaged Codex runtime and create a conversation
for each job with its selected execution settings. Verify that later processes reuse
those same conversations.

## What Belongs Here

- Digest-bound plans for native automation actions without private scheduler-file writes.
- Real app-server conversation creation, selected model/permission readback, and attributed setup history without model generation.
- Fresh-process resumption and shared profile changes preserving conversation identity, permissions, and durable model/effort settings.

## What Does Not Belong Here

- Plugin installation and workspace lifecycle: [Codex install](../codex-install/README.md). Notification activation and workflow authority: [Codex notifications](../codex-notifications/README.md).
- Pending-write cancellation/lost-response recovery and exhaustive unsupported occurrence/history diagnostics.
- Actual desktop scheduler mutation, scheduled execution, or native desktop-tool behavior; the headless checks do not establish those outcomes.

## Notes

- The named-zone declaration maps to a native timezone-qualified recurrence. Codex direct creation does not accept `DTSTART`, so only a new timezone-qualified schedule prepares a native review card and waits for verified saved settings. Timezone edits to existing schedules use direct updates. Native timing limitations are documented in [Codex automations](../../MANIFEST.md#codex-execution-and-ownership).
- Sidebar inventories and responses are explicit headless fixtures; native sidebar behavior requires desktop verification. Lookup inventories are explicit fixtures. `list` and `sync` inspect or plan native app actions; they do not write scheduler files. `threads-sync` creates/resumes real conversations through `codex app-server` under installation authorization and a fresh digest.
- Native readback checks `auto_review`, `on-request`, and `workspace-write`. No model generation or provider credentials are used; run only in GitHub Actions.
- Pending relocation: prepare/cancel retains a pending journal until verification and permits cancellation only while the failed target is unchanged. Pending creates also require no new native IDs; an unmarked job may be a partial create.
- Lost-response recovery may acknowledge the exact saved pending definition without another create; further writes need a fresh plan. Older journals retain whole-scheduler cancellation checks in source coverage.
- Pending relocation: explicit `automation-run-now-unsupported` and `automation-history-unavailable` checks remain below.
- Reviewed native request/response and saved-state captures in the repository's [fixtures directory](../../fixtures/) retain separate provenance; constructed failures are identified in source tests. They do not replace installed desktop verification.

## Setup

```bash
# should install and enable the exact prepared codex plugin in isolated state
root="$TMPDIR/agent-system-codex-automations"
mkdir -p "$root/package"
tar -xzf "$AGENT_SYSTEM_PACKAGE" -C "$root/package"
codex-tools install "$root/package/package" --json | jq -e '.ok == true and .inspection.installed == true and .inspection.enabled == true'
codex-tools cache check --repo-root "$root/package/package" --json | tee "$root/cache.json" | jq -e '.ok == true and .status == "current"'
```

## Testing

```bash
# should plan automation sync through the packed runtime without native scheduler writes
root="$TMPDIR/agent-system-codex-automations"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
workspace=$(cd "$GITHUB_WORKSPACE/examples/codex-automations/automation" && pwd -P)
node "$runtime" binding bind --plugin-data "$root/automation-data" --workspace "$workspace" --confirm
jq -n --arg workspace "$workspace" '{projects:{schemaVersion:2,projects:[{projectId:"fixture-project",projectKind:"local",hostId:"local",path:$workspace}]}}' > "$root/automation-input.json"
node "$runtime" automations plan --plugin-data "$root/automation-data" < "$root/automation-input.json" \
  | tee "$root/automation-plan.json" \
  | jq -e '.status == "requires-native-app-sync" and .actions[0].mode == "create" and (.actions[0].expected.rrule | startswith("DTSTART;TZID=America/New_York:")) and .actions[0].expected.projectId == "fixture-project" and .actions[0].expected.status == "PAUSED"'
node "$runtime" setup install --plugin-data "$root/automation-data" \
  | jq -e '.status == "requires-native-app-sync"'
test ! -d "$CODEX_HOME/automations"

# should expose list sync and explicit occurrence gaps through the installed runtime
root="$TMPDIR/agent-system-codex-automations"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
node "$runtime" automations --help | grep -F 'run-now'
node "$runtime" automations list --plugin-data "$root/automation-data" < "$root/automation-input.json" | jq -e '.jobs[0].id == "review" and .jobs[0].nativeId == null'
node "$runtime" automations sync --plugin-data "$root/automation-data" < "$root/automation-input.json" | jq -e '.status == "requires-native-app-sync"'
if printf '%s\n' '{"id":"review"}' | node "$runtime" automations run --plugin-data "$root/automation-data" > "$root/run-gap.json"; then exit 1; fi
jq -e '.code == "automation-run-now-unsupported" and .manualTask.schedulerOccurrence == false and .manualTask.history == "separate-task"' "$root/run-gap.json"
if printf '%s\n' '{"id":"review"}' | node "$runtime" automations runs --plugin-data "$root/automation-data" > "$root/history-gap.json"; then exit 1; fi
jq -e '.code == "automation-history-unavailable" and .telemetry.execution == "unavailable"' "$root/history-gap.json"
test ! -d "$CODEX_HOME/automations"

# should prepare timezone creation for review without writing a native schedule
root="$TMPDIR/agent-system-codex-automations"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
digest=$(jq -r .digest "$root/automation-plan.json")
jq --arg digest "$digest" '. + {digest:$digest}' "$root/automation-input.json" > "$root/prepare-input.json"
node "$runtime" automations prepare --plugin-data "$root/automation-data" < "$root/prepare-input.json" \
  | jq -e '.status == "prepared" and .request.mode == "suggested_create" and (.request.rrule | startswith("DTSTART;TZID=America/New_York:")) and .request.status == "PAUSED"'
if node "$runtime" automations acknowledge --plugin-data "$root/automation-data" < "$root/prepare-input.json" 2> "$root/review-pending.json"; then exit 1; fi
jq -e '.code == "automation-review-pending"' "$root/review-pending.json"
test ! -d "$CODEX_HOME/automations"

# should create durable conversations with selected models and verified auto review
root="$TMPDIR/agent-system-codex-automations"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
node "$runtime" binding bind --plugin-data "$root/threads-data" --workspace "$GITHUB_WORKSPACE/examples/codex-automations/threads" --confirm
node "$GITHUB_WORKSPACE/scripts/codex-sidebar-fixture.mjs" "$runtime" "$root/threads-data" "$root/sidebar-input.json" | tee "$root/threads-created.json" | jq -e '.status == "verified" and ([.threads[].id] | unique | length) == 2'
node "$runtime" automations plan --plugin-data "$root/threads-data" < "$root/sidebar-input.json" | tee "$root/threads-plan.json" | jq -e '.status == "requires-native-app-sync" and ([.actions[].expected.targetThreadId] | unique | length) == 2 and all(.actions[]; .expected.kind == "heartbeat")'

# should retain conversation identities and model settings after the creating process exits
root="$TMPDIR/agent-system-codex-automations"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
node "$GITHUB_WORKSPACE/scripts/codex-sidebar-fixture.mjs" "$runtime" "$root/threads-data" "$root/sidebar-input.json" > "$root/threads-reused.json"
jq -S '.threads | map_values(.id)' "$root/threads-created.json" > "$root/threads-ids.json"
jq -S '.threads | map_values(.id)' "$root/threads-reused.json" | diff - "$root/threads-ids.json"
jq -e 'any(.nativeInventory.sections[]; .name == "agent system" and .itemKeys == []) and any(.nativeInventory.sections[]; .name == "AGENT SYSTEM" and (.itemKeys | length) == 2)' "$root/sidebar-input.json"
test ! -d "$CODEX_HOME/automations"

# should update shared profile effort without replacing either conversation
root="$TMPDIR/agent-system-codex-automations"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
node --input-type=module -e 'import fs from "node:fs"; import {parse,stringify} from "yaml"; const path=process.env.GITHUB_WORKSPACE+"/examples/codex-automations/threads/agent.yaml"; const manifest=parse(fs.readFileSync(path,"utf8")); manifest.models.default.effort="high"; fs.writeFileSync(path,stringify(manifest));'
node "$runtime" automations inspect --plugin-data "$root/threads-data" < "$root/sidebar-input.json" | jq -e 'any(.findings[]; .id == "check-builds" and .code == "automation-thread-model-drift" and .settings.requested.effort == "high" and .settings.observed.effort == "medium" and .settings.requested.model == .settings.observed.model)'
node "$GITHUB_WORKSPACE/scripts/codex-sidebar-fixture.mjs" "$runtime" "$root/threads-data" "$root/sidebar-input.json" > "$root/threads-updated.json"
jq -S '.threads | map_values(.id)' "$root/threads-updated.json" | diff - "$root/threads-ids.json"
jq -e 'all(.threads[]; .settings.requested.model == "gpt-6-luna" and .settings.observed.model == "gpt-6-luna" and .settings.requested.effort == "high" and .settings.observed.effort == "high")' "$root/threads-updated.json"
node "$GITHUB_WORKSPACE/scripts/codex-sidebar-fixture.mjs" "$runtime" "$root/threads-data" "$root/sidebar-input.json" > "$root/threads-cold.json"
jq -S '.threads' "$root/threads-updated.json" > "$root/threads-settings.json"
jq -S '.threads' "$root/threads-cold.json" | diff - "$root/threads-settings.json"
test ! -d "$CODEX_HOME/automations"
```
