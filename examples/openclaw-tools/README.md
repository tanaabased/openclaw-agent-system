# OpenClaw Tools Example

Run managed Git and GitHub commands through the public CLI and installed shims.
Verify the agent identity, stdin, and machine-readable output, along with configuration
and assignment protections.

## What Belongs Here

- Real account/author identity through both managed command entrypoints.
- Stdin forwarding and diagnostics kept out of machine-readable results.
- Consequential configuration/self-unassignment refusals with actionable, redacted results through those installed routes.

## What Does Not Belong Here

- Setup-script and scheduled-command descendants: [tool descendants](../openclaw-tool-descendants/README.md).
- Full scheduler lifecycle: [automations](../openclaw-automation-command/README.md). Model-facing two-account identity: [GitHub](../openclaw-github/README.md).
- Signed commits and native storage protections: [OS credentials](../os-credentials/README.md).

## Notes

- Direct Ubuntu checks use `GH_TOKEN_TANAABOT` without a model. GitHub operations read account identity; this job creates no remote content.

## Setup

```bash
# should install the packed plugin and disposable managed tool workspace
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.component == "agent" and .status == "created")'
```

## Testing

```bash
# should retain managed identities through the public command route
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
openclaw as tool git -- var GIT_AUTHOR_IDENT | grep -F 'Tools Tanaabot <tanaabot@tanaab.dev>'
openclaw agent-system tool gh -- api user --jq .login | grep -Fx tanaabot

# should forward stdin while keeping debug logs out of machine output
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
printf '%s' '{"query":"query { viewer { login } }"}' | OPENCLAW_LOG_LEVEL=debug openclaw agent-system tool gh -- api graphql --input - | jq -se 'length == 1 and .[0].data.viewer.login == "tanaabot"'

# should retain the same identities through installed package shims
cd "$GITHUB_WORKSPACE/examples/openclaw-tools"
plugin_dir=$(openclaw plugins inspect agent-system --json | jq -er '.plugin.rootDir')
"$plugin_dir/bin/git" var GIT_AUTHOR_IDENT | grep -F 'Tools Tanaabot <tanaabot@tanaab.dev>'
"$plugin_dir/bin/gh" api user --jq .login | grep -Fx tanaabot

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
```
