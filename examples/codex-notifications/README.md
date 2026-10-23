# Codex Notifications Example

Load notification declarations through the packaged Codex runtime, plan an intake conversation and schedule bound to that installation, and verify that missing activation or native ownership cannot authorize dispatch, continuation, feedback, or delivery.

## What Belongs Here

- Active and paused declaration handling without silently activating intake or writing scheduler files.
- Installed runtime/caller/receipt boundaries before managed workflow effects, including rejection of unowned retained assessments.
- A native schedule request using the installed runtime and bound plugin data, without global scanner rules.

## What Does Not Belong Here

- Package binding and setup: [Codex install](../codex-install/README.md). Generic automation planning and durable conversations: [Codex automations](../codex-automations/README.md).
- Reset/history recovery, schema compatibility permutations, detailed heartbeat presentation, unsupported CLI spelling, and cadence-change variants.
- Successful assignment-to-plan or PR journeys, desktop approval behavior, final-text preservation, and rendered cards. The executable headless checks do not establish those outcomes.

## Notes

- These direct Ubuntu checks use isolated Codex state without hosted secrets or model generation. Both active and paused fixtures declare V3; a paused declaration retains configuration while future occurrences remain disabled.
- Pending relocation: explicit-target reset refusal, host/update/quiet heartbeat cases, restored pre-reset history, removed configuration fields, unsupported stdin flag, and cadence-change checks remain below.
- Native acceptance below is an inventory of separate installed/manual checks, not coverage executed by this README. Keep results, app/plugin revision, time, redacted source IDs, and actual native receipts in issue or PR evidence.

### Native Acceptance Inventory

