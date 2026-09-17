# Memory Example

This scenario verifies manifest-managed built-in memory search for keyword-only,
local, and OpenAI providers. It also proves that the OpenAI credential remains a
secret reference, resolves through packed and source-linked installations after
service restart, and produces bounded readiness diagnostics without rebuilding
an existing index. The source-linked case replaces the packed install in the
same profile to verify configuration migration and index preservation.

## Setup

```bash
# should configure an isolated openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"
```

## Testing

```bash
# should reconcile keyword-only memory without an embedding provider
cd "$GITHUB_WORKSPACE/examples/memory/none"
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "memory" and .code == "set-agent-memory" and .status == "updated")'
openclaw config get 'agents.entries.memory-none.memory.search' --json \
  | jq -e '.provider == "none" and .fallback == "none" and (has("remote") | not)'
openclaw agent-system doctor --json \
  | jq -e '.findings | any(.component == "memory" and .code == "agent-memory-keyword-ready" and .status == "healthy")'
```

```bash
# should reconcile local memory and report readiness without initializing its model
cd "$GITHUB_WORKSPACE/examples/memory/local"
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "memory" and .code == "set-agent-memory" and .status == "updated")'
openclaw config get 'agents.entries.memory-local.memory.search' --json \
  | jq -e '.provider == "local" and .fallback == "none" and (has("remote") | not)'
openclaw agent-system doctor --json \
  | jq -e '.findings | any(.component == "memory" and ((.code == "agent-memory-local-ready" and .status == "healthy") or (.code == "agent-memory-local-unprobed" and .status == "manual")))'
```

```bash
# should install an agent-bound openai secret reference without exposing its value
cd "$GITHUB_WORKSPACE/examples/memory/openai"
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "memory" and .code == "set-agent-memory" and .status == "updated")'
configured="$(openclaw config get 'agents.entries.memory-openai.memory.search' --json)"
printf '%s\n' "$configured" \
  | jq -e '.provider == "openai" and .fallback == "none" and .model == "text-embedding-3-small" and .remote.apiKey.source == "exec" and .remote.apiKey.provider == "agent-system-environment"'
if [[ "$configured" == *"$OPENAI_API_KEY"* ]]; then exit 1; fi
```

```bash
# should prove openai embedding readiness through the public doctor surface
cd "$GITHUB_WORKSPACE/examples/memory/openai"
output="$(openclaw agent-system doctor --json)" || {
  printf '%s\n' "$output" | jq -c '{memory: [.findings[] | select(.component == "memory") | {code, status}]}' >&2
  exit 1
}
printf '%s\n' "$output" \
  | jq -e '.findings | any(.component == "memory" and .code == "agent-memory-openai-ready" and .status == "healthy")'
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "memory" and .code == "agent-memory-unchanged" and .status == "unchanged")'
```

```bash
# should resolve the same secret reference after an openclaw service restart
openclaw-gateway start
openclaw memory status --index --agent memory-openai --json >/dev/null
openclaw-gateway stop
openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/memory/openai"
output="$(openclaw agent-system doctor --json)" || {
  printf '%s\n' "$output" | jq -c '{memory: [.findings[] | select(.component == "memory") | {code, status}]}' >&2
  exit 1
}
printf '%s\n' "$output" \
  | jq -e '.findings | any(.component == "memory" and .code == "agent-memory-openai-ready" and .status == "healthy")'
```

```bash
# should migrate to a source-linked provider, remain idempotent, and retrieve through the gateway
openclaw-gateway stop
openclaw plugins install --link "$GITHUB_WORKSPACE" --force --accept-capabilities
openclaw plugins registry --json \
  | jq -e '.state == "fresh" and (.differences | length == 0)'
openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess true
openclaw plugins inspect agent-system --runtime --json \
  | jq -e '.plugin.id == "agent-system" and .plugin.origin == "config" and .plugin.status == "loaded"'
cd "$GITHUB_WORKSPACE/examples/memory/openai"
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "memory" and .code == "set-agent-memory" and .status == "updated")'
configured="$(openclaw config get 'agents.entries.memory-openai.memory.search' --json)"
printf '%s\n' "$configured" \
  | jq -e '.provider == "openai" and .fallback == "none" and .model == "text-embedding-3-small" and .remote.apiKey.source == "exec" and .remote.apiKey.provider == "agent-system-environment"'
if [[ "$configured" == *"$OPENAI_API_KEY"* ]]; then exit 1; fi
output="$(openclaw agent-system doctor --json)" || {
  printf '%s\n' "$output" | jq -c '{memory: [.findings[] | select(.component == "memory") | {code, status}]}' >&2
  exit 1
}
printf '%s\n' "$output" \
  | jq -e '.findings | any(.component == "memory" and .code == "agent-memory-openai-ready" and .status == "healthy")'
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "memory" and .code == "agent-memory-unchanged" and .status == "unchanged")'
openclaw-gateway start
openclaw gateway call memory.search \
  --params '{"agentId":"memory-openai","query":"Which observatory stores cobalt astrolabes?","maxResults":5}' \
  --timeout 120000 \
  --json | jq -e '
    .agentId == "memory-openai" and
    .provider == "openai" and
    .searchMode == "hybrid" and
    (.results | any(.path | endswith("memory/linked-provider.md")))
  '
```

## Cleanup

```bash
# should stop the background gateway cleanly
openclaw-gateway stop
```
