# Codex Install Example

Install the prepared plugin in isolated Codex state, discover its skills through a fresh app server, and verify workspace binding, runtime-aware setup, session context, model routing, and unbinding. The checked-in workspaces run in place; separate manifest snapshots prove they remain unchanged. These direct checks require no model or provider credentials. Run only in GitHub Actions.

## Setup

```bash
# should install and enable the exact prepared codex plugin in isolated state
root="$TMPDIR/agent-system-codex-install"
mkdir -p "$root/package"
tar -xzf "$AGENT_SYSTEM_PACKAGE" -C "$root/package"
codex-tools install "$root/package/package" --json | jq -e '.ok == true and .inspection.installed == true and .inspection.enabled == true'
codex-tools cache check --repo-root "$root/package/package" --json | tee "$root/cache.json" | jq -e '.ok == true and .status == "current"'

# should expose complete packaged skills to a fresh codex app server
bun --cwd "$GITHUB_WORKSPACE" run test:codex-plugin

# should prepare valid, inactive, and replacement workspaces
root="$TMPDIR/agent-system-codex-install"
mkdir -p "$root/missing-manifest"
cp "$GITHUB_WORKSPACE/examples/codex-install/workspace/agent.yaml" "$root/workspace.expected.yaml"
cp "$GITHUB_WORKSPACE/examples/codex-install/rebound/agent.yaml" "$root/rebound.expected.yaml"
```

## Testing

