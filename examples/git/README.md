# Git Tool Example

This scenario verifies the packaged Agent System `git` shim, Git declaration
validation, nested workspace discovery, agent identity on a real commit, and
isolated SSH authentication against GitHub. It does not start a Gateway or
invoke a model.

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

# should prepare one ephemeral ssh identity and trusted github host key
mkdir "$TMPDIR/agent-system-git-tanaabot"
ssh-keygen -q -t ed25519 -N '' -C agent-system-leia-git -f "$TMPDIR/agent-system-git-tanaabot/id_ed25519"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
cp "$GITHUB_WORKSPACE/examples/git/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"

# should store access and install the scenario-owned agent through agent system
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
openclaw agent-system credentials set op --from-env
AGENT_SYSTEM_LEIA_GIT_PRIVATE_KEY="$(cat "$TMPDIR/agent-system-git-tanaabot/id_ed25519")" openclaw agent-system install

# should register only the generated public key for tanaabot
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
AGENT_SYSTEM_LEIA_GIT_PRIVATE_KEY="$(cat "$TMPDIR/agent-system-git-tanaabot/id_ed25519")" OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method POST /user/keys -f "title=agent-system-git-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$RUNNER_OS" -f "key=$(cat "$TMPDIR/agent-system-git-tanaabot/id_ed25519.pub")" --jq .id > "$TMPDIR/agent-system-git-tanaabot/github-key-id"
```

## Testing

```bash
# should identify the agent system git command
PATH="$GITHUB_WORKSPACE/bin:$PATH" git --agent-system | grep -Fx 'agent-system'

# should deny an alternate force push before git execution
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
if output="$(PATH="$GITHUB_WORKSPACE/bin:$PATH" git push origin +main:main 2>&1)"; then
  exit 1
fi
printf '%s\n' "$output" | grep -F 'git.policy.destructive'

# should validate the inherited git identity from a nested directory
mkdir "$GITHUB_WORKSPACE/examples/git/tanaabot/validate"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot/validate"
openclaw agent-system validate | grep -F 'valid' | grep -F 'git' | grep -F 'Git tool identity and policy configuration'

# should preserve a nested repository directory and commit as tanaabot
mkdir "$GITHUB_WORKSPACE/examples/git/tanaabot/repository"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot/repository"
export AGENT_SYSTEM_LEIA_GIT_PRIVATE_KEY="$(cat "$TMPDIR/agent-system-git-tanaabot/id_ed25519")"
PATH="$GITHUB_WORKSPACE/bin:$PATH" git init --quiet
touch identity.txt
PATH="$GITHUB_WORKSPACE/bin:$PATH" git add identity.txt
PATH="$GITHUB_WORKSPACE/bin:$PATH" git commit --quiet --message 'verify managed identity'
PATH="$GITHUB_WORKSPACE/bin:$PATH" git log -1 --format='%an <%ae>' | grep -Fx 'Tanaabot <tanaabot@tanaab.dev>'

# should report managed git ssh dependencies healthy
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
openclaw agent-system doctor | grep -F 'healthy' | grep -F 'git' | grep -F 'Git SSH authentication dependencies are available'

# should authenticate to github through the isolated agent system ssh identity
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
AGENT_SYSTEM_LEIA_GIT_PRIVATE_KEY="$(cat "$TMPDIR/agent-system-git-tanaabot/id_ed25519")" PATH="$GITHUB_WORKSPACE/bin:$PATH" git ls-remote git@github.com:tanaabased/openclaw-agent-system.git HEAD | grep -F 'HEAD'
```

## Cleanup

```bash
# should remove only the generated tanaabot public key
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
key_id="$(cat "$TMPDIR/agent-system-git-tanaabot/github-key-id")"
AGENT_SYSTEM_LEIA_GIT_PRIVATE_KEY="$(cat "$TMPDIR/agent-system-git-tanaabot/id_ed25519")" OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method DELETE "/user/keys/$key_id"
remaining="$(AGENT_SYSTEM_LEIA_GIT_PRIVATE_KEY="$(cat "$TMPDIR/agent-system-git-tanaabot/id_ed25519")" OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --paginate /user/keys --jq ".[] | select(.id == $key_id) | .id")"
test -z "$remaining"
```
