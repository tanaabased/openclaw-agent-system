# Install Example

Install the declared agent on macOS and Ubuntu, repeat without foundational changes, and inspect it through read-only Doctor while unsupported review declarations leave unrelated readiness intact.

## What Belongs Here

- Real native installation, convergence, and read-only readiness on both operating systems.
- Read-only instance inspection with a readable name and human-only identifier masking.
- Unsupported review declarations remain warnings without activating issue intake or enrolling dispatch credentials.

## What Does Not Belong Here

- Native dispatch consent, enrollment recovery, and connectivity after restart: [dispatch enrollment](../os-dispatch-enrollment/README.md).
- Portable Doctor presentation: [Doctor](../openclaw-doctor/README.md). Native tool grants: [tool access](../openclaw-tool-access/README.md).
- Hosted GitHub discovery or model behavior: [notification intake](../openclaw-notifications-intake/README.md).

## Notes

- Direct checks use the packed plugin on both supported operating systems without a Gateway, model, or hosted secret.
- Unsupported review validation, warning routing, and unrelated readiness remain one installed compatibility check; detailed parser variants retain source coverage.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"

```

## Testing

```bash
# should install the scenario agent with a component-first table without color
cd "$GITHUB_WORKSPACE/examples/os-install/data"
NO_COLOR=1 openclaw agent-system install | grep -E '^agent[[:space:]]+created[[:space:]]' | grep -F 'OpenClaw agent install-data'

# should report every foundational component as unchanged in json on repeated install
cd "$GITHUB_WORKSPACE/examples/os-install/data"
output=$(openclaw agent-system install --json)
printf '%s\n' "$output" | jq -e '.outcomes | (any(.component == "agent" and .status == "unchanged") and any(.component == "path" and .status == "unchanged"))'
openclaw agent-system doctor --json | jq -e '.status == "healthy"'

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
# should validate an unavailable review adapter without rejecting the manifest
cp "$GITHUB_WORKSPACE/examples/os-install/unsupported-notifications/agent.yaml" "$GITHUB_WORKSPACE/examples/os-install/data/agent.yaml"
cd "$GITHUB_WORKSPACE/examples/os-install/data"
openclaw agent-system validate --json | jq -e '.status == "valid" and any(.diagnostics[]; .code == "github-notification-runtime-unsupported" and .severity == "warning")'

# should skip dispatch enrollment for unavailable reviews without activating issue intake
set -o pipefail
install_diagnostics() {
  status=$?
  if [ "$status" -ne 0 ]; then
    jq '{status, code, outcomes: [.outcomes[]? | {component, status, code}], warnings: [.warnings[]? | {component, code}]}' "$TMPDIR/review-install.json" >&2 || true
    cat "$TMPDIR/review-install.stderr" >&2 || true
  fi
  exit "$status"
}
trap install_diagnostics EXIT
cd "$GITHUB_WORKSPACE/examples/os-install/data"
openclaw agent-system install --non-interactive --json >"$TMPDIR/review-install.json" 2>"$TMPDIR/review-install.stderr"
jq -e 'any(.outcomes[]; .code == "session-dispatch-not-required") and any(.warnings[]; .code == "github-notification-runtime-unsupported") and any(.outcomes[]; .component == "github") and all(.outcomes[]; .code != "intake-activated")' "$TMPDIR/review-install.json"
test "$(grep -Fc 'code=github-notification-runtime-unsupported' "$TMPDIR/review-install.stderr")" -eq 1
grep -F 'field=/github/review-request' "$TMPDIR/review-install.stderr"
openclaw agent-system tool git -- --version | grep -F 'git version'

# should warn about unavailable reviews without blocking unrelated readiness
cd "$GITHUB_WORKSPACE/examples/os-install/data"
openclaw agent-system doctor --json 2>"$TMPDIR/review-doctor.stderr" | jq -e '.status == "healthy" and any(.findings[]; .component == "github-intake" and .code == "github-notification-runtime-unsupported" and .status == "warning") and any(.findings[]; .component == "github" and .status == "healthy")'
test "$(grep -Fc 'code=github-notification-runtime-unsupported' "$TMPDIR/review-doctor.stderr")" -eq 1
```
