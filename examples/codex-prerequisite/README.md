# Shared Codex Prerequisite Example

This GitHub Actions-only scenario first probes model configuration with Codex enabled on the pinned host/plugin pair, including clean command exits and child-process cleanup for [#135](https://github.com/tanaabased/openclaw-agent-system/issues/135).

It then verifies the packed Agent System plugin's fresh prerequisite installation,
repeat convergence, second-agent reuse, disabled repair, conflicts, and sanitized
provider failures. Every installation and configuration change is disposable.

## Setup

```bash
# should prepare an isolated profile and install the exact codex prerequisite
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
openclaw plugins install npm:@openclaw/codex@2026.9.7 --pin --accept-capabilities
openclaw plugins enable codex --accept-capabilities
openclaw --version | grep -F '2026.9.7'
openclaw plugins inspect codex --json | jq -e '.plugin.version == "2026.9.7" and .plugin.enabled == true and .install.version == "2026.9.7"'
openclaw agents add codex-probe --workspace "$TMPDIR/codex-probe" --non-interactive
```

## Testing

```bash
# should configure models with codex enabled and leave no surviving child process
node --import tsx "$GITHUB_WORKSPACE/scripts/codex-lifecycle-probe.ts" codex-probe

# should remove the probe route and plugin to establish a genuinely missing prerequisite
openclaw agents delete codex-probe --force
openclaw plugins uninstall codex --force
openclaw plugins list --json | jq -e 'all(.plugins[]; .id != "codex")'

# should diagnose a missing prerequisite without changing configuration or installation state
cd "$GITHUB_WORKSPACE/examples/codex-prerequisite/first"
before="$(openclaw config get plugins --json | jq -cS .)"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.findings | any(.code == "codex-plugin-missing" and .status == "drift")'
test "$(openclaw config get plugins --json | jq -cS .)" = "$before"
openclaw plugins list --json | jq -e 'all(.plugins[]; .id != "codex")'

# should retain sanitized failure details when openclaw install policy blocks provisioning
openclaw config set security.installPolicy '{"enabled":true,"targets":["plugin"]}' --strict-json
trap 'openclaw config unset security.installPolicy >/dev/null' EXIT
cd "$GITHUB_WORKSPACE/examples/codex-prerequisite/first"
if output=$(openclaw agent-system install --skip-setup --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.blocked.component == "codex-plugin" and .blocked.code == "codex-plugin-install-failed" and (.blocked.message | contains("category=policy")) and (.unattempted | any(.component == "models"))'
openclaw plugins list --json | jq -e 'all(.plugins[]; .id != "codex")'
openclaw config unset security.installPolicy
trap - EXIT

# should provision the exact shared plugin before fresh agent and model reconciliation
cd "$GITHUB_WORKSPACE/examples/codex-prerequisite/first"
openclaw agent-system install --skip-setup --json | jq -e '.outcomes[0].component == "codex-plugin" and .outcomes[0].code == "codex-plugin-installed" and (.outcomes | any(.component == "models" and .status == "updated"))'
openclaw plugins inspect codex --json | jq -e '.plugin.version == "2026.9.7" and .plugin.enabled == true and .install.version == "2026.9.7"'

# should reuse the shared install without changing its receipt across repeat and second agent installation
receipt="$(openclaw plugins inspect codex --json | jq -cS .install)"
cd "$GITHUB_WORKSPACE/examples/codex-prerequisite/first"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "codex-plugin-unchanged" and .status == "unchanged")'
cd "$GITHUB_WORKSPACE/examples/codex-prerequisite/second"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "codex-plugin-unchanged" and .status == "unchanged")'
test "$(openclaw plugins inspect codex --json | jq -cS .install)" = "$receipt"

# should diagnose disabled codex without repair and explicitly enable the matching shared installation
openclaw plugins disable codex
cd "$GITHUB_WORKSPACE/examples/codex-prerequisite/first"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.findings | any(.code == "codex-plugin-disabled" and .status == "drift")'
openclaw plugins inspect codex --json | jq -e '.plugin.enabled == false'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "codex-plugin-enabled" and .status == "updated")'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "codex-plugin-ready" and .status == "healthy")'

# should reject a conflicting shared plugin without silently upgrading it
openclaw plugins uninstall codex --force
openclaw plugins install npm:@openclaw/codex@2026.9.6 --pin --accept-capabilities
receipt="$(openclaw plugins inspect codex --json | jq -cS .install)"
cd "$GITHUB_WORKSPACE/examples/codex-prerequisite/second"
if output=$(openclaw agent-system install --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.blocked.code == "codex-plugin-conflict" and (.blocked.message | contains("2026.9.7")) and (.blocked.message | contains("2026.9.6"))'
test "$(openclaw plugins inspect codex --json | jq -cS .install)" = "$receipt"

# should require explicit operator reconciliation to restore the declared shared version
openclaw plugins uninstall codex --force
openclaw plugins install npm:@openclaw/codex@2026.9.7 --pin --accept-capabilities
cd "$GITHUB_WORKSPACE/examples/codex-prerequisite/second"
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "codex-plugin-ready")'

# should reject the packed plugin on a real incompatible host before agent installation
npm install --prefix "$TMPDIR/incompatible-host" --ignore-scripts --no-audit --no-fund --package-lock=false openclaw@2026.9.6
"$TMPDIR/incompatible-host/node_modules/.bin/openclaw" --version | grep -F '2026.9.6'
if output=$(OPENCLAW_STATE_DIR="$TMPDIR/incompatible-state" OPENCLAW_CONFIG_PATH="$TMPDIR/incompatible-state/openclaw.json" "$TMPDIR/incompatible-host/node_modules/.bin/openclaw" plugins install "$AGENT_SYSTEM_PACKAGE" --force --accept-capabilities 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F '2026.9.7'
```
