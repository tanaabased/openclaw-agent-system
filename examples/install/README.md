# Install Example

This scenario installs the prepared Agent System package on a fresh GitHub Actions runner and verifies its runtime and lightweight command contract.

## Setup

```bash
# should install and enable the packed plugin through OpenClaw's managed npm package path
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system
```

## Testing

```bash
# should load the packed runtime from dist
openclaw plugins inspect agent-system --runtime --json | grep -F '"id": "agent-system"'
openclaw plugins inspect agent-system --runtime --json | grep -F 'dist/index.js'

# should expose the canonical command tree and its alias
openclaw agent-system --help | grep -F 'validate'
openclaw as --help | grep -F 'validate'
```
