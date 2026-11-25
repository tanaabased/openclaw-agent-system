# Install Example

Install an agent on macOS and Ubuntu, repeat installation without changing its core
configuration, and inspect it with Doctor. Verify that a review-only agent requires dispatch consent.

## What Belongs Here

- Real native installation, convergence, and read-only readiness on both operating systems.
- Read-only instance inspection with a readable name and human-only identifier masking.
- Review-only declarations validate without warnings about runtime support and cannot enroll dispatch without approval.
- Retired repository-owner configuration fails validation with direction to routing, even when routing is also present.

## What Does Not Belong Here

- Native dispatch consent, enrollment recovery, and connectivity after restart: [dispatch enrollment](../os-dispatch-enrollment/README.md).
- Portable Doctor presentation: [Doctor](../openclaw-doctor/README.md). Native tool grants: [tool access](../openclaw-tool-access/README.md).
- Hosted GitHub discovery or model behavior: [notification intake](../openclaw-issue-intake/README.md).

## Notes

- Direct checks use the packed plugin on both supported operating systems without a Gateway, model, or hosted secret.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" --needs-secret-service

```

## Testing

```bash
# should reject retired repository scope before installation
cd "$GITHUB_WORKSPACE/examples/os-install/retired-repository-scope"
if openclaw agent-system validate --json > "$TMPDIR/retired-scope.stdout" 2> "$TMPDIR/retired-scope.stderr"; then exit 1; fi
grep -F 'code=github-repository-owners-removed' "$TMPDIR/retired-scope.stderr" | grep -F 'github.routing'

# should install the scenario agent with a component-first table without color
cd "$GITHUB_WORKSPACE/examples/os-install/data"
NO_COLOR=1 openclaw agent-system install | grep -F 'agent' | grep -F 'created' | grep -F 'id: install-data'

# should report every foundational component as unchanged in json on repeated install
cd "$GITHUB_WORKSPACE/examples/os-install/data"
openclaw config set plugins.entries.agent-system.config.storage.backend sqlite
if openclaw config set plugins.entries.agent-system.config.storage.backend file; then exit 1; fi
test "$(openclaw config get plugins.entries.agent-system.config.storage.backend)" = sqlite
output=$(openclaw agent-system install --json)
printf '%s\n' "$output" | jq -e '.outcomes | (any(.component == "agent" and .status == "unchanged") and any(.component == "path" and .status == "unchanged") and any(.component == "agent-storage" and .status == "unchanged"))'
openclaw agent-system doctor --json | jq -e '.status == "healthy" and any(.findings[]; .code == "agent-storage-ready") and any(.findings[]; .code == "agent-system-storage-ready")'

# should inspect the installed identity with human-only id masking
cd "$GITHUB_WORKSPACE/examples/os-install/data"
identity=$(openclaw agent-system instance inspect --json)
name=$(printf '%s\n' "$identity" | jq -er .displayName)
full_id=$(printf '%s\n' "$identity" | jq -er .instanceId)
masked_id=$(printf '%s\n' "$identity" | jq -er '"***" + .instanceId[-4:]')
human=$(NO_COLOR=1 openclaw agent-system instance inspect)
printf '%s\n' "$human" | grep -F 'status' | grep -F 'ready'
printf '%s\n' "$human" | grep -F 'name' | grep -F "$name"
printf '%s\n' "$human" | grep -F 'id' | grep -F "$masked_id"
if printf '%s\n' "$human" | grep -F "$full_id"; then
  exit 1
fi
```

```bash
# should accept an openclaw review declaration without an unsupported runtime warning
cp "$GITHUB_WORKSPACE/examples/os-install/unsupported-notifications/agent.yaml" "$GITHUB_WORKSPACE/examples/os-install/data/agent.yaml"
cd "$GITHUB_WORKSPACE/examples/os-install/data"
openclaw agent-system validate --json | jq -e '.status == "valid" and all(.diagnostics[]?; .code != "github-notification-runtime-unsupported")'

# should require consent before enrolling a review-only agent
cd "$GITHUB_WORKSPACE/examples/os-install/data"
if openclaw agent-system install --non-interactive --json >"$TMPDIR/review-install.json"; then exit 1; fi
jq -e '.status == "blocked" and .code == "session-dispatch-approval-required" and .outcomes == []' "$TMPDIR/review-install.json"
```
