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

# should prefer the hidden manifest and report the ignored shorthand
cd "$GITHUB_WORKSPACE/examples/validate/preferred"
openclaw agent-system validate 2>&1 | grep -F 'valid' | grep -F 'Agent System manifest for data'
openclaw agent-system validate 2>&1 | grep -F 'code=manifest-shadowed'

# should reject an unknown schema key with a failing exit code
cd "$GITHUB_WORKSPACE/examples/validate/invalid"
if openclaw agent-system validate; then exit 1; fi
grep -F 'manifest: invalid Agent System manifest' < <(openclaw agent-system validate 2>&1)
grep -F 'code=manifest-unknown-key' < <(openclaw agent-system validate 2>&1)
```
