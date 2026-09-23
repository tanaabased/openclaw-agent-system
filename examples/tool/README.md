# Tool Command Example

This scenario verifies the public Agent System tool runner and Agent System `gh` command without starting a Gateway or invoking a model.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"

# should install the scenario-owned agent through agent system
cd "$GITHUB_WORKSPACE/examples/tool/tanaabot"
openclaw agent-system install
```

## Testing

```bash
# should keep internal launcher controls out of public help
for namespace in agent-system as; do
  output="$(openclaw "$namespace" tool --help)"
  printf '%s\n' "$output" | grep -F -- '--agent'
  if printf '%s\n' "$output" | grep -F -- '--shim'; then exit 1; fi
done

# should identify the agent system gh command
PATH="$GITHUB_WORKSPACE/bin:$PATH" gh --agent-system | grep -Fx 'agent-system'

# should pass generic gh arguments through the current agent manifest
cd "$GITHUB_WORKSPACE/examples/tool/tanaabot"
openclaw as tool gh -- repo view tanaabased/openclaw-agent-system --json name --jq .name | grep -Fx 'openclaw-agent-system'

# should deliver standard input through the installed host runner without contaminating json output
cd "$GITHUB_WORKSPACE/examples/tool/tanaabot"
printf '%s' '{"query":"query { viewer { login } }"}' | OPENCLAW_LOG_LEVEL=debug openclaw as tool gh -- api graphql --input - | jq -se 'length == 1 and .[0].data.viewer.login == "tanaabot"'

# should run a tool command for an explicit installed agent outside its workspace
cd "$TMPDIR"
openclaw as tool gh --agent tanaabot -- api user --jq .login | grep -Fx 'tanaabot'

# should report that host commands may reach trusted operator surfaces
cd "$GITHUB_WORKSPACE/examples/tool/tanaabot"
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-operator-boundary-exposed")'

# should delegate the packaged gh command through the same agent-bound tool runtime
cd "$GITHUB_WORKSPACE/examples/tool/tanaabot"
OPENCLAW_LOG_LEVEL=debug PATH="$GITHUB_WORKSPACE/bin:$PATH" gh api user --jq .login | grep -Fx 'tanaabot'

# should use host tools outside any agent workspace without session authority
cd "$TMPDIR"
PATH="$GITHUB_WORKSPACE/bin:$PATH" git -c user.name=host-fixture -c user.email=host@example.invalid var GIT_AUTHOR_IDENT | grep -F 'host-fixture <host@example.invalid>'
PATH="$GITHUB_WORKSPACE/bin:$PATH" gh --version | grep -F 'gh version'
```
