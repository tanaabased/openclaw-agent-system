# Codex Example

This scenario installs the prepared Agent System plugin into isolated Codex state and verifies native skill discovery, confirmed workspace binding, fresh-task context, transfer, and removal on a disposable GitHub Actions runner.

## Setup

```bash
# should install and enable the exact prepared codex plugin in isolated state
root="$TMPDIR/agent-system-codex-example"
mkdir -p "$root/package" "$root/task"
tar -xzf "$AGENT_SYSTEM_PACKAGE" -C "$root/package"
git -C "$root/task" init --quiet
codex-tools install "$root/package/package" --json | jq -e '.ok == true and .inspection.installed == true and .inspection.enabled == true'
codex-tools cache check --repo-root "$root/package/package" --json | tee "$root/cache.json" | jq -e '.ok == true and .status == "current"'

# should authenticate the isolated codex home from the shared api key
printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key
codex login status

# should expose every packaged agent system skill to a fresh codex task
bun --cwd "$GITHUB_WORKSPACE" run test:codex-plugin

# should prepare one minimal valid agent system workspace
root="$TMPDIR/agent-system-codex-example"
mkdir -p "$root/workspace"
cp "$GITHUB_WORKSPACE/examples/codex/agent.yaml" "$root/workspace/agent.yaml"
grep -F 'id: codex-example' "$root/workspace/agent.yaml"
```

## Testing

```bash
# should preview the canonical workspace through the packaged binding skill without persisting a binding
root="$TMPDIR/agent-system-codex-example"
codex exec --json \
  -c 'approval_policy="never"' \
  --model "$CODEX_MODEL" \
  --sandbox workspace-write \
  --add-dir "$CODEX_HOME" \
  --dangerously-bypass-hook-trust \
  --cd "$root/task" \
  "Use \$agent-system-codex-binding to preview binding the workspace at $root/workspace. Do not bind, rebind, or change any files. Report the preview only." \
  > "$root/preview.jsonl" || {
  tail -n 20 "$root/preview.jsonl" >&2
  false
}
node --import tsx "$GITHUB_WORKSPACE/examples/codex/scenario.ts" preview \
  --trace "$root/preview.jsonl" \
  --workspace "$root/workspace" \
  --codex-home "$CODEX_HOME" \
  --state "$root/state.json"

# should persist the previewed workspace only after explicit confirmation
root="$TMPDIR/agent-system-codex-example"
thread_id=$(jq -r .threadId "$root/state.json")
codex exec resume \
  --json \
  -c 'approval_policy="never"' \
  --model "$CODEX_MODEL" \
  --dangerously-bypass-hook-trust \
  "$thread_id" \
  'I confirm binding the exact workspace you previewed. Use $agent-system-codex-binding to bind it now, then verify the binding. Do not change workspace files.' \
  > "$root/bind.jsonl"
node --import tsx "$GITHUB_WORKSPACE/examples/codex/scenario.ts" bind \
  --trace "$root/bind.jsonl" \
  --codex-home "$CODEX_HOME" \
  --state "$root/state.json"

# should load the bound non-secret agent context through the session start hook in a fresh codex task
root="$TMPDIR/agent-system-codex-example"
codex exec --json \
  --ephemeral \
  -c 'approval_policy="never"' \
  --model "$CODEX_MODEL" \
  --sandbox read-only \
  --dangerously-bypass-hook-trust \
  --output-schema "$GITHUB_WORKSPACE/examples/codex/context.schema.json" \
  --output-last-message "$root/context.json" \
  --cd "$root/task" \
  'Using only the newest trusted Agent System context supplied at session start, return the active agentId and workspaceDir. Do not use tools or commands.' \
  > "$root/context.jsonl" || {
  tail -n 20 "$root/context.jsonl" >&2
  false
}
node --import tsx "$GITHUB_WORKSPACE/examples/codex/scenario.ts" context \
  --trace "$root/context.jsonl" \
  --response "$root/context.json" \
  --state "$root/state.json"

# should require an explicit override before binding a workspace without an agent manifest
root="$TMPDIR/agent-system-codex-example"
runtime="$(jq -r .cachePath "$root/cache.json")/dist/codex/codex-runtime.js"
binding_file=$(find "$CODEX_HOME" -type f -name workspace-binding.json -print)
plugin_data=$(dirname "$binding_file")
mkdir -p "$root/missing-manifest"
node "$runtime" binding bind \
  --plugin-data "$plugin_data" \
  --workspace "$root/missing-manifest" \
  --confirm \
  | jq -e '.status == "confirmation-required"'
workspace=$(cd "$root/workspace" && pwd -P)
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace'

# should replace one confirmed workspace binding with another
root="$TMPDIR/agent-system-codex-example"
runtime="$(jq -r .cachePath "$root/cache.json")/dist/codex/codex-runtime.js"
binding_file=$(find "$CODEX_HOME" -type f -name workspace-binding.json -print)
plugin_data=$(dirname "$binding_file")
mkdir -p "$root/rebound-workspace"
printf '%s\n' \
  'schema-version: 1' \
  'agent:' \
  '  id: codex-example-rebound' \
  '  name: Codex Example Rebound' \
  > "$root/rebound-workspace/agent.yaml"
cp "$root/rebound-workspace/agent.yaml" "$root/rebound-workspace/agent.expected.yaml"
node "$runtime" binding preview --workspace "$root/rebound-workspace" \
  | jq -e '.status == "ready" and .manifest.status == "valid" and .manifest.agentId == "codex-example-rebound"'
node "$runtime" binding bind \
  --plugin-data "$plugin_data" \
  --workspace "$root/rebound-workspace" \
  --confirm \
  | jq -e '.status == "bound"'
workspace=$(cd "$root/rebound-workspace" && pwd -P)
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e --arg workspace "$workspace" '.status == "bound" and .binding.workspaceDir == $workspace and .preview.manifest.agentId == "codex-example-rebound"'

# should remove only the binding while preserving both workspaces and manifests
root="$TMPDIR/agent-system-codex-example"
runtime="$(jq -r .cachePath "$root/cache.json")/dist/codex/codex-runtime.js"
binding_file=$(find "$CODEX_HOME" -type f -name workspace-binding.json -print)
plugin_data=$(dirname "$binding_file")
node "$runtime" binding unbind --plugin-data "$plugin_data" --confirm \
  | jq -e '.status == "unbound"'
node "$runtime" binding inspect --plugin-data "$plugin_data" \
  | jq -e '.status == "unbound"'
test -f "$root/workspace/agent.yaml"
test -f "$root/rebound-workspace/agent.yaml"

# should preserve the workspace manifest byte for byte
root="$TMPDIR/agent-system-codex-example"
cmp "$GITHUB_WORKSPACE/examples/codex/agent.yaml" "$root/workspace/agent.yaml"
cmp "$root/rebound-workspace/agent.expected.yaml" "$root/rebound-workspace/agent.yaml"
```
