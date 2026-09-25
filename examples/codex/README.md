# Codex Example

This scenario installs the prepared Agent System plugin into isolated Codex state and verifies deterministic skill discovery, workspace binding, runtime-aware setup, session context, transfer, and removal on a disposable GitHub Actions runner.

## Setup

```bash
# should install and enable the exact prepared codex plugin in isolated state
root="$TMPDIR/agent-system-codex-example"
mkdir -p "$root/package"
tar -xzf "$AGENT_SYSTEM_PACKAGE" -C "$root/package"
codex-tools install "$root/package/package" --json | jq -e '.ok == true and .inspection.installed == true and .inspection.enabled == true'
codex-tools cache check --repo-root "$root/package/package" --json | tee "$root/cache.json" | jq -e '.ok == true and .status == "current"'

# should expose every packaged agent system skill to a fresh codex app server
bun --cwd "$GITHUB_WORKSPACE" run test:codex-plugin

# should prepare valid, inactive, and replacement workspaces
root="$TMPDIR/agent-system-codex-example"
mkdir -p "$root/workspace" "$root/missing-manifest" "$root/rebound-workspace"
cp "$GITHUB_WORKSPACE/examples/codex/agent.yaml" "$root/workspace/agent.yaml"
printf '%s\n' \
  'schema-version: 1' \
  'agent:' \
  '  id: codex-example-rebound' \
  '  name: Codex Example Rebound' \
  > "$root/rebound-workspace/agent.yaml"
cp "$root/workspace/agent.yaml" "$root/workspace/agent.expected.yaml"
cp "$root/rebound-workspace/agent.yaml" "$root/rebound-workspace/agent.expected.yaml"
```

## Testing

