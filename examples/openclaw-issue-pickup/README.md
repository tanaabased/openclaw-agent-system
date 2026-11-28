# OpenClaw Issue Pickup Example

Run an activated pickup scan, select one disposable issue, and let ordinary issue
assignment create its managed chat and checkout with Work mode. Both native
OpenClaw and OpenClaw-hosted Codex first read paged fixture guidance and explicitly
select nothing, then verify their window allows no second assignment.

## What Belongs Here

- Native pickup enrollment with closed milestone scope, read-only Doctor inspection, and scheduled execution after that milestone reopens through each runtime.
- Selection triggered by a due-time occurrence, including native paging before explicitly declining assignment. Verify assignment and exhausted-window outcomes through the real automation/tool boundary.
- Namespace discovery restricted by routing to the disposable repository, with model selection from a repository-qualified milestone list and the default `only` policy, GitHub self-assignment despite the ordinary assigner policy, and ordinary intake receiving the pickup exception and Work mode.
- A repeat scan preserving the single assignment, chat, and checkout.

## What Does Not Belong Here

- Implementation and PR delivery: [Work](../openclaw-issue-work-custom/README.md).
- Assignment concurrency and recovery: [intake](../openclaw-issue-intake/README.md) and [assignment policy](../openclaw-issue-assignment-policy/README.md).
- Standalone Codex desktop scheduling and chat creation: the native acceptance checks in [Codex notifications](../codex-notifications/README.md). Hosted Codex uses OpenClaw's scheduler and dispatch owner.
- Pagination failure permutations, uncertain writes, and policy permutations remain in unit/component coverage.

## Notes

- Strict AIMock supplies the selection and assessment. Scheduler authority, GitHub reads/writes, intake, chat creation, and checkout creation remain real. Hosted Codex keeps its native searchable-tool default. AIMock declines Responses WebSocket upgrades so Codex falls back to HTTP with full request history. This does not prove model judgment, long-running unattended reliability, or desktop rendering.
- Closed-scope enrollment adds two provider updates and one Doctor inspection per execution path, without another install, restart, or model turn. It catches installation rejection at the real runtime boundary before the existing scheduled assignment.
- Each execution path gets its own disposable milestone, two issues, agent workspace, and native job. The exhausted-window check runs on demand. Selection waits for the installed daily schedule, moved through the manifest to a slot two to three minutes ahead; it never substitutes a forced run if that occurrence fails. This adds up to three minutes of scheduler waiting per runtime.
- Each runtime adds one in-window run without another install, restart, or scheduled wait. Its first run reads all guidance pages, submits no issue, and checks both candidates stay unassigned. Removing its fixture-body marker enables ordinary assignment.
- Debug logs correlate native cron initialization, pickup lookup, and cleanup with hashed identities.
- Ordinary assignments permit EMORI, not Tanaabot, and default to Plan. The selected issue asks a clarification question: the assessment asserts Work mode, retains the question, and stops before implementation or publication.
- Only Tanaabot receives fixture assignments. Refresh is scoped to the selected issue. Cleanup stops the Gateway before closing issues and deleting milestones; the shared workflow cleanup owns SSH registrations.

## Setup

```bash
# should prepare both hosted execution paths with strict model responses
set -euo pipefail
export OPENAI_API_KEY=agent-system-aimock-test
export NODE_OPTIONS="--import=$GITHUB_WORKSPACE/examples/openclaw-issue-pickup/catalog-fixture.mjs"
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --needs-ssh-key --model openai/gpt-5.4-nano --yolo
openclaw-aimock prepare --scenario openclaw-issue-pickup
openclaw config set models.mode merge
openclaw config set memory.search.enabled false --strict-json
openclaw config set skills.workshop.autonomous.mode off
openclaw config set plugins.entries.memory-core.config.dreaming.enabled false --strict-json
openclaw config set plugins.entries.codex.config.appServer.args '["-c","openai_base_url=\"http://127.0.0.1:4010/v1\"","app-server","--listen","stdio://"]' --strict-json
mkdir -p "$HOME/.ssh"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
```

## Testing

