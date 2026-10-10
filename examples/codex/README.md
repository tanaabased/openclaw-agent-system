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
The dispatch checks below cover packaged discovery, the assessment skill's schema and
presentation resources in the installed cache, read-only inspection, and the activation
boundary. Native issue worktree creation, useful assessment output, and desktop rendering
require a separately authorized test. For assessment acceptance, review clear requirements,
missing material information, conflicting evidence, and setup obstacles semantically:
check repository grounding, focused questions, justified documentation/tests, credible file
changes, and readable headings, lists, links, quotations, and code blocks. Deterministic
package checks do not establish those model and desktop properties.
Include a pending native receipt with a provider different from the app-server default
and a normalized title: reconciliation must find the existing chat, verify its identity,
correct the title before assessment, and avoid a second creation. Check summary concision
and agreement with the full plan semantically; verify that the complete plan follows inline
without a word-count target or an extra click. Do not assert exact model wording.
Check that full-plan sections pair each change with its files instead of repeating
the work in a separate inventory. Required decisions and meaningful validation must
survive the shorter presentation; grouped test cases must still identify the behavior
being checked. Do not invent file edits for sections that only describe operations.
Verify that retained Evidence and Investigation appear under optional Reference material
after the primary result. Questions, setup actions, and consequential uncertainty must
remain visible before that section; omit the section when no supporting detail exists.
For readability acceptance, review the assessment and summary without reading the full
plan: identify the affected user, their task and current friction, the proposed change,
and any consequential choice or limitation. Reject an opening that only lists internal
mechanisms, even if it is concise and technically correct. Compare it with the issue,
repository findings, and full plan to catch invented benefits or concealed uncertainty.
Use a fresh issue as well as revisions so the trial does not merely reproduce a coached
example; assess meaning rather than word counts or a forbidden-words list.
For the opening editor, inspect the native helper call: it must start without inherited
conversation and receive only the editor instructions and factual user-journey brief,
not the full plan or earlier opening. Verify that the assessor checks its claims against
the plan and that the full plan, outcome, questions, and saved routing remain intact.
Include a clarification case so editing does not turn an unresolved choice into a promise;
exercise answers arriving both in a later turn and after recording within the same turn.
The revision must replace the acknowledged result using its digest; a stale revision
must fail without overwriting the newer result. An identical retry stays idempotent.
Assign several fixtures together: intake should fill available capacity within its action
budget, continuing past completion notices and launches. Compare each native launch with
the prepared request exactly; issue evidence comes from context, not a copied snapshot.
If isolated helpers are unavailable, require an explicit limitation rather than a false
claim that the separate pass ran. This is live semantic evidence, not an exact-word test.
For an explicitly authorized reassessment pilot, preview and apply an operator reset
only after the prior chat is idle with a recorded result. Verify that its evidence
remains retained, an ordinary poll creates nothing, and a subsequent assignment event
produces exactly one new assessment chat through the normal intake flow.
While assessment is active, poll through the separate app-server adapter: an unloaded
history must not turn an apparent interruption into a missing-result blocker. Verify
that the eventual recorded result completes the same dispatch.

For the assessment-selection pilot, use the default with no guidance, inline guidance,
and file guidance, then the installed replacement with and without guidance. The
`assessment-skill/SKILL.md` fixture is suitable for a disposable repository. Verify
bare, `$`-prefixed, and plugin-qualified IDs resolve consistently, and that missing,
disabled, ambiguous, or changed skills stop assessment without a fallback. Inspect
the retained skill name, source, digest, and guidance snapshot through context; edits
to a guidance file must affect a fresh assessment but not continuation of an existing
one. Include attempted authority expansion and malformed replacement output: neither
may alter routing, mode, publication authority, or an already recorded valid result.
Both replacement plans and questions must use the shared host presentation. Verify
that its Assessment instructions block follows Model routing, identifies the resolved
custom skill and/or guidance source, preserves multiline inline guidance, and stays
absent for the default without guidance. File guidance displays its workspace-relative
path, not its contents. Continuations retain the original instruction selection. These
semantic pilot checks need explicit authorization; the headless checks prove discovery
and configuration only.

Verify that a fresh assessment uses the launch prompt's exact context request on stdin
with the trusted dispatch runtime and plugin-data arguments, without guessing action
flags. Apply the same transport when recording its result.
Keep the prepared request as parsed data through native creation, and compare the
actual launch prompt with the retained request. After retiring a closed fixture and
admitting a new assignment, verify that reusing its old native receipt is rejected
without retaining either supplied identity or creating another chat. Use distinctive
cat-themed skill and guidance markers to distinguish both inputs in the retained
assessment; these markers must not grant implementation or publication authority.

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

# should expose packaged dispatch without letting intake-only state launch work
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/notification-data"
printf '%s\n' '{"action":"inspect"}' | node "$runtime" dispatch --plugin-data "$plugin_data" \
  | jq -e '.version == 1 and .records == []'
if output=$(printf '%s\n' '{"action":"next","projects":[]}' | CODEX_THREAD_ID=fixture-intake node "$runtime" dispatch --plugin-data "$plugin_data" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and .code == "dispatch-activation-required"'
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
printf '%s\n' "$context" | grep -F 'For new routed work, use'

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

# should plan intake conversation setup without a global scanner rule or reload acknowledgment
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
printf '{}\n' | node "$runtime" automations plan --plugin-data "$root/notification-data" | jq -e '.status == "requires-native-app-sync" and any(.findings[]; .code == "automation-thread-sync-required")'
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
