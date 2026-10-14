# Codex Example

This scenario installs the prepared Agent System plugin into isolated Codex state and verifies deterministic skill discovery, workspace binding, runtime-aware setup, automation planning, session context, transfer, and removal on a disposable GitHub Actions runner.

## Automation Checks

Automation lookup inputs below are explicit fixtures. The installed runtime's
`list` and `sync` routes inspect inventory and plan authorized native app actions;
they do not write scheduler files. The `run` and `runs` checks assert the explicit
`automation-run-now-unsupported` and `automation-history-unavailable` results.

The trusted `automationRuntime` exposes `threads-sync` under explicit installation
authorization and a fresh plan digest. It creates per-automation conversations
through `codex app-server` in the ambient profile, adds an attributed setup
history item without model generation, and verifies resume through a fresh
process, including native `auto_review`, `on-request`, and `workspace-write`
permission readback. Repeated sync reuses those conversations.

The prepare/cancel check retains a pending journal until saved-state verification
and permits cancellation only while the failed write's target remains unchanged.
Pending creates also require no new native IDs: an unmarked job could be a partial
create. Lost-response recovery may acknowledge the exact saved pending definition
without another create; further writes require a fresh plan. Older journals retain
the whole-scheduler cancellation check.

Native request/response and saved-state captures live in `fixtures/` with separate
provenance. Ordinary tests consume reviewed captures without contacting the app;
constructed failure cases are identified in the tests. This packed/headless
scenario does not replace separate installed desktop-tool verification.

### Desktop Acceptance

These headless checks prove packaged discovery, configuration, activation boundaries,
and native conversation persistence. They do not prove scheduled issue creation,
model judgment, or desktop rendering. Those require a separately authorized pilot
using disposable issues and the installed plugin.

- **Assignment intake:** assign more issues than the available slots. Verify that
  available slots fill, overflow starts after an assessment finishes, and later
  checks neither create duplicates nor repeat earlier start notices. Intake reports
  starts, pending work, slots, and intake obstacles; assessment progress stays in
  the issue.
- **Creation handoff:** verify the scheduled orchestration passes the complete
  prepared request directly to `create_thread`, including all runtime transport
  instructions. Command polling must finish before creation; preparation failure
  or uncertain native submission must never cause another creation call.
- **Unsubmitted creation:** let an intake turn end after preparation without
  calling `create_thread`. A later scheduled turn must verify complete native
  history, retain the abandoned attempt, and prepare one fresh request. A recorded
  call (including rejection), pending receipt, or incomplete history must prevent
  automatic rearming; repeated preparation in the same turn must not authorize
  another call.
- **Assessment:** exercise a clear request, missing requirements, conflicting
  evidence, and a setup obstacle. Check repository grounding, useful questions,
  a readable opening from the isolated editor, and a concise full plan with files
  beside their changes. Review meaning, not exact wording. A clarification answer
  should revise the retained result without losing investigation or routing.
- **Custom instructions:** try the default skill, inline and file guidance, and a
  replacement skill. Exercise both the recommended integrated fixture and an
  unchanged existing generic assessment skill with no Agent System commands,
  result fields, or required headings. Verify the complete assessment is saved and
  displayed for an actionable plan, a blocking question with partial work, and a
  later answer after that question was recorded. Include conditional recommendations,
  unavailable evidence, and unusable output; compare summaries and readiness with
  the original, not exact wording. Confirm integrated results are not adapted or
  submitted twice. Deterministic tests establish storage/rendering, not faithful
  model interpretation. Verify the retained selection and shared presentation; missing
  or changed skills must stop with an actionable diagnostic rather than a fallback.
