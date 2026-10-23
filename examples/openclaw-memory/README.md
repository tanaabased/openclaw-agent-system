# OpenClaw Memory Example

Install manifest-managed keyword memory, index a known workspace note, retrieve its content, and verify that repeat installation and Doctor preserve the configured provider and usable search.

## What Belongs Here

- The declared memory configuration producing a real indexed and retrievable note.
- Repeat convergence, read-only readiness, and retrieval after the repeated install.
- Native OpenClaw indexing/search commands, because Agent System has no equivalent subcommands.

## What Does Not Belong Here

- Credential-backed embedding-provider handoff and retrieval; that is a separate valid installed path.
- Secret resolution after Gateway restart, embedding quality, or live provider/model evaluation.
- Generic provider-cache behavior: [credentials](../openclaw-credentials/README.md).

## Notes

- Keyword checks use direct commands without a Gateway, model, or hosted credential.
- Pending relocation: an additional workspace installs an embedding secret reference without persisting its value, retrieves through the Gateway, then resolves it again after restart.
- That embedding fixture uses strict AIMock with fixed vectors and a required synthetic credential. It proves credential handoff/retrieval rather than embedding quality or hosted provider transport.

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
cd "$GITHUB_WORKSPACE/examples/openclaw-memory/embeddings"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-memory/embeddings"
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