```bash
# should preview a valid workspace without persisting a binding
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$GITHUB_WORKSPACE/examples/codex-install/workspace" && pwd -P)
node "$runtime" binding preview --workspace "$GITHUB_WORKSPACE/examples/codex-install/workspace" \
  | jq -e --arg workspace "$workspace" '.status == "ready" and .workspaceDir == $workspace and .manifest.status == "valid" and .manifest.agentId == "codex-example"'
test ! -e "$plugin_data/workspace-binding.json"

# should refuse to bind without explicit confirmation
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
if output=$(node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$GITHUB_WORKSPACE/examples/codex-install/workspace" 2>&1); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "error" and (.message | contains("require --confirm"))'
test ! -e "$plugin_data/workspace-binding.json"

# should persist and inspect one explicitly confirmed workspace binding
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$GITHUB_WORKSPACE/examples/codex-install/workspace" && pwd -P)
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$GITHUB_WORKSPACE/examples/codex-install/workspace" --confirm \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace and .preview.manifest.agentId == "codex-example"'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace and .preview.manifest.agentId == "codex-example"'

# should keep standalone setup diagnostics quiet without runner debug
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
if diagnostics=$(node "$runtime" setup inspect --plugin-data "$plugin_data" 2>&1 >/dev/null); then
  :
else
  status=$?
  printf '%s\n' "$diagnostics" >&2
  exit "$status"
fi
test -z "$diagnostics"

# should expose codex tools diagnostics through standalone setup with runner debug
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
if diagnostics=$(RUNNER_DEBUG=1 node "$runtime" setup inspect --plugin-data "$plugin_data" 2>&1 >/dev/null); then
  :
else
  status=$?
  printf '%s\n' "$diagnostics" >&2
  exit "$status"
fi
printf '%s\n' "$diagnostics" | grep -F 'debug: {"command":"status"'

# should inspect and install only setup applicable to standalone codex
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
inspection=$(node "$runtime" setup inspect --plugin-data "$plugin_data")
printf '%s\n' "$inspection" \
  | jq -e '.status == "inspected" and [.findings[] | [.stepId, .code]] == [["codex-tools-debug", "setup-healthy"], ["shared", "setup-drift"], ["codex-only", "setup-manual"], ["openclaw-only", "setup-not-applicable"]]'
installed=$(node "$runtime" setup install --plugin-data "$plugin_data")
printf '%s\n' "$installed" \
  | jq -e '.status == "installed" and [.outcomes[] | [.stepId, .code]] == [["codex-tools-debug", "setup-unchanged"], ["shared", "setup-applied"], ["codex-only", "setup-applied"], ["openclaw-only", "setup-not-applicable"]]'
test -f "$GITHUB_WORKSPACE/examples/codex-install/workspace/.codex-shared"
test -f "$GITHUB_WORKSPACE/examples/codex-install/workspace/.codex-only"
test ! -e "$GITHUB_WORKSPACE/examples/codex-install/workspace/.openclaw-checked"
test ! -e "$GITHUB_WORKSPACE/examples/codex-install/workspace/.openclaw-only"

# should report a blocked setup check when an exited parent leaves inherited pipes open
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
node "$runtime" binding bind --plugin-data "$root/timeout-data" --workspace "$GITHUB_WORKSPACE/examples/codex-install/timeout" --confirm
node "$runtime" setup inspect --plugin-data "$root/timeout-data" \
  | jq -e '.status == "inspected" and [.findings[].code] == ["setup-blocked"]'

# should load the bound workspace through a packaged hook path containing spaces
root="$TMPDIR/agent-system-codex-install"
cache_root=$(jq -r .cachePath "$root/cache.json")
plugin_root="$root/plugin with spaces"
cp -R "$cache_root" "$plugin_root"
hook=$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$plugin_root/hooks/hooks.json")
plugin_data="$root/plugin-data"
workspace=$(cd "$GITHUB_WORKSPACE/examples/codex-install/workspace" && pwd -P)
context=$(printf '%s\n' '{"hook_event_name":"SessionStart","source":"startup"}' \
  | PLUGIN_DATA="$plugin_data" PLUGIN_ROOT="$plugin_root" sh -c "$hook" \
  | jq -r '.hookSpecificOutput.additionalContext')
printf '%s\n' "$context" | grep -F '"status": "active"'
printf '%s\n' "$context" | grep -F '"id": "codex-example"'
printf '%s\n' "$context" | grep -F "\"workspaceDir\": \"$workspace\""
printf '%s\n' "$context" | sed -n '/^{/,/^}/p' \
  | jq -e '.binding.context.capabilities == ["agent-system-doctor", "agent-system-install", "agent-system-model-routing", "agent-system-git-cli", "agent-system-github-cli"]'
printf '%s\n' "$context" | sed -n '/^{/,/^}/p' \
  | jq -e '.binding.context.modelRouting.medium == {status: "mapped", sourceModel: "openai/gpt-5.6-sol", model: "gpt-5.6-sol", thinking: "high"}'
printf '%s\n' "$context" | sed -n '/^{/,/^}/p' \
  | jq -e '.feedbackRuntime.argvPrefix[-1] == "feedback"'
printf '%s\n' "$context" | grep -F 'For new routed work, use'
printf '%s\n' "$context" | grep -F 'Reproduce the complete returned presentation Markdown in the final reply'

# should resolve bounded routing through the installed cache and preserve unresolved reasoning
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
inspection=$(printf '%s\n' '{"action":"inspect"}' | node "$runtime" model-routing --plugin-data "$plugin_data")
printf '%s\n' "$inspection" | jq -e '.status == "available" and (.reportGuidance | contains("Model routing"))'
digest=$(printf '%s\n' "$inspection" | jq -r .manifestDigest)
jq -n --arg digest "$digest" '{action:"resolve",manifestDigest:$digest,context:"An unspecified task.",assessment:{complexity:"unset",reason:"No defensible tier."}}' \
  | node "$runtime" model-routing --plugin-data "$plugin_data" \
  | jq -e '.status == "unresolved" and .profile == null and .selection == null and .reason == "No defensible tier."'
jq -n --arg digest "$digest" '{action:"resolve",manifestDigest:$digest,context:"An unspecified task.",assessment:{complexity:"unset",reason:"No defensible tier."},fallback:"default",overrides:{effort:"low"}}' \
  | node "$runtime" model-routing --plugin-data "$plugin_data" \
  | jq -e '.status == "unresolved" and .profile == "default" and .candidate.thinking == "low" and .execution == "unverified"'

# should accept issue objects as bounded routing context through the installed cache
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
inspection=$(printf '%s\n' '{"action":"inspect"}' | node "$runtime" model-routing --plugin-data "$plugin_data")
digest=$(printf '%s\n' "$inspection" | jq -r .manifestDigest)
jq -n --arg digest "$digest" '{action:"resolve",manifestDigest:$digest,context:{title:"Notification settings",body:"Add workflow enable controls."},assessment:{complexity:"medium",reason:"Extend existing configuration and scheduling."}}' \
  | node "$runtime" model-routing --plugin-data "$plugin_data" \
  | jq -e '.status == "resolved" and .profile == "medium" and .candidate.model == "gpt-5.6-sol" and .candidate.thinking == "high" and .execution == "unverified"'

# should refresh local settings through the bound codex runtime without changing the shared base
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
printf '%s\n' 'models: { default: { effort: xhigh } }' 'setup-agent: { steps: [] }' > "$GITHUB_WORKSPACE/examples/codex-install/workspace/agent.local.yaml"
cp "$GITHUB_WORKSPACE/examples/codex-install/workspace/agent.local.yaml" "$root/local.expected.yaml"
printf '%s\n' '{"hook_event_name":"SessionStart","source":"startup"}' \
  | PLUGIN_DATA="$plugin_data" PLUGIN_ROOT="$plugin_root" node "$runtime" session-start \
  | jq -r '.hookSpecificOutput.additionalContext' \
  | sed -n '/^{/,/^}/p' \
  | jq -e '.binding.context.modelRouting.default.thinking == "xhigh"'
cmp "$root/workspace.expected.yaml" "$GITHUB_WORKSPACE/examples/codex-install/workspace/agent.yaml"
cmp "$root/local.expected.yaml" "$GITHUB_WORKSPACE/examples/codex-install/workspace/agent.local.yaml"
rm "$GITHUB_WORKSPACE/examples/codex-install/workspace/agent.local.yaml"

# should preserve the active binding when a workspace has no agent manifest
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$GITHUB_WORKSPACE/examples/codex-install/workspace" && pwd -P)
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$root/missing-manifest" --confirm \
  | jq -e '.status == "confirmation-required" and .preview.manifest.status == "missing"'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace'

# should bind a missing manifest workspace only with the explicit inactive override
root="$TMPDIR/agent-system-codex-install"
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
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
workspace=$(cd "$GITHUB_WORKSPACE/examples/codex-install/rebound" && pwd -P)
node "$runtime" binding preview --workspace "$GITHUB_WORKSPACE/examples/codex-install/rebound" \
  | jq -e --arg workspace "$workspace" '.status == "ready" and .workspaceDir == $workspace and .manifest.agentId == "codex-example-rebound"'
node "$runtime" binding bind --plugin-data "$plugin_data" --workspace "$GITHUB_WORKSPACE/examples/codex-install/rebound" --confirm \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace and .preview.manifest.agentId == "codex-example-rebound"'

# should unbind without changing either workspace or manifest
root="$TMPDIR/agent-system-codex-install"
plugin_root=$(jq -r .cachePath "$root/cache.json")
runtime="$plugin_root/dist/codex/codex-runtime.js"
plugin_data="$root/plugin-data"
node "$runtime" binding unbind --plugin-data "$plugin_data" --confirm \
  | jq -e '.status == "unbound"'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e '.status == "unbound"'
cmp "$root/workspace.expected.yaml" "$GITHUB_WORKSPACE/examples/codex-install/workspace/agent.yaml"
cmp "$root/rebound.expected.yaml" "$GITHUB_WORKSPACE/examples/codex-install/rebound/agent.yaml"
```
