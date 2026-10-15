# Install Example

This scenario installs the prepared Agent System package on a fresh GitHub Actions runner and verifies explicit lifecycle installation, human output, JSON output, idempotency, and manifest-derived native tool access reconciliation.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --needs-secret-service

# should prepare an isolated install workspace
mkdir -p "$TMPDIR/install-data"
cp "$GITHUB_WORKSPACE/examples/os-install/data/agent.yaml" "$TMPDIR/install-data/agent.yaml"
```

## Testing

```bash
# should expose the canonical command tree and its alias
openclaw agent-system --help | grep -F 'validate'
openclaw as --help | grep -F 'validate'

# should expose lowercase owned descriptions without changing host help headings
openclaw agent-system install --help | grep -F 'including required session dispatch'
openclaw as status --help | grep -F 'inspect agent system agent, path, and configured capability drift.'

# should install the scenario agent with a component-first table without color
cd "$TMPDIR/install-data"
NO_COLOR=1 openclaw agent-system install | grep -E '^agent[[:space:]]+created[[:space:]]' | grep -F 'OpenClaw agent install-data'

# should report every foundational component as unchanged in json on repeated install
cd "$TMPDIR/install-data"
output=$(openclaw agent-system install --json)
printf '%s\n' "$output" | jq -e '.outcomes | (any(.component == "agent" and .status == "unchanged") and any(.component == "path" and .status == "unchanged"))'
```

```bash
# should reconcile additive native tool grants while preserving unrelated access
openclaw config set 'agents.entries.install-data.tools.alsoAllow' '["message"]' --strict-json
cp "$GITHUB_WORKSPACE/examples/os-install/with-tools/agent.yaml" "$TMPDIR/install-data/agent.yaml"
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.install-data.tools.alsoAllow' --json | jq -e 'index("message") != null'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should reconcile selected native tools through an exact allowlist
openclaw config unset 'agents.entries.install-data.tools.alsoAllow'
openclaw config set 'agents.entries.install-data.tools.allow' '["read"]' --strict-json
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.install-data.tools.allow' --json | jq -e 'index("read") != null'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should leave converged native tool access unchanged
cd "$TMPDIR/install-data"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "agent-tool-access-unchanged")'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should block a selected native tool denied by operator policy
openclaw config set 'agents.entries.install-data.tools.deny' '["agent_system_github"]' --strict-json
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.findings | any(.component == "tool-access" and .status == "blocked" and .code == "agent-tool-access-denied" and (.message | contains("agent_system_github")))'
if output=$(openclaw agent-system install --json 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=agent-tool-access-denied'
```

```bash
# should remove stale owned grants when capabilities disappear
openclaw config set 'agents.entries.install-data.tools.deny' '[]' --strict-json
cp "$GITHUB_WORKSPACE/examples/os-install/data/agent.yaml" "$TMPDIR/install-data/agent.yaml"
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.install-data.tools' --json | jq -e '(.allow | sort) == (["read", "agent_system_install", "agent_system_doctor"] | sort) and (has("alsoAllow") | not)'
```

```bash
# should validate an unavailable review adapter without rejecting the manifest
cp "$GITHUB_WORKSPACE/examples/os-install/unsupported-notifications/agent.yaml" "$TMPDIR/install-data/agent.yaml"
cd "$TMPDIR/install-data"
openclaw agent-system validate --json | jq -e '.status == "valid" and any(.diagnostics[]; .code == "github-notification-runtime-unsupported" and .severity == "warning")'

# should refuse unattended enrollment without explicit consent before making changes
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system install --non-interactive --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.code == "session-dispatch-approval-required"'

# should report missing enrollment without issuing credentials
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e 'any(.findings[]; .code == "session-dispatch-credential-missing")'

# should start the gateway for owner-consented device enrollment
openclaw-gateway start

# should enroll dispatch while skipping unavailable reviews without activating issue intake
cd "$TMPDIR/install-data"
openclaw agent-system install --yes --json | jq -e 'any(.outcomes[]; .code == "session-dispatch-enrolled") and any(.outcomes[]; .component == "github-notifications" and .status == "skipped") and any(.warnings[]; .code == "github-notification-runtime-unsupported") and any(.outcomes[]; .component == "github") and all(.outcomes[]; .code != "intake-activated")'
openclaw agent-system tool git -- --version | grep -F 'git version'

# should retain the notification blocker without hiding unrelated readiness findings
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e 'any(.findings[]; .component == "github-notifications" and .code == "github-notification-runtime-unsupported" and .status == "blocked") and any(.findings[]; .component == "github" and .status == "healthy")'
```

```bash
# should reuse enrollment without another explicit consent or bootstrap
cd "$TMPDIR/install-data"
openclaw agent-system install --non-interactive --json | jq -e 'any(.outcomes[]; .code == "session-dispatch-unchanged")'

# should retain device-only connectivity across a gateway restart
openclaw-gateway stop
openclaw-gateway start
cd "$TMPDIR/install-data"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e 'any(.findings[]; .code == "session-dispatch-ready")'

# should refuse local reset while the exact device remains paired
device_id=$(openclaw devices list --json | jq -er '.paired[] | select(.displayName == "Agent System") | .deviceId')
printf '%s' "$device_id" > "$TMPDIR/session-dispatch-device"
if openclaw agent-system session-dispatch reset "$device_id"; then exit 1; fi

# should report revocation and require explicit enrollment after exact reset
device_id=$(cat "$TMPDIR/session-dispatch-device")
openclaw devices remove "$device_id"
cd "$TMPDIR/install-data"
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
