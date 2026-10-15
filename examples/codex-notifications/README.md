# Codex Notifications Example

Verify packaged notification activation boundaries, intake responses, and work preparation in isolated Codex state. Installation and workspace lifecycle checks live in the [Codex install example](../codex-install/README.md); generic automation planning and conversation persistence live in the [Codex automations example](../codex-automations/README.md). Runtime tests run this scenario on Ubuntu without a live model or hosted secrets.

## Desktop Acceptance

These headless notification checks verify planning and activation boundaries.
They do not prove scheduled issue creation,
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
- **Continuation handoff:** verify preparation finishes without sending, then a
  separate execution consumes the stored complete request once. An idle check must
  never invoke native send or request implementation approval. A missing stored
  request or native rejection must stop without reconstructing or resending it. An altered
  prompt must produce a mismatch blocker, never implementation authority or quiet
  success. An operator retry must retain the malformed send evidence and current
  diagnostic turn, require an unchanged assessment checkout and no implementation
  result, and queue exactly one fresh handoff. Repeat polling to prove no duplicate
  send; duplicate sends, changed model or destination, and native denials stay blocked.
- **Reapproved send rejection:** after an exact native continuation send is rejected,
  verify ordinary polls and `retry` leave it blocked. Explicit operator reapproval
  through `retry-denied` must bind the rejected call and fresh preview digest, retain
  its request and reason, and queue one new receipt in the original chat and unchanged
  worktree. Repeated application or polling must not duplicate that send. Unknown
  failures, intervening turns, changed files, and implementation denials stay blocked.
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
- **Auto mode:** explicitly activate Auto through Install; an older Plan/Work
  schedule must not authorize it. Use one clear disposable issue and one issue
  requiring operator direction. Verify the same assessment skill produces a retained
  proceed/wait decision with reasons: proceed keeps the complete assessment, guidance,
  and selected model/effort through one implementation turn and one linked PR; wait
  keeps its plan, releases the implementation slot, and produces neither. Repeat
  polling and restart to verify no duplicate turn or PR and no promotion of wait.
  Submit an invalid assessment before adoption, then correct it through the result
  route. Verify one continuation uses the corrected proceed result; a corrected
  wait still stops. Invalid submissions must preserve existing wait, cancellation,
  denial, or changed-authority blockers, and must not rearm an adopted assessment.
  Require an authored PR description with the verified implementation and validation
  evidence; missing or blank bodies must stop before automatic publication.
  Capture native receipts, provider linkage, attachment, and visible presentation
  separately. Unit fixtures cover invalid decisions, stale evidence, changed guidance,
  revoked authority, and denial; they do not prove model suitability judgment.
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
  inline reply carrying its own empty review and matching submission timestamp
  stays a thread comment: preview the exact thread permalink, publish once under
  its root review comment, and leave the PR conversation reply count unchanged.
  Repeat polling after publication and after upgrading with retained review groups;
  neither may replay already handled feedback. Check that an ordinary
  comment and inline review finding use the shared quoted card: linked author heading, unchanged body and
  mentions, and an exact-comment permalink beneath it. Verify multiline Markdown
  stays inside the quote and the response stays outside. Verify inline findings
  show the retained reviewed diff inside the same quote, with shortened hunks
  labeled as excerpts and historical locations kept distinct from current code.
  Fill the three shared
  slots, queue comments on a busy owner, then verify a released slot admits the
  oldest eligible work without a noisy owner monopolizing the queue. Check verified
  send counts and quiet repeat polls. Hold an ordinary desktop turn active while
  the separate native adapter reports `notLoaded`/`interrupted` without `completedAt`:
  feedback must remain queued without a send or an additional slot until that turn
  has a verified completion timestamp. If a native send races with a new turn and
  arrives as steering, reconcile its exact envelope within that turn; never resend
  or leave an ended, unanswered delivery occupying capacity indefinitely.
  Edit a source or revoke its author before
  publication; retain the private answer and withhold the public reply. Interrupt a
  reply after its provider write and reconcile the same receipt without a duplicate.
  Request the intake report while a reply holds the journal: it must wait within
  the bounded lock policy, then report fresh saved state. If contention outlasts
  that wait and the permitted retries, show a temporary tracking-file warning
  without claiming an identity mismatch or consuming the pending report.
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
  Add a harmless follow-up in the owner chat before recovery: verify the original
  completed feedback receipt still permits the explicitly approved retry. Unfinished,
  missing, or mismatched original receipts and an active owner must remain blocked.
  After an ended feedback turn is blocked, verify the next queued comment on that
  owner can start in the same poll when capacity permits, without retrying an
  uncertain send or exceeding the poll budget. Verify the delivery PR card reports
  feedback as active only after saved schedule readback; disabled or unverified
  intake must not claim active delivery.
  With top-level `debug: true`, check skill and guidance notices after model routing for assessment,
  after the PR card for implementation, and after the public quote and outcome
  for feedback. All distinct cards include their emoji, title, content, and
  notices inside one outer quote; full assessments, plans, and private responses
  remain ordinary document sections. Check routing and instruction cards for
  accidental repeated wrapping. Include default skill selections; skill and guidance file links
  resolve to retained sources, and inline guidance links to its manifest source
  while preserving the literal retained text. With debug false or omitted, hide
  all instruction notices while retaining blockers and publication outcomes.
  Confirm the outgoing quote contains both the “📤 To @recipient” linked heading and every reply line, including the preview.
  Use a temporary Latin-only replacement reply skill to distinguish an English
  private response from its public candidate, then test guidance separately and
  restore the bundled default after the trial.
  Independent reviewer-chat routing requires its separate intake adapter.
