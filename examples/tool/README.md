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

## Google

These blocks use a fake GoG host executable and disposable OAuth fixtures. They do
not contact Google or prove live OAuth transport.

```bash
# should install and inspect google credentials without changing a ready installation
cd "$GITHUB_WORKSPACE/examples/tool/googlebot"
GOG_HOME="$TMPDIR/googlebot-gog" PATH="$GITHUB_WORKSPACE/examples/tool/google-host:$PATH" openclaw agent-system install --json | jq -e '.outcomes | any(.code == "google-credentials-created")'
GOG_HOME="$TMPDIR/googlebot-gog" PATH="$GITHUB_WORKSPACE/examples/tool/google-host:$PATH" openclaw agent-system install --json | jq -e '.outcomes | any(.code == "google-credentials-unchanged")'
GOG_HOME="$TMPDIR/googlebot-gog" PATH="$GITHUB_WORKSPACE/examples/tool/google-host:$PATH" openclaw agent-system doctor --json | jq -e '.findings | any(.code == "google-live-identity-ready")'

# should run a google data command through the public tool route with the configured account
cd "$GITHUB_WORKSPACE/examples/tool/googlebot"
GOG_HOME="$TMPDIR/googlebot-gog" PATH="$GITHUB_WORKSPACE/examples/tool/google-host:$PATH" openclaw agent-system tool gog --agent googlebot -- gmail search 'is:unread' | jq -e '.account == "googlebot@example.invalid" and .backend == "file" and .managed == true'

# should identify packaged google shims and reject account overrides without host fallback
"$GITHUB_WORKSPACE/bin/gog" --agent-system | grep -Fx agent-system
"$GITHUB_WORKSPACE/bin/agent-system-gog" --agent-system | grep -Fx agent-system
cd "$GITHUB_WORKSPACE/examples/tool/googlebot"
GOG_HOME="$TMPDIR/googlebot-gog" PATH="$GITHUB_WORKSPACE/examples/tool/google-host:$PATH" openclaw agent-system tool gog --agent googlebot -- gmail search --account other@example.invalid > "$TMPDIR/google-override.out" 2>&1 && exit 1
grep -F invalid_arguments "$TMPDIR/google-override.out"
```
