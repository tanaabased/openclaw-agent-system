# Codex Notifications Example

Verify packaged notification activation boundaries, intake responses, and work preparation in isolated Codex state. Installation and workspace lifecycle checks live in the [Codex install example](../codex-install/README.md); generic automation planning and conversation persistence live in the [Codex automations example](../codex-automations/README.md). Runtime tests run this scenario on Ubuntu without a live model or hosted secrets.

These headless checks establish activation and authority boundaries. Successful assignment admission and plan creation need a separate installed end-to-end example; these checks do not establish that flow or desktop rendering.

For native intake verification, reconcile the installed schedule before its next occurrence. Confirm that a host-access retry retains the exact command through subsequent busy responses, routing identifiers reach preparation unchanged, and native chat creation happens separately and only once. An actual native approval denial must stop the operation and appear in the intake report; a closed historical fixture must not define the scope of unrelated assignments under the active recurring authorization. The generated transport has controlled unit coverage, but desktop approval behavior still requires this live evidence.

For coordinator replacement verification, retain an active issue, reconcile the automation to a new intake chat, and continue that same issue. Verify its original creation source remains intact, new sends record the replacement coordinator, and both old and new send receipts reconcile without duplicate messages. Rename the issue chat and change its live assessment or implementation guidance before a subsequent context request; neither requires another issue admission or Install. Controlled tests cover these transitions; the desktop run remains the native transport proof.

Native same-turn verification also requires the desktop: run one Work issue and one
Auto issue whose recorded decision selects Work. Confirm implementation context
binds to the assessment turn and implementation starts without a coordinator send.
End a turn before implementation completes and confirm the next intake resumes the
same issue with its saved assessment and checkout. A clarification result must wait
for an answer rather than being retried on each scan.
After delivery, confirm the PR, announcement, attachment, and card-generation receipts
make status complete and the next scan idle without a separate completion transition.
Interrupt before the announcement or card and confirm recovery finishes those steps
without repeating implementation or creating another PR.

Native retirement verification also requires the desktop: let normal intake create an assessment with its helper and Guardian review chats, close the idle issue, and observe automatic archival and worktree reclamation after the configured grace period. Completed native descendants should not count as independent worktree owners; running, unrelated, pinned, and automation-owned chats must still protect the checkout. Retain the assessment and routing receipt, and do not manually remove resources to manufacture success.

## Setup

```bash
# should install and enable the exact prepared codex plugin in isolated state
root="$TMPDIR/agent-system-codex-notifications"
mkdir -p "$root/package"
tar -xzf "$AGENT_SYSTEM_PACKAGE" -C "$root/package"
codex-tools install "$root/package/package" --json | jq -e '.ok == true and .inspection.installed == true and .inspection.enabled == true'
codex-tools cache check --repo-root "$root/package/package" --json | tee "$root/cache.json" | jq -e '.ok == true and .status == "current"'
```

## Testing