- **Continuation:** explicitly request implementation in the issue and verify its
  handoff preserves the assessment and worktree. Later intake must neither inspect
  that implementation nor prevent another eligible issue from starting.
  Preview a human-authorized handoff, let feedback polling and intake reporting run,
  then apply the original digest: those observation updates must not invalidate it.
  A revised assessment, manifest, or native user turn must invalidate the preview.
  Recover a stale preview through the same handoff action and its fresh digest;
  do not return an implemented branch to assessment-context verification.
- **Workflow authority:** the existing assessment schedule must reject implementation,
  review, and publication authority. A separately authorized native pilot must record
  the fresh schedule, native continuation and publication receipts, any approval
  intervention, and recovery before unattended support can be claimed.

Use fresh issues as well as follow-up revisions. Keep detailed pilot plans and results
in the owning issue or pull request, and retire disposable fixtures afterward.

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
# should explain a host permission failure in one heartbeat without accessing tracking state
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
printf '%s\n' '{"automationId":"fixture-native-intake","code":"codex-host-access-required"}' \
  | node "$runtime" intake failure-response --plugin-data "$root/uncreated-failure-data" \
  | jq -e '.status == "failure" and (.response | startswith("<heartbeat>")) and (.response | endswith("</heartbeat>")) and (.response | contains("<decision>NOTIFY</decision>")) and (.response | contains("> ## ⚠️ Codex needs access to its tracking files\n>\n>")) and (.response | contains("> - **Technical detail:**")) and (.response | contains("native host approval")) and (.response | contains("codex-host-access-required"))'
test ! -e "$root/uncreated-failure-data"

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
mkdir -p "$root/notification-workspace"
cp "$GITHUB_WORKSPACE/examples/codex-notifications/notification-policy-agent.yaml" "$root/notification-workspace/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/codex-notifications/assessment-guidance.md" "$root/notification-workspace/assessment-guidance.md"
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
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
mkdir -p "$root/removed-feedback-workspace"
cp "$GITHUB_WORKSPACE/examples/codex-notifications/notification-global-feedback-agent.yaml" "$root/removed-feedback-workspace/agent.yaml"
node "$runtime" binding preview --workspace "$root/removed-feedback-workspace" \
  | jq -e '.manifest.status == "invalid" and any(.manifest.diagnostics[]; .code == "github-notification-global-feedback-removed")'
test ! -d "$CODEX_HOME/automations"

# should expose packaged dispatch without letting intake-only state launch work
root="$TMPDIR/agent-system-codex-notifications"
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

# should accept separate feedback and stage selections while leaving disabled workflows inactive
root="$TMPDIR/agent-system-codex-notifications"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/disabled-notification-data"
mkdir -p "$root/disabled-notification-workspace"
cp "$GITHUB_WORKSPACE/examples/codex-notifications/notification-disabled-agent.yaml" "$root/disabled-notification-workspace/agent.yaml"
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/disabled-notification-workspace" --confirm \
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
sed 's/mode: auto/mode: work/' "$GITHUB_WORKSPACE/examples/codex-notifications/notification-policy-agent.yaml" > "$root/notification-workspace/agent.yaml"
printf '{}\n' | node "$runtime" automations plan --plugin-data "$plugin_data" > "$root/work-plan.json"
jq '{digest:.digest}' "$root/work-plan.json" | node "$runtime" automations threads-sync --plugin-data "$plugin_data" | jq -e '.status == "verified"'
node_executable=$(node -p 'process.execPath')
printf '{}\n' | node "$runtime" automations plan --plugin-data "$plugin_data" \
  | jq -e --arg node "$node_executable" --arg runtime "$runtime" --arg data "$plugin_data" '.actions[0].expected.prompt | contains([$node,$runtime,"continuation","--plugin-data",$data] | tojson)'
test ! -d "$CODEX_HOME/automations"
test ! -d "$CODEX_HOME/rules"
```
