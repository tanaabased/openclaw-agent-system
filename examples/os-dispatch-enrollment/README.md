# Native Dispatch Enrollment Example

Require owner consent and keep the same device identity after enrollment fails.
When the Gateway becomes available, enroll that device and verify that its credential
works after a restart.

## What Belongs Here

- Unattended refusal before effects and read-only missing-credential inspection.
- Failed-attempt identity retention, successful enrollment, reuse, and device-only connectivity across restart.

## What Does Not Belong Here

- Foundational installation and unsupported-review compatibility: [OS install](../os-install/README.md).
- Hosted issue discovery, model behavior, and scheduler controls: [intake](../openclaw-notifications-intake/README.md) and [scheduling](../openclaw-notifications-scheduling/README.md).

## Notes

- Run on macOS and Ubuntu because Keychain and Secret Service are distinct native storage boundaries.
- A local GitHub CLI fixture supplies synthetic identity responses. Enrollment, consent, storage, and restart are real; no hosted secret or provider request is needed.
- The paused workflow has no allowed actors. Successful enrollment must reuse the device retained by the unavailable-Gateway attempt.

## Setup

```bash
# should prepare the packed plugin and native credential backend
chmod +x "$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/provider/gh"
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --needs-secret-service
```

## Testing

```bash
# should refuse unattended enrollment for a declared issue workflow before making changes
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/provider:$PATH"
cd "$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/data"
if output=$(openclaw agent-system install --non-interactive --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.code == "session-dispatch-approval-required"'

# should report missing enrollment without issuing credentials
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/provider:$PATH"
cd "$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/data"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e 'any(.findings[]; .code == "session-dispatch-credential-missing")'

# should report bounded enrollment failure while the gateway is unavailable
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/provider:$PATH"
cd "$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/data"
if openclaw agent-system install --yes --json >"$TMPDIR/enrollment-failed.json"; then exit 1; fi
jq -e '.status == "failed" and .blocked.code == "session-dispatch-enrollment-unverified" and (.blocked.sessionDispatchDiagnostic | (.category == "transport" or .category == "timeout") and (.phase == "connection" or .phase == "unknown") and (.reasonCode | type == "string"))' "$TMPDIR/enrollment-failed.json"
if ! jq -e 'if .blocked.sessionDispatchDiagnostic.reasonCode == "gateway-readiness-deadline" then .blocked.sessionDispatchDiagnostic.readinessEvidence | .state == "observed" and .maxWaitMs == 90000 and .elapsedMs >= .maxWaitMs and .elapsedMs < (.maxWaitMs + 10000) and .totalObservations > 0 and (.observations | length > 0 and length <= 16) and .droppedObservations == (.totalObservations - (.observations | length)) and all(.observations[]; .path == "/startupz" and .statusCode == null and .transport != "none") else false end' "$TMPDIR/enrollment-failed.json"; then jq '.blocked.sessionDispatchDiagnostic' "$TMPDIR/enrollment-failed.json" >&2; exit 1; fi

# should start the gateway for owner-consented device enrollment
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/provider:$PATH"
openclaw-gateway start

# should enroll a paused issue workflow with no allowed actors
set -o pipefail
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/provider:$PATH"
cd "$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/data"
openclaw agent-system install --yes --json | tee "$TMPDIR/enrollment-install.json"
jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .code == "intake-activated")' "$TMPDIR/enrollment-install.json"
retained_device=$(jq -er '.blocked.message | capture("device (?<id>[a-f0-9]{64})").id' "$TMPDIR/enrollment-failed.json")
jq -e --arg device "$retained_device" 'any(.outcomes[]; .code == "session-dispatch-enrolled" and (.message | contains($device)))' "$TMPDIR/enrollment-install.json"
openclaw agent-system automations list --json | jq -e '.status == "aligned" and any(.jobs[]; .id == "github-issue-assignment" and .nativeEnabled == false)'

# should reuse enrollment without another explicit consent or bootstrap
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/provider:$PATH"
cd "$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/data"
openclaw agent-system install --non-interactive --json | jq -e 'any(.outcomes[]; .code == "session-dispatch-unchanged")'

# should retain device-only connectivity across a gateway restart
export OPENCLAW_PATH_BOOTSTRAPPED=1 PATH="$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/provider:$PATH"
openclaw-gateway stop --timeout 340
openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/os-dispatch-enrollment/data"
openclaw agent-system doctor --json | jq -e 'any(.findings[]; .code == "session-dispatch-ready")'
```
