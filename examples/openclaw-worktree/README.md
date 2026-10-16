# OpenClaw Worktree Example

Verify the installed managed worktree lifecycle against a disposable local repository: prepare, reuse without losing edits, execute Git with the owning agent identity, and remove safely. Public Agent System commands own preparation and removal; both the public Git command and the packaged contextual shim must discover the agent from inside the worktree.

Ubuntu coverage also provisions disposable GitHub authentication/signing keys, prepares a remote SSH worktree, and runs an ordinary native agent session there. Strict AIMock requires canonical workspace guidance before issuing either real execution call. An explicit session label keeps automatic model-generated titles outside this execution contract. A continuation after Gateway restart must retain its session, working directory, and Git identity. CI supplies only the existing Tanaabot token; generated public keys are removed after the test.

## Setup

```bash
# should install a disposable agent with a declared local repository
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-ssh-key --yolo
openclaw-aimock prepare --scenario openclaw-worktree
mkdir -p "$TMPDIR/worktree-tanaabot/source"
sed -e "s/__GITHUB_RUN_ID__/$GITHUB_RUN_ID/g" -e "s/__GITHUB_RUN_ATTEMPT__/$GITHUB_RUN_ATTEMPT/g" "$GITHUB_WORKSPACE/examples/openclaw-worktree/agent.yaml" > "$TMPDIR/worktree-tanaabot/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/openclaw-worktree/SOUL.md" "$TMPDIR/worktree-tanaabot/SOUL.md"
cp -R "$GITHUB_WORKSPACE/examples/openclaw-worktree/tools" "$TMPDIR/worktree-tanaabot/tools"
mkdir -p "$TMPDIR/worktree-tanaabot/keys" "$HOME/.ssh"
cp "$HOME/.ssh/big-test-bucket-ssh" "$TMPDIR/worktree-tanaabot/keys/id_ed25519"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$TMPDIR/worktree-tanaabot/keys/id_ed25519.pub"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"
cd "$TMPDIR/worktree-tanaabot"
git init --initial-branch=main source
printf '%s\n' 'tracked source content' > source/tracked.txt
git -C source add tracked.txt
git -C source -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -m 'seed local fixture'
git -C source rev-parse HEAD > "$TMPDIR/worktree-source-head"
printf '%s\n' 'preserve source edits' > source/source-user.txt
openclaw agent-system install --yes --json | jq -e '.agentId == "worktree-tanaabot" and (.outcomes | any(.code == "add-github-ssh-keys") and any(.code == "add-github-ssh-signing-keys"))'
```

## Testing

```bash
# should prepare one managed worktree from the declared local repository
cd "$TMPDIR/worktree-tanaabot"
openclaw agent-system tool worktree -- prepare fixture 306-critical-path HEAD | tee "$TMPDIR/worktree-created.json" | jq -e '.status == "created" and .repositoryId == "fixture" and (.branch == (.path | split("/") | last))'
worktree_path=$(jq -er .path "$TMPDIR/worktree-created.json")
grep -Fx 'tracked source content' "$worktree_path/tracked.txt"
openclaw agent-system tool worktree -- list fixture | jq -e --arg path "$worktree_path" 'length == 1 and .[0].status == "active" and .[0].path == $path'

# should reuse the same worktree while preserving uncommitted edits
cd "$TMPDIR/worktree-tanaabot"
worktree_path=$(jq -er .path "$TMPDIR/worktree-created.json")
printf '%s\n' 'preserve worktree edits' > "$worktree_path/user-work.txt"
openclaw agent-system tool worktree -- prepare fixture 306-critical-path HEAD | tee "$TMPDIR/worktree-reused.json" | jq -e '.status == "existing"'
jq -e --slurp '.[0].path == .[1].path and .[0].branch == .[1].branch' "$TMPDIR/worktree-created.json" "$TMPDIR/worktree-reused.json"
grep -Fx 'preserve worktree edits' "$worktree_path/user-work.txt"

# should discover the owning identity from inside the worktree through both git entrypoints
plugin_dir=$(openclaw plugins inspect agent-system --json | jq -er '.plugin.rootDir')
cd "$(jq -er .path "$TMPDIR/worktree-created.json")"
openclaw agent-system tool git -- var GIT_AUTHOR_IDENT | grep -F 'Worktree Tanaabot <tanaabot@tanaab.dev>'
"$plugin_dir/bin/git" var GIT_AUTHOR_IDENT | grep -F 'Worktree Tanaabot <tanaabot@tanaab.dev>'

# should refuse to remove a dirty worktree without losing its edits
cd "$TMPDIR/worktree-tanaabot"
if output=$(openclaw agent-system tool worktree -- remove fixture 306-critical-path 2>&1); then
  printf '%s\n' "$output"
  exit 1
fi
printf '%s\n' "$output" | grep -F 'code=execution_failed'
worktree_path=$(jq -er .path "$TMPDIR/worktree-created.json")
grep -Fx 'preserve worktree edits' "$worktree_path/user-work.txt"

# should remove the clean worktree while preserving the source checkout and its edits
cd "$TMPDIR/worktree-tanaabot"
worktree_path=$(jq -er .path "$TMPDIR/worktree-created.json")
rm "$worktree_path/user-work.txt"
openclaw agent-system tool worktree -- remove fixture 306-critical-path | jq -e '.status == "removed"'
test ! -e "$worktree_path"
openclaw agent-system tool worktree -- list fixture | jq -e 'length == 0'
test -d source/.git
test "$(git -C source rev-parse HEAD)" = "$(cat "$TMPDIR/worktree-source-head")"
git -C source branch --show-current | grep -Fx main
grep -Fx 'tracked source content' source/tracked.txt
grep -Fx 'preserve source edits' source/source-user.txt
```

```bash
# should reuse enrolled keys and prepare a remote worktree through managed ssh
cd "$TMPDIR/worktree-tanaabot"
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
cd "$TMPDIR/worktree-tanaabot"
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
cd "$TMPDIR/worktree-tanaabot"
openclaw agent-system tool worktree -- remove remote 306-runtime-context | jq -e '.status == "removed"'

# should stop the isolated gateway and strict provider
openclaw-gateway stop --timeout 340
openclaw-aimock stop
```