- **Recovery:** interrupt native creation and verify that the next check recovers
  the same issue destination. Exercise missing project registration and native
  host-access approval; follow the supported recovery in [Codex](../../CODEX.md#issue-assessment)
  without clearing tracking state or bypassing a denial.
- **Work mode:** activate the complete workflow through Install, assign one bounded
  disposable issue, and verify assessment, one native implementation continuation,
  and one linked PR in the original chat without stage approvals. Capture native
  send receipts, restart reconciliation, provider linkage, attachment, and visible
  presentation separately; a forged or missing receipt must not start work.
  During the handoff, inspect through a separate native reader: an interrupted
  status without a completion timestamp must not end the running turn. After an
  actual ended-turn blocker, verify a digest-bound operator retry retains the
  same plan and chat and queues one handoff on the next occurrence; native denials
  and substantive implementation results must remain ineligible for that retry.
  After recording implementation, cancel or fail its turn before delivery. The
  next occurrence must retain the result and stop without preparing publication;
  only a successfully completed turn may receive the delivery-only continuation.
  A native command, patch, or tool approval denial must also stop continuation,
  even when the surrounding turn completes normally after recording implementation.
- **Author feedback:** activate inherited assigners plus one pinned contributor. Verify a
  new issue comment, a submitted review on its delivery PR, and a later inline reply
  reach the original issue chat with exact source context. Check that an ordinary
  comment uses the shared quoted card: linked author heading, unchanged body and
  mentions, and an exact-comment permalink beneath it. Verify multiline Markdown
  stays inside the quote and the response stays outside. Fill the three shared
  slots, queue comments on a busy owner, then verify a released slot admits the
  oldest eligible work without a noisy owner monopolizing the queue. Check verified
  send counts and quiet repeat polls. Edit a source or revoke its author before
  publication; retain the private answer and withhold the public reply. Interrupt a
  reply after its provider write and reconcile the same receipt without a duplicate.
  Verify same-account feedback stays private even if a public candidate is supplied,
  and that confirmed runtime replies never become new feedback events.
  Activate routine public replies once, then process two successive comments from
  the pinned contributor without per-comment human confirmation. Each publication
  must expose its exact destination and attributed draft before applying the matching
  digest through native approval. A changed source, stale digest, or native denial
  must still stop the write.
  Verify receipt matching accepts an explicit `hostId: local` on the otherwise
  unchanged native send, while rejecting another host or changed request fields.
  Verify a fuller private answer remains visible in the final chat response and
  the selected reply skill produces a separate concise public quote. Exercise the
  bundled default, a replacement skill, inline and file guidance, and a missing or
  changed skill; missing replacements must preserve the private answer and block
  publication without fallback. Confirm applicable voice skills are read and their
  style is reflected without inventing facts or hiding blockers. Check actual
  rendered cards separately from stored Markdown and provider receipts. Confirm
  the final response starts with the complete incoming card even after progress
  commentary is collapsed, followed by the private answer and public quote.
  During slow provider discovery, save a child response and confirm the scan does
  not block that save or overwrite its result or publication receipt. Preserve
  lock-loss protections; never delete a lock to make the trial pass.
  An unfinished publication must stay stopped across scheduled polls. After fresh
  human approval, verify the operator preview binds the exact retained draft and
  destination, rejects a stale digest, and reconciles a prior write without duplication.
  After an ended feedback turn is blocked, verify the next queued comment on that
  owner can start in the same poll when capacity permits, without retrying an
  uncertain send or exceeding the poll budget. Verify the delivery PR card reports
  feedback as active only after saved schedule readback; disabled or unverified
  intake must not claim active delivery.
  Check custom skill and guidance notices after model routing for assessment,
  after the PR card for implementation, and after the public quote and outcome
  for feedback. Default-only selections stay hidden; custom skill and guidance
  file links resolve to the retained files, and inline guidance remains literal.
  Use a temporary Latin-only replacement reply skill to distinguish an English
  private response from its public candidate, then test guidance separately and
  restore the bundled default after the trial.
  Independent reviewer-chat routing requires its separate intake adapter.
- **Continuation:** explicitly request implementation in the issue and verify its
  handoff preserves the assessment and worktree. Later intake must neither inspect
  that implementation nor prevent another eligible issue from starting.
- **Workflow authority:** the existing assessment schedule must reject implementation,
  review, and publication authority. A separately authorized native pilot must record
  the fresh schedule, native continuation and publication receipts, any approval
  intervention, and recovery before unattended support can be claimed.

Use fresh issues as well as follow-up revisions. Keep detailed pilot plans and results
in the owning issue or pull request, and retire disposable fixtures afterward.

## Setup

```bash
# should install and enable the exact prepared codex plugin in isolated state
root="$TMPDIR/agent-system-codex-example"
mkdir -p "$root/package"
tar -xzf "$AGENT_SYSTEM_PACKAGE" -C "$root/package"
codex-tools install "$root/package/package" --json | jq -e '.ok == true and .inspection.installed == true and .inspection.enabled == true'
codex-tools cache check --repo-root "$root/package/package" --json | tee "$root/cache.json" | jq -e '.ok == true and .status == "current"'

# should expose complete packaged skills to a fresh codex app server
bun --cwd "$GITHUB_WORKSPACE" run test:codex-plugin

# should prepare valid, inactive, and replacement workspaces
root="$TMPDIR/agent-system-codex-example"
mkdir -p "$root/workspace" "$root/missing-manifest" "$root/rebound-workspace"
cp "$GITHUB_WORKSPACE/examples/codex/agent.yaml" "$root/workspace/agent.yaml"
printf '%s\n' \
  'schema-version: 1' \
  'agent:' \
  '  id: codex-example-rebound' \
  '  name: Codex Example Rebound' \
  > "$root/rebound-workspace/agent.yaml"
cp "$root/workspace/agent.yaml" "$root/workspace/agent.expected.yaml"
cp "$root/rebound-workspace/agent.yaml" "$root/rebound-workspace/agent.expected.yaml"
```

## Testing

```bash
# should explain a host permission failure in one heartbeat without accessing tracking state
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
printf '%s\n' '{"automationId":"fixture-native-intake","code":"codex-host-access-required"}' \
  | node "$runtime" intake failure-response --plugin-data "$root/uncreated-failure-data" \
  | jq -e '.status == "failure" and (.response | startswith("<heartbeat>")) and (.response | endswith("</heartbeat>")) and (.response | contains("<decision>NOTIFY</decision>")) and (.response | contains("native host approval")) and (.response | contains("codex-host-access-required"))'
test ! -e "$root/uncreated-failure-data"

# should format a packaged quiet heartbeat without activating intake or changing its state
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
printf '%s\n' '{"automationId":"fixture-native-intake","currentTimeIso":"2026-10-09T12:00:00.000Z","intake":{"status":"ready","changed":false},"dispatch":[{"status":"at-capacity","changed":false}]}' \
  | TZ=UTC node "$runtime" intake quiet-response --plugin-data "$root/quiet-data" \
  | jq -e '.status == "quiet" and .period == "afternoon" and (.message | length > 0) and .response == ("<heartbeat>\n  <automation_id>fixture-native-intake</automation_id>\n  <decision>DONT_NOTIFY</decision>\n  <message>" + .message + "</message>\n</heartbeat>")'
test ! -e "$root/quiet-data"

# should preserve an actionable earlier result instead of replacing it with quiet text
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
printf '%s\n' '{"automationId":"fixture-native-intake","currentTimeIso":"2026-10-09T12:00:00.000Z","intake":{"status":"ready","changed":false},"dispatch":[{"status":"completed","changed":true},{"status":"idle","changed":false}]}' \
  | node "$runtime" intake quiet-response --plugin-data "$root/quiet-data" \
  | jq -e '.status == "not-quiet" and (has("response") | not)'

# should expose packaged intake and plan one owned schedule without activating it
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/notification-data"
mkdir -p "$root/notification-workspace"
cp "$GITHUB_WORKSPACE/examples/codex/notification-policy-agent.yaml" "$root/notification-workspace/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/codex/assessment-guidance.md" "$root/notification-workspace/assessment-guidance.md"
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/notification-workspace" --confirm \
  | jq -e '.status == "bound" and .preview.manifest.status == "valid"'
node "$runtime" intake inspect --plugin-data "$plugin_data" \
  | jq -e '.status == "blocked" and .code == "intake-activation-required" and .records == []'
if output=$(node "$runtime" intake scan --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "intake-activation-required"'
printf '%s\n' '{}' | node "$runtime" automations plan --plugin-data "$plugin_data" \
  | jq -e 'any(.findings[]; .code == "automation-thread-sync-required") and (.conversations | length) == 1'
test ! -e "$root/notification-workspace/.setup-applied"
test ! -d "$CODEX_HOME/automations"

# should reject removed global feedback before binding or activation
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
mkdir -p "$root/removed-feedback-workspace"
cp "$GITHUB_WORKSPACE/examples/codex/notification-global-feedback-agent.yaml" "$root/removed-feedback-workspace/agent.yaml"
node "$runtime" binding preview --workspace "$root/removed-feedback-workspace" \
  | jq -e '.manifest.status == "invalid" and any(.manifest.diagnostics[]; .code == "github-notification-global-feedback-removed")'
test ! -d "$CODEX_HOME/automations"

# should expose packaged dispatch without letting intake-only state launch work
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/notification-data"
printf '%s\n' '{"action":"inspect"}' | node "$runtime" dispatch --plugin-data "$plugin_data" \
  | jq -e '.version == 1 and .records == []'
if output=$(printf '%s\n' '{"action":"next","projects":[]}' | CODEX_THREAD_ID=fixture-intake node "$runtime" dispatch --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-activation-required" and .notice.severity == "warning" and .notice.notify == true and (.notice.message | contains("Next step"))'
if output=$(printf '%s\n' '{"action":"handoff","id":"missing"}' | CODEX_THREAD_ID=fixture-operator node "$runtime" dispatch --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-handoff-unavailable" and .notice.severity == "error"'
test ! -d "$CODEX_HOME/automations"
test ! -d "$root/notification-workspace/checkouts"
test ! -d "$root/notification-workspace/.agent-system/repositories"

# should return an actionable diagnostic for an unsupported stdin flag
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
if output=$(node "$runtime" dispatch --plugin-data "$root/notification-data" --input - 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and (.message | contains("--plugin-data")) and (.message | contains("stdin")) and (.message | contains("--input"))'

# should reject packaged continuation without newly reconciled work authority
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
if output=$(printf '%s\n' '{"action":"next"}' | CODEX_THREAD_ID=fixture-intake node "$runtime" continuation --plugin-data "$root/notification-data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-activation-required"'
test ! -d "$CODEX_HOME/automations"

# should reject packaged feedback without a freshly reconciled intake schedule
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
if output=$(printf '%s\n' '{"action":"next"}' | CODEX_THREAD_ID=fixture-intake node "$runtime" feedback --plugin-data "$root/notification-data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-activation-required"'
test ! -d "$CODEX_HOME/automations"

# should expose packaged delivery while rejecting requests without a valid managed receipt
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
node "$runtime" delivery --help | grep -F 'present renders the card and notices even when attachment is pending'
if output=$(printf '%s\n' '{"action":"publish","id":"missing"}' | node "$runtime" delivery --plugin-data "$root/notification-data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "delivery-request-invalid" and .notices[0].severity == "error"'

# should accept separate feedback and stage selections while leaving disabled workflows inactive
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/disabled-notification-data"
mkdir -p "$root/disabled-notification-workspace"
cp "$GITHUB_WORKSPACE/examples/codex/notification-disabled-agent.yaml" "$root/disabled-notification-workspace/agent.yaml"
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/disabled-notification-workspace" --confirm \
  | jq -e '.status == "bound" and .preview.manifest.status == "valid"'
printf '%s\n' '{}' | node "$runtime" automations plan --plugin-data "$plugin_data" \
  | jq -e '.status == "aligned" and .actions == [] and (.conversations // []) == []'
if output=$(node "$runtime" intake scan --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "intake-policy-disabled"'
test ! -d "$CODEX_HOME/automations"

# should preview a valid workspace without persisting a binding
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$root/workspace" && pwd -P)
node "$runtime" binding preview --workspace "$root/workspace" \
  | jq -e --arg workspace "$workspace" '.status == "ready" and .workspaceDir == $workspace and .manifest.status == "valid" and .manifest.agentId == "codex-example"'
test ! -e "$plugin_data/workspace-binding.json"

# should refuse to bind without explicit confirmation
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
if output=$(node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/workspace" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and (.message | contains("require --confirm"))'
test ! -e "$plugin_data/workspace-binding.json"

# should persist and inspect one explicitly confirmed workspace binding
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$root/workspace" && pwd -P)
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/workspace" --confirm \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace and .preview.manifest.agentId == "codex-example"'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace and .preview.manifest.agentId == "codex-example"'

# should keep standalone setup diagnostics quiet without runner debug
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
if diagnostics=$(node "$runtime" setup inspect --plugin-data "$plugin_data" 2>&1 >/dev/null); then
  :
else
  status=$?
  printf '%s\n' "$diagnostics" >&2
  exit "$status"
fi
test -z "$diagnostics"

# should expose codex tools diagnostics through standalone setup with runner debug
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
if diagnostics=$(RUNNER_DEBUG=1 node "$runtime" setup inspect --plugin-data "$plugin_data" 2>&1 >/dev/null); then
  :
else
  status=$?
  printf '%s\n' "$diagnostics" >&2
  exit "$status"
fi
printf '%s\n' "$diagnostics" | grep -F 'debug: {"command":"status"'

# should inspect and install only setup applicable to standalone codex
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
inspection=$(node "$runtime" setup inspect --plugin-data "$plugin_data")
printf '%s\n' "$inspection" \
  | jq -e '.status == "inspected" and [.findings[] | [.stepId, .code]] == [["codex-tools-debug", "setup-healthy"], ["shared", "setup-drift"], ["codex-only", "setup-manual"], ["openclaw-only", "setup-not-applicable"]]'
installed=$(node "$runtime" setup install --plugin-data "$plugin_data")
printf '%s\n' "$installed" \
  | jq -e '.status == "installed" and [.outcomes[] | [.stepId, .code]] == [["codex-tools-debug", "setup-unchanged"], ["shared", "setup-applied"], ["codex-only", "setup-applied"], ["openclaw-only", "setup-not-applicable"]]'
test -f "$root/workspace/.codex-shared"
test -f "$root/workspace/.codex-only"
test ! -e "$root/workspace/.openclaw-checked"
test ! -e "$root/workspace/.openclaw-only"

# should plan automation sync through the packed runtime without native scheduler writes
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
mkdir -p "$root/automation-workspace"
cp "$GITHUB_WORKSPACE/examples/codex/automation-agent.yaml" "$root/automation-workspace/agent.yaml"
workspace=$(cd "$root/automation-workspace" && pwd -P)
node "$runtime" binding bind --plugin-data "$root/automation-data" --workspace "$workspace" --confirm
jq -n --arg workspace "$workspace" '{projects:{schemaVersion:2,projects:[{projectId:"fixture-project",projectKind:"local",hostId:"local",path:$workspace}]}}' > "$root/automation-input.json"
node "$runtime" automations plan --plugin-data "$root/automation-data" < "$root/automation-input.json" \
  | tee "$root/automation-plan.json" \
  | jq -e '.status == "requires-native-app-sync" and .actions[0].mode == "create" and .actions[0].expected.projectId == "fixture-project" and .actions[0].expected.status == "PAUSED"'
node "$runtime" setup install --plugin-data "$root/automation-data" \
  | jq -e '.status == "requires-native-app-sync"'
test ! -d "$CODEX_HOME/automations"

# should expose list sync and explicit occurrence gaps through the installed runtime
root="$TMPDIR/agent-system-codex-example"
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

# should retain a pending native action and cancel only an unchanged failed write
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
digest=$(jq -r .digest "$root/automation-plan.json")
jq --arg digest "$digest" '. + {digest:$digest}' "$root/automation-input.json" \
  | node "$runtime" automations prepare --plugin-data "$root/automation-data" \
  | jq -e '.status == "prepared" and .request.mode == "create"'
node "$runtime" automations inspect --plugin-data "$root/automation-data" < "$root/automation-input.json" \
  | jq -e '.status == "blocked" and ([.findings[].code] | index("automation-pending-readback-required") != null)'
jq -n --arg digest "$digest" '{digest:$digest}' \
  | node "$runtime" automations cancel --plugin-data "$root/automation-data" \
  | jq -e '.status == "cancelled"'
test ! -d "$CODEX_HOME/automations"

# should report a blocked setup check when an exited parent leaves inherited pipes open
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
mkdir -p "$root/timeout-workspace"
printf '%s\n' \
  'schema-version: 1' \
  'agent: { id: codex-timeout }' \
  'setup-agent:' \
  '  check: { command: sh, args: ["-c", "sleep 3 & exit 0"], timeout-seconds: 1 }' \
  '  apply: "true"' \
  > "$root/timeout-workspace/agent.yaml"
node "$runtime" binding bind --plugin-data "$root/timeout-data" --workspace "$root/timeout-workspace" --confirm
node "$runtime" setup inspect --plugin-data "$root/timeout-data" \
  | jq -e '.status == "inspected" and [.findings[].code] == ["setup-blocked"]'

# should load the bound workspace through a packaged hook path containing spaces
root="$TMPDIR/agent-system-codex-example"
cache_root=$(jq -r .cachePath "$root/cache.json")
plugin_root="$root/plugin with spaces"
cp -R "$cache_root" "$plugin_root"
hook=$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$plugin_root/hooks/hooks.json")
plugin_data="$root/plugin-data"
workspace=$(cd "$root/workspace" && pwd -P)
context=$(printf '%s\n' '{"hook_event_name":"SessionStart","source":"startup"}' \
  | PLUGIN_DATA="$plugin_data" PLUGIN_ROOT="$plugin_root" sh -c "$hook" \
  | jq -r '.hookSpecificOutput.additionalContext')
printf '%s\n' "$context" | grep -F '"status": "active"'
printf '%s\n' "$context" | grep -F '"id": "codex-example"'
printf '%s\n' "$context" | grep -F "\"workspaceDir\": \"$workspace\""
printf '%s\n' "$context" | sed -n '/^{/,/^}/p' \
  | jq -e '.binding.context.capabilities == ["agent-system-doctor", "agent-system-install", "agent-system-model-routing", "agent-system-git-cli", "agent-system-github-cli"]'
printf '%s\n' "$context" | sed -n '/^{/,/^}/p' \
  | jq -e '.binding.context.modelRouting.medium == {status: "mapped", sourceModel: "openai/gpt-5.6-sol", model: "gpt-5.6-sol", thinking: "high"}'
printf '%s\n' "$context" | sed -n '/^{/,/^}/p' \
  | jq -e '.feedbackRuntime.argvPrefix[-1] == "feedback"'
printf '%s\n' "$context" | grep -F 'For new routed work, use'
printf '%s\n' "$context" | grep -F 'Reproduce the complete returned presentation Markdown in the final reply'

# should resolve bounded routing through the installed cache and preserve unresolved reasoning
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
inspection=$(printf '%s\n' '{"action":"inspect"}' | node "$runtime" model-routing --plugin-data "$plugin_data")
printf '%s\n' "$inspection" | jq -e '.status == "available" and (.reportGuidance | contains("**Model routing**"))'
digest=$(printf '%s\n' "$inspection" | jq -r .manifestDigest)
jq -n --arg digest "$digest" '{action:"resolve",manifestDigest:$digest,context:"An unspecified task.",assessment:{complexity:"unset",reason:"No defensible tier."}}' \
  | node "$runtime" model-routing --plugin-data "$plugin_data" \
  | jq -e '.status == "unresolved" and .profile == null and .selection == null and .reason == "No defensible tier."'
jq -n --arg digest "$digest" '{action:"resolve",manifestDigest:$digest,context:"An unspecified task.",assessment:{complexity:"unset",reason:"No defensible tier."},fallback:"default",overrides:{effort:"low"}}' \
  | node "$runtime" model-routing --plugin-data "$plugin_data" \
  | jq -e '.status == "unresolved" and .profile == "default" and .candidate.thinking == "low" and .execution == "unverified"'

# should accept issue objects as bounded routing context through the installed cache
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
inspection=$(printf '%s\n' '{"action":"inspect"}' | node "$runtime" model-routing --plugin-data "$plugin_data")
digest=$(printf '%s\n' "$inspection" | jq -r .manifestDigest)
jq -n --arg digest "$digest" '{action:"resolve",manifestDigest:$digest,context:{title:"Notification settings",body:"Add workflow enable controls."},assessment:{complexity:"medium",reason:"Extend existing configuration and scheduling."}}' \
  | node "$runtime" model-routing --plugin-data "$plugin_data" \
  | jq -e '.status == "resolved" and .profile == "medium" and .candidate.model == "gpt-5.6-sol" and .candidate.thinking == "high" and .execution == "unverified"'

# should plan intake conversation setup without a global scanner rule or reload acknowledgment
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
printf '{}\n' | node "$runtime" automations plan --plugin-data "$root/notification-data" | jq -e '.status == "requires-native-app-sync" and any(.findings[]; .code == "automation-thread-sync-required")'
test ! -d "$CODEX_HOME/rules"

# should bind work preparation to the installed runtime in the native schedule request
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/notification-data"
sed 's/mode: auto/mode: work/' "$GITHUB_WORKSPACE/examples/codex/notification-policy-agent.yaml" > "$root/notification-workspace/agent.yaml"
printf '{}\n' | node "$runtime" automations plan --plugin-data "$plugin_data" > "$root/work-plan.json"
jq '{digest:.digest}' "$root/work-plan.json" | node "$runtime" automations threads-sync --plugin-data "$plugin_data" | jq -e '.status == "verified"'
node_executable=$(node -p 'process.execPath')
printf '{}\n' | node "$runtime" automations plan --plugin-data "$plugin_data" \
  | jq -e --arg node "$node_executable" --arg runtime "$runtime" --arg data "$plugin_data" '.actions[0].expected.prompt | contains([$node,$runtime,"continuation","--plugin-data",$data] | tojson)'
test ! -d "$CODEX_HOME/automations"
test ! -d "$CODEX_HOME/rules"

# should refresh local settings through the bound codex runtime without changing the shared base
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
printf '%s\n' 'models: { default: { effort: xhigh } }' 'setup-agent: { steps: [] }' > "$root/workspace/agent.local.yaml"
cp "$root/workspace/agent.local.yaml" "$root/local.expected.yaml"
printf '%s\n' '{"hook_event_name":"SessionStart","source":"startup"}' \
  | PLUGIN_DATA="$plugin_data" PLUGIN_ROOT="$plugin_root" node "$runtime" session-start \
  | jq -r '.hookSpecificOutput.additionalContext' \
  | sed -n '/^{/,/^}/p' \
  | jq -e '.binding.context.modelRouting.default.thinking == "xhigh"'
cmp "$root/workspace/agent.expected.yaml" "$root/workspace/agent.yaml"
cmp "$root/local.expected.yaml" "$root/workspace/agent.local.yaml"
rm "$root/workspace/agent.local.yaml"

# should create durable conversations with selected models and verified auto review
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
mkdir -p "$root/threads-workspace"
cp "$GITHUB_WORKSPACE/examples/codex/threads-agent.yaml" "$root/threads-workspace/agent.yaml"
node "$runtime" binding bind --plugin-data "$root/threads-data" --workspace "$root/threads-workspace" --confirm
printf '{}\n' | node "$runtime" automations plan --plugin-data "$root/threads-data" > "$root/threads-plan.json"
jq '{digest}' "$root/threads-plan.json" | node "$runtime" automations threads-sync --plugin-data "$root/threads-data" | tee "$root/threads-created.json" | jq -e '.status == "verified" and ([.threads[].id] | unique | length) == 2'
printf '{}\n' | node "$runtime" automations plan --plugin-data "$root/threads-data" | tee "$root/threads-plan.json" | jq -e '.status == "requires-native-app-sync" and ([.actions[].expected.targetThreadId] | unique | length) == 2 and all(.actions[]; .expected.kind == "heartbeat")'

# should retain conversation identities and model settings after the creating process exits
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
jq '{digest}' "$root/threads-plan.json" | node "$runtime" automations threads-sync --plugin-data "$root/threads-data" > "$root/threads-reused.json"
jq -S '.threads | map_values(.id)' "$root/threads-created.json" > "$root/threads-ids.json"
jq -S '.threads | map_values(.id)' "$root/threads-reused.json" | diff - "$root/threads-ids.json"
test ! -d "$CODEX_HOME/automations"

# should preserve the active binding when a workspace has no agent manifest
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$root/workspace" && pwd -P)
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/missing-manifest" --confirm \
  | jq -e '.status == "confirmation-required" and .preview.manifest.status == "missing"'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace'

# should bind a missing manifest workspace only with the explicit inactive override
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$root/missing-manifest" && pwd -P)
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/missing-manifest" --confirm --allow-inactive \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace and .preview.manifest.status == "missing"'
context=$(printf '%s\n' '{"hook_event_name":"SessionStart","source":"startup"}' \
  | PLUGIN_DATA="$plugin_data" PLUGIN_ROOT="$plugin_root" node "$runtime" session-start \
  | jq -r '.hookSpecificOutput.additionalContext')
printf '%s\n' "$context" | grep -F '"status": "inactive"'
printf '%s\n' "$context" | grep -F '"code": "manifest-missing"'

# should replace the binding with another explicitly confirmed workspace
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$root/rebound-workspace" && pwd -P)
node "$runtime" binding preview --workspace "$root/rebound-workspace" \
  | jq -e --arg workspace "$workspace" '.status == "ready" and .workspaceDir == $workspace and .manifest.agentId == "codex-example-rebound"'
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/rebound-workspace" --confirm \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace and .preview.manifest.agentId == "codex-example-rebound"'

# should unbind without changing either workspace or manifest
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
node "$runtime" binding unbind --plugin-data "$plugin_data" --confirm \
  | jq -e '.status == "unbound"'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e '.status == "unbound"'
cmp "$root/workspace/agent.expected.yaml" "$root/workspace/agent.yaml"
cmp "$root/rebound-workspace/agent.expected.yaml" "$root/rebound-workspace/agent.yaml"
```
