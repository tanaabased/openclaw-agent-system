# Shared Codex Prerequisite Example

This GitHub Actions-only scenario first probes model configuration with Codex enabled on the pinned host/plugin pair, including clean command exits and child-process cleanup for [#135](https://github.com/tanaabased/openclaw-agent-system/issues/135).

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
```
