# Shared Codex Prerequisite Example

This GitHub Actions-only scenario first probes model configuration with Codex enabled on the pinned host/plugin pair, including clean command exits and child-process cleanup for [#135](https://github.com/tanaabased/openclaw-agent-system/issues/135).

Each probe command has a two-minute limit and reports whether it is still running after 30 seconds. A successful probe requires a normal exit and no surviving child processes.

It then verifies the packed Agent System plugin's fresh prerequisite installation,
repeat convergence, second-agent reuse, disabled repair, conflicts, and sanitized
provider failures. It also verifies that a native agent installs without the plugin
and ignores an unrelated conflicting shared installation. Every installation and
configuration change is disposable. The model test changes declared effort while
Codex is enabled and verifies that the native runtime binding survives reconciliation.

## Setup

```bash
# should prepare an isolated profile and install the exact codex prerequisite
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
openclaw plugins install npm:@openclaw/codex@2026.9.9 --pin --accept-capabilities
openclaw plugins enable codex --accept-capabilities
openclaw --version | grep -F '2026.9.9'
openclaw plugins inspect codex --json | jq -e '.plugin.version == "2026.9.9" and .plugin.enabled == true and .install.version == "2026.9.9"'
openclaw agents add codex-probe --workspace "$TMPDIR/codex-probe" --non-interactive
mkdir -p "$TMPDIR/codex-first" "$TMPDIR/codex-second" "$TMPDIR/native-agent"
cp "$GITHUB_WORKSPACE/examples/prerequisite/first/agent.yaml" "$TMPDIR/codex-first/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/prerequisite/second/agent.yaml" "$TMPDIR/codex-second/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/prerequisite/native/agent.yaml" "$TMPDIR/native-agent/agent.yaml"
```

## Testing

```bash
# should configure models with codex enabled and leave no surviving child process
node --import tsx "$GITHUB_WORKSPACE/scripts/codex-lifecycle-probe.ts" codex-probe

# should remove the probe route and plugin to establish a missing prerequisite
openclaw agents delete codex-probe --force
openclaw plugins uninstall codex --force
openclaw plugins list --json | jq -e 'all(.plugins[]; .id != "codex")'

# should install a native agent without inspecting or provisioning the missing codex plugin
cd "$TMPDIR/native-agent"
output="$(openclaw agent-system doctor --json || true)"
printf '%s\n' "$output" | jq -e '.findings | all(.component != "codex-plugin")'
openclaw agent-system install --json | jq -e '.outcomes | all(.component != "codex-plugin")'
openclaw plugins list --json | jq -e 'all(.plugins[]; .id != "codex")'

# should diagnose a missing prerequisite without changing configuration or installation state
cd "$TMPDIR/codex-first"
before="$(openclaw config get plugins --json | jq -cS .)"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.findings | any(.code == "codex-plugin-missing" and .status == "drift")'
test "$(openclaw config get plugins --json | jq -cS .)" = "$before"
openclaw plugins list --json | jq -e 'all(.plugins[]; .id != "codex")'

# should retain sanitized failure details when openclaw install policy blocks provisioning
openclaw config set security.installPolicy '{"enabled":true,"targets":["plugin"]}' --strict-json
trap 'openclaw config unset security.installPolicy >/dev/null' EXIT
cd "$TMPDIR/codex-first"
if output=$(openclaw agent-system install --skip-setup --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.blocked.component == "codex-plugin" and .blocked.code == "codex-plugin-install-failed" and (.blocked.message | contains("category=policy")) and (.unattempted | any(.component == "models"))'
openclaw plugins list --json | jq -e 'all(.plugins[]; .id != "codex")'
openclaw config unset security.installPolicy
trap - EXIT

# should provision the exact shared plugin before fresh agent and model reconciliation
cd "$TMPDIR/codex-first"
openclaw agent-system install --skip-setup --json | jq -e '.outcomes[0].component == "codex-plugin" and .outcomes[0].code == "codex-plugin-installed" and (.outcomes | any(.component == "models" and .status == "updated"))'
openclaw plugins inspect codex --json | jq -e '.plugin.version == "2026.9.9" and .plugin.enabled == true and .install.version == "2026.9.9"'

# should reuse the shared install without changing its receipt across repeat and second agent installation
receipt="$(openclaw plugins inspect codex --json | jq -cS .install)"
cd "$TMPDIR/codex-first"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "codex-plugin-unchanged" and .status == "unchanged")'
cd "$TMPDIR/codex-second"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "codex-plugin-unchanged" and .status == "unchanged")'
test "$(openclaw plugins inspect codex --json | jq -cS .install)" = "$receipt"

# should enable the matching shared plugin before changing a codex-bound model declaration
openclaw config set agents.entries.codex-first.models '{"openai/gpt-5.4-nano":{"agentRuntime":{"id":"codex"}}}' --strict-json
openclaw plugins disable codex
cd "$TMPDIR/codex-first"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.findings | any(.code == "codex-plugin-disabled" and .status == "drift")'
openclaw plugins inspect codex --json | jq -e '.plugin.enabled == false'
sed 's/effort: medium/effort: high/' "$GITHUB_WORKSPACE/examples/prerequisite/first/agent.yaml" > agent.yaml
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "codex-plugin-enabled" and .status == "updated") and any(.component == "models" and .code == "set-agent-models" and .status == "updated")'
openclaw config get agents.entries.codex-first --json | jq -e '.thinkingDefault == "high" and .models["openai/gpt-5.4-nano"].agentRuntime.id == "codex"'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "codex-plugin-ready" and .status == "healthy")'

# should reject a conflicting shared plugin without silently upgrading it
openclaw plugins uninstall codex --force
openclaw plugins install npm:@openclaw/codex@2026.9.8 --pin --accept-capabilities
receipt="$(openclaw plugins inspect codex --json | jq -cS .install)"
cd "$TMPDIR/codex-second"
if output=$(openclaw agent-system install --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.blocked.code == "codex-plugin-conflict" and (.blocked.message | contains("2026.9.9")) and (.blocked.message | contains("2026.9.8"))'
test "$(openclaw plugins inspect codex --json | jq -cS .install)" = "$receipt"

# should leave an unrelated conflicting shared installation untouched for a native agent
cd "$TMPDIR/native-agent"
receipt="$(openclaw plugins inspect codex --json | jq -cS .install)"
openclaw agent-system doctor --json | jq -e '.status == "healthy" and (.findings | all(.component != "codex-plugin"))'
openclaw agent-system install --json | jq -e '.outcomes | all(.component != "codex-plugin")'
test "$(openclaw plugins inspect codex --json | jq -cS .install)" = "$receipt"

# should require explicit operator reconciliation to restore the declared shared version
openclaw plugins uninstall codex --force
openclaw plugins install npm:@openclaw/codex@2026.9.9 --pin --accept-capabilities
openclaw plugins enable codex --accept-capabilities
cd "$TMPDIR/codex-second"
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "codex-plugin-ready")'

# should reject the packed plugin on a real incompatible host before agent installation
npm install --prefix "$TMPDIR/incompatible-host" --ignore-scripts --no-audit --no-fund --package-lock=false openclaw@2026.9.8
"$TMPDIR/incompatible-host/node_modules/.bin/openclaw" --version | grep -F '2026.9.8'
if output=$(OPENCLAW_STATE_DIR="$TMPDIR/incompatible-state" OPENCLAW_CONFIG_PATH="$TMPDIR/incompatible-state/openclaw.json" "$TMPDIR/incompatible-host/node_modules/.bin/openclaw" plugins install "$AGENT_SYSTEM_PACKAGE" --force --accept-capabilities 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F '2026.9.9'
```
