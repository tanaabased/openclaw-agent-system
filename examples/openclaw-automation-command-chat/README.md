# OpenClaw command-to-chat automation

Run four output cases into one saved chat and inspect the real model's reports:
Markdown, JSON, plain text, and failure with misleading success output.

## What belongs here

- Shared persistent destination creation and reuse by command automations.
- Four real formatter turns using captured stdout, stderr, and process outcome.
- Corresponding durable reports after reconnect, without repeating commands.

## What does not belong here

- Prompt scheduling: [prompt automation](../openclaw-automation-prompt/README.md).
- Raw command capture and descendant authority: [command automation](../openclaw-automation-command/README.md).
- Restart recovery and later prompt history: [recovery](../openclaw-automation-recovery/README.md).

## Notes

- Uses the CI `OPENAI_API_KEY` secret and a small live model because formatting interpretation is the behavior under test. It does not use AIMock.
- Assertions require the original run identity, process outcome, a quoted report, and the relevant archive name—not exact wording or layout. Native history does not prove browser rendering.
- All declarations call one script with a mode flag. Install runs once; each command runs once. Empty-output and timeout permutations remain in source tests.
- Assistant text is printed for human review. Observation deadlines include CLI startup and RPC time.

## Setup

```bash
# should create one shared reporting chat for all four command declarations
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service --model openai/gpt-5.4-nano
openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess true --strict-json
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-command-chat"
openclaw agent-system install --yes --json
openclaw agent-system automations list --json > "$TMPDIR/chat-jobs.json"
jq -e '([.jobs[].routing] | unique | length) == 1 and all(.jobs[]; .routing | startswith("session:"))' "$TMPDIR/chat-jobs.json"
```

## Testing

```bash
# should retain four truthful model-formatted reports without rerunning their commands
cd "$GITHUB_WORKSPACE/examples/openclaw-automation-command-chat"
chat=$(jq -er '.jobs[0].routing | sub("^session:"; "")' "$TMPDIR/chat-jobs.json")
for mode in markdown json text failure; do
  expected=ok
  reason='Exit 0'
  if test "$mode" = failure; then expected=error; reason='Exit 17'; fi
  run_id=$(openclaw agent-system automations run "$mode" --json | jq -er 'select(.status == "queued") | .runId')
  node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" "$mode" "$run_id" "$expected"
  deadline=$((SECONDS + 180))
  while test "$SECONDS" -lt "$deadline"; do
    remaining=$((deadline - SECONDS))
    test "$remaining" -gt 0 || break
    timeout --signal=TERM --kill-after=5 "$remaining" openclaw agent-system automations runs "$mode" --json > "$TMPDIR/report-$mode.json"
    if jq -e 'any(.reports[]; .status == "delivered" or .status == "failed" or .status == "uncertain")' "$TMPDIR/report-$mode.json" >/dev/null; then break; fi
    sleep 2
  done
  jq -e --arg reason "$reason" '.reports | length == 1 and all(.[]; .status == "delivered" and .reason == $reason and (.messageId | type == "string"))' "$TMPDIR/report-$mode.json"
  message_id=$(jq -er '.reports[0].messageId' "$TMPDIR/report-$mode.json")
  openclaw gateway call chat.history --params "$(jq -nc --arg key "$chat" '{sessionKey:$key,limit:100,maxChars:100000}')" --json > "$TMPDIR/chat-history.json"
  jq -er --arg id "$message_id" '.messages[] | select(.__openclaw.id == $id and .role == "assistant") | [.content[]? | select(.type == "text") | .text] | join("\n")' "$TMPDIR/chat-history.json" > "$TMPDIR/card-$mode.md"
  cat "$TMPDIR/card-$mode.md"
  grep -F '> ##' "$TMPDIR/card-$mode.md"
  grep -F "$reason" "$TMPDIR/card-$mode.md"
done
grep -Fi alpha "$TMPDIR/card-markdown.md"
grep -Fi bravo "$TMPDIR/card-json.md"
grep -Fi charlie "$TMPDIR/card-text.md"
grep -Fi delta "$TMPDIR/card-failure.md"
grep -F '❌' "$TMPDIR/card-failure.md"
test "$(wc -l < command.runs | tr -d ' ')" = 4

# should retain the same report messages through a fresh history connection
chat=$(jq -er '.jobs[0].routing | sub("^session:"; "")' "$TMPDIR/chat-jobs.json")
openclaw gateway call chat.history --params "$(jq -nc --arg key "$chat" '{sessionKey:$key,limit:100,maxChars:100000}')" --json > "$TMPDIR/chat-reconnected.json"
for mode in markdown json text failure; do
  message_id=$(jq -er '.reports[0].messageId' "$TMPDIR/report-$mode.json")
  jq -e --arg id "$message_id" 'any(.messages[]; .__openclaw.id == $id and .role == "assistant")' "$TMPDIR/chat-reconnected.json"
done
```
