# Install Example

This scenario installs the prepared Agent System package on a fresh GitHub Actions runner and verifies its runtime and initial command contract.

## Setup

```bash
# should install the packed plugin through OpenClaw's managed npm package path
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
```

## Testing

```bash
# should load the packed runtime from dist
set -o pipefail
openclaw plugins inspect agent-system --runtime --json | tee "$TMPDIR/inspection.json"
grep -F '"id": "agent-system"' "$TMPDIR/inspection.json"
grep -F 'dist/index.js' "$TMPDIR/inspection.json"

# should pass OpenClaw plugin diagnostics
openclaw plugins doctor

# should expose the canonical command and its alias
openclaw agent-system --help | grep -F 'Manage reproducible OpenClaw agent workspaces.'
openclaw as --help | grep -F 'Manage reproducible OpenClaw agent workspaces.'
openclaw agent-system | grep -F 'Agent System for OpenClaw is installed.'
openclaw as | grep -F 'Agent System for OpenClaw is installed.'
```
