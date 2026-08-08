# Validate Example

This scenario installs the prepared Agent System package and verifies manifest discovery and diagnostics through the public command surface.

## Setup

```bash
# should install and enable the packed plugin
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system
```

## Testing

```bash
# should validate the current workspace through the canonical command
cd "$GITHUB_WORKSPACE/examples/validate/valid"
openclaw agent-system validate | grep -F 'valid' | grep -F 'Agent System manifest for data'
openclaw agent-system validate | grep -F 'valid' | grep -F 'agent'
openclaw agent-system validate | grep -F 'valid' | grep -F 'path'

# should expose foundational validation checks as structured json
cd "$GITHUB_WORKSPACE/examples/validate/valid"
openclaw agent-system validate --json | grep -F '"component": "agent"'
openclaw agent-system validate --json | grep -F '"component": "path"'
openclaw agent-system validate --json | grep -F '"status": "valid"'

# should prefer the hidden manifest and report the ignored shorthand
cd "$GITHUB_WORKSPACE/examples/validate/preferred"
openclaw agent-system validate 2>&1 | grep -F 'valid' | grep -F 'Agent System manifest for data'
openclaw agent-system validate 2>&1 | grep -F 'code=manifest-shadowed'

# should reject an unknown schema key with a failing exit code
cd "$GITHUB_WORKSPACE/examples/validate/invalid"
if output=$(openclaw agent-system validate 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'manifest: invalid Agent System manifest'
printf '%s\n' "$output" | grep -F 'code=manifest-unknown-key'
```
