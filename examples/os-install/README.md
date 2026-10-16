# Install Example

Verify installation, repeat convergence, read-only Doctor inspection, and native credential enrollment on macOS and Ubuntu. Portable help, presentation, and tool-grant variants belong to the Ubuntu Doctor example.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
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

# should refuse unattended enrollment without explicit consent before making changes
cd "$GITHUB_WORKSPACE/examples/os-install/data"
if output=$(openclaw agent-system install --non-interactive --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.code == "session-dispatch-approval-required"'

# should report missing enrollment without issuing credentials
cd "$GITHUB_WORKSPACE/examples/os-install/data"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e 'any(.findings[]; .code == "session-dispatch-credential-missing")'

# should start the gateway for owner-consented device enrollment
openclaw-gateway start

# should enroll dispatch while skipping unavailable reviews without activating issue intake
cd "$GITHUB_WORKSPACE/examples/os-install/data"
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.warnings[]; .code == "github-notification-runtime-unsupported") and any(.outcomes[]; .component == "github") and all(.outcomes[]; .code != "intake-activated")'
openclaw agent-system tool git -- --version | grep -F 'git version'

# should warn about unavailable reviews without blocking unrelated readiness
cd "$GITHUB_WORKSPACE/examples/os-install/data"
openclaw agent-system doctor --json | jq -e '.status == "healthy" and any(.findings[]; .component == "github-intake-v2" and .code == "github-notification-runtime-unsupported" and .status == "warning") and any(.findings[]; .component == "github" and .status == "healthy")'
```

```bash
# should reuse enrollment without another explicit consent or bootstrap
cd "$GITHUB_WORKSPACE/examples/os-install/data"
openclaw agent-system install --non-interactive --json | jq -e 'any(.outcomes[]; .code == "session-dispatch-unchanged")'

# should retain device-only connectivity across a gateway restart
openclaw-gateway stop
openclaw-gateway start
cd "$GITHUB_WORKSPACE/examples/os-install/data"
openclaw agent-system doctor --json | jq -e 'any(.findings[]; .code == "session-dispatch-ready")'

# should refuse local reset while the exact device remains paired
device_id=$(openclaw devices list --json | jq -er '.paired[] | select(.displayName == "Agent System") | .deviceId')
printf '%s' "$device_id" > "$TMPDIR/session-dispatch-device"
if openclaw agent-system session-dispatch reset "$device_id"; then exit 1; fi

# should report revocation and require explicit enrollment after exact reset
device_id=$(cat "$TMPDIR/session-dispatch-device")
openclaw devices remove "$device_id"
cd "$GITHUB_WORKSPACE/examples/os-install/data"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e 'any(.findings[]; .code == "session-dispatch-credential-revoked")'
openclaw agent-system session-dispatch reset "$device_id" | jq -e '.status == "removed"'
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e 'any(.findings[]; .code == "session-dispatch-credential-missing")'
```

## Cleanup

```bash
# should stop the background gateway
openclaw-gateway stop
```
