# Worktree Tool Example

This scenario verifies Agent System managed worktree preparation, configuration,
discovery, policy, health, and removal through the installed plugin and packaged
`git` shim. It does not start a Gateway, invoke a model, or load credentials.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"

# should install the scenario-owned agents through agent system
cd "$GITHUB_WORKSPACE/examples/worktree/tanaabot"
openclaw agent-system install
cd "$GITHUB_WORKSPACE/examples/worktree/rootsbot"
openclaw agent-system install
cd "$GITHUB_WORKSPACE/examples/worktree/localbot"
openclaw agent-system install
```

## Testing

The lock-loss regression pauses a read-only Git command under the installed
plugin's preparation lease. Changing that test lock's timestamp forces the real
heartbeat callback to report lost ownership. The command must fail through its
normal error path, leave the compromised lock alone, and create no worktree.
This exercises containment, not a host freeze or the Doctor approval flow.

```bash
# should fail a compromised preparation without creating a worktree
mkdir -p "$TMPDIR/lock-loss-bin"
command -v git > "$TMPDIR/lock-loss-bin/real-git"
cp "$GITHUB_WORKSPACE/examples/worktree/delay-git.mjs" "$TMPDIR/lock-loss-bin/git"
chmod +x "$TMPDIR/lock-loss-bin/git"
cd "$GITHUB_WORKSPACE/examples/worktree/localbot"
PATH="$TMPDIR/lock-loss-bin:$PATH" openclaw agent-system tool worktree -- prepare agent-system 790-lock-loss HEAD > "$TMPDIR/lock-loss.log" 2>&1 &
preparation_pid=$!
trap 'kill "$preparation_pid" 2>/dev/null || true' EXIT
node "$GITHUB_WORKSPACE/examples/worktree/compromise-lock.mjs" "$TMPDIR/lock-loss-bin/paused" "$GITHUB_WORKSPACE/.git/agent-system-worktree-preparation.lock"
if wait "$preparation_pid"; then cat "$TMPDIR/lock-loss.log"; exit 1; fi
cat "$TMPDIR/lock-loss.log"
grep -F 'The private state file lock was lost' "$TMPDIR/lock-loss.log"
test -d "$GITHUB_WORKSPACE/.git/agent-system-worktree-preparation.lock"
openclaw agent-system tool worktree -- list agent-system | jq -e 'all(.[]; (.branch | startswith("790-lock-loss-")) | not)'

# should recover preparation after a lost lease without restarting the host
cd "$GITHUB_WORKSPACE/examples/worktree/localbot"
openclaw agent-system tool worktree -- prepare agent-system 790-lock-loss HEAD | jq -e '.status == "created"'
openclaw agent-system tool worktree -- remove agent-system 790-lock-loss | jq -e '.status == "removed"'
```

```bash
# should grant the native managed worktree tool to the installed worktree agent
openclaw config get agents.entries.tanaabot.tools --json | jq -e '((.allow // []) + (.alsoAllow // [])) | index("agent_system_git_worktree") != null'
```

```bash
# should prepare a managed worktree through the installed operator command
cd "$GITHUB_WORKSPACE/examples/worktree/tanaabot"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree -- prepare agent-system 123-verify-worktree-flow origin/main --clone-url https://github.com/tanaabased/openclaw-agent-system.git > "$TMPDIR/agent-system-worktree.json"
jq -e '.status == "created" and (.branch == (.path | split("/") | last)) and (.branch | startswith("123-verify-worktree-flow-"))' "$TMPDIR/agent-system-worktree.json"

# should return the same managed worktree on repeated preparation
cd "$GITHUB_WORKSPACE/examples/worktree/tanaabot"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree -- prepare agent-system 123-verify-worktree-flow origin/main --clone-url https://github.com/tanaabased/openclaw-agent-system.git | grep -F '"status": "existing"'
openclaw agent-system tool worktree -- list agent-system | grep -F '"status": "active"'

# should prepare a managed worktree under custom roots
cd "$GITHUB_WORKSPACE/examples/worktree/rootsbot"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree -- prepare agent-system 456-verify-custom-roots origin/main --clone-url https://github.com/tanaabased/openclaw-agent-system.git | jq -e '.status == "created" and (.path | contains("/.agent-system/custom/worktrees/"))'
test -d .agent-system/custom/repositories/*.git

# should prepare from a configured local repository without a clone url
cd "$GITHUB_WORKSPACE/examples/worktree/localbot"
openclaw agent-system doctor | grep -F 'healthy' | grep -F 'Git local repository override agent-system is ready'
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree -- prepare agent-system 789-verify-local-override HEAD | grep -F '"status": "created"'

# should route the packaged shim from the managed worktree to tanaabot
cd "$(jq -r .path "$TMPDIR/agent-system-worktree.json")"
PATH="$GITHUB_WORKSPACE/bin:$PATH" git --agent-system | grep -Fx 'agent-system'
PATH="$GITHUB_WORKSPACE/bin:$PATH" git config --get user.email | grep -Fx 'tanaabot@tanaab.dev'

# should allow read-only raw worktree listing
cd "$(jq -r .path "$TMPDIR/agent-system-worktree.json")"
PATH="$GITHUB_WORKSPACE/bin:$PATH" git worktree list --porcelain | grep -F 'worktree '

# should reject raw worktree mutation before git execution
cd "$(jq -r .path "$TMPDIR/agent-system-worktree.json")"
if output="$(PATH="$GITHUB_WORKSPACE/bin:$PATH" git worktree add --detach "$TMPDIR/agent-system-raw-worktree" HEAD 2>&1)"; then
  exit 1
fi
printf '%s\n' "$output" | grep -F 'code=invalid_arguments'
test ! -e "$TMPDIR/agent-system-raw-worktree"

# should report managed worktree roots as healthy
cd "$GITHUB_WORKSPACE/examples/worktree/tanaabot"
openclaw agent-system doctor | grep -F 'healthy' | grep -F 'git' | grep -F 'Git managed repository and worktree roots are ignored'

# should remove the clean managed worktree without enabling delete policy
cd "$GITHUB_WORKSPACE/examples/worktree/tanaabot"
openclaw agent-system tool worktree -- remove agent-system 123-verify-worktree-flow | grep -F '"status": "removed"'
openclaw agent-system tool worktree -- list agent-system | grep -Fx '[]'

# should remove clean custom-root and local-repository worktrees through the same write policy
cd "$GITHUB_WORKSPACE/examples/worktree/rootsbot"
openclaw agent-system tool worktree -- remove agent-system 456-verify-custom-roots | grep -F '"status": "removed"'
cd "$GITHUB_WORKSPACE/examples/worktree/localbot"
openclaw agent-system tool worktree -- remove agent-system 789-verify-local-override | grep -F '"status": "removed"'
```
