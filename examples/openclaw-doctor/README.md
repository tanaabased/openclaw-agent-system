# OpenClaw Doctor Example

Inspect a healthy installed agent, introduce one identity drift, detect it through read-only Doctor with a failing status, repair it through Install, and verify healthy state again.

## What Belongs Here

- Meaningful healthy inspection through public commands and structured output.
- Drift detection without implicit repair, followed by explicit reconciliation and a healthy result.
- The installed CLI boundary; one representative path is enough to prove diagnosis and repair.

## What Does Not Belong Here

- Native installation/enrollment differences: [OS install](../os-install/README.md). Workspace setup and convergence: [workspace](../openclaw-workspace/README.md).
- Identity rename/rotation, exhaustive help/alias/presentation variants, and native tool-grant reconciliation. Tool grants need their own focused installed contract; ordinary tool execution belongs to [tools](../openclaw-tools/README.md).

## Notes

- Direct checks install the prepared package without a model, Gateway, or provider credential. Workspaces run in place.
- Pending relocation: command-tree/alias and warning-layout checks, installation identity administration, and additive/allowlist/deny/stale tool-grant variants remain below.
- A temporary baseline restores the original manifest after tool-grant changes. Preserve those permission assertions when separating the grant contract; they are not redundant merely because they sit outside Doctor's core path.

## Setup

```bash
# should configure an unauthenticated local openclaw profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"

# should install the disposable doctor workspace through agent system
cp "$GITHUB_WORKSPACE/examples/openclaw-doctor/data/agent.yaml" "$TMPDIR/doctor-base.yaml"
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agent-system install
```

## Testing

```bash
# should expose the canonical command tree and its alias
openclaw agent-system --help | grep -F 'validate'
openclaw as --help | grep -F 'validate'

# should preserve installation identity through install and allow explicit rename and rotation
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agent-system instance inspect --json > "$TMPDIR/doctor-instance.json"
original=$(jq -er .instanceId "$TMPDIR/doctor-instance.json")
openclaw agent-system install --json | jq -e 'any(.outcomes[]; .component == "instance-identity" and .status == "unchanged")'
openclaw agent-system instance rename 'Doctor Laptop' --json | jq -e --arg id "$original" '.instanceId == $id and .displayName == "doctor-laptop"'
openclaw agent-system instance rotate --expected-id "$original" --json | jq -e --arg id "$original" '.instanceId != $id and .displayName == "doctor-laptop"'
openclaw agent-system doctor --json | jq -e 'any(.findings[]; .component == "instance-identity" and .status == "healthy")'

# should expose lowercase owned descriptions without changing host help headings
openclaw agent-system install --help | grep -F 'including required session dispatch'
openclaw as status --help | grep -F 'inspect agent system agent, path, and configured capability drift.'

```

```bash
# should place install manifest warnings after the result table in one message section
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/warning-data"
output="$(NO_COLOR=1 openclaw agent-system install --skip-setup --yes 2>&1)"
printf '%s\n' "$output" | grep -F 'manifest-setup-deprecated'
printf '%s\n' "$output" | awk '/^[[:space:]]*workspace[[:space:]]/ {footer=NR} /^messages$/ {section=NR; count++} END {exit !(footer && section > footer && count == 1)}'

# should place doctor manifest warnings after the workspace footer
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/warning-data"
output="$(NO_COLOR=1 openclaw agent-system doctor 2>&1)"
printf '%s\n' "$output" | grep -F 'manifest-setup-deprecated'
printf '%s\n' "$output" | awk '/^[[:space:]]*workspace[[:space:]]/ {footer=NR} /^messages$/ {section=NR; count++} END {exit !(footer && section > footer && count == 1)}'

# should report component-first healthy agent and path state without color
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
NO_COLOR=1 openclaw agent-system doctor | grep -E '^agent[[:space:]]+healthy[[:space:]]'
NO_COLOR=1 openclaw agent-system doctor | grep -E '^path[[:space:]]+healthy[[:space:]]'

# should report the same healthy aggregate state as structured json
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agent-system doctor --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'

# should report the same healthy aggregate state through both status aliases
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agent-system status --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'
openclaw as status --json | jq -e '.status == "healthy" and (.findings | any(.component == "agent"))'

# should detect public identity drift with a failing exit code
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agents set-identity \
  --agent doctor-data \
  --workspace "$GITHUB_WORKSPACE/examples/openclaw-doctor/data" \
  --name Drifted \
  --json
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'agent'

# should repair identity drift through install and return doctor to healthy state
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agent-system install --json | jq -e '.outcomes | any(.status == "updated")'
openclaw agent-system doctor --json | jq -e '.status == "healthy"'
```

```bash
# should reconcile additive native tool grants while preserving unrelated access
openclaw config set 'agents.entries.doctor-data.tools.alsoAllow' '["message"]' --strict-json
cp "$GITHUB_WORKSPACE/examples/openclaw-doctor/with-tools.yaml" "$GITHUB_WORKSPACE/examples/openclaw-doctor/data/agent.yaml"
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.doctor-data.tools.alsoAllow' --json | jq -e 'index("message") != null'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should reconcile selected native tools through an exact allowlist
openclaw config unset 'agents.entries.doctor-data.tools.alsoAllow'
openclaw config set 'agents.entries.doctor-data.tools.allow' '["read"]' --strict-json
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.doctor-data.tools.allow' --json | jq -e 'index("read") != null'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should leave converged native tool access unchanged
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "agent-tool-access-unchanged")'
openclaw agent-system doctor --json | jq -e '.findings | any(.code == "agent-tool-access-ready")'
```

```bash
# should block a selected native tool denied by operator policy
openclaw config set 'agents.entries.doctor-data.tools.deny' '["agent_system_github"]' --strict-json
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
if output=$(openclaw agent-system doctor --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.findings | any(.component == "tool-access" and .status == "blocked" and .code == "agent-tool-access-denied" and (.message | contains("agent_system_github")))'
if output=$(openclaw agent-system install --json 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=agent-tool-access-denied'
```

```bash
# should remove stale owned grants when capabilities disappear
openclaw config set 'agents.entries.doctor-data.tools.deny' '[]' --strict-json
cp "$TMPDIR/doctor-base.yaml" "$GITHUB_WORKSPACE/examples/openclaw-doctor/data/agent.yaml"
cd "$GITHUB_WORKSPACE/examples/openclaw-doctor/data"
if output=$(openclaw agent-system doctor 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'drift' | grep -F 'tool-access'
openclaw agent-system install --json | jq -e '.outcomes | any(.code == "set-agent-tool-access")'
openclaw config get 'agents.entries.doctor-data.tools' --json | jq -e '(.allow | sort) == (["read", "agent_system_install", "agent_system_doctor"] | sort) and (has("alsoAllow") | not)'
```
