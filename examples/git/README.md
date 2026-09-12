# Git Tool Example

This scenario verifies the packaged Agent System `git` shim, Git declaration
validation, nested workspace discovery, agent identity on a real commit,
and SSH authentication and commit/tag signing with one disposable generated key.
The [environment example](../env/README.md) covers vault-backed key retrieval.
This example does not start a Gateway or invoke a model.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE" \
  --needs-ssh-key

# should trust the github host key for the prepared ssh identity
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should trust the generated signing key for the scenario identity
mkdir -p "$GITHUB_WORKSPACE/examples/git/tanaabot/.agent-system"
printf 'tanaabot@tanaab.dev %s\n' "$(cat "$HOME/.ssh/big-test-bucket-ssh.pub")" > "$GITHUB_WORKSPACE/examples/git/tanaabot/.agent-system/allowed_signers"

# should install the scenario-owned agent through agent system
export GIT_SSH_PRIVATE_KEY="$(cat "$HOME/.ssh/big-test-bucket-ssh")"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
openclaw agent-system install

# should register only the generated public key for tanaabot
export GIT_SSH_PRIVATE_KEY="$(cat "$HOME/.ssh/big-test-bucket-ssh")"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method POST /user/keys -f "title=agent-system-git-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS" -f "key=$(cat "$HOME/.ssh/big-test-bucket-ssh.pub")" --jq .id > "$TMPDIR/big-test-bucket-ssh.key-id"
```

## Testing

```bash
# should grant the native git tool to the installed git agent
openclaw config get agents.entries.tanaabot.tools --json | jq -e '((.allow // []) + (.alsoAllow // [])) | index("agent_system_git") != null'
```

```bash
# should identify the agent system git command
"$GITHUB_WORKSPACE/bin/git" --agent-system | grep -Fx 'agent-system'

# should run one explicitly allowed external git extension
export GIT_SSH_PRIVATE_KEY="$(cat "$HOME/.ssh/big-test-bucket-ssh")"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
PATH="$GITHUB_WORKSPACE/examples/git/tanaabot/bin:$PATH" "$GITHUB_WORKSPACE/bin/git" big-test-bucket | grep -Fx 'agent-system-extension'

# should deny an alternate force push before git execution
export GIT_SSH_PRIVATE_KEY="$(cat "$HOME/.ssh/big-test-bucket-ssh")"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
if output="$("$GITHUB_WORKSPACE/bin/git" push origin +main:main 2>&1)"; then
  exit 1
fi
printf '%s\n' "$output" | grep -F 'git.policy.force-push'

# should validate the inherited git identity from a nested directory
export GIT_SSH_PRIVATE_KEY="$(cat "$HOME/.ssh/big-test-bucket-ssh")"
mkdir "$GITHUB_WORKSPACE/examples/git/tanaabot/validate"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot/validate"
openclaw agent-system validate | grep -F 'valid' | grep -F 'git' | grep -F 'Git tool identity and policy configuration'

# should preserve a nested repository directory and create a trusted signed commit as tanaabot
export GIT_SSH_PRIVATE_KEY="$(cat "$HOME/.ssh/big-test-bucket-ssh")"
mkdir "$GITHUB_WORKSPACE/examples/git/tanaabot/repository"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot/repository"
"$GITHUB_WORKSPACE/bin/git" init --quiet
touch identity.txt
"$GITHUB_WORKSPACE/bin/git" add identity.txt
"$GITHUB_WORKSPACE/bin/git" commit --quiet --message 'verify managed identity'
"$GITHUB_WORKSPACE/bin/git" log -1 --format='%an <%ae>' | grep -Fx 'Tanaabot <tanaabot@tanaab.dev>'
"$GITHUB_WORKSPACE/bin/git" log -1 --format='%G? %GS' | grep -Fx 'G tanaabot@tanaab.dev'
"$GITHUB_WORKSPACE/bin/git" verify-commit HEAD

# should create and locally verify a trusted signed tag
export GIT_SSH_PRIVATE_KEY="$(cat "$HOME/.ssh/big-test-bucket-ssh")"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot/repository"
"$GITHUB_WORKSPACE/bin/git" tag --message 'verify managed signing' agent-system-signing-test
"$GITHUB_WORKSPACE/bin/git" verify-tag agent-system-signing-test

# should report managed ssh dependencies as healthy
export GIT_SSH_PRIVATE_KEY="$(cat "$HOME/.ssh/big-test-bucket-ssh")"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
openclaw agent-system doctor --json | jq -e '.findings | any(.component == "git" and .status == "healthy" and .code == "git-ssh-dependencies-ready")'

# should authenticate with the same generated key used for signing
export GIT_SSH_PRIVATE_KEY="$(cat "$HOME/.ssh/big-test-bucket-ssh")"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
"$GITHUB_WORKSPACE/bin/git" ls-remote git@github.com:tanaabased/openclaw-agent-system.git HEAD | grep -F 'HEAD'

# should prepare github worktrees with the configured ssh transport
export GIT_SSH_PRIVATE_KEY="$(cat "$HOME/.ssh/big-test-bucket-ssh")"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree -- prepare agent-system ssh-transport origin/main --clone-url https://github.com/tanaabased/openclaw-agent-system.git | tee "$TMPDIR/agent-system-ssh-worktree.json" | grep -F '"status": "created"'
cd "$(jq -r .path "$TMPDIR/agent-system-ssh-worktree.json")"
"$GITHUB_WORKSPACE/bin/git" remote get-url origin | grep -Fx 'git@github.com:tanaabased/openclaw-agent-system.git'
```

## Cleanup

```bash
# should remove the clean ssh backed worktree
export GIT_SSH_PRIVATE_KEY="$(cat "$HOME/.ssh/big-test-bucket-ssh")"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree -- remove agent-system ssh-transport | grep -F '"status": "removed"'

# should remove only the generated tanaabot public key
export GIT_SSH_PRIVATE_KEY="$(cat "$HOME/.ssh/big-test-bucket-ssh")"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
key_id="$(cat "$TMPDIR/big-test-bucket-ssh.key-id")"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method DELETE "/user/keys/$key_id"
remaining="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --paginate /user/keys --jq ".[] | select(.id == $key_id) | .id")"
test -z "$remaining"
```
