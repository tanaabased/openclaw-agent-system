# OpenClaw Memory Embeddings Example

Install an embedding credential reference, retrieve an indexed note through the Gateway, and retrieve it again after restart using freshly resolved authentication.

## What Belongs Here

- Secret-reference installation without persisting the credential value in OpenClaw configuration.
- Authenticated embedding retrieval and credential resolution across Gateway restart.

## What Does Not Belong Here

- Keyword-only indexing and convergence: [memory](../openclaw-memory/README.md).
- General provider cache behavior: [credentials](../openclaw-credentials/README.md).

## Notes

- Strict AIMock supplies fixed vectors and requires a synthetic credential. The Gateway and credential resolution are real; embedding quality and hosted transport are outside this contract.
- The checked-in workspace runs in place without a hosted secret or model turn.

## Setup

```bash
# should prepare the packed plugin for installed embedding retrieval
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
```

## Testing

```bash
# should install an embedding secret reference without persisting its value in openclaw configuration
openclaw-aimock prepare --scenario openclaw-memory-embeddings
cd "$GITHUB_WORKSPACE/examples/openclaw-memory-embeddings"
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
cd "$GITHUB_WORKSPACE/examples/openclaw-memory-embeddings"
openclaw agent-system doctor --json | tee "$TMPDIR/openclaw-memory-doctor.json"
jq -e '.findings | any(.code == "agent-memory-openai-ready" and .status == "healthy")' "$TMPDIR/openclaw-memory-doctor.json"
openclaw gateway call memory.search --params '{"agentId":"memory-embeddings","query":"cobalt astrolabes","maxResults":5}' --timeout 120000 --json | jq -e '.provider == "openai" and any(.results[]; .path == "memory/observatory.md")'
curl --fail-with-body --silent --show-error http://127.0.0.1:4010/proof/evidence | jq -e --argjson before "$(cat "$TMPDIR/memory-before-restart.json")" '.strictMissCount == 0 and .embeddingAuthentication.accepted > $before.embeddingAuthentication.accepted and .embeddingAuthentication.rejected == 0'
```
