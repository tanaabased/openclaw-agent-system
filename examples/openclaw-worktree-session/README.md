# OpenClaw Worktree Session Example

Enroll disposable SSH keys, prepare a remote managed checkout, execute a native session there, and continue the same session after Gateway restart without losing context or replaying input.

## What Belongs Here

- Authentication/signing key enrollment and reuse, with managed SSH remote selection.
- Canonical workspace guidance, identity, working directory, and exact input receipts across restart.

## What Does Not Belong Here

- Local preparation, dirty reuse, and removal safety: [worktree](../openclaw-worktree/README.md).
- General runtime execution and approvals: [runtimes](../openclaw-runtimes/README.md) and [lifecycle approvals](../openclaw-lifecycle-approvals/README.md).

## Notes

- Strict AIMock drives two turns; GitHub, SSH, the Gateway, and native session execution remain real. Only the generated account keys are removed.
- An explicit session label excludes automatic title generation. The continued turn must retain the original session and execute each input once.

## Setup

```bash
# should enroll disposable ssh keys for the managed remote workspace
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-worktree-session
sed -e "s/__GITHUB_RUN_ID__/$GITHUB_RUN_ID/g" -e "s/__GITHUB_RUN_ATTEMPT__/$GITHUB_RUN_ATTEMPT/g" "$GITHUB_WORKSPACE/examples/openclaw-worktree-session/agent.yaml" > "$TMPDIR/worktree-agent.yaml"
mv "$TMPDIR/worktree-agent.yaml" "$GITHUB_WORKSPACE/examples/openclaw-worktree-session/agent.yaml"
mkdir -p "$GITHUB_WORKSPACE/examples/openclaw-worktree-session/keys" "$HOME/.ssh"
cp "$HOME/.ssh/big-test-bucket-ssh" "$GITHUB_WORKSPACE/examples/openclaw-worktree-session/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$GITHUB_WORKSPACE/examples/openclaw-worktree-session/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"
cd "$GITHUB_WORKSPACE/examples/openclaw-worktree-session"
openclaw agent-system install --yes --json | jq -e '.agentId == "worktree-tanaabot" and (.outcomes | any(.code == "add-github-ssh-keys") and any(.code == "add-github-ssh-signing-keys"))'
```

## Testing