```bash
# should reject an unattended reset without an explicit target before accessing private state
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
status=0
node "$runtime" notifications reset --plugin-data "$root/uncreated-reset-data" > "$root/reset-result.json" <<'JSON' || status=$?
{"yes":true}
JSON
test "$status" -ne 0
jq -e '.code == "notification-reset-explicit-bound-agent-required"' "$root/reset-result.json"
test ! -e "$root/uncreated-reset-data"

# should explain a host permission failure in one heartbeat without accessing tracking state
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
printf '%s\n' '{"automationId":"fixture-native-intake","code":"codex-host-access-required"}' \
  | node "$runtime" intake failure-response --plugin-data "$root/uncreated-failure-data" \
  | jq -e '.status == "failure" and (.response | startswith("<heartbeat>")) and (.response | endswith("</heartbeat>")) and (.response | contains("<decision>NOTIFY</decision>")) and (.response | contains("> ## ⚠️ Codex needs access to its tracking files\n>\n>")) and (.response | contains("> - **Technical detail:**")) and (.response | contains("native host approval")) and (.response | contains("codex-host-access-required"))'
test ! -e "$root/uncreated-failure-data"

# should distinguish a required automation update from first-time setup in the packaged failure response
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
printf '%s\n' '{"automationId":"fixture-native-intake","code":"intake-automation-update-required"}' \
  | node "$runtime" intake failure-response --plugin-data "$root/uncreated-update-data" \
  | jq -e '.status == "failure" and (.response | contains("<decision>NOTIFY</decision>")) and (.response | contains("✨")) and (.response | contains("New intake is paused")) and (.response | contains("intake-automation-update-required"))'
printf '%s\n' '{"automationId":"fixture-native-intake","code":"intake-activation-required"}' \
  | node "$runtime" intake failure-response --plugin-data "$root/uncreated-update-data" \
  | jq -e '.status == "failure" and (.response | contains("⚠️")) and (.response | contains("intake-activation-required")) and (.response | contains("✨") | not)'
test ! -e "$root/uncreated-update-data"

# should format a packaged quiet heartbeat without activating intake or changing its state
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
printf '%s\n' '{"automationId":"fixture-native-intake","currentTimeIso":"2026-10-09T12:00:00.000Z","intake":{"status":"ready","changed":false},"dispatch":[{"status":"at-capacity","changed":false}]}' \
  | TZ=UTC node "$runtime" intake quiet-response --plugin-data "$root/quiet-data" \
  | jq -e '.status == "quiet" and .period == "afternoon" and (.message | length > 0) and .response == ("<heartbeat>\n  <automation_id>fixture-native-intake</automation_id>\n  <decision>DONT_NOTIFY</decision>\n  <message>" + .message + "</message>\n</heartbeat>")'
test ! -e "$root/quiet-data"

# should preserve an actionable earlier result instead of replacing it with quiet text
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
printf '%s\n' '{"automationId":"fixture-native-intake","currentTimeIso":"2026-10-09T12:00:00.000Z","intake":{"status":"ready","changed":false},"dispatch":[{"status":"completed","changed":true},{"status":"idle","changed":false}]}' \
  | node "$runtime" intake quiet-response --plugin-data "$root/quiet-data" \
  | jq -e '.status == "not-quiet" and (has("response") | not)'

# should expose packaged intake and plan one owned schedule without activating it
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/notification-data"
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$GITHUB_WORKSPACE/examples/codex-notifications/active" --confirm \
  | jq -e '.status == "bound" and .preview.manifest.status == "valid"'
node "$runtime" intake inspect --plugin-data "$plugin_data" \
  | jq -e '.status == "blocked" and .code == "intake-activation-required" and .records == []'
if output=$(node "$runtime" intake scan --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "intake-activation-required"'
printf '%s\n' '{}' | node "$runtime" automations plan --plugin-data "$plugin_data" \
  | jq -e 'any(.findings[]; .code == "automation-thread-sync-required") and (.conversations | length) == 1'
node "$runtime" setup inspect --plugin-data "$plugin_data" \
  | jq -e 'any(.findings[]; .code == "github-notification-runtime-unsupported" and .status == "warning") and all(.findings[]; .code != "github-notification-runtime-unsupported" or .status != "blocked")'
test ! -e "$GITHUB_WORKSPACE/examples/codex-notifications/active/.setup-applied"
test ! -d "$CODEX_HOME/automations"

# should reject removed global feedback before binding or activation
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
node "$runtime" binding preview --workspace "$GITHUB_WORKSPACE/examples/codex-notifications/removed-feedback" \
  | jq -e '.manifest.status == "invalid" and any(.manifest.diagnostics[]; .code == "github-notification-global-feedback-removed")'
test ! -d "$CODEX_HOME/automations"

# should expose packaged dispatch without letting intake-only state launch work
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/notification-data"
printf '%s\n' '{"action":"inspect"}' | node "$runtime" dispatch --plugin-data "$plugin_data" \
  | jq -e '.version == 1 and .records == []'
if output=$(printf '%s\n' '{"action":"next","projects":[],"threads":{"schemaVersion":4,"pinnedThreads":[],"unavailableHosts":[],"unavailableSources":[]}}' | CODEX_THREAD_ID=fixture-intake node "$runtime" dispatch --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-activation-required" and .notice.severity == "warning" and .notice.notify == true and (.notice.message | contains("Next step"))'
if output=$(printf '%s\n' '{"action":"handoff","id":"missing"}' | CODEX_THREAD_ID=fixture-operator node "$runtime" dispatch --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-handoff-unavailable" and .notice.severity == "error"'
test ! -d "$CODEX_HOME/automations"
test ! -d "$GITHUB_WORKSPACE/examples/codex-notifications/active/checkouts"
test ! -d "$GITHUB_WORKSPACE/examples/codex-notifications/active/.agent-system/repositories"

# should keep historical capacity reconciliation behind the owning intake activation
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
if output=$(printf '%s\n' '{"action":"reconcile","id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' | CODEX_THREAD_ID=fixture-intake node "$runtime" dispatch --plugin-data "$root/notification-data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-activation-required" and .operation == "dispatch:reconcile"'
test ! -d "$CODEX_HOME/automations"

# should require a reconciled intake before operator retirement can queue cleanup
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
if output=$(printf '%s\n' '{"action":"retire","id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' | CODEX_THREAD_ID=fixture-operator node "$runtime" dispatch --plugin-data "$root/notification-data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-activation-required" and .operation == "dispatch:retire"'
test ! -d "$CODEX_HOME/automations"

# should keep explicit denial recovery behind reconciled intake activation
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
if output=$(printf '%s\n' '{"action":"retry-denied","id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","approvedCallId":"fixture-denied-call"}' | CODEX_THREAD_ID=fixture-operator node "$runtime" dispatch --plugin-data "$root/notification-data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-activation-required" and .operation == "dispatch:retry-denied"'
test ! -d "$CODEX_HOME/automations"

# should return an actionable diagnostic for an unsupported stdin flag
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
if output=$(node "$runtime" dispatch --plugin-data "$root/notification-data" --input - 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and (.message | contains("--plugin-data")) and (.message | contains("stdin")) and (.message | contains("--input"))'

# should reject packaged continuation without newly reconciled work authority
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
if output=$(printf '%s\n' '{"action":"next"}' | CODEX_THREAD_ID=fixture-intake node "$runtime" continuation --plugin-data "$root/notification-data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-activation-required"'
test ! -d "$CODEX_HOME/automations"

# should reject packaged feedback without a freshly reconciled intake schedule
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
if output=$(printf '%s\n' '{"action":"next"}' | CODEX_THREAD_ID=fixture-intake node "$runtime" feedback --plugin-data "$root/notification-data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-activation-required"'
test ! -d "$CODEX_HOME/automations"

# should expose packaged delivery while rejecting requests without a valid managed receipt
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
node "$runtime" delivery --help | grep -F 'present renders the card and notices even when attachment is pending'
if output=$(printf '%s\n' '{"action":"publish","id":"missing"}' | node "$runtime" delivery --plugin-data "$root/notification-data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "delivery-request-invalid" and .notices[0].severity == "error"'
if output=$(printf '%s\n' '{"action":"announce","id":"missing"}' | node "$runtime" delivery --plugin-data "$root/notification-data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "delivery-request-invalid"'


# should accept separate feedback and stage selections while leaving disabled workflows inactive
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/disabled-notification-data"
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$GITHUB_WORKSPACE/examples/codex-notifications/disabled" --confirm \
  | jq -e '.status == "bound" and .preview.manifest.status == "valid"'
printf '%s\n' '{}' | node "$runtime" automations plan --plugin-data "$plugin_data" \
  | jq -e '.status == "aligned" and .actions == [] and (.conversations // []) == []'
if output=$(node "$runtime" intake scan --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "intake-policy-disabled"'
test ! -d "$CODEX_HOME/automations"

# should plan intake conversation setup without a global scanner rule or reload acknowledgment
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
printf '{}\n' | node "$runtime" automations plan --plugin-data "$root/notification-data" | jq -e '.status == "requires-native-app-sync" and any(.findings[]; .code == "automation-thread-sync-required")'
test ! -d "$CODEX_HOME/rules"

# should bind work preparation to the installed runtime in the native schedule request
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/notification-data"
sed 's/mode: auto/mode: work/' "$GITHUB_WORKSPACE/examples/codex-notifications/active/agent.yaml" > "$root/work-agent.yaml"
mv "$root/work-agent.yaml" "$GITHUB_WORKSPACE/examples/codex-notifications/active/agent.yaml"
printf '{}\n' | node "$runtime" automations plan --plugin-data "$plugin_data" > "$root/work-plan.json"
jq '{digest:.digest}' "$root/work-plan.json" | node "$runtime" automations threads-sync --plugin-data "$plugin_data" | jq -e '.status == "verified"'
printf '{}\n' | node "$runtime" automations plan --plugin-data "$plugin_data" > "$root/work-schedule.json"
node --input-type=module - "$root/work-schedule.json" "$runtime" "$plugin_data" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const [planPath, runtimePath, pluginData] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const block = plan.actions[0].expected.prompt.split('\n\n').find(part => part.startsWith('const runtime = '));
assert.ok(block, 'installed schedule must contain its execution block');
const calls = [];
await runInNewContext('(async () => {' + block + '})()', {
  runtimeRoute: 'continuation', runtimeInput: { action: 'next' },
  load: () => undefined, store: () => {}, text: () => {},
  tools: { exec_command: async request => {
    calls.push(request);
    return { exit_code: 0, output: JSON.stringify({ status: 'idle' }) };
  } },
});
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const argv = [process.execPath, runtimePath, 'continuation', 'next', '--plugin-data', pluginData];
assert.equal(calls.length, 1);
assert.equal(calls[0].cmd, argv.map(quote).join(' ') + " <<'AGENT_SYSTEM_INPUT'\n" + JSON.stringify({ action: 'next' }) + '\nAGENT_SYSTEM_INPUT');
NODE
test ! -d "$CODEX_HOME/automations"
test ! -d "$CODEX_HOME/rules"

# should update planned cadence without replacing the activated workflow authority
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/notification-data"
printf '{}\n' | node "$runtime" automations plan --plugin-data "$plugin_data" > "$root/before-timing.json"
sed 's/    schema-version: 2/    schema-version: 2\n    interval-minutes: 17\n    max-concurrent-items: 8\n    cleanup: {enabled: true, grace-minutes: 30}/' "$GITHUB_WORKSPACE/examples/codex-notifications/active/agent.yaml" > "$root/timing-agent.yaml"
mv "$root/timing-agent.yaml" "$GITHUB_WORKSPACE/examples/codex-notifications/active/agent.yaml"
printf '{}\n' | node "$runtime" automations plan --plugin-data "$plugin_data" > "$root/after-timing.json"
jq -es '.[0].actions[0].expected.prompt as $before | .[1].actions[0].expected | (.prompt != null and .prompt == $before) and (.rrule | contains("INTERVAL=17"))' "$root/before-timing.json" "$root/after-timing.json"
test ! -d "$CODEX_HOME/automations"

```
