# Tool Command Example

This scenario verifies the public Agent System tool runner and Agent System `gh` command without starting a Gateway or invoking a model.

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

# should store access and install the scenario-owned agent through agent system
cd "$GITHUB_WORKSPACE/examples/tool/tanaabot"
openclaw agent-system credentials set op --from-env
openclaw agent-system install
```

## Testing

```bash
# should identify the agent system gh command
PATH="$GITHUB_WORKSPACE/bin:$PATH" gh --agent-system | grep -Fx 'agent-system'

# should pass generic gh arguments through the current agent manifest
cd "$GITHUB_WORKSPACE/examples/tool/tanaabot"
openclaw as tool gh -- repo view tanaabased/openclaw-agent-system --json name --jq .name | grep -Fx 'openclaw-agent-system'

# should run a tool command for an explicit installed agent outside its workspace
cd "$TMPDIR"
openclaw as tool gh --agent tanaabot -- api user --jq .login | grep -Fx 'tanaabot'

# should report that host commands may reach trusted operator surfaces
cd "$GITHUB_WORKSPACE/examples/tool/tanaabot"
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-operator-boundary-exposed")'

# should delegate the packaged gh command through the same agent-bound tool runtime
cd "$GITHUB_WORKSPACE/examples/tool/tanaabot"
PATH="$GITHUB_WORKSPACE/bin:$PATH" gh api user --jq .login | grep -Fx 'tanaabot'
```
