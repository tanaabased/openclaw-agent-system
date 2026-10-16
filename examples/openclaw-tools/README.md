# OpenClaw Tools Example

Verify managed Git and GitHub execution through the public command, the installed package's shims, agent setup, and a native command automation. The operator and setup checks use contextual `git` and `gh` shims; the automation uses strict `agent-system-git` and `agent-system-gh` launchers under trusted agent authority. Each path must retain Tanaabot's identity; setup and automation descendants must not receive the declared GitHub token. The GitHub operation reads account identity and creates no remote fixture. No model is needed.

Runtime tests run this example on Ubuntu with `GH_TOKEN_TANAABOT`. The copied workspace owns setup and automation receipts. Signed commits and native credential-store protections remain in OS coverage.

## Setup

```bash
# should install the packed plugin and disposable managed tool workspace
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
mkdir -p "$TMPDIR/tools-tanaabot"
cp "$GITHUB_WORKSPACE/examples/openclaw-tools/agent.yaml" \
  "$GITHUB_WORKSPACE/examples/openclaw-tools/automations.yaml" \
  "$GITHUB_WORKSPACE/examples/openclaw-tools/probe.sh" \
  "$TMPDIR/tools-tanaabot"
cd "$TMPDIR/tools-tanaabot"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.stepId == "tool-identity" and .status == "updated")'
```

## Testing

```bash
# should retain managed identities through the public command route
cd "$TMPDIR/tools-tanaabot"
openclaw agent-system tool git -- var GIT_AUTHOR_IDENT | grep -F 'Tools Tanaabot <tanaabot@tanaab.dev>'
openclaw agent-system tool gh -- api user --jq .login | grep -Fx tanaabot

# should retain the same identities through installed package shims
cd "$TMPDIR/tools-tanaabot"
plugin_dir=$(openclaw plugins inspect agent-system --json | jq -er '.plugin.rootDir')
"$plugin_dir/bin/git" var GIT_AUTHOR_IDENT | grep -F 'Tools Tanaabot <tanaabot@tanaab.dev>'
"$plugin_dir/bin/gh" api user --jq .login | grep -Fx tanaabot

# should complete setup through bound shims without exposing credentials to its script
cd "$TMPDIR/tools-tanaabot"
grep -F 'Tools Tanaabot <tanaabot@tanaab.dev>' setup.git
grep -Fx tanaabot setup.github
test -f setup.complete
test "$(wc -l < setup.runs | tr -d ' ')" = 1
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.stepId == "tool-identity" and .status == "unchanged")'
test "$(wc -l < setup.runs | tr -d ' ')" = 1

# should complete a native automation through strict bound launchers exactly once
openclaw-gateway start
cd "$TMPDIR/tools-tanaabot"
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
