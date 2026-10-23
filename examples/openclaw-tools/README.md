# OpenClaw Tools Example

Execute managed Git and GitHub commands through the public route and installed contextual shims, preserving the owning identity, stdin/machine output, and critical configuration and assignment protection boundaries.

## What Belongs Here

- Real account/author identity through both managed command entrypoints.
- Stdin forwarding and diagnostics kept out of machine-readable results.
- Consequential configuration/self-unassignment refusals with actionable, redacted results through those installed routes.

## What Does Not Belong Here

- Setup-script and scheduled-command descendants; these need a focused descendant-authority contract rather than expanding ordinary command execution.
- Full scheduler lifecycle: [automations](../openclaw-automations/README.md). Model-facing two-account identity: [GitHub](../openclaw-github/README.md).
- Signed commits and native storage protections: [OS credentials](../os-credentials/README.md).

## Notes

- Direct Ubuntu checks use `GH_TOKEN_TANAABOT` without a model. GitHub operations read account identity; this job creates no remote content.
- Pending relocation: setup uses contextual `git`/`gh` shims, while one native command automation uses strict `agent-system-git`/`agent-system-gh` launchers. Both descendants must retain identity without receiving the declared GitHub token.
- Descendant checks retain receipts in the checked-in disposable workspace, verify setup convergence, and require exactly one automation execution. Preserve these distinct credential/launcher assertions when separating them.

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

# should reject self-unassignment through the public managed command
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
if output=$(openclaw agent-system tool gh -- issue edit 0 --repo tanaabased/big-test-bucket --remove-assignee @me 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F self-unassignment
printf '%s\n' "$output" | grep -F 'another authorized user'

# should reject self-unassignment through the installed contextual shim
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
plugin_dir=$(openclaw plugins inspect agent-system --json | jq -er '.plugin.rootDir')
if output=$("$plugin_dir/bin/gh" issue edit 0 --repo tanaabased/big-test-bucket --remove-assignee tanaabot 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F self-unassignment
printf '%s\n' "$output" | grep -F 'another authorized user'

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