```bash
# should preview a valid workspace without persisting a binding
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$root/workspace" && pwd -P)
node "$runtime" binding preview --workspace "$root/workspace" \
  | jq -e --arg workspace "$workspace" '.status == "ready" and .workspaceDir == $workspace and .manifest.status == "valid" and .manifest.agentId == "codex-example"'
test ! -e "$plugin_data/workspace-binding.json"

# should refuse to bind without explicit confirmation
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
if output=$(node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/workspace" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and (.message | contains("require --confirm"))'
test ! -e "$plugin_data/workspace-binding.json"

# should persist and inspect one explicitly confirmed workspace binding
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$root/workspace" && pwd -P)
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/workspace" --confirm \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace and .preview.manifest.agentId == "codex-example"'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace and .preview.manifest.agentId == "codex-example"'

# should keep standalone setup diagnostics quiet without runner debug
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
diagnostics=$(node "$runtime" setup inspect --plugin-data "$plugin_data" 2>&1 >/dev/null)
test -z "$diagnostics"

# should expose codex tools diagnostics through standalone setup with runner debug
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
diagnostics=$(RUNNER_DEBUG=1 node "$runtime" setup inspect --plugin-data "$plugin_data" 2>&1 >/dev/null)
printf '%s\n' "$diagnostics" | grep -F 'debug: {"command":"status"'

# should inspect and install only setup applicable to standalone codex
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
inspection=$(node "$runtime" setup inspect --plugin-data "$plugin_data")
printf '%s\n' "$inspection" \
  | jq -e '.status == "inspected" and [.findings[] | [.stepId, .code]] == [["codex-tools-debug", "setup-healthy"], ["shared", "setup-drift"], ["codex-only", "setup-manual"], ["openclaw-only", "setup-not-applicable"]]'
installed=$(node "$runtime" setup install --plugin-data "$plugin_data")
printf '%s\n' "$installed" \
  | jq -e '.status == "installed" and [.outcomes[] | [.stepId, .code]] == [["codex-tools-debug", "setup-unchanged"], ["shared", "setup-applied"], ["codex-only", "setup-applied"], ["openclaw-only", "setup-not-applicable"]]'
test -f "$root/workspace/.codex-shared"
test -f "$root/workspace/.codex-only"
test ! -e "$root/workspace/.openclaw-checked"
test ! -e "$root/workspace/.openclaw-only"

# should report a blocked setup check when an exited parent leaves inherited pipes open
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
mkdir -p "$root/timeout-workspace"
printf '%s\n' \
  'schema-version: 1' \
  'agent: { id: codex-timeout }' \
  'setup:' \
  '  check: { command: sh, args: ["-c", "sleep 3 & exit 0"], timeout-seconds: 1 }' \
  '  apply: "true"' \
  > "$root/timeout-workspace/agent.yaml"
node "$runtime" binding bind --plugin-data "$root/timeout-data" --workspace "$root/timeout-workspace" --confirm
node "$runtime" setup inspect --plugin-data "$root/timeout-data" \
  | jq -e '.status == "inspected" and [.findings[].code] == ["setup-blocked"]'

# should load the bound workspace and only standalone capabilities through the packaged hook
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$root/workspace" && pwd -P)
context=$(printf '%s\n' '{"hook_event_name":"SessionStart","source":"startup"}' \
  | PLUGIN_DATA="$plugin_data" PLUGIN_ROOT="$plugin_root" node "$runtime" session-start \
  | jq -r '.hookSpecificOutput.additionalContext')
printf '%s\n' "$context" | grep -F '"status": "active"'
printf '%s\n' "$context" | grep -F '"id": "codex-example"'
printf '%s\n' "$context" | grep -F "\"workspaceDir\": \"$workspace\""
printf '%s\n' "$context" | sed -n '/^{/,/^}/p' \
  | jq -e '.binding.context.capabilities == ["agent-system-doctor", "agent-system-install", "agent-system-model-routing", "agent-system-git-cli", "agent-system-github-cli"]'
printf '%s\n' "$context" | sed -n '/^{/,/^}/p' \
  | jq -e '.binding.context.modelRouting.medium == {status: "mapped", sourceModel: "openai/gpt-5.6-sol", model: "gpt-5.6-sol", thinking: "high"}'
printf '%s\n' "$context" | grep -F 'For new routed work, use'

# should resolve bounded routing through the installed cache and preserve unresolved reasoning
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
inspection=$(printf '%s\n' '{"action":"inspect"}' | node "$runtime" model-routing --plugin-data "$plugin_data")
printf '%s\n' "$inspection" | jq -e '.status == "available" and (.reportGuidance | contains("**Model routing**"))'
digest=$(printf '%s\n' "$inspection" | jq -r .manifestDigest)
jq -n --arg digest "$digest" '{action:"resolve",manifestDigest:$digest,context:"An unspecified task.",assessment:{complexity:"unset",reason:"No defensible tier."}}' \
  | node "$runtime" model-routing --plugin-data "$plugin_data" \
  | jq -e '.status == "unresolved" and .profile == null and .selection == null and .reason == "No defensible tier."'
jq -n --arg digest "$digest" '{action:"resolve",manifestDigest:$digest,context:"An unspecified task.",assessment:{complexity:"unset",reason:"No defensible tier."},fallback:"default",overrides:{effort:"low"}}' \
  | node "$runtime" model-routing --plugin-data "$plugin_data" \
  | jq -e '.status == "unresolved" and .profile == "default" and .candidate.thinking == "low" and .execution == "unverified"'

# should preserve the active binding when a workspace has no agent manifest
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$root/workspace" && pwd -P)
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/missing-manifest" --confirm \
  | jq -e '.status == "confirmation-required" and .preview.manifest.status == "missing"'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace'

# should bind a missing manifest workspace only with the explicit inactive override
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$root/missing-manifest" && pwd -P)
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/missing-manifest" --confirm --allow-inactive \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace and .preview.manifest.status == "missing"'
context=$(printf '%s\n' '{"hook_event_name":"SessionStart","source":"startup"}' \
  | PLUGIN_DATA="$plugin_data" PLUGIN_ROOT="$plugin_root" node "$runtime" session-start \
  | jq -r '.hookSpecificOutput.additionalContext')
printf '%s\n' "$context" | grep -F '"status": "inactive"'
printf '%s\n' "$context" | grep -F '"code": "manifest-missing"'

# should replace the binding with another explicitly confirmed workspace
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$root/rebound-workspace" && pwd -P)
node "$runtime" binding preview --workspace "$root/rebound-workspace" \
  | jq -e --arg workspace "$workspace" '.status == "ready" and .workspaceDir == $workspace and .manifest.agentId == "codex-example-rebound"'
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/rebound-workspace" --confirm \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace and .preview.manifest.agentId == "codex-example-rebound"'

# should unbind without changing either workspace or manifest
root="$TMPDIR/agent-system-codex-example"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
node "$runtime" binding unbind --plugin-data "$plugin_data" --confirm \
  | jq -e '.status == "unbound"'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e '.status == "unbound"'
cmp "$root/workspace/agent.expected.yaml" "$root/workspace/agent.yaml"
cmp "$root/rebound-workspace/agent.expected.yaml" "$root/rebound-workspace/agent.yaml"
```