```bash
# should hand one pickup assignment to ordinary work intake through each runtime
set -euo pipefail
runtime=setup
stage=verify-fixture-actor
pickup_failure() {
  status=$?
  if test "$status" -ne 0; then
    set +e
    printf 'pickup failure: runtime=%s stage=%s exit=%s\n' "$runtime" "$stage" "$status" >&2
    redactor="$(dirname "$(command -v openclaw-gateway)")/lib/redact-stream.mjs"
    if test "$stage" = install-pickup || test "$stage" = install-pickup-schedule; then
      printf 'gateway at Install failure (%s UTC):\n' "$(date -u +%FT%T)" >&2
      gateway_log=$(openclaw-gateway log-path)
      if test -r "$gateway_log"; then
        tail -n 300 "$gateway_log" | grep -Ei 'reload|restart|drain|shut.?down|cron[./]|database resources|unavailable|baseline' | node "$redactor" | tail -n 40 | tail -c 8192 >&2
      fi
      if ! openclaw-fixture-gateway cron.status --json 2> "$TMPDIR/pickup-cron-status.stderr" | jq -ce 'if .ok == false then {type: .error.type, code: .error.code, kind: .error.kind, retryable: .error.retryable} | error("cron.status: " + tojson) else {enabled, jobs, nextWakeAtMs} end' >&2; then
        printf 'cron.status unavailable after Install failure\n' >&2
        node "$redactor" < "$TMPDIR/pickup-cron-status.stderr" | tail -c 2048 >&2
      fi
      printf 'pickup job readback after Install failure:\n' >&2
      if ! openclaw gateway call cron.list --params '{"includeDisabled":true,"includeDeliveryPreviews":false,"limit":200}' --timeout 5000 --json 2> "$TMPDIR/pickup-cron-list.stderr" | jq -ce --arg agent "pickup-$runtime-tanaabot" '{hasMore, total, matches: [.jobs[] | select(.agentId == $agent and ((.declarationKey // "") | endswith(":github-issue-pickup"))) | {id, enabled, configRevision}]}' >&2; then
        printf 'pickup job readback unavailable\n' >&2
        node "$redactor" < "$TMPDIR/pickup-cron-list.stderr" | tail -c 2048 >&2
      fi
    fi
    printf 'pickup mock server errors:\n' >&2
    tail -n 120 "$TMPDIR/openclaw-aimock.log" | node "$redactor" | tail -c 16384 >&2
    printf '\npickup mock request diagnostics:\n' >&2
    curl --max-time 10 --silent --show-error http://127.0.0.1:4010/proof/diagnostics | node "$redactor" >&2
    if test -s "$TMPDIR/pickup-$runtime-before.json"; then
      conversation=$(jq -er .threadId "$TMPDIR/pickup-$runtime-before.json")
      printf '\npickup assessment tool results:\n' >&2
      openclaw-fixture-gateway chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:40}')" --json | jq '[.messages[] | select(.role == "toolResult" or .role == "tool") | {role,toolName,toolCallId,isError,content:(.content | tostring | .[0:8192])}] | .[-4:]' | node "$redactor" >&2
    fi
  fi
  exit "$status"
}
trap pickup_failure EXIT
actor_node=$(GH_TOKEN="$GH_TOKEN_EMORI" gh api user --jq 'select(.login == "emoriwan") | .node_id')
for runtime in codex openclaw; do
  cd "$GITHUB_WORKSPACE/examples/openclaw-issue-pickup/$runtime"
  stage=create-milestone
  milestone=$(GH_TOKEN="$GH_TOKEN_TANAABOT" gh api --method POST repos/tanaabased/big-test-bucket/milestones -f title="agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-pickup-$runtime" --jq .number)
  printf '%s\n' "$milestone" > "$TMPDIR/pickup-$runtime-milestone"
  stage=prepare-workspace
  paging_fixture=$(printf '%18000s' '' | tr ' ' x)
  sed -e "s|__PAGING_FIXTURE__|$paging_fixture|g" -e "s|__ACTOR_NODE_ID__|$actor_node|g" -e "s|__MILESTONE_NUMBER__|$milestone|g" -e "s|__GITHUB_REPOSITORY_ID__|$GITHUB_REPOSITORY_ID|g" -e "s|__GITHUB_RUN_ID__|$GITHUB_RUN_ID|g" -e "s|__GITHUB_RUN_ATTEMPT__|$GITHUB_RUN_ATTEMPT|g" agent.yaml > "$TMPDIR/pickup-agent.yaml"
  mv "$TMPDIR/pickup-agent.yaml" agent.yaml
  mkdir -p keys
  cp "$HOME/.ssh/big-test-bucket-ssh" keys/id_ed25519
  cp "$HOME/.ssh/big-test-bucket-ssh.pub" keys/id_ed25519.pub
  stage=close-installation-scope
  GH_TOKEN="$GH_TOKEN_TANAABOT" gh api --method PATCH "repos/tanaabased/big-test-bucket/milestones/$milestone" -f state=closed > /dev/null
  stage=install-pickup
  openclaw agent-system install --yes --json > "$TMPDIR/pickup-$runtime-install.json"
  jq -e 'any(.outcomes[]; .stepId == "github-issue-pickup" and .status == "created")' "$TMPDIR/pickup-$runtime-install.json"
  stage=inspect-closed-scope
  openclaw agent-system doctor --json | jq -e 'any(.findings[]; .code == "issue-pickup-ready" and .status == "healthy")'
  stage=reopen-scheduled-scope
  GH_TOKEN="$GH_TOKEN_TANAABOT" gh api --method PATCH "repos/tanaabased/big-test-bucket/milestones/$milestone" -f state=open > /dev/null
  stage=verify-pickup-install
  openclaw agent-system notifications wait --for baseline-ready --timeout 30 --json | jq -e '.status == "completed"'
  openclaw agent-system automations list --json | tee "$TMPDIR/pickup-$runtime-jobs.json"
  jq -e '.jobs | type == "array"' "$TMPDIR/pickup-$runtime-jobs.json"
  native=$(jq -er '.jobs[] | select(.id == "github-issue-pickup" and .nativeEnabled == true) | .nativeId' "$TMPDIR/pickup-$runtime-jobs.json")
  chat=$(jq -er '.jobs[] | select(.id == "github-issue-pickup") | .routing | select(startswith("session:"))' "$TMPDIR/pickup-$runtime-jobs.json")
  stage=create-redesign-fixture
  redesign_body='Disposable pickup fixture: redesign the entire cleanup system.'
  initial_body="$redesign_body pickup-paging-no-assignment"
  GH_TOKEN="$GH_TOKEN_TANAABOT" gh api --method POST repos/tanaabased/big-test-bucket/issues -f "title=agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-pickup-$runtime-redesign" -f "body=$initial_body" -F milestone="$milestone" > "$TMPDIR/pickup-$runtime-other.json"
  stage=create-cleanup-fixture
  GH_TOKEN="$GH_TOKEN_TANAABOT" gh api --method POST repos/tanaabased/big-test-bucket/issues -f "title=agent-system-test-$GITHUB_REPOSITORY_ID-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-pickup-$runtime-cleanup" -f 'body=Disposable pickup-cleanup-clarification fixture: document closing test issues, but first clarify whether cleanup happens after evidence capture.' -F milestone="$milestone" > "$TMPDIR/pickup-$runtime-selected.json"
  stage=prepare-pickup-schedule
  due=$(node -e 'process.stdout.write(String(Math.ceil((Date.now() + 120000) / 60000) * 60000))')
  start=$(node -e 'process.stdout.write(new Date(Number(process.argv[1])).toTimeString().slice(0, 5))' "$due")
  sed "s/start: '00:00'/start: '$start'/" agent.yaml > "$TMPDIR/pickup-$runtime-scheduled.yaml"
  mv "$TMPDIR/pickup-$runtime-scheduled.yaml" agent.yaml
  stage=install-pickup-schedule
  openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .stepId == "github-issue-pickup" and .status == "updated")'
  stage=verify-pickup-schedule
  openclaw agent-system automations list --json | jq -e --arg id "$native" --arg chat "$chat" 'any(.jobs[]; .id == "github-issue-pickup" and .nativeId == $id and .routing == $chat and .nativeEnabled == true)'
  stage=await-scheduled-pickup
  node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" --scheduled-after github-issue-pickup "$native" "$due" > "$TMPDIR/pickup-$runtime-scheduled.json"
  stage=verify-scheduled-pickup-report
  jq -e 'if (.summary | contains("2 eligible")) then true else error("scheduled pickup report mismatch: " + tojson) end' "$TMPDIR/pickup-$runtime-scheduled.json"
  number=$(jq -er .number "$TMPDIR/pickup-$runtime-selected.json")
  other=$(jq -er .number "$TMPDIR/pickup-$runtime-other.json")
  stage=verify-paged-selection-without-assignment
  jq -e '.summary | contains("Paging fixture read all material; no issue selected.")' "$TMPDIR/pickup-$runtime-scheduled.json"
  for issue in "$number" "$other"; do
    GH_TOKEN="$GH_TOKEN_TANAABOT" gh api "repos/tanaabased/big-test-bucket/issues/$issue" | jq -e '.assignees | length == 0'
  done
  GH_TOKEN="$GH_TOKEN_TANAABOT" gh api --method PATCH "repos/tanaabased/big-test-bucket/issues/$other" -f "body=$redesign_body" > /dev/null
  stage=run-in-window-assignment
  run_id=$(openclaw agent-system automations run github-issue-pickup --json | jq -er 'select(.status == "queued") | .runId | strings')
  node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" github-issue-pickup "$run_id"
  stage=verify-assignment-and-native-assessment
  GH_TOKEN="$GH_TOKEN_TANAABOT" gh api "repos/tanaabased/big-test-bucket/issues/$number" | jq -e '.assignees | length == 1 and .[0].login == "tanaabot"'
  run_id=$(node --import tsx "$GITHUB_WORKSPACE/scripts/refresh-notifications.ts" --repository tanaabased/big-test-bucket --kind issue --number "$number")
  node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
  openclaw agent-system notifications wait --repository tanaabased/big-test-bucket --kind issue --number "$number" --for worktree-ready --refresh --timeout 600 --json | jq -e '.status == "completed"'
  node "$GITHUB_WORKSPACE/scripts/sqlite-example-state.mjs" dispatch | jq -es --arg issue "$(jq -er .node_id "$TMPDIR/pickup-$runtime-selected.json")" '[.[].records[] | select(.projectWork.pickup.issueNodeId == $issue)] | if length == 1 then .[0] else error("one pickup intake owner required") end' > "$TMPDIR/pickup-$runtime-before.json"
  run_id=$(jq -er '(.nativeTurns | map(select(.role == "assessment")) | last | .turn).runId' "$TMPDIR/pickup-$runtime-before.json")
  node --import tsx "$GITHUB_WORKSPACE/scripts/wait-for-agent-run.ts" "$run_id" 600000
  node "$GITHUB_WORKSPACE/scripts/sqlite-example-state.mjs" dispatch | jq -es --arg issue "$(jq -er .node_id "$TMPDIR/pickup-$runtime-selected.json")" '[.[].records[] | select(.projectWork.pickup.issueNodeId == $issue)] | if length == 1 then .[0] else error("one pickup intake owner required") end' > "$TMPDIR/pickup-$runtime-before.json"
  jq -e '.sessionCreation.verified == true and (.threadId | length > 0) and (.worktree | length > 0) and .delivery == null' "$TMPDIR/pickup-$runtime-before.json"
  conversation=$(jq -er .threadId "$TMPDIR/pickup-$runtime-before.json")
  openclaw-fixture-gateway chat.history --params "$(jq -nc --arg key "$conversation" '{sessionKey:$key,limit:200}')" --json | jq -e 'any(.messages[]; .role == "assistant" and ((.content | if type == "string" then . else map(.text // "") | join("") end) | contains("Should disposable issues close after evidence capture?")))'
  openclaw agent-system tool worktree -- list | jq -e --arg path "$(jq -er .worktree "$TMPDIR/pickup-$runtime-before.json")" '[.[] | select(.path == $path)] | length == 1'
  run_id=$(openclaw agent-system automations run github-issue-pickup --json | jq -er 'select(.status == "queued") | .runId | strings')
  node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" github-issue-pickup "$run_id"
  openclaw-fixture-gateway cron.runs --params "$(jq -nc --arg id "$native" --arg run "$run_id" '{id:$id,runId:$run,limit:1,offset:0}')" --json | jq -e --arg run "$run_id" 'any(.entries[]; .runId == $run and .status == "ok" and (.summary | contains("1 of 1 assigned")))'
  stage=verify-pickup-budget-and-evidence
  GH_TOKEN="$GH_TOKEN_TANAABOT" gh api "repos/tanaabased/big-test-bucket/issues/$other" | jq -e '.assignees | length == 0'
  node "$GITHUB_WORKSPACE/scripts/sqlite-example-state.mjs" dispatch | jq -es --slurpfile before "$TMPDIR/pickup-$runtime-before.json" '[.[].records[] | select(.projectWork.pickup.issueNodeId == $before[0].projectWork.pickup.issueNodeId)] | length == 1 and .[0].threadId == $before[0].threadId and .[0].worktree == $before[0].worktree and (.[0] | .nativeTurns | map(select(.role == "assessment")) | last | .turn).runId == ($before[0] | .nativeTurns | map(select(.role == "assessment")) | last | .turn).runId and .[0].result == $before[0].result and .[0].delivery == null'
  curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e 'if .scenario == "openclaw-issue-pickup" and .strictMissCount == 0 and any(.tools[]; .name == "agent_system_intake" and .callResponseCount > 0 and .resultRequestCount > 0) and any(.tools[]; .name == "agent_system_dispatch" and .resultRequestCount > 0) then . else error("pickup provider evidence incomplete: " + tojson) end'
done
```

## Cleanup

```bash
# should quiesce native work before disposing of the github fixtures
set -euo pipefail
openclaw-gateway stop --timeout 340
for runtime in openclaw codex; do
  for kind in selected other; do
    saved="$TMPDIR/pickup-$runtime-$kind.json"
    if test -s "$saved"; then
      number=$(jq -er .number "$saved")
      GH_TOKEN="$GH_TOKEN_TANAABOT" gh api --method PATCH "repos/tanaabased/big-test-bucket/issues/$number" -f state=closed > /dev/null
    fi
  done
  saved="$TMPDIR/pickup-$runtime-milestone"
  if test -s "$saved"; then
    milestone=$(cat "$saved")
    GH_TOKEN="$GH_TOKEN_TANAABOT" gh api --method DELETE "repos/tanaabased/big-test-bucket/milestones/$milestone"
  fi
done
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/diagnostics
```
