# Memory Example

This scenario verifies manifest-managed built-in memory search for keyword-only,
local, and OpenAI providers. It also proves that the OpenAI credential remains a
secret reference, resolves through the packed plugin after service restart, and
produces bounded readiness diagnostics without rebuilding an index.

## Setup

```bash
# should configure an isolated openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system-plugin "$AGENT_SYSTEM_PACKAGE"
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
# should reconcile local memory and diagnose its separately managed provider
cd "$GITHUB_WORKSPACE/examples/memory/local"
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "memory" and .code == "set-agent-memory" and .status == "updated")'
openclaw config get 'agents.entries.memory-local.memory.search' --json \
  | jq -e '.provider == "local" and .fallback == "none" and (has("remote") | not)'
if output="$(openclaw agent-system doctor --json)"; then exit 1; fi
printf '%s\n' "$output" \
  | jq -e '.findings | any(.component == "memory" and .status == "blocked" and (.remediation | contains("@openclaw/llama-cpp-provider")))'
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
openclaw agent-system doctor --json \
  | jq -e '.findings | any(.component == "memory" and .code == "agent-memory-openai-ready" and .status == "healthy")'
openclaw agent-system install --json \
  | jq -e '.outcomes | any(.component == "memory" and .code == "agent-memory-unchanged" and .status == "unchanged")'
```

```bash
# should resolve the same secret reference after an openclaw service restart
openclaw-gateway start
openclaw-gateway stop
openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/memory/openai"
openclaw agent-system doctor --json \
  | jq -e '.findings | any(.component == "memory" and .code == "agent-memory-openai-ready" and .status == "healthy")'
```

## Cleanup

```bash
# should stop the background gateway cleanly
openclaw-gateway stop
```
