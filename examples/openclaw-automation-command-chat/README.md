# OpenClaw command-to-chat automation

Run a successful command and a failing command into a saved chat in each of
embedded OpenClaw and OpenClaw-hosted Codex, with a mock provider returning
reports through the real Gateway response path.

## What belongs here

- Shared persistent destination creation and reuse by command automations.
- Captured stdout, stderr, and process outcome reaching the formatter request.
- Corresponding durable reports after reconnect, without repeating commands.
- Report-time model selection with an effort different from the agent default.
- Hosted Codex report formatting without an unsupported prompt-hook tool allowlist.

## What does not belong here

- Prompt scheduling: [prompt automation](../openclaw-automation-prompt/README.md).
- Raw command capture and descendant authority: [command automation](../openclaw-automation-command/README.md).
- Restart recovery and later prompt history: [recovery](../openclaw-automation-recovery/README.md).

## Notes

- Strict AIMock supplies both runtimes' provider responses with synthetic credentials and no live fallback. Commands, chat creation, report delivery, and history remain real; no live-model credential is required.
- Hosted Codex uses `gpt-5.5` from its native catalog. After install, capture the agent's catalog before and after provider refresh and require that model to be available through Codex; inference routing to AIMock alone does not establish runtime support.
- The fixture accepts only the expected captured streams and process outcome. Assertions verify the returned message in native history, not prose quality or browser rendering.
- Both runtimes call one script with a mode flag. Each command runs once per runtime. Output-format, empty-output, and timeout permutations remain in source tests.
- This proves report delivery, not model judgment or exhaustive native-tool interception. Source components exercise the blanket blocker and preserve the automation result after blocked attempts.
- Observation deadlines include CLI startup and RPC time.
- Native OpenClaw output hooks omit executed effort. Verify the model in the retained report and high effort in the formatter's exact native run trace; do not substitute requested settings for missing execution telemetry.

## Setup

```bash
# should create one reporting chat per runtime for both command declarations
export OPENAI_API_KEY=agent-system-aimock-test
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --model openai/gpt-5.5
openclaw-aimock prepare --scenario openclaw-automation-command-chat
openclaw config set models.mode merge
openclaw config set memory.search.enabled false --strict-json
openclaw config set plugins.entries.codex.config.codexDynamicToolsLoading direct
openclaw config set plugins.entries.codex.config.appServer.args '["-c","openai_base_url=\"http://127.0.0.1:4010/v1\"","app-server","--listen","stdio://"]' --strict-json
openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess true --strict-json
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
for runtime in openclaw codex; do
  workspace="$GITHUB_WORKSPACE/examples/openclaw-automation-command-chat"
  if test "$runtime" = codex; then workspace="$workspace/codex"; fi
  cd "$workspace"
  openclaw agent-system install --yes --json
  openclaw agent-system automations list --json > "$TMPDIR/chat-jobs-$runtime.json"
  jq -e '([.jobs[].routing] | unique | length) == 1 and all(.jobs[]; .routing | startswith("session:"))' "$TMPDIR/chat-jobs-$runtime.json"
done
for refresh in false true; do
  openclaw gateway call models.list --params "$(jq -nc --argjson refresh "$refresh" '{agentId:"command-chat-codex-tanaabot",provider:"openai",view:"all",refresh:$refresh}')" --json > "$TMPDIR/codex-catalog-$refresh.json"
  jq --arg refresh "$refresh" '{refresh:$refresh,providerOutcomes,models:[.models[] | select(.id == "gpt-5.5" or .id == "gpt-5.4-nano")]}' "$TMPDIR/codex-catalog-$refresh.json"
done
jq -e 'any(.models[]; .provider == "openai" and .id == "gpt-5.5" and .available == true and .agentRuntime.id == "codex")' "$TMPDIR/codex-catalog-true.json"
```

## Testing