```bash
# should reuse enrolled keys and prepare a remote worktree through managed ssh
cd "$GITHUB_WORKSPACE/examples/openclaw-worktree-session"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.code == "github-ssh-keys-unchanged") and any(.code == "github-ssh-signing-keys-unchanged")'
openclaw agent-system doctor --json | tee "$TMPDIR/openclaw-worktree-doctor.json"
jq -e '.findings | any(.component == "github" and .status == "healthy")' "$TMPDIR/openclaw-worktree-doctor.json"
openclaw agent-system tool worktree -- prepare remote 306-runtime-context HEAD --clone-url https://github.com/tanaabased/big-test-bucket.git | tee "$TMPDIR/worktree-remote.json" | jq -e '.status == "created"'
cd "$(jq -er .path "$TMPDIR/worktree-remote.json")"
openclaw agent-system tool git -- remote get-url origin | grep -Fx git@github.com:tanaabased/big-test-bucket.git

# should execute an ordinary worktree session with canonical agent context and identity
openclaw-gateway start
worktree_path=$(jq -er .path "$TMPDIR/worktree-remote.json")
openclaw gateway call sessions.create --params "$(jq -nc --arg cwd "$worktree_path" '{key:"agent:worktree-tanaabot:dashboard:worktree-leia",agentId:"worktree-tanaabot",label:"Worktree execution fixture",cwd:$cwd}')" --json | tee "$TMPDIR/worktree-session.json" | jq -e '.runStarted == false and (.sessionId | type == "string")'
session_id=$(jq -er .sessionId "$TMPDIR/worktree-session.json")
openclaw gateway call chat.send --params "$(jq -nc --arg id "$session_id" '{sessionKey:"agent:worktree-tanaabot:dashboard:worktree-leia",agentId:"worktree-tanaabot",sessionId:$id,message:"Execute the worktree first probe.",queueMode:"followup",deliver:false,expectedLeafEntryId:null,idempotencyKey:"worktree-first"}')" --json | jq -e '.runId == "worktree-first"'
openclaw gateway call agent.wait --params '{"runId":"worktree-first","timeoutMs":120000}' --timeout 130000 --json | jq -e '.status == "ok"'
grep -Fx verified "$TMPDIR/worktree-first.receipt"
test "$(cat "$TMPDIR/worktree-first.pwd")" = "$worktree_path"

# should continue the same worktree session after restart without replaying its first turn
openclaw-gateway stop --timeout 340
openclaw-gateway start
session_id=$(jq -er .sessionId "$TMPDIR/worktree-session.json")
openclaw gateway call chat.history --params '{"sessionKey":"agent:worktree-tanaabot:dashboard:worktree-leia","limit":1}' --json | tee "$TMPDIR/worktree-history.json" | jq -e --arg id "$session_id" '.sessionId == $id and .sessionInfo.hasActiveRun == false and (.sessionInfo.activeLeafEntryId | type == "string")'
leaf=$(jq -er .sessionInfo.activeLeafEntryId "$TMPDIR/worktree-history.json")
openclaw gateway call chat.send --params "$(jq -nc --arg id "$session_id" --arg leaf "$leaf" '{sessionKey:"agent:worktree-tanaabot:dashboard:worktree-leia",agentId:"worktree-tanaabot",sessionId:$id,message:"Execute the worktree continued probe.",queueMode:"followup",deliver:false,expectedLeafEntryId:$leaf,idempotencyKey:"worktree-continued"}')" --json | jq -e '.runId == "worktree-continued"'
openclaw gateway call agent.wait --params '{"runId":"worktree-continued","timeoutMs":120000}' --timeout 130000 --json | jq -e '.status == "ok"'
grep -Fx verified "$TMPDIR/worktree-continued.receipt"
cmp "$TMPDIR/worktree-first.pwd" "$TMPDIR/worktree-continued.pwd"
cat "$TMPDIR/worktree-probe-invocations"
printf '%s\n' first continued | cmp - "$TMPDIR/worktree-probe-invocations"
openclaw gateway call chat.history --params '{"sessionKey":"agent:worktree-tanaabot:dashboard:worktree-leia","inputRunIds":["worktree-first","worktree-continued"],"limit":200}' --json > "$TMPDIR/worktree-final-history.json"
jq '{sessionId, firstInputs: [.messages[] | select(.role == "user" and .idempotencyKey == "worktree-first:user") | .__openclaw.id], continuedInputs: [.messages[] | select(.role == "user" and .idempotencyKey == "worktree-continued:user") | .__openclaw.id], terminalReplies: [.messages[] | select(.role == "assistant" and .__openclaw.runId == "worktree-continued" and .__openclaw.runTerminal != false and .stopReason == "stop") | .__openclaw.id]}' "$TMPDIR/worktree-final-history.json" | tee "$TMPDIR/worktree-history-proof.json"
jq -e --arg id "$session_id" '.sessionId == $id and (.firstInputs | length) == 1 and (.continuedInputs | length) == 1 and (.terminalReplies | length) == 1 and ([.firstInputs[], .continuedInputs[], .terminalReplies[]] | all(type == "string" and length > 0)) and .firstInputs[0] != .continuedInputs[0]' "$TMPDIR/worktree-history-proof.json"
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | tee "$TMPDIR/worktree-model-evidence.json"
jq -e '.strictMissCount == 0 and .finalResponseCount == 2 and any(.tools[]; .name == "exec" and .callResponseCount == 2)' "$TMPDIR/worktree-model-evidence.json"
```

## Cleanup

```bash
# should remove only the generated account keys
cd "$GITHUB_WORKSPACE/examples/openclaw-worktree-session"
key_material=$(awk '{print $2}' keys/id_ed25519.pub)
for collection in keys ssh_signing_keys; do
  key_id=$(openclaw agent-system tool gh -- api --paginate "/user/$collection" --jq ".[] | select((.key | split(\" \") | index(\"$key_material\")) != null) | .id")
  if test -n "$key_id"; then
    openclaw agent-system tool gh -- api --method DELETE "/user/$collection/$key_id"
  fi
  remaining=$(openclaw agent-system tool gh -- api --paginate "/user/$collection" --jq ".[] | select((.key | split(\" \") | index(\"$key_material\")) != null) | .id")
  test -z "$remaining"
done

# should remove the clean remote worktree
cd "$GITHUB_WORKSPACE/examples/openclaw-worktree-session"
openclaw agent-system tool worktree -- remove remote 306-runtime-context | jq -e '.status == "removed"'

# should stop the isolated gateway and strict provider
openclaw-gateway stop --timeout 340
openclaw-aimock stop
```
