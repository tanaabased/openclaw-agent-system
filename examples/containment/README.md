# Agent Command Containment Example

This scenario runs the prepared Agent System package in the default Gateway with two explicitly installed agents. It verifies that a repository helper can use a managed shim with the active identity but cannot switch identity by changing into another agent workspace. Both native OpenClaw and Codex descendants must reject one unattended operator install through the `openclaw as` alias. Unit tests cover the other install, Doctor, and status forms.

The live model exercises native command execution in both runtimes; assertions depend on filesystem evidence rather than final wording. This scenario tests the OpenClaw [development target](../../README.md#version-compatibility).

## Setup

```bash
# should configure the default profile with the ci model
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --model "openai/$OPENAI_MODEL" \
  --yolo

# should install both scenario-owned workspaces through agent system
cd "$GITHUB_WORKSPACE/examples/containment/tanaabot"
openclaw agent-system install --skip-setup
cd "$GITHUB_WORKSPACE/examples/containment/emori"
openclaw agent-system install --skip-setup

# should route tanaabot through codex and emori through native openclaw
openclaw config set skills.workshop.autonomous.mode off
openclaw config set 'agents.entries.tanaabot.model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.entries.tanaabot.models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"codex\"}}}" --strict-json
openclaw config set 'agents.entries.emori.model' "openai/$OPENAI_MODEL"
openclaw config set 'agents.entries.emori.models' "{\"openai/$OPENAI_MODEL\":{\"agentRuntime\":{\"id\":\"openclaw\"}}}" --strict-json

# should start the default gateway as a supervised background process
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
```

## Testing

The ordinary-session check keeps canonical agent guidance and managed tool identity
separate from the issue worktree's execution directory. The synthetic marker checks
first-turn guidance delivery without allowing the agent to read missing guidance
as a repair. This is a CI-only live-runtime contract, not a local validation command.
The same first turn uses the public `chat.send` route used by dispatch. Exact input
custody and transcript run ownership must survive a Gateway restart; these checks
do not replace the dispatch journal's unit coverage or prove the full assessment workflow.

```bash
# should prepare one owned worktree and create an ordinary worktree-bound conversation
cd "$GITHUB_WORKSPACE/examples/containment/tanaabot"
openclaw agent-system tool worktree -- prepare agent-system workspace-context origin/main --clone-url https://github.com/tanaabased/openclaw-agent-system.git > "$TMPDIR/containment-worktree.json"
worktree_path=$(jq -er '.path' "$TMPDIR/containment-worktree.json")
openclaw gateway call sessions.create --params "$(jq -nc --arg cwd "$worktree_path" '{key:"agent:tanaabot:dashboard:worktree-context-leia",agentId:"tanaabot",cwd:$cwd}')" --json | jq -er 'select(.runStarted == false) | .sessionId' > "$TMPDIR/containment-session-id"

# should confirm the created incarnation has empty idle current history before its first turn
session_id=$(cat "$TMPDIR/containment-session-id")
openclaw gateway call chat.history --params '{"sessionKey":"agent:tanaabot:dashboard:worktree-context-leia","limit":1}' --json | jq -e --arg id "$session_id" '.sessionId == $id and .sessionInfo.hasActiveRun == false and (.messages | length) == 0'

# should expose the shared assessment skill in the ordinary session's native catalog
openclaw gateway call skills.status --params '{"agentId":"tanaabot","sessionKey":"agent:tanaabot:dashboard:worktree-context-leia"}' --json | jq -e 'any(.skills[]; .name == "agent-system-issue-assessment" and .eligible == true and .modelVisible == true and .disabled != true and (.filePath | endswith("/SKILL.md")))'

# should accept one first turn in the exact empty session incarnation
session_id=$(cat "$TMPDIR/containment-session-id")
openclaw gateway call chat.send --params "$(jq -nc --arg id "$session_id" --rawfile message "$GITHUB_WORKSPACE/examples/containment/worktree-context.md" '{sessionKey:"agent:tanaabot:dashboard:worktree-context-leia",agentId:"tanaabot",sessionId:$id,message:$message,queueMode:"followup",deliver:false,expectedLeafEntryId:null,idempotencyKey:"containment-worktree-first-turn"}')" --json | jq -e '.runId == "containment-worktree-first-turn" and (.status == "started" or .status == "queued" or .status == "ok")'

# should retain canonical guidance and native identity while executing in the worktree
openclaw gateway call agent.wait --params '{"runId":"containment-worktree-first-turn","timeoutMs":600000}' --timeout 620000 --json | jq -e '.runId == "containment-worktree-first-turn" and .status == "ok"'
grep -Fx canonical-tanaabot-worktree-context "$TMPDIR/agent-system-worktree-guidance.txt"
worktree_path=$(jq -er '.path' "$TMPDIR/containment-worktree.json")
grep -Fx "$worktree_path" "$TMPDIR/agent-system-worktree-pwd.txt"
grep -Fx "$worktree_path" "$TMPDIR/agent-system-worktree-git.txt"
grep -F tanaabot-containment@example.invalid "$TMPDIR/agent-system-worktree-identity.txt"

# should expose a stable transcript leaf before an assessment continuation
openclaw gateway call chat.history --params '{"sessionKey":"agent:tanaabot:dashboard:worktree-context-leia","limit":1}' --json | jq -e '.sessionInfo.hasActiveRun == false and .pendingInputs.total == 0 and (.sessionInfo.activeLeafEntryId | type == "string" and length > 0) and (.messages | length) == 1 and .messages[0].role == "assistant"'

# should retain exact first-turn custody and reply ownership across a gateway restart
openclaw-gateway stop
OPENCLAW_LOG_LEVEL=debug openclaw-gateway start
session_id=$(cat "$TMPDIR/containment-session-id")
openclaw gateway call chat.history --params '{"sessionKey":"agent:tanaabot:dashboard:worktree-context-leia","inputRunIds":["containment-worktree-first-turn"],"limit":200,"maxChars":100000}' --json | jq -e --arg id "$session_id" --rawfile message "$GITHUB_WORKSPACE/examples/containment/worktree-context.md" '
  def input_text: if (.content | type) == "string" then .content else [.content[] | select(.type == "text") | .text] | join("") end;
  .sessionId == $id and .sessionInfo.hasActiveRun == false and
  ([.messages[] | select(.role == "user" and .__openclaw.runId == "containment-worktree-first-turn" and
    (.__openclaw.idempotencyKey // .idempotencyKey) == "containment-worktree-first-turn:user" and
    (.__openclaw.id | length) > 0 and .__openclaw.truncated != true and input_text == $message)] | length) == 1 and
  any(.messages[]; .role == "assistant" and .__openclaw.runId == "containment-worktree-first-turn" and
    (.__openclaw.id | length) > 0 and .__openclaw.truncated != true and .stopReason == "stop" and
    (.__openclaw.mirrorOrigin == null or .__openclaw.runTerminal == true))'
```

```bash
# should bind helper shims to tanaabot and prevent a cwd switch to emori
if ! openclaw agent \
  --agent tanaabot \
  --session-key agent:tanaabot:agent-system-containment-leia \
  --message-file "$GITHUB_WORKSPACE/examples/containment/cross-agent.md" \
  --timeout 600; then
  openclaw gateway call chat.history \
    --params '{"sessionKey":"agent:tanaabot:agent-system-containment-leia","limit":10,"maxBytes":32768}' \
    --json | jq '{messages: [.messages[] | select(.role == "assistant" or .role == "toolResult")]}'
  exit 1
fi
grep -F 'tanaabot-containment@example.invalid' "$TMPDIR/agent-system-active-agent-result.txt"
test ! -e "$TMPDIR/agent-system-cross-agent-result.txt"
grep -Fx verified "$TMPDIR/agent-system-cross-agent-denied.txt"
grep -Fx verified "$TMPDIR/agent-system-setup-boundary-codex.txt"
test ! -e "$TMPDIR/agent-system-forbidden-setup"
test ! -e "$TMPDIR/agent-system-doctor-check"

# should reject operator setup commands from a native openclaw descendant
openclaw agent \
  --agent emori \
  --session-key agent:emori:agent-system-setup-containment-leia \
  --message-file "$GITHUB_WORKSPACE/examples/containment/setup-native.md" \
  --timeout 600
grep -Fx verified "$TMPDIR/agent-system-setup-boundary-native.txt"
test ! -e "$TMPDIR/agent-system-forbidden-setup"
```

## Cleanup

```bash
# should remove the bounded workspace-context fixture
cd "$GITHUB_WORKSPACE/examples/containment/tanaabot"
openclaw agent-system tool worktree -- remove agent-system workspace-context | jq -e '.status == "removed"'

# should stop the background gateway cleanly
if ! openclaw-gateway stop; then
  grep -E '\[gateway\].*(signal SIG|received SIG|drain|shutdown|server close)' "$(openclaw-gateway log-path)" | tail -n 30
  exit 1
fi
```
