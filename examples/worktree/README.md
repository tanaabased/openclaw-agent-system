# Worktree Tool Example

This scenario verifies Agent System managed worktree preparation, configuration,
discovery, policy, health, and removal through the installed plugin and packaged
`git` shim. It does not start a Gateway, invoke a model, or load credentials.

## Setup

```bash
# should configure an unauthenticated local openclaw profile
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice skip \
  --workspace "$TMPDIR/main" \
  --gateway-bind loopback \
  --skip-daemon \
  --skip-health \
  --skip-bootstrap \
  --skip-channels \
  --skip-hooks \
  --skip-search \
  --skip-skills \
  --skip-ui \
  --suppress-gateway-token-output

# should install and enable the packed plugin
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system

# should install the scenario-owned agents through agent system
cd "$GITHUB_WORKSPACE/examples/worktree/tanaabot"
openclaw agent-system install
cd "$GITHUB_WORKSPACE/examples/worktree/rootsbot"
openclaw agent-system install
cd "$GITHUB_WORKSPACE/examples/worktree/localbot"
openclaw agent-system install
```

## Testing

```bash
# should grant the native managed worktree tool to the installed worktree agent
openclaw config get agents.list --json | jq -e '.[] | select(.id == "tanaabot") | ((.tools.allow // []) + (.tools.alsoAllow // [])) | index("agent_system_git_worktree") != null'
```

```bash
# should prepare a managed network repository worktree
cd "$GITHUB_WORKSPACE/examples/worktree/tanaabot"
OPENCLAW_LOG_LEVEL=error openclaw agent-system tool worktree -- prepare agent-system 123-verify-worktree-flow origin/main --clone-url https://github.com/tanaabased/openclaw-agent-system.git | tee "$TMPDIR/agent-system-worktree.json" | grep -F '"status": "created"'
jq -e '(.branch == (.path | split("/") | last)) and (.branch | startswith("123-verify-worktree-flow-"))' "$TMPDIR/agent-system-worktree.json"

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