```bash
# should retain both mock-formatted reports without rerunning their commands
for runtime in openclaw codex; do
  workspace="$GITHUB_WORKSPACE/examples/openclaw-automation-command-chat"
  model=aimock/gpt-5.5
  if test "$runtime" = codex; then workspace="$workspace/codex"; model=openai/gpt-5.5; fi
  cd "$workspace"
  chat=$(jq -er '.jobs[0].routing | sub("^session:"; "")' "$TMPDIR/chat-jobs-$runtime.json")
  for mode in success failure; do
    expected=ok
    reason='Exit 0'
    if test "$mode" = failure; then expected=error; reason='Exit 17'; fi
    run_id=$(openclaw agent-system automations run "$mode" --json | jq -er 'select(.status == "queued") | .runId')
    node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" "$mode" "$run_id" "$expected"
    deadline=$((SECONDS + 180))
    while test "$SECONDS" -lt "$deadline"; do
      remaining=$((deadline - SECONDS))
      test "$remaining" -gt 0 || break
      timeout --signal=TERM --kill-after=5 "$remaining" openclaw agent-system automations runs "$mode" --json > "$TMPDIR/report-$runtime-$mode.json"
      if jq -e 'any(.reports[]; .status == "delivered" or .status == "failed" or .status == "uncertain")' "$TMPDIR/report-$runtime-$mode.json" >/dev/null; then break; fi
      sleep 2
    done
    if ! jq -e --arg reason "$reason" --arg model "$model" '.reports | length == 1 and all(.[]; .status == "delivered" and .reason == $reason and (.messageId | type == "string") and .requested == {model:$model,effort:"high"} and .effective.model == .requested.model and (.effective.effort == null or .effective.effort == "high"))' "$TMPDIR/report-$runtime-$mode.json"; then
      jq '{id,reports}' "$TMPDIR/report-$runtime-$mode.json"
      exit 1
    fi
    report_id=$(jq -er '.reports[0].executionId' "$TMPDIR/report-$runtime-$mode.json")
    if test "$runtime" = openclaw; then
      grep -F 'embedded run start:' "$(openclaw-gateway log-path)" | grep -F "runId=$report_id " | grep -F 'provider=aimock model=gpt-5.5 thinking=high '
    fi
    message_id=$(jq -er '.reports[0].messageId' "$TMPDIR/report-$runtime-$mode.json")
    openclaw gateway call chat.history --params "$(jq -nc --arg key "$chat" '{sessionKey:$key,limit:100,maxChars:100000}')" --json > "$TMPDIR/chat-history.json"
    jq -er --arg id "$message_id" '.messages[] | select(.__openclaw.id == $id and .role == "assistant") | [.content[]? | select(.type == "text") | .text] | join("\n")' "$TMPDIR/chat-history.json" > "$TMPDIR/card-$runtime-$mode.md"
    cat "$TMPDIR/card-$runtime-$mode.md"
    grep -F '> ##' "$TMPDIR/card-$runtime-$mode.md"
    grep -F "$reason" "$TMPDIR/card-$runtime-$mode.md"
  done
  grep -Fi alpha "$TMPDIR/card-$runtime-success.md"
  grep -Fi delta "$TMPDIR/card-$runtime-failure.md"
  grep -F '❌' "$TMPDIR/card-$runtime-failure.md"
  test "$(wc -l < command.runs | tr -d ' ')" = 2
done
openclaw-aimock evidence --scenario openclaw-automation-command-chat --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-automation-command-chat/expected-evidence.json"

# should retain the same report messages through a fresh history connection
for runtime in openclaw codex; do
  chat=$(jq -er '.jobs[0].routing | sub("^session:"; "")' "$TMPDIR/chat-jobs-$runtime.json")
  openclaw gateway call chat.history --params "$(jq -nc --arg key "$chat" '{sessionKey:$key,limit:100,maxChars:100000}')" --json > "$TMPDIR/chat-reconnected.json"
  for mode in success failure; do
    message_id=$(jq -er '.reports[0].messageId' "$TMPDIR/report-$runtime-$mode.json")
    jq -e --arg id "$message_id" 'any(.messages[]; .__openclaw.id == $id and .role == "assistant")' "$TMPDIR/chat-reconnected.json"
  done
done
```
