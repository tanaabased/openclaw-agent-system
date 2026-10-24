# OpenClaw Memory Example

Install manifest-managed keyword memory, index a known workspace note, retrieve its content, and verify that repeat installation and Doctor preserve the configured provider and usable search.

## What Belongs Here

- The declared memory configuration producing a real indexed and retrievable note.
- Repeat convergence, read-only readiness, and retrieval after the repeated install.
- Native OpenClaw indexing/search commands, because Agent System has no equivalent subcommands.

## What Does Not Belong Here

- Credential-backed embedding handoff and retrieval across restart: [embeddings](../openclaw-memory-embeddings/README.md).
- Secret resolution after Gateway restart, embedding quality, or live provider/model evaluation.
- Generic provider-cache behavior: [credentials](../openclaw-credentials/README.md).

## Notes

- Keyword checks use direct commands without a Gateway, model, or hosted credential.

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
```
