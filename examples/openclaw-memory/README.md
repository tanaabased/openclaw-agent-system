# OpenClaw Memory Example

Verify manifest-managed memory through the packed plugin: install keyword-only search, index a known note, retrieve its content, and confirm repeat installation and Doctor preserve the configured provider. Native OpenClaw commands own indexing and search because Agent System has no equivalent subcommands.

Runtime tests run this example on Ubuntu without a model, Gateway, or embedding service. This proves the basic memory path; embedding providers, secret references, and restart behavior remain separate coverage in the older unscheduled memory example.

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
openclaw agent-system doctor --json | jq -e '.findings | any(.component == "memory" and .code == "agent-memory-keyword-ready" and .status == "healthy")'
openclaw memory search --agent memory-tanaabot --query 'cobalt astrolabes' --json | jq -e '(.stale != true) and any(.results[]; .path == "memory/observatory.md" and (.snippet | contains("cabinet seven")))'
```