- **Admission and denial recovery:** reconcile the installed schedule, preserve exact commands through host-access/busy retries, and verify one native creation independently. Deny one disposable issue's exact preparation/create request while another eligible issue proceeds. Report the denied operation, safely redacted actual reason or its unavailability, recovery IDs, and the other issue's started link. Preserve the denied issue's hold/source across restart, coordinator replacement, and reassignment; only a digest-bound operator `retry-denied` permits a fresh attempt. Verified non-creation releases capacity; uncertain creation retains it. Shared refusals, unrelated denials, altered commands, or incomplete history cannot authorize continuation.
- **Routing:** verified medium Complexity must win over a high coordinator content assessment, retaining source/reason and one chat. Without verified Complexity, bounded content assessment selects the profile. Verify the same contract in OpenClaw without credential edits or reassignment.
- **Pause/resume:** compare UI controls with manifest `paused` plus Install. Preserve automation/chat IDs, baseline, pending events, and receipts; accepted turns finish while future occurrences stop. After resume, discover assignments and issue/PR comments once without replay.
- **Reports and debug:** capture healthy, warning, and unchanged `DONT_NOTIFY` reports. Debug toggles expose retained cleanup/assessment/delivery context separately without changing work, notification decisions, or blocker visibility. Historical records without cleanup evidence cannot claim cleanup success.
- **Text and rendering:** retain the complete runtime response, exact final assistant text/diff, and actual displayed card separately. Capture app/version, revision, time, decision, and redacted IDs. A model echo or HTML preview cannot prove desktop rendering; matching text displayed literally needs a minimal upstream reproduction.
- **Comment cards:** on standalone Codex and OpenClaw, inspect incoming/outgoing comments, inline reviews, plan summaries, and PR announcements against [GitHub presentation](../../channels/github/PRESENTATION.md). Verify body-first display without added headings or literal HTML, space before the italic footer, exact author/source links, unlinked drafts, verified publication footers, visible blockers, and retained private plans, findings, PR cards, and attachments.
- **Coordinator replacement:** archive the intake chat natively; Doctor must report replacement required without creating a chat. Install binds a new coordinator while retaining baseline, issue/assessment/delivery state, and original creation provenance; new sends identify the replacement.
- **Reset and sidebar:** decline a preview without effects, then confirm a fresh preview. Verify pause, new baseline/tracking, native archival, one replacement coordinator under `AGENT SYSTEM`, unchanged workspace, and restored schedule/preferences. Unverified sidebar movement retains the pause. Lost readback after schedule creation must adopt the same replacement rather than create another.
- **Purge and uncertain resources:** purge disposable managed work through native chat/worktree removal while leaving GitHub state unchanged. Resume interrupted reset without repeated archival or replacements. Prepared creation and already-removed resources require complete active/archived inventory and verified checkout absence; found or uncertain resources retain recovery. Removal observed within 30 seconds completes purge without manual cleanup; pending removal stays incomplete, and a later reset resumes without another archival.
- **Same-turn progression:** one Work issue and one Auto-to-Work issue must implement from the assessment turn without an extra coordinator send. Interrupt and resume with the same assessment/checkout; clarification waits for an answer. PR, announcement, attachment, and card receipts make completion; unfinished delivery recovers without another implementation or PR.
- **Message parity:** compare direct and approved issue/PR questions, revisions, clarification answers, implementation requests, and repairs at equivalent task stages. Preserve full plans/partial work, owner and PR; Plan questions never implement, and explicit Plan/Auto implementation needs no extra decision object. Headless/component pairs do not prove desktop interpretation or display.
- **Removal authority:** an assignment removed by an actor outside the live allowed list preserves chat, checkout, and stage while reporting unresolved authority. Reassignment clears the warning without a new owner. Approved removal queues retirement; later actor-policy revocation must prevent stale cleanup authority.
- **Saved-plan readback:** `present` with `includeDetails: true` exposes the complete assessment, evidence, investigation, and plan only in its bound chat without changing saved results/digests. Default `reviewSummary` presentation remains concise; implementation still receives the full retained material.
- **Retirement:** observe automatic archival/reclamation after [shared installation grace](../../CONFIG.md#shared-cleanup), preserving assessment/routing evidence. Include more than twelve helpers and an inactive verified Guardian with empty native history; running, unrelated, pinned, or automation-owned chats still protect the checkout. Blockers report once and recover without manual resource removal to manufacture success.
- **Explicit retirement:** preview/apply retirement of a second open assigned task, skip grace, and redeem only the prepared native archive request. Own-active-turn requests stay pending. Reconciliation after native cleanup must retain history with one archive and no duplicate admission. Lookup/host errors keep their actual diagnostic; uncertain writes or denials never trigger blind retries.
- **Direct reply:** a fresh task selects the configured reply skill/guidance for a disposable source and retains an unpublished draft without intake activation. Later explicit publication verifies the exact destination, author, and permalink. Managed sources reuse their owner, inputs, results, and receipts; invalid managed context cannot become manual authority.

## Setup

```bash
# should install and enable the exact prepared codex plugin in isolated state
root="$TMPDIR/agent-system-codex-notifications"
mkdir -p "$root/package"
tar -xzf "$AGENT_SYSTEM_PACKAGE" -C "$root/package"
codex-tools install "$root/package/package" --json | jq -e '.ok == true and .inspection.installed == true and .inspection.enabled == true'
codex-tools cache check --repo-root "$root/package/package" --json | tee "$root/cache.json" | jq -e '.ok == true and .status == "current"'

# should choose grace in the shared isolated installation rather than agent manifests
install -d -m 700 "$XDG_CONFIG_HOME/tanaab/agent-system"
cp "$GITHUB_WORKSPACE/examples/codex-notifications/config.yaml" "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"
chmod 600 "$XDG_CONFIG_HOME/tanaab/agent-system/config.yaml"
```

## Testing

```bash
# should reject an unattended reset without an explicit target before accessing private state
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
status=0
node "$runtime" notifications reset --plugin-data "$root/uncreated-reset-data" > "$root/reset-stdout.txt" 2> "$root/reset-result.json" <<'JSON' || status=$?
{"yes":true}
JSON
test "$status" -ne 0
test ! -s "$root/reset-stdout.txt"
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

# should preserve restored pre-reset history and reject it before any workflow execution
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/notification-data"
scope=$(printf '%s\n' '{}' | node "$runtime" dispatch inspect --plugin-data "$plugin_data" | jq -er .scope)
state="$plugin_data/codex-dispatch-$scope.json"
umask 077
jq -nc --arg scope "$scope" '{version:1,scope:$scope,records:[{retired:{at:1,by:"historical-owner"},result:{decision:{action:"proceed"}}}]}' > "$state"
cp "$state" "$root/pre-reset-before.json"
if output=$(printf '%s\n' '{}' | node "$runtime" dispatch inspect --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "notification-state-reset-required" and (.notice.next | contains("Preserve the original file"))'
cmp "$state" "$root/pre-reset-before.json"
mv "$state" "$root/pre-reset-history.json"
printf '%s\n' '{}' | node "$runtime" dispatch inspect --plugin-data "$plugin_data" | jq -e '.records == [] and .resetGeneration == "initial"'

# should expose direct reply without intake activation while requiring an actual native caller
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/notification-data"
if output=$(printf '%s\n' '{"action":"reply","operation":"compose","target":"https://github.com/tanaabased/big-test-bucket/issues/1","privateText":"A supplied response."}' | env -u CODEX_THREAD_ID node "$runtime" feedback reply compose --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "reply-native-caller-required"'
if output=$(printf '%s\n' '{"action":"reply","operation":"publish"}' | node "$runtime" feedback reply compose --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "workflow-command-action-mismatch"'
test ! -d "$CODEX_HOME/automations"

# should reject unsupported configuration before binding
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
sed 's/  schema-version: 3/  schema-version: 3\n  notifications: {obsolete: true}/' "$GITHUB_WORKSPACE/examples/codex-notifications/active/agent.yaml" > "$root/unsupported-agent.yaml"
cp "$GITHUB_WORKSPACE/examples/codex-notifications/active/agent.yaml" "$root/original-agent.yaml"
trap 'cp "$root/original-agent.yaml" "$GITHUB_WORKSPACE/examples/codex-notifications/active/agent.yaml"' EXIT
cp "$root/unsupported-agent.yaml" "$GITHUB_WORKSPACE/examples/codex-notifications/active/agent.yaml"
node "$runtime" binding preview --workspace "$GITHUB_WORKSPACE/examples/codex-notifications/active" | jq -e '.manifest.status == "invalid" and any(.manifest.diagnostics[]; .code == "manifest-unknown-key")'
cp "$root/original-agent.yaml" "$GITHUB_WORKSPACE/examples/codex-notifications/active/agent.yaml"
trap - EXIT
node "$runtime" binding preview --workspace "$GITHUB_WORKSPACE/examples/codex-notifications/active" | jq -e '.manifest.status == "valid"'

# should reject removed global feedback before binding or activation
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
node "$runtime" binding preview --workspace "$GITHUB_WORKSPACE/examples/codex-notifications/removed-feedback" \
  | jq -e '.manifest.status == "invalid" and any(.manifest.diagnostics[]; .code == "manifest-unknown-key")'
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

# should require a reconciled native owner before operator retirement can start cleanup
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

# should reject missing or unowned retained assessments
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
if output=$(printf '%s\n' '{"action":"present","id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","includeDetails":true}' | CODEX_THREAD_ID=fixture-intake node "$runtime" dispatch --plugin-data "$root/notification-data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-assessment-caller-mismatch"'

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


# should retain a paused declaration and diagnose its inverse compatibility alias
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/disabled-notification-data"
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$GITHUB_WORKSPACE/examples/codex-notifications/disabled" --confirm \
  | jq -e '.status == "bound" and .preview.manifest.status == "valid"'
printf '%s\n' '{}' | node "$runtime" automations plan --plugin-data "$plugin_data" \
  | jq -e '.status == "requires-native-app-sync" and any(.findings[]; .code == "automation-thread-sync-required")'
if output=$(node "$runtime" intake scan --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "intake-automation-paused"'
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
sed 's/  schema-version: 3/  schema-version: 3\n  interval-minutes: 17\n  max-concurrent-items: 8/' "$GITHUB_WORKSPACE/examples/codex-notifications/active/agent.yaml" > "$root/timing-agent.yaml"
mv "$root/timing-agent.yaml" "$GITHUB_WORKSPACE/examples/codex-notifications/active/agent.yaml"
printf '{}\n' | node "$runtime" automations plan --plugin-data "$plugin_data" > "$root/after-timing.json"
jq -es '.[0].actions[0].expected.prompt as $before | .[1].actions[0].expected | (.prompt != null and .prompt == $before) and (.rrule | contains("INTERVAL=17"))' "$root/before-timing.json" "$root/after-timing.json"
test ! -d "$CODEX_HOME/automations"

```
