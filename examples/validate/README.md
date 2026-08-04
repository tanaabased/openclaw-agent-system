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
(cd "$GITHUB_WORKSPACE/examples/validate/valid" && openclaw agent-system validate) | grep -F 'valid: Agent System manifest for data'

# should prefer the hidden manifest and report the ignored shorthand
set -o pipefail
(cd "$GITHUB_WORKSPACE/examples/validate/preferred" && openclaw agent-system validate) 2>&1 | tee "$TMPDIR/preferred-validation.log"
grep -F 'valid: Agent System manifest for data' "$TMPDIR/preferred-validation.log"
grep -F '[manifest-shadowed]' "$TMPDIR/preferred-validation.log"

# should reject an unknown schema key with a failing exit code
if (cd "$GITHUB_WORKSPACE/examples/validate/invalid" && openclaw agent-system validate) > "$TMPDIR/invalid-validation.log" 2>&1; then exit 1; fi
grep -F 'error: invalid Agent System manifest' "$TMPDIR/invalid-validation.log"
grep -F '[manifest-unknown-key]' "$TMPDIR/invalid-validation.log"
```
