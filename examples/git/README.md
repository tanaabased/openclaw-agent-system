# Git Tool Example

This scenario verifies the packaged Agent System `git` shim, Git declaration
validation, nested workspace discovery, and agent identity on a real commit. It
does not start a Gateway or invoke a model.

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

# should install the scenario-owned agent through agent system
cd "$GITHUB_WORKSPACE/examples/git/tanaabot"
openclaw agent-system install
```

## Testing

```bash
# should identify the agent system git command
PATH="$GITHUB_WORKSPACE/bin:$PATH" git --agent-system | grep -Fx 'agent-system'

# should validate the inherited git identity from a nested directory
mkdir "$GITHUB_WORKSPACE/examples/git/tanaabot/validate"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot/validate"
openclaw agent-system validate | grep -F 'valid' | grep -F 'git' | grep -F 'Git tool identity and policy configuration'

# should preserve a nested repository directory and commit as tanaabot
mkdir "$GITHUB_WORKSPACE/examples/git/tanaabot/repository"
cd "$GITHUB_WORKSPACE/examples/git/tanaabot/repository"
PATH="$GITHUB_WORKSPACE/bin:$PATH" git init --quiet
touch identity.txt
PATH="$GITHUB_WORKSPACE/bin:$PATH" git add identity.txt
PATH="$GITHUB_WORKSPACE/bin:$PATH" git commit --quiet --message 'verify managed identity'
PATH="$GITHUB_WORKSPACE/bin:$PATH" git log -1 --format='%an <%ae>' | grep -Fx 'Tanaabot <tanaabot@tanaab.dev>'
```
