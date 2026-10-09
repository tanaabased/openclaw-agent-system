# Validate Example

This scenario installs the prepared Agent System package and verifies manifest discovery and diagnostics through the public command surface.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"
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
openclaw agent-system validate --json | jq -e '.status == "valid" and (.checks | (any(.component == "agent" and .code == "agent-declaration-valid") and any(.component == "path") and any(.code == "manifest-valid")))'

# should prefer the hidden manifest and report the ignored shorthand
cd "$GITHUB_WORKSPACE/examples/validate/preferred"
openclaw agent-system validate 2>&1 | grep -F 'valid' | grep -F 'Agent System manifest for data'
openclaw agent-system validate 2>&1 | grep -F 'code=manifest-shadowed'

# should reject an unknown schema key with a failing exit code
cd "$GITHUB_WORKSPACE/examples/validate/invalid"
if output=$(openclaw agent-system validate 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'manifest: invalid Agent System manifest'
printf '%s\n' "$output" | grep -F 'code=manifest-unknown-key'

# should validate nested automation references without executing declared commands
cd "$GITHUB_WORKSPACE/examples/validate/automations"
openclaw agent-system validate --json | jq -e '.status == "valid" and .agentId == "automation-test"'
test ! -e automation-ran

# should reject missing automation prompt content with a failing exit code
cd "$GITHUB_WORKSPACE/examples/validate/automation-missing"
if output=$(openclaw agent-system validate 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=manifest-automation-prompt-file-unreadable'

# should validate a local overlay and leave both declarations untouched
workspace="$TMPDIR/manifest-overlay"
mkdir -p "$workspace/.agent-system"
printf '%s\n' 'schema-version: 1' 'agent: { id: overlay-shared }' > "$workspace/.agent-system/agent.yaml"
printf '%s\n' 'agent: { id: overlay-local }' 'setup-agent: { apply: touch must-not-run }' > "$workspace/.agent-system/agent.local.yaml"
cp "$workspace/.agent-system/agent.yaml" "$workspace/base.expected"
cp "$workspace/.agent-system/agent.local.yaml" "$workspace/local.expected"
cd "$workspace"
openclaw agent-system validate --json | jq -e '.status == "valid" and .agentId == "overlay-local"'
cmp .agent-system/agent.yaml base.expected
cmp .agent-system/agent.local.yaml local.expected
test ! -e must-not-run

# should reject a malformed local overlay instead of using the valid base
workspace="$TMPDIR/manifest-overlay"
printf '%s\n' 'agent: { unknown: value }' > "$workspace/.agent-system/agent.local.yaml"
cd "$workspace"
if output=$(openclaw agent-system validate 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=manifest-unknown-key'

# should restore base settings after local overlay removal
workspace="$TMPDIR/manifest-overlay"
rm "$workspace/.agent-system/agent.local.yaml"
cd "$workspace"
openclaw agent-system validate --json | jq -e '.status == "valid" and .agentId == "overlay-shared"'
cmp .agent-system/agent.yaml base.expected
```
