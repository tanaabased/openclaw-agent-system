# OpenClaw Tools Example

Verify managed Git and GitHub execution through the public command, the installed package's shims, agent setup, and a native command automation. The operator and setup checks use contextual `git` and `gh` shims; the automation uses strict `agent-system-git` and `agent-system-gh` launchers under trusted agent authority. Each path must retain Tanaabot's identity; setup and automation descendants must not receive the declared GitHub token. The GitHub operation reads account identity and creates no remote fixture. No model is needed.

Runtime tests run this example on Ubuntu with `GH_TOKEN_TANAABOT`. The checked-in workspace owns setup and automation receipts on the disposable runner. Signed commits and native credential-store protections remain in OS coverage.

## Setup

```bash
# should install the packed plugin and disposable managed tool workspace
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.stepId == "tool-identity" and .status == "updated")'
```

## Testing

```bash
# should retain managed identities through the public command route
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
openclaw agent-system tool git -- var GIT_AUTHOR_IDENT | grep -F 'Tools Tanaabot <tanaabot@tanaab.dev>'
openclaw agent-system tool gh -- api user --jq .login | grep -Fx tanaabot

# should forward stdin while keeping debug logs out of machine output
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
printf '%s' '{"query":"query { viewer { login } }"}' | OPENCLAW_LOG_LEVEL=debug openclaw agent-system tool gh -- api graphql --input - | jq -se 'length == 1 and .[0].data.viewer.login == "tanaabot"'

# should retain the same identities through installed package shims
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
plugin_dir=$(openclaw plugins inspect agent-system --json | jq -er '.plugin.rootDir')
"$plugin_dir/bin/git" var GIT_AUTHOR_IDENT | grep -F 'Tools Tanaabot <tanaabot@tanaab.dev>'
"$plugin_dir/bin/gh" api user --jq .login | grep -Fx tanaabot

# should complete setup through bound shims without exposing credentials to its script
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
grep -F 'Tools Tanaabot <tanaabot@tanaab.dev>' setup.git
grep -Fx tanaabot setup.github
test -f setup.complete
test "$(wc -l < setup.runs | tr -d ' ')" = 1
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.stepId == "tool-identity" and .status == "unchanged")'
test "$(wc -l < setup.runs | tr -d ' ')" = 1

# should explain public command configuration rejection without echoing input
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
if output=$(openclaw agent-system tool git -- config user.name private-argument-sentinel 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F invalid_arguments
printf '%s\n' "$output" | grep -F agent.yaml
printf '%s\n' "$output" | grep -F mutated
if printf '%s\n' "$output" | grep -F private-argument-sentinel; then exit 1; fi

# should explain installed shim configuration rejection without echoing input
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
plugin_dir=$(openclaw plugins inspect agent-system --json | jq -er '.plugin.rootDir')
if output=$("$plugin_dir/bin/gh" config set editor private-editor-sentinel 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F invalid_arguments
printf '%s\n' "$output" | grep -F agent.yaml
printf '%s\n' "$output" | grep -F mutated
if printf '%s\n' "$output" | grep -F private-editor-sentinel; then exit 1; fi

# should complete a native automation through strict bound launchers exactly once
openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
openclaw agent-system automations sync --json | jq -e '.status == "synchronized"'
run_id=$(openclaw agent-system automations run tool-identity --json | jq -er 'select(.status == "queued") | .runId | strings')
node "$GITHUB_WORKSPACE/scripts/wait-for-automation-run.mjs" tool-identity "$run_id"
grep -F 'Tools Tanaabot <tanaabot@tanaab.dev>' automation.git
grep -Fx tanaabot automation.github
test -f automation.complete
test "$(wc -l < automation.runs | tr -d ' ')" = 1
```

## Cleanup

```bash
# should stop the scenario gateway
openclaw-gateway stop --timeout 340
```
