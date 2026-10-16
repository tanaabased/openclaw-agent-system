# OpenClaw Memory Example

Verify manifest-managed memory through the packed plugin: install keyword-only search, index a known note, retrieve its content, and confirm repeat installation and Doctor preserve the configured provider. Native OpenClaw commands own indexing and search because Agent System has no equivalent subcommands.

Ubuntu coverage also exercises the installed secret-provider handoff to OpenClaw embeddings and resolution after a Gateway restart. Strict AIMock returns fixed vectors only when it receives the synthetic fixture credential. No live model or hosted embedding service is used; this tests credential handoff and retrieval rather than embedding quality.

## Setup

```bash
# should install manifest-managed keyword memory through the packed plugin
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
cd "$GITHUB_WORKSPACE/examples/openclaw-memory"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.component == "memory" and .code == "set-agent-memory" and .status == "updated")'
openclaw config get agents.entries.memory-tanaabot.memory.search --json | jq -e '.provider == "none" and .fallback == "none" and (has("remote") | not)'
```

## Testing

```bash
# should index and retrieve the declared workspace note without an embedding provider
openclaw memory index --agent memory-tanaabot
openclaw memory search --agent memory-tanaabot --query 'cobalt astrolabes' --json | jq -e '(.stale != true) and any(.results[]; .path == "memory/observatory.md" and (.snippet | contains("The Meridian observatory stores cobalt astrolabes in cabinet seven.")))'

# should preserve the memory configuration and usable index on repeat installation
cd "$GITHUB_WORKSPACE/examples/openclaw-memory"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.component == "memory" and .code == "agent-memory-unchanged" and .status == "unchanged")'
openclaw agent-system doctor --json | tee "$TMPDIR/openclaw-memory-doctor.json"
jq -e '.findings | any(.component == "memory" and .code == "agent-memory-keyword-ready" and .status == "healthy")' "$TMPDIR/openclaw-memory-doctor.json"
openclaw memory search --agent memory-tanaabot --query 'cobalt astrolabes' --json | jq -e '(.stale != true) and any(.results[]; .path == "memory/observatory.md" and (.snippet | contains("cabinet seven")))'

# should install an embedding secret reference without persisting its value in openclaw configuration
openclaw-aimock prepare --scenario openclaw-memory
mkdir -p "$TMPDIR/memory-embeddings/memory"
cp "$GITHUB_WORKSPACE/examples/openclaw-memory/embedding-agent.yaml" "$TMPDIR/memory-embeddings/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/openclaw-memory/memory/observatory.md" "$TMPDIR/memory-embeddings/memory/observatory.md"
cd "$TMPDIR/memory-embeddings"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.component == "memory" and .code == "set-agent-memory")'
openclaw config set agents.entries.memory-embeddings.memory.search.remote.baseUrl http://127.0.0.1:4010/v1
openclaw config set agents.entries.memory-embeddings.memory.search.remote.batch.enabled false --strict-json
openclaw config get agents.entries.memory-embeddings.memory.search --json | jq -e '.provider == "openai" and .remote.apiKey.source == "exec" and .remote.apiKey.provider == "agent-system-environment"'
if grep -Fq synthetic-memory-credential "$OPENCLAW_CONFIG_PATH"; then exit 1; fi

# should retrieve through the gateway after resolving the installed embedding credential
openclaw-gateway start
openclaw memory index --agent memory-embeddings
openclaw gateway call memory.search --params '{"agentId":"memory-embeddings","query":"cobalt astrolabes","maxResults":5}' --timeout 120000 --json | jq -e '.agentId == "memory-embeddings" and .provider == "openai" and any(.results[]; .path == "memory/observatory.md")'

# should resolve the same secret reference after gateway restart and preserve retrieval
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence > "$TMPDIR/memory-before-restart.json"
openclaw-gateway stop --timeout 340
openclaw-gateway start
cd "$TMPDIR/memory-embeddings"
openclaw agent-system doctor --json | tee "$TMPDIR/openclaw-memory-doctor.json"
jq -e '.findings | any(.code == "agent-memory-openai-ready" and .status == "healthy")' "$TMPDIR/openclaw-memory-doctor.json"
openclaw gateway call memory.search --params '{"agentId":"memory-embeddings","query":"cobalt astrolabes","maxResults":5}' --timeout 120000 --json | jq -e '.provider == "openai" and any(.results[]; .path == "memory/observatory.md")'
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e --argjson before "$(cat "$TMPDIR/memory-before-restart.json")" '.strictMissCount == 0 and .embeddingAuthentication.accepted > $before.embeddingAuthentication.accepted and .embeddingAuthentication.rejected == 0'
```

## Cleanup

```bash
# should stop the isolated gateway and embedding fixture
openclaw-gateway stop --timeout 340
openclaw-aimock stop
```
