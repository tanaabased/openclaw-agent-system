# Validate Example

This scenario installs the prepared Agent System package and verifies manifest discovery and diagnostics through the public command surface.

## Setup

```bash
# should install and enable the packed plugin
openclaw plugins install "npm-pack:$AGENT_SYSTEM_PACKAGE" --force
openclaw plugins enable agent-system

# should prepare independent scenario-owned workspaces
cp -R "$GITHUB_WORKSPACE/examples/validate/data" "$TMPDIR/valid-data"
cp -R "$GITHUB_WORKSPACE/examples/validate/data" "$TMPDIR/preferred-data"
cp -R "$GITHUB_WORKSPACE/examples/validate/data" "$TMPDIR/invalid-data"
mkdir "$TMPDIR/preferred-data/.agent-system"
cp "$GITHUB_WORKSPACE/examples/validate/preferred-agent.yaml" "$TMPDIR/preferred-data/.agent-system/agent.yaml"
cp "$GITHUB_WORKSPACE/examples/validate/invalid-agent.yaml" "$TMPDIR/invalid-data/agent.yaml"
```

## Testing

```bash
# should validate the current workspace through the canonical command and alias
(cd "$TMPDIR/valid-data" && openclaw agent-system validate) | grep -F 'valid: Agent System manifest for data'
(cd "$TMPDIR/valid-data" && openclaw as validate) | grep -F 'valid: Agent System manifest for data'

# should prefer the hidden manifest and report the ignored shorthand
set -o pipefail
(cd "$TMPDIR/preferred-data" && openclaw agent-system validate) 2>&1 | tee "$TMPDIR/preferred-validation.log"
grep -F 'valid: Agent System manifest for data' "$TMPDIR/preferred-validation.log"
grep -F '[manifest-shadowed]' "$TMPDIR/preferred-validation.log"

# should reject an unknown schema key with a failing exit code
if (cd "$TMPDIR/invalid-data" && openclaw agent-system validate) > "$TMPDIR/invalid-validation.log" 2>&1; then exit 1; fi
grep -F 'error: invalid Agent System manifest' "$TMPDIR/invalid-validation.log"
grep -F '[manifest-unknown-key]' "$TMPDIR/invalid-validation.log"
```
