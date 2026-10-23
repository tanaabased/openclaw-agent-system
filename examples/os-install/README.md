# Install Example

Install the declared agent on macOS and Ubuntu, repeat without foundational changes, inspect it through read-only Doctor, and explicitly enroll/reuse the native session-dispatch credential.

## What Belongs Here

- Real native installation, convergence, and read-only readiness on both operating systems.
- Consent before first enrollment and Doctor reporting missing credentials without issuing them.
- Successful device enrollment through Keychain or Secret Service and reuse without another consent/bootstrap.

## What Does Not Belong Here

- Unsupported review-adapter permutations, portable help/presentation, or native tool-grant matrices; the latter variants are currently collected in [Doctor](../openclaw-doctor/README.md) pending separation.
- Gateway-unavailable enrollment recovery and connectivity after restart. Any extracted native enrollment/recovery contract must retain both operating systems where their storage boundary differs.
- Hosted GitHub discovery or model behavior: [notification intake](../openclaw-notifications-intake/README.md).

## Notes

- A strict local GitHub CLI substitute supplies synthetic identity responses. The issue workflow is paused with no allowed actors; Gateway device enrollment, native credential storage, consent, and restart are real.
- No hosted secret, GitHub request, or model call is needed. Preserve the prepared PATH so CLI bootstrap cannot put the system GitHub CLI ahead of the fixture.
- Pending relocation: unsupported review validation/install/Doctor variants, bounded enrollment failure before Gateway startup, and device-only connectivity after restart remain below.
- The successful enrollment currently verifies reuse of the device ID retained by the preceding failed attempt. Preserve that recovery evidence when separating the ordinary enrollment path.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
chmod +x "$GITHUB_WORKSPACE/examples/os-install/provider/gh"
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --needs-secret-service

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

```bash
# should refuse unattended enrollment for a declared issue workflow before making changes
cp "$GITHUB_WORKSPACE/examples/os-install/enrollment/agent.yaml" "$GITHUB_WORKSPACE/examples/os-install/data/agent.yaml"
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-install/provider:$PATH"
cd "$GITHUB_WORKSPACE/examples/os-install/data"
if output=$(openclaw agent-system install --non-interactive --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.code == "session-dispatch-approval-required"'

# should report missing enrollment without issuing credentials
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-install/provider:$PATH"
cd "$GITHUB_WORKSPACE/examples/os-install/data"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e 'any(.findings[]; .code == "session-dispatch-credential-missing")'

# should report bounded enrollment failure while the gateway is unavailable
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-install/provider:$PATH"
cd "$GITHUB_WORKSPACE/examples/os-install/data"
if openclaw agent-system install --yes --json >"$TMPDIR/enrollment-failed.json"; then exit 1; fi
jq -e '.status == "failed" and .blocked.code == "session-dispatch-enrollment-unverified" and (.blocked.sessionDispatchDiagnostic | (.category == "transport" or .category == "timeout") and (.phase == "connection" or .phase == "unknown") and (.reasonCode | type == "string"))' "$TMPDIR/enrollment-failed.json"

# should start the gateway for owner-consented device enrollment
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-install/provider:$PATH"
openclaw-gateway start

# should enroll a paused issue workflow with no allowed actors
set -o pipefail
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-install/provider:$PATH"
cd "$GITHUB_WORKSPACE/examples/os-install/data"
openclaw agent-system install --yes --json | tee "$TMPDIR/enrollment-install.json"
jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated")' "$TMPDIR/enrollment-install.json"
retained_device=$(jq -er '.blocked.message | capture("device (?<id>[a-f0-9]{64})").id' "$TMPDIR/enrollment-failed.json")
jq -e --arg device "$retained_device" 'any(.outcomes[]; .code == "session-dispatch-enrolled" and (.message | contains($device)))' "$TMPDIR/enrollment-install.json"
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == false)'

# should reuse enrollment without another explicit consent or bootstrap
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-install/provider:$PATH"
cd "$GITHUB_WORKSPACE/examples/os-install/data"
openclaw agent-system install --non-interactive --json | jq -e 'any(.outcomes[]; .code == "session-dispatch-unchanged")'

# should retain device-only connectivity across a gateway restart
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-install/provider:$PATH"
openclaw-gateway stop
openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/os-install/data"
openclaw agent-system doctor --json | jq -e 'any(.findings[]; .code == "session-dispatch-ready")'

```

## Cleanup

```bash
# should stop the background gateway
openclaw-gateway stop
```
